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
import { deriveRequiredGates, mutationFactFromChangedFiles } from "./policies.ts";
import { brokerKind } from "./scheduler.ts";
import { MissionScheduler } from "./scheduler.ts";
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
  /** Planner: decomposes a goal into tasks. Injected for determinism. */
  planner: (mission: Mission, risk: RiskProfile) => Promise<PlanTaskInput[]>;
  /** Acceptance criterion deriver. */
  deriveAcceptance?: (mission: Mission) => Promise<string[]>;
  /** Called on each mission phase transition. */
  onPhase?: (mission: Mission, phase: string) => void;
  parentSessionId?: string | null;
  limits?: { maxActive?: number; maxAgents?: number; maxSubprocesses?: number; maxPerRole?: number };
  router?: IntentRouter;
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
  private readonly parentSessionId: string | null;
  private readonly limits: NonNullable<OrchestratorOptions["limits"]>;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.router = opts.router ?? new IntentRouter();
    this.limits = opts.limits ?? {};
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
    });
    this.gate = new CompletionGate(this.store);
    this.planner = opts.planner;
    this.deriveAcceptance = opts.deriveAcceptance;
    this.onPhase = opts.onPhase;
    this.parentSessionId = opts.parentSessionId ?? null;
  }

  private phase(mission: Mission, phase: string): void {
    this.onPhase?.(mission, phase);
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
    } = { repository: ".", baseRef: "" },
  ): Promise<OrchestrateResult> {
    const intent = this.router.route({
      request,
      changedFiles: opts.changedFiles,
      mutationRequested:
        opts.mutationRequested ?? workflowMutatesRepo(this.router.route({ request }).suggested_workflow),
    });
    const risk = this.router.risk({ request });

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

    // For pure conversation/research, no scheduling needed.
    if (intent.suggested_workflow === "conversation" || intent.suggested_workflow === "research") {
      this.store.completeMission(mission.mission_id);
      const final = this.store.getMission(mission.mission_id)!;
      return { mission: final, intent, verdict: this.gate.evaluate(final), completed: true, failureReason: null };
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

    // Post-execution: validate + review if the mission mutated or requires gates.
    await this.postExecution(this.store.getMission(mission.mission_id)!);

    // Completion gate.
    const finalMission = this.store.getMission(mission.mission_id)!;
    const verdict = this.gate.evaluate(finalMission);
    if (verdict.can_complete) {
      this.store.completeMission(finalMission.mission_id);
      this.phase(this.store.getMission(mission.mission_id)!, "complete");
      return {
        mission: this.store.getMission(mission.mission_id)!,
        intent,
        verdict,
        completed: true,
        failureReason: null,
      };
    }
    // Not complete: block for repair (legal from FINAL_VALIDATION) or fail.
    const hasBlocking = finalMission.required_gates.length > 0 && verdict.reasons.length > 0;
    if (hasBlocking) {
      this.store.transitionMission(finalMission.mission_id, "BLOCKED");
    } else {
      this.store.failMission(finalMission.mission_id, verdict.reasons.join("; "));
    }
    return {
      mission: this.store.getMission(mission.mission_id)!,
      intent,
      verdict,
      completed: false,
      failureReason: verdict.reasons.join("; "),
    };
  }

  /** Post-execution validation + review, respecting required gates. */
  private async postExecution(mission: Mission): Promise<void> {
    const gates = new Set<RequiredGate>(mission.required_gates);
    const tasks = this.store.listTasks(mission.mission_id);
    const anyMutation = tasks.some((t) => t.mutates_repo && t.status === "SUCCEEDED");

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
      await this.runSingleTask(mission.mission_id, task.task_id);
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
      await this.runSingleTask(mission.mission_id, task.task_id);
      // From REVIEWING the mission moves to final validation (or repair handled
      // by the caller via the completion gate).
      this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
    }
  }

  private lastValidationTaskId(missionId: string): string[] {
    return this.store
      .listTasks(missionId)
      .filter((t) => t.kind === "validation")
      .map((t) => t.task_id);
  }

  private async runSingleTask(missionId: string, taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)!;
    this.store.transitionTask(taskId, "RUNNING");
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
    try {
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
      this.store.transitionTask(taskId, "SUCCEEDED");
    } catch (err) {
      this.store.transitionTask(taskId, "FAILED");
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
          const ex = this.store.listExecutions(missionId, t.task_id).at(-1);
          if (ex) {
            this.store.setExecutionStatus(ex.execution_id, "CANCELED", { exit_status: "steered by constraint" });
            this.store.transitionTask(t.task_id, "CANCELED");
          }
        }
      }
    }
    return this.store.getMission(missionId)!;
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
