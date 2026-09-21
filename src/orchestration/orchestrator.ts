/**
 * Orchestrator facade (spec 00 §2, spec 06).
 *
 * The parent-session-facing entry point. Given a normal-language request, it:
 *  1. routes intent (Stage A semantic + Stage B policy);
 *  2. creates a durable Mission;
 *  3. derives acceptance criteria;
 *  4. plans/decomposes into tasks (fast path for low-risk);
 *  5. schedules workers via the broker;
 *  6. integrates, validates, reviews;
 *  7. creates repair tasks from findings;
 *  8. enforces the deterministic completion gate;
 *  9. returns completion evidence.
 *
 * No slash command is required: call `orchestrate(request)`.
 */

import type { GitRepo } from "../git/GitRepo.ts";
import type { EventStoreBackend } from "../platform/eventstore/backend.ts";
import { type BrokerBackends, ExecutionBroker } from "./broker.ts";
import { CompletionGate } from "./completionGate.ts";
import { IntentRouter, workflowMutatesRepo } from "./intentRouter.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";
import { deriveRequiredGates, mutationFactFromChangedFiles } from "./policies.ts";
import { brokerKind } from "./scheduler.ts";
import { MissionScheduler } from "./scheduler.ts";
import { canTransitionMission } from "./state.ts";
import type {
  AcceptanceCriterion,
  CompletionVerdict,
  Mission,
  OrchestrationTask,
  RequiredGate,
  ReviewFinding,
  RiskProfile,
  TaskStatus,
  WorkflowClass,
} from "./types.ts";

/** A task planned by the planner; the orchestrator fills lifecycle fields. */
export type PlanTaskInput = Omit<
  OrchestrationTask,
  | "task_id"
  | "mission_id"
  | "status"
  | "created_at"
  | "started_at"
  | "completed_at"
  | "attempt"
  | "steer_requests"
  | "artifacts"
  | "assigned_execution_id"
>;

export interface OrchestratorOptions {
  store: MissionStore;
  backends: BrokerBackends;
  /**
   * Optional observability read-model (spec 00 §observability). When present the
   * orchestrator feeds mission/phase/task transitions into it so a real run's
   * progress, health and activity stream live to the user. The observability
   * service stays a projector — the store remains authoritative. Optional so the
   * orchestrator remains usable standalone.
   */
  observability?: MissionObservability | null;
  /** Planner: decomposes a goal into tasks. Injected for determinism. */
  planner: (mission: Mission, risk: RiskProfile) => Promise<PlanTaskInput[]>;
  /** Acceptance criterion deriver. */
  deriveAcceptance?: (mission: Mission) => Promise<string[]>;
  /** Called on each mission phase transition. */
  onPhase?: (mission: Mission, phase: string) => void;
  parentSessionId?: string | null;
  limits?: { maxActive?: number; maxAgents?: number; maxSubprocesses?: number; maxPerRole?: number };
  router?: IntentRouter;
  /**
   * Maximum gate-driven repair rounds (spec 07). Each round repairs the open
   * blocking findings and then re-validates + re-reviews. Bounded so a reviewer
   * that keeps re-raising the same defect cannot loop forever; when the budget
   * is exhausted the mission BLOCKS with the findings left on the record.
   */
  maxRepairRounds?: number;
  /** Git provider used to allocate isolated worktrees for mutating tasks. */
  git?: GitRepo | null;
  /** Base ref (commit) worktrees are created at. Defaults to current HEAD. */
  baseRef?: string;
}

export interface OrchestrateResult {
  mission: Mission;
  intent: ReturnType<IntentRouter["route"]>;
  verdict: CompletionVerdict;
  completed: boolean;
  failureReason: string | null;
}

export class Orchestrator {
  readonly store: MissionStore;
  readonly broker: ExecutionBroker;
  readonly scheduler: MissionScheduler;
  readonly gate: CompletionGate;
  private readonly router: IntentRouter;
  private readonly planner: OrchestratorOptions["planner"];
  private readonly deriveAcceptance: OrchestratorOptions["deriveAcceptance"];
  private readonly onPhase: OrchestratorOptions["onPhase"];
  private readonly observability: OrchestratorOptions["observability"];
  private readonly parentSessionId: string | null;
  private readonly limits: NonNullable<OrchestratorOptions["limits"]>;
  private readonly maxRepairRounds: number;
  /** Per-call progress hook set by `orchestrate`; consumed by task/phase events. */
  private progress: ((line: string) => void) | null = null;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.router = opts.router ?? new IntentRouter();
    this.limits = opts.limits ?? {};
    this.maxRepairRounds = opts.maxRepairRounds ?? 2;
    this.broker = new ExecutionBroker({
      store: this.store,
      backends: opts.backends,
      git: opts.git ?? null,
      baseRef: opts.baseRef ?? "",
    });
    this.scheduler = new MissionScheduler({
      store: this.store,
      broker: this.broker,
      limits: this.limits,
      // Surface every task settlement as live progress so a running mission is
      // never silent: the operator sees each worker/gate settle instead of a
      // black screen for the whole worker budget (default 30 min).
      onTaskSettled: (missionId, taskId, status) => {
        this.report(`[mission ${missionId}] task ${taskId} -> ${status}`);
        this.observeTaskSettled(missionId, taskId, status);
      },
    });
    this.gate = new CompletionGate(this.store);
    this.planner = opts.planner;
    this.deriveAcceptance = opts.deriveAcceptance;
    this.onPhase = opts.onPhase;
    this.observability = opts.observability ?? null;
    this.parentSessionId = opts.parentSessionId ?? null;
  }

  private phase(mission: Mission, phase: string): void {
    this.onPhase?.(mission, phase);
    this.report(`[mission ${mission.mission_id}] phase ${phase}`);
    this.observability?.phaseChanged(mission.mission_id, phase);
  }

  /** Signal the CompletionGate passing to observability (100% · VERIFIED COMPLETE). */
  private observeGatePassed(missionId: string): void {
    const obs = this.observability;
    if (!obs) return;
    obs.gateStarted(missionId);
    obs.gatePassed(missionId);
    obs.markVerifiedComplete(missionId);
  }

  /** Feed a settled task into observability (SUCCEEDED/FAILED terminal states). */
  private observeTaskSettled(missionId: string, taskId: string, status: TaskStatus): void {
    const obs = this.observability;
    if (!obs) return;
    const task = this.store.getTask(taskId);
    const label = task?.objective ?? taskId;
    if (status === "SUCCEEDED") {
      obs.taskStarted(missionId, taskId, label);
      obs.taskCompleted(missionId, taskId, label);
      obs.workerCompleted(missionId, taskId);
      obs.activity(missionId, { type: "worker_completed", summary: label, workerId: taskId });
    } else if (status === "FAILED") {
      obs.workerFailed(missionId, taskId);
      obs.recordError(missionId, "task_failed", `task ${taskId} settled ${status}`);
    }
  }

  /** Emit a live progress line to the operator (no-op when no hook is set). */
  private report(line: string): void {
    try {
      this.progress?.(line);
    } catch {
      // A progress listener is an observer, never a participant.
    }
  }

  /**
   * Full automatic engineering workflow from a normal-language request.
   */
  async orchestrate(
    request: string,
    opts: {
      title?: string;
      repository: string;
      baseRef: string;
      constraints?: string[];
      changedFiles?: string[];
      mutationRequested?: boolean;
      acceptanceCriteria?: string[];
      /** Live progress callback (per-call). Lines stream as the mission runs. */
      onProgress?: (line: string) => void;
    } = { repository: ".", baseRef: "" },
  ): Promise<OrchestrateResult> {
    const intent = this.router.route({
      request,
      changedFiles: opts.changedFiles,
      mutationRequested:
        opts.mutationRequested ?? workflowMutatesRepo(this.router.route({ request }).suggested_workflow),
    });
    const risk = this.router.risk({ request });

    // Install the per-call progress hook for the duration of this mission so
    // task/phase transitions stream to the caller (e.g. the /mission command).
    this.progress = opts.onProgress ?? null;
    this.report(`[mission] starting workflow=${intent.suggested_workflow} risk=${risk}`);

    const mission = this.store.createMission({
      title: opts.title ?? request,
      goal: request,
      user_request: request,
      repository: opts.repository,
      base_ref: opts.baseRef,
      constraints: opts.constraints ?? [],
      risk_profile: risk,
      workflow_class: intent.suggested_workflow,
      parent_session_id: this.parentSessionId,
    });
    this.observability?.missionCreated(mission.mission_id, mission.title);
    this.store.transitionMission(mission.mission_id, "CLASSIFYING");

    // Derive acceptance criteria.
    const criteria = opts.acceptanceCriteria ?? (await this.deriveAcceptance?.(mission)) ?? [];
    for (const c of criteria) this.store.addAcceptanceCriterion(mission.mission_id, c);
    if (criteria.length === 0 && workflowMutatesRepo(intent.suggested_workflow)) {
      this.store.addAcceptanceCriterion(mission.mission_id, `Goal achieved: ${request}`);
    }

    // Required gates from policy. A mutation request (even before files exist)
    // counts as a source mutation so validation + review are mandated by code.
    if (intent.suggested_workflow !== "conversation" || opts.mutationRequested) {
      const fact = mutationFactFromChangedFiles(opts.changedFiles ?? []);
      if (opts.mutationRequested && fact.changedFiles.length === 0) {
        fact.changedFiles = [request];
      }
      const { gates } = deriveRequiredGates(fact);
      this.store.updateMission(mission.mission_id, { required_gates: dedupe([...gates]) });
    }
    this.phase(this.store.getMission(mission.mission_id)!, "classified");
    this.store.transitionMission(mission.mission_id, "PLANNING");

    // Pure conversation/research has nothing to schedule — but ONLY when policy
    // attached no gates. Taking this shortcut while gates are set would complete
    // a mission that policy says must be validated and reviewed, and calling
    // completeMission straight from PLANNING threw `illegal mission transition
    // PLANNING -> COMPLETE` (reproduced for a plain "Explain this function").
    const gatesNow = this.store.getMission(mission.mission_id)!.required_gates;
    const passive = intent.suggested_workflow === "conversation" || intent.suggested_workflow === "research";
    if (passive && gatesNow.length === 0) {
      // Walk the lifecycle legally instead of teleporting to COMPLETE.
      this.store.transitionMission(mission.mission_id, "READY");
      this.store.transitionMission(mission.mission_id, "EXECUTING");
      this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
      this.observeGatePassed(mission.mission_id);
      this.store.completeMission(mission.mission_id);
      const final = this.store.getMission(mission.mission_id)!;
      const verdict = this.gate.evaluate(final);
      this.progress = null;
      return {
        mission: final,
        intent,
        verdict,
        completed: verdict.can_complete,
        failureReason: verdict.can_complete ? null : verdict.reasons.join("; "),
      };
    }

    // Plan/decompose into tasks.
    const planned = await this.planner(this.store.getMission(mission.mission_id)!, risk);
    for (const t of planned) {
      this.store.createTask({ mission_id: mission.mission_id, ...t });
    }
    this.store.transitionMission(mission.mission_id, "READY");

    // Schedule + execute.
    this.store.transitionMission(mission.mission_id, "EXECUTING");
    this.phase(this.store.getMission(mission.mission_id)!, "executing");
    await this.scheduler.runMission(mission.mission_id);

    // Post-execution: integrate, validate + review if the mission mutated or
    // requires gates. If integration did not land the change, the mission must
    // not complete — otherwise it reports success over an unchanged repository.
    let post = await this.postExecution(this.store.getMission(mission.mission_id)!);
    let integrated = post.integrationOk;

    // Completion gate, with bounded repair rounds (spec 07): a blocking reviewer
    // finding creates repair work, and the repaired result is re-validated and
    // re-reviewed before the gate is consulted again.
    let verdict = this.gate.evaluate(this.store.getMission(mission.mission_id)!);
    let repairRounds = 0;
    while ((!verdict.can_complete || !integrated) && repairRounds < this.maxRepairRounds) {
      const openBlocking = this.store
        .listFindings(mission.mission_id)
        .filter((f) => f.severity === "blocking" && f.status === "open");
      // A failed validation / integration / review is repairable too: the usual
      // cause is work that does not build, does not merge, or was not reviewed
      // clean. Without this the mission wedges permanently, because a FAILED
      // task keeps the gate closed and nothing else ever retries it.
      const failedGates = this.store.listTasks(mission.mission_id).filter(
        (t) =>
          (t.kind === "validation" || t.kind === "integration" || t.kind === "review") &&
          t.status === "FAILED" &&
          // Only repair a gate that CAN run: a mission whose harness has no
          // validation/review backend has an unavailable capability, not
          // broken work, and repairing it would burn rounds for nothing.
          this.broker.hasBackend(t.kind as "validation" | "integration" | "review"),
      );
      // Nothing repairable (missing gate, running task): the repair loop cannot
      // help, so stop and let the caller block or fail.
      if (openBlocking.length === 0 && failedGates.length === 0) break;
      repairRounds++;

      // FINAL_VALIDATION -> REPAIRING is legal; guard the self-transition, which
      // has no self-loop and would throw on a second round that left the mission
      // already in REPAIRING.
      if (this.store.getMission(mission.mission_id)!.status !== "REPAIRING") {
        this.store.transitionMission(mission.mission_id, "REPAIRING");
      }
      this.phase(this.store.getMission(mission.mission_id)!, "repairing");
      // What to fix this round: open blocking findings, plus failed gate tasks
      // when there is nothing else to act on.
      const objectives: Array<{ objective: string; findingId?: string }> = openBlocking.map((f) => {
        const where = f.file ? ` [${f.file}${f.line ? `:${f.line}` : ""}]` : "";
        return {
          objective: `Repair review finding (${f.category})${where}: ${f.summary} — recommended: ${f.recommended_action || "n/a"}`,
          findingId: f.finding_id,
        };
      });
      if (objectives.length === 0) {
        for (const t of failedGates) {
          objectives.push({
            objective: `Fix the failing ${t.kind} step for this mission (${t.objective}). Make the repository's own checks pass and leave the change ready to integrate.`,
          });
        }
      }
      for (const obj of objectives) {
        const repair = this.store.createTask({
          mission_id: mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: obj.objective,
          mutates_repo: true,
          write_domains: ["**"],
          isolation: "worktree",
        });
        this.store.transitionTask(repair.task_id, "READY");
        const repaired = await this.runSingleTask(mission.mission_id, repair.task_id);
        // Only a repair that actually RAN may close its finding; a failed repair
        // leaves the finding open so the gate keeps blocking rather than letting
        // a crashed worker silently clear a defect. When the repair succeeds the
        // finding is closed optimistically and the mandatory re-review below
        // decides whether it still stands — a reviewer that still sees the
        // defect records a fresh finding, which keeps the mission blocked.
        if (repaired && obj.findingId) this.store.resolveFinding(obj.findingId);
      }
      // Mandatory re-integration, re-validation + re-review of the repaired result.
      post = await this.postExecution(this.store.getMission(mission.mission_id)!);
      integrated = post.integrationOk;
      // A finding may only be considered cleared if the re-review actually ran.
      // If it failed, there is no evidence the defect is gone, so stop here and
      // let the mission block rather than complete on optimistic closure.
      if (post.reviewAttempted && !post.reviewOk) {
        verdict = this.gate.evaluate(this.store.getMission(mission.mission_id)!);
        break;
      }
      verdict = this.gate.evaluate(this.store.getMission(mission.mission_id)!);
    }

    // The mission is finished either way: release the mission-scoped worktrees so
    // they cannot accumulate for tasks that never reach an integration dispatch
    // (e.g. repair tasks). Branches are released only when the work actually
    // landed — otherwise the branch is the last copy of the worker's output and
    // deleting it would destroy what an operator needs to resolve the conflict.
    await this.broker.cleanupMission(mission.mission_id, { keepBranches: !integrated });
    if (!integrated) {
      const preserved = this.broker.preservedBranches(mission.mission_id);
      if (preserved.length > 0) {
        this.store.addFinding({
          mission_id: mission.mission_id,
          task_id: null,
          severity: "major",
          category: "integration",
          file: null,
          line: null,
          summary: `Unmerged worker work preserved on branch(es): ${preserved.join(", ")}`,
          evidence: null,
          recommended_action: "Merge or discard these branches manually; the orchestrator will not re-run them.",
        });
      }
    }

    const finalMission = this.store.getMission(mission.mission_id)!;
    if (verdict.can_complete && integrated) {
      // COMPLETE is only legal from REVIEWING / FINAL_VALIDATION. A mission with
      // no post-execution gates (e.g. a read-only investigation) is still
      // EXECUTING, so settle it into FINAL_VALIDATION first.
      const pre = this.store.getMission(mission.mission_id)!.status;
      if (pre !== "FINAL_VALIDATION" && pre !== "REVIEWING") {
        this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
      }
      this.observeGatePassed(mission.mission_id);
      this.store.completeMission(mission.mission_id);
      this.phase(this.store.getMission(mission.mission_id)!, "complete");
      this.progress = null;
      return {
        mission: this.store.getMission(mission.mission_id)!,
        intent,
        verdict,
        completed: true,
        failureReason: null,
      };
    }
    // Not complete: block when a human/repair decision is needed (unresolved
    // blocking findings, or unmet required gates); fail only when the work
    // itself failed. Previously findings on a mission with no required gates
    // were reported as FAILED, which lost the distinction.
    const unresolvedBlocking = this.store
      .listFindings(finalMission.mission_id)
      .filter((f) => f.severity === "blocking" && f.status !== "resolved").length;
    const hasBlocking =
      unresolvedBlocking > 0 || (finalMission.required_gates.length > 0 && verdict.reasons.length > 0);
    if (hasBlocking) {
      if (finalMission.status !== "BLOCKED") this.store.transitionMission(finalMission.mission_id, "BLOCKED");
    } else {
      this.store.failMission(finalMission.mission_id, verdict.reasons.join("; "));
    }
    this.progress = null;
    return {
      mission: this.store.getMission(mission.mission_id)!,
      intent,
      verdict,
      completed: false,
      failureReason: verdict.reasons.join("; "),
    };
  }

  /**
   * Post-execution validation + review, respecting required gates. Reports
   * whether each stage was attempted and whether it succeeded, so the caller
   * can refuse to complete when a mandatory re-review did not actually run.
   */
  private async postExecution(mission: Mission): Promise<{
    validationAttempted: boolean;
    validationOk: boolean;
    reviewAttempted: boolean;
    reviewOk: boolean;
    integrationOk: boolean;
  }> {
    let validationAttempted = false;
    let validationOk = false;
    let reviewAttempted = false;
    let reviewOk = false;
    // True unless a merge was required and did not land. Defaulting this to false
    // made every repair round look unintegrated for missions with no worktrees.
    let integrationOk = true;
    const gates = new Set<RequiredGate>(mission.required_gates);
    const tasks = this.store.listTasks(mission.mission_id);
    const anyMutation = tasks.some((t) => t.mutates_repo && t.status === "SUCCEEDED");

    // INTEGRATING first: workers and repairs edit isolated worktrees whose
    // branches must be merged into the checkout BEFORE validation and review,
    // otherwise both run against an unchanged tree and a mutating mission can
    // 'complete' without the repository ever changing.
    // Only integrate when isolated worktrees actually hold unmerged work: a
    // mission with no git provider edits the checkout directly and needs no merge.
    if (this.broker.pendingIntegrations(mission.mission_id) > 0) {
      const cur = this.store.getMission(mission.mission_id)!.status;
      if (cur !== "INTEGRATING" && canTransitionMission(cur, "INTEGRATING")) {
        this.store.transitionMission(mission.mission_id, "INTEGRATING");
      }
      const integ = this.store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "Merge worker/repair branches into the base checkout.",
        mutates_repo: true,
        isolation: "none",
      });
      this.store.transitionTask(integ.task_id, "READY");
      integrationOk = await this.runSingleTask(mission.mission_id, integ.task_id);
      // A green merge is not proof the work landed: harvesting a worktree can
      // fail silently, and merging an empty branch is trivially clean. Require
      // the checkout to actually differ from the mission's base commit.
      if (integrationOk) {
        const landed = await this.broker.changedFilesSinceBase(mission.mission_id);
        if (landed !== null && landed.length === 0) {
          integrationOk = false;
          // Say WHAT is wrong, in the channel operators (and the PI WEB panel)
          // already read, rather than leaving an opaque unmet-gate verdict.
          this.store.addFinding({
            mission_id: mission.mission_id,
            task_id: integ.task_id,
            severity: "blocking",
            category: "integration",
            file: null,
            line: null,
            summary: "Integration produced no change: the worker branches held no committed work",
            evidence: null,
            recommended_action: "The implementer must actually edit files; harvested worktrees were empty.",
          });
        }
      }
      // A conflicted or failed integration means the change is not in the tree;
      // report it so the caller does not complete on top of an unchanged repo.
      if (!integrationOk) return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk };
    } else if (anyMutation) {
      // No worktree/merge path exists because the runtime has no git provider, so
      // there is no base commit to diff against and nothing can PROVE the repo
      // changed. Mutating without version control cannot be made safe here, but
      // it must not pass silently: record it (non-blocking) so the unverified
      // mutation is visible in the mission record and the PI WEB panel.
      this.store.addFinding({
        mission_id: mission.mission_id,
        task_id: null,
        severity: "minor",
        category: "verification",
        file: null,
        line: null,
        summary: "Mutation could not be verified against a base commit (no git provider, nothing to integrate)",
        evidence: null,
        recommended_action:
          "Run the runtime inside a git repository so worker output is isolated, merged and diffable.",
      });
    }

    if (gates.has("validation") || anyMutation) {
      this.store.transitionMission(mission.mission_id, "VALIDATING");
      const task = this.store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "Run deterministic validation (typecheck/tests/lint) over the integrated result.",
        mutates_repo: false,
        isolation: "none",
      });
      this.store.transitionTask(task.task_id, "READY");
      validationAttempted = true;
      validationOk = await this.runSingleTask(mission.mission_id, task.task_id);
      // From VALIDATING the mission may move on to review or final validation.
      if (
        !gates.has("independent_review") &&
        !gates.has("security_review") &&
        !gates.has("compatibility_review") &&
        !anyMutation
      ) {
        this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
      }
    }

    if (
      gates.has("independent_review") ||
      gates.has("security_review") ||
      gates.has("compatibility_review") ||
      anyMutation
    ) {
      this.store.transitionMission(mission.mission_id, "REVIEWING");
      const role = gates.has("security_review") ? "security-review" : "reviewer";
      const task = this.store.createTask({
        mission_id: mission.mission_id,
        kind: "review",
        role,
        objective: `Fresh independent review of the integrated change. Mission: ${mission.goal}`,
        mutates_repo: false,
        isolation: "none",
        depends_on: this.lastValidationTaskId(mission.mission_id),
      });
      this.store.transitionTask(task.task_id, "READY");
      reviewAttempted = true;
      reviewOk = await this.runSingleTask(mission.mission_id, task.task_id);
      // From REVIEWING the mission moves to final validation (or repair handled
      // by the caller via the completion gate).
      this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
    }
    return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk };
  }

  private lastValidationTaskId(missionId: string): string[] {
    return this.store
      .listTasks(missionId)
      .filter((t) => t.kind === "validation")
      .map((t) => t.task_id);
  }

  /** Run one task to settlement. Returns true iff it reached SUCCEEDED. */
  private async runSingleTask(missionId: string, taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId)!;
    this.store.transitionTask(taskId, "RUNNING");
    this.report(`[mission ${missionId}] ${task.kind}:${task.role} starting — ${task.objective.slice(0, 120)}`);
    try {
      // execute() itself can throw — e.g. no backend is registered for the task
      // kind. Left outside the try it propagated out of postExecution and
      // orchestrate and left the mission stranded in INTEGRATING / VALIDATING /
      // REVIEWING. The scheduler path was hardened the same way; this one was not.
      const handle = await this.broker.execute({
        taskId,
        missionId,
        kind: brokerKind(task.kind),
        role: task.role,
        objective: task.objective,
        mutatesRepo: task.mutates_repo,
        writeDomains: task.write_domains,
        isolation: task.isolation,
        modelRequirements: task.execution_requirements,
      });
      const outcome = await handle.result();
      // Record reviewer findings so the completion gate can block on them.
      for (const f of outcome.findings ?? []) {
        const severity =
          (f.severity as string) === "blocking" ? "blocking" : (f.severity as string) === "major" ? "major" : "minor";
        this.store.addFinding({
          mission_id: missionId,
          task_id: taskId,
          severity: severity as ReviewFinding["severity"],
          category: (f.category as string) ?? "correctness",
          file: (f.file as string | null) ?? null,
          line: (f.line as number | null) ?? null,
          summary: String(f.summary ?? "review finding"),
          evidence: (f.evidence as string | null) ?? null,
          recommended_action: String(f.recommended_action ?? ""),
        });
      }
      // A task canceled underneath us (steering) must not be rewritten, and a
      // canceled task must NOT count as passing evidence for a gate.
      const status = this.store.getTask(taskId)?.status;
      if (status !== "RUNNING") return false;
      // A backend that resolves without throwing has NOT necessarily succeeded:
      // integration reports `conflict`, validation reports `failed`, and a worker
      // reports `failed` through exitStatus. Trusting resolution alone let a
      // failing test suite satisfy the validation gate and a conflicted merge
      // satisfy integration — i.e. a mission could COMPLETE over an unchanged or
      // broken tree.
      if (outcome.exitStatus !== "succeeded") {
        this.store.transitionTask(taskId, "FAILED", "system", { failure_reason: outcome.exitStatus });
        this.report(`[mission ${missionId}] ${task.kind}:${task.role} FAILED (${outcome.exitStatus})`);
        return false;
      }
      this.store.transitionTask(taskId, "SUCCEEDED");
      this.report(`[mission ${missionId}] ${task.kind}:${task.role} succeeded`);
      return true;
    } catch (err) {
      if (this.store.getTask(taskId)?.status === "RUNNING") this.store.transitionTask(taskId, "FAILED");
      this.report(`[mission ${missionId}] ${task.kind}:${task.role} errored`);
      return false;
    }
  }

  // ── Steering ───────────────────────────────────────────────────────────

  /** Add a user constraint mid-run; cancel tasks whose domains it affects. */
  async addConstraint(missionId: string, constraint: string): Promise<Mission> {
    const m = this.store.getMission(missionId)!;
    const constraints = [...m.constraints, constraint];
    this.store.updateMission(missionId, { constraints });
    // Steer/cancel active mutating tasks (best-effort; the user said don't change X).
    for (const t of this.store.listTasks(missionId)) {
      if (t.status === "READY" || t.status === "RUNNING") {
        this.store.steerTask(t.task_id, `constraint added: ${constraint}`);
        if (t.status === "RUNNING") {
          // Cancel THROUGH the broker so the runner is aborted and its worktree
          // released. Cancelling by poking the store left the runner running,
          // leaked the worktree, and let the late result overwrite CANCELED with
          // SUCCEEDED (and threw CANCELED -> SUCCEEDED in the scheduler).
          await this.broker.cancelByTask(t.task_id);
        }
      }
    }
    return this.store.getMission(missionId)!;
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
