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

import { id } from "../core/ids.ts";
import { GitRepo } from "../git/GitRepo.ts";
import type { EventStoreBackend } from "../platform/eventstore/backend.ts";
import type { GatewayResilienceConfig } from "../resilience/config.ts";
import type { RecoveryProbe } from "../resilience/probe.ts";
import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import { type BrokerBackends, ExecutionBroker } from "./broker.ts";
import { CompletionGate } from "./completionGate.ts";
import { IntentRouter, workflowMutatesRepo } from "./intentRouter.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";
import { computeProgress } from "./observability/progress.ts";
import type { ActivityType, WaitingReason } from "./observability/types.ts";
import { deriveRequiredGates, mutationFactFromChangedFiles } from "./policies.ts";
import type { RepositoryRegistry } from "./repositoryRegistry.ts";
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
import { type WorkspaceManifestResolver, WorkspaceScopeError, createWorkspaceManifest } from "./workspaceManifest.ts";

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
  /**
   * Mission-level gateway resilience config passed to the scheduler. Defaults to
   * the environment-resolved config (time-based 90-min window, 10s probes).
   * Inject to override for a deployment or to disable (retry_transient_errors).
   */
  resilience?: GatewayResilienceConfig;
  /**
   * Lightweight gateway recovery probe passed to the scheduler. Defaults to a
   * pass-through healthy probe; inject an HttpRecoveryProbe for a real gateway
   * to detect recovery without burning a full worker session.
   */
  probe?: RecoveryProbe;
  /** Injectable clock passed to the scheduler (default Date.now). For tests. */
  now?: () => number;
  /** Injectable sleep passed to the scheduler (default real setTimeout). For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG passed to the scheduler (default Math.random). For tests. */
  rand?: () => number;
  /** Resolve explicit user workspace authority before material planning. */
  workspaceResolver?: WorkspaceManifestResolver;
  /** Repository-scoped execution dependencies populated from the manifest. */
  repositoryRegistry?: RepositoryRegistry;
  /** Process launch directory; never assumed to be the requested repository. */
  launchCwd?: string;
}

export interface OrchestrateResult {
  mission: Mission;
  intent: ReturnType<IntentRouter["route"]>;
  verdict: CompletionVerdict;
  completed: boolean;
  failureReason: string | null;
  /**
   * True when the mission paused on an infrastructure failure (its time-based
   * retry window was exhausted) rather than failing. A paused mission preserves
   * all progress and is resumable via `Orchestrator.resume()` when the gateway
   * recovers — it is NOT a terminal failure.
   */
  paused?: boolean;
}

type FinalizationResult = Omit<OrchestrateResult, "intent" | "paused">;

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
  /** Per-mission progress hooks; missions may overlap on one orchestrator. */
  private readonly progress = new Map<string, (line: string) => void>();
  private readonly observedExecutions = new Set<string>();
  private readonly taskExecutions = new Map<string, string>();
  private readonly workspaceResolver?: WorkspaceManifestResolver;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly launchCwd: string;
  private readonly missionRepoIds = new Map<string, string>();

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.router = opts.router ?? new IntentRouter();
    this.limits = opts.limits ?? {};
    this.maxRepairRounds = opts.maxRepairRounds ?? 2;
    this.broker = new ExecutionBroker({
      store: this.store,
      backends: opts.backends,
      git: opts.git ?? null,
      resolveRepository: opts.repositoryRegistry
        ? async (repoId, writableDomains) => {
            const context = await opts.repositoryRegistry!.resolveForExecution(repoId, writableDomains);
            return { repoId: context.repoId, root: context.root, git: context.git };
          }
        : undefined,
      baseRef: opts.baseRef ?? "",
      onActivity: (event) => this.observeWorkerActivity(event),
    });
    this.scheduler = new MissionScheduler({
      store: this.store,
      broker: this.broker,
      limits: this.limits,
      // Time-based gateway resilience: a worker transient-infra failure retries
      // within the (env-resolved) window, parking the mission in a WAITING state,
      // and pauses (not fails) on exhaustion. Operator may override config/probe.
      resilience: opts.resilience,
      probe: opts.probe,
      now: opts.now,
      sleep: opts.sleep,
      rand: opts.rand,
      onStatus: (notice) => {
        const obs = this.observability;
        if (notice.action === "resumed") {
          obs?.clearWaiting(notice.missionId);
          this.report(
            notice.missionId,
            `[mission ${notice.missionId}] recovery succeeded; worker execution resumed (attempt ${notice.attempt})`,
          );
          return;
        }
        const waitingReason: WaitingReason =
          notice.status === "WAITING_FOR_CAPACITY"
            ? "rate_limit"
            : notice.status === "RECOVERING_CONTEXT"
              ? "model_request"
              : "external_resource";
        const next = notice.nextActionAt ? `; next recovery check ${new Date(notice.nextActionAt).toISOString()}` : "";
        const detail =
          notice.action === "paused"
            ? `Recovery stopped with no active worker: ${notice.reason}. Mission is paused and resumable.`
            : `No active worker while recovery runs: ${notice.reason}; attempt ${notice.attempt}${next}`;
        obs?.setWaiting(notice.missionId, waitingReason, detail);
        this.report(notice.missionId, `[mission ${notice.missionId}] ${detail}`);
      },
      // Surface every task settlement as live progress so a running mission is
      // never silent: the operator sees each worker/gate settle instead of a
      // black screen for the whole worker budget (default 30 min).
      onTaskSettled: (missionId, taskId, status) => {
        const reason = (this.store.getTask(taskId) as (OrchestrationTask & { failure_reason?: string }) | undefined)
          ?.failure_reason;
        const detail = reason ? `: ${reason}` : "";
        this.report(missionId, `[mission ${missionId}] task ${taskId} -> ${status}${detail}`);
        this.observeTaskSettled(missionId, taskId, status);
      },
    });
    this.gate = new CompletionGate(this.store);
    this.planner = opts.planner;
    this.deriveAcceptance = opts.deriveAcceptance;
    this.onPhase = opts.onPhase;
    this.observability = opts.observability ?? null;
    this.parentSessionId = opts.parentSessionId ?? null;
    this.workspaceResolver = opts.workspaceResolver;
    this.repositoryRegistry = opts.repositoryRegistry;
    this.launchCwd = opts.launchCwd ?? ".";
  }

  private repoIdForMission(missionId: string): string | undefined {
    return this.missionRepoIds.get(missionId) ?? this.store.getWorkspaceManifest(missionId)?.repositories[0]?.repoId;
  }

  private activateMissionRepository(missionId: string): void {
    const repoId = this.repoIdForMission(missionId);
    if (repoId && this.repositoryRegistry) {
      this.missionRepoIds.set(missionId, repoId);
      this.repositoryRegistry.activate(repoId);
    }
  }

  private phase(mission: Mission, phase: string): void {
    this.onPhase?.(mission, phase);
    this.report(mission.mission_id, `[mission ${mission.mission_id}] phase ${phase}`);
    this.observability?.phaseChanged(mission.mission_id, phase);
  }

  private observeWorkerActivity(
    event: WorkerActivity & { missionId: string; taskId: string; executionId: string },
  ): void {
    const obs = this.observability;
    if (!this.observedExecutions.has(event.executionId)) {
      this.observedExecutions.add(event.executionId);
      this.taskExecutions.set(`${event.missionId}:${event.taskId}`, event.executionId);
      const task = this.store.getTask(event.taskId);
      obs?.workerStarted(event.missionId, event.executionId, { taskId: event.taskId, runtime: "pi" });
      if (task) {
        obs?.taskStarted(event.missionId, event.taskId, task.objective);
        obs?.setCurrentObjective(event.missionId, task.objective);
      }
    }
    if (event.kind === "heartbeat") {
      obs?.heartbeat(event.missionId, event.executionId, {
        elapsedMs: event.elapsedMs,
        lastActivityMs: event.lastActivityMs,
      });
    } else {
      const type = this.activityType(event);
      obs?.activity(event.missionId, {
        type,
        summary: event.summary,
        workerId: event.executionId,
        meaningfulProgress: event.meaningfulProgress,
      });
      if (event.kind === "tool")
        obs?.noteWorkerTool(event.missionId, event.executionId, `${event.toolName}:${event.phase}`);
      if ((event.kind === "state" || event.kind === "execution") && event.phase === "completed") {
        obs?.workerCompleted(event.missionId, event.executionId);
        if (event.kind === "execution") {
          this.observedExecutions.delete(event.executionId);
          this.taskExecutions.delete(`${event.missionId}:${event.taskId}`);
        }
      } else if (
        (event.kind === "state" || event.kind === "execution") &&
        (event.phase === "failed" || event.phase === "canceled")
      ) {
        obs?.workerFailed(event.missionId, event.executionId);
        if (event.kind === "execution") {
          this.observedExecutions.delete(event.executionId);
          this.taskExecutions.delete(`${event.missionId}:${event.taskId}`);
        }
      }
    }
    this.report(event.missionId, `[mission ${event.missionId}] ${event.summary}`);
  }

  private activityType(event: WorkerActivity): ActivityType {
    if (event.kind === "tool") return event.toolName === "bash" ? "running_command" : "tool_invocation";
    if (event.phase === "failed" || event.phase === "canceled") return "error";
    if (event.kind === "state") return event.phase === "completed" ? "worker_completed" : "worker_started";
    switch (event.stage) {
      case "validation":
        return "validation";
      case "integration":
        return "integration";
      case "review":
        return event.phase === "completed" ? "review_completed" : "review_started";
      case "process":
        return "running_command";
      default:
        return event.phase === "completed" ? "worker_completed" : "worker_started";
    }
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
    const task = this.store.getTask(taskId);
    const label = task?.objective ?? taskId;
    const workerId = this.taskExecutions.get(`${missionId}:${taskId}`) ?? taskId;
    if (obs && status === "SUCCEEDED") {
      obs.taskStarted(missionId, taskId, label);
      obs.taskCompleted(missionId, taskId, label);
      obs.workerCompleted(missionId, workerId);
      obs.activity(missionId, { type: "worker_completed", summary: "Task completed", workerId });
    } else if (obs && status === "FAILED") {
      obs.workerFailed(missionId, workerId);
      obs.activity(missionId, { type: "error", summary: "Task failed", workerId });
      obs.recordError(missionId, "task_failed", `task ${taskId} settled ${status}`);
    }
    this.taskExecutions.delete(`${missionId}:${taskId}`);
    this.observedExecutions.delete(workerId);
  }

  /**
   * Format a compact text progress bar (20 cells) from the active mission's
   * weighted-DAG progress. Empty when no mission is active. The percent is
   * computed deterministically from the mission DAG (never an LLM number).
   */
  private progressBar(missionId: string): string {
    const projection = this.observability?.projection(missionId);
    const mission = this.store.getMission(missionId);
    const pct =
      projection?.summary.progress.approximatePercent ??
      computeProgress({
        missionId,
        tasks: this.store.listTasks(missionId),
        missionStatus: mission?.status ?? "NEW",
        verifiedComplete: false,
        completionStatus: "",
      }).approximatePercent;
    if (!Number.isFinite(pct) || pct < 0) return "";
    const cells = Math.round(Math.min(100, pct) / 5);
    const filled = "#".repeat(cells);
    const empty = ".".repeat(20 - cells);
    return `[${filled}${empty}] ${Math.round(pct)}%`;
  }

  /** Emit a live progress line to the operator, appending the live progress bar. */
  private report(missionId: string, line: string): void {
    const bar = this.progressBar(missionId);
    try {
      this.progress.get(missionId)?.(bar ? `${line} ${bar}` : line);
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
      /** Cancels active work and stops any infrastructure-recovery wait. */
      signal?: AbortSignal;
    } = { repository: ".", baseRef: "" },
  ): Promise<OrchestrateResult> {
    const intent = this.router.route({
      request,
      changedFiles: opts.changedFiles,
      mutationRequested:
        opts.mutationRequested ?? workflowMutatesRepo(this.router.route({ request }).suggested_workflow),
    });
    const risk = this.router.risk({ request });
    const material = workflowMutatesRepo(intent.suggested_workflow) || opts.mutationRequested === true;
    let workspace: Awaited<ReturnType<WorkspaceManifestResolver["resolve"]>> | undefined;
    let workspaceError: WorkspaceScopeError | undefined;
    if (material && this.workspaceResolver && this.repositoryRegistry) {
      try {
        workspace = await this.workspaceResolver.resolve(request, this.launchCwd);
      } catch (error) {
        workspaceError =
          error instanceof WorkspaceScopeError
            ? error
            : new WorkspaceScopeError(error instanceof Error ? error.message : String(error));
      }
    }

    // Install the per-call progress hook for the duration of this mission so
    // task/phase transitions stream to the caller (e.g. the /mission command).
    try {
      opts.onProgress?.(`[mission] starting workflow=${intent.suggested_workflow} risk=${risk}`);
    } catch {
      // A progress listener is an observer, never a participant.
    }

    const primaryBinding = workspace?.repositories.find((repository) => repository.repoId === workspace?.primaryRepoId);
    let selectedBaseRef = primaryBinding?.baseSha ?? opts.baseRef;
    if (primaryBinding && opts.baseRef && !workspaceError) {
      const targetGit = await GitRepo.open(primaryBinding.canonicalRoot);
      const targetCommit = await targetGit?.resolveCommit(opts.baseRef);
      if (!targetCommit) {
        workspaceError = new WorkspaceScopeError(
          `Requested base ${opts.baseRef} does not belong to selected repository ${primaryBinding.canonicalRoot}`,
        );
      } else {
        selectedBaseRef = targetCommit;
      }
    }
    const mission = this.store.createMission({
      title: opts.title ?? request,
      goal: request,
      user_request: request,
      repository: primaryBinding?.canonicalRoot ?? opts.repository,
      base_ref: selectedBaseRef || "",
      constraints: opts.constraints ?? [],
      risk_profile: risk,
      workflow_class: intent.suggested_workflow,
      parent_session_id: this.parentSessionId,
    });
    if (opts.onProgress) this.progress.set(mission.mission_id, opts.onProgress);
    try {
      this.observability?.missionCreated(mission.mission_id, mission.title);
      this.store.transitionMission(mission.mission_id, "CLASSIFYING");

      if (workspaceError) {
        this.store.classifyFailure({
          classificationId: id("FC"),
          missionId: mission.mission_id,
          taskId: null,
          executionId: null,
          category: "WORKSPACE_SCOPE_MISMATCH",
          evidenceRefs: [],
          fingerprint: `workspace:${workspaceError.message}`,
          summary: workspaceError.message,
          classifiedAt: new Date().toISOString(),
        });
        this.store.transitionMission(mission.mission_id, "BLOCKED");
        const blocked = this.store.getMission(mission.mission_id)!;
        return {
          mission: blocked,
          intent,
          verdict: this.gate.evaluate(blocked),
          completed: false,
          failureReason: workspaceError.message,
        };
      }

      if (workspace && this.repositoryRegistry) {
        let probes: Awaited<ReturnType<RepositoryRegistry["probe"]>>;
        try {
          const manifest = createWorkspaceManifest(workspace, mission.mission_id);
          this.store.bindWorkspaceManifest(manifest);
          await this.store.flush();
          await this.repositoryRegistry.register(manifest);
          probes = await this.repositoryRegistry.probe(workspace.primaryRepoId);
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error);
          this.store.classifyFailure({
            classificationId: id("FC"),
            missionId: mission.mission_id,
            taskId: null,
            executionId: null,
            category: "WORKSPACE_SCOPE_MISMATCH",
            evidenceRefs: [],
            fingerprint: `workspace-preflight:${workspace.primaryRepoId}`,
            summary,
            classifiedAt: new Date().toISOString(),
          });
          this.store.transitionMission(mission.mission_id, "BLOCKED");
          const blocked = this.store.getMission(mission.mission_id)!;
          return {
            mission: blocked,
            intent,
            verdict: this.gate.evaluate(blocked),
            completed: false,
            failureReason: summary,
          };
        }
        const failed = probes.filter((probe) => !probe.ok);
        if (failed.length > 0 || probes.some((probe) => probe.repoId !== workspace.primaryRepoId)) {
          const summary = `Repository role preflight mismatch: ${failed
            .map((probe) => `${probe.role}: ${probe.reason ?? "binding mismatch"}`)
            .join("; ")}`;
          this.store.classifyFailure({
            classificationId: id("FC"),
            missionId: mission.mission_id,
            taskId: null,
            executionId: null,
            category: "WORKSPACE_SCOPE_MISMATCH",
            evidenceRefs: [],
            fingerprint: `workspace-probe:${workspace.primaryRepoId}`,
            summary,
            classifiedAt: new Date().toISOString(),
          });
          this.store.transitionMission(mission.mission_id, "BLOCKED");
          const blocked = this.store.getMission(mission.mission_id)!;
          return {
            mission: blocked,
            intent,
            verdict: this.gate.evaluate(blocked),
            completed: false,
            failureReason: summary,
          };
        }
        this.missionRepoIds.set(mission.mission_id, workspace.primaryRepoId);
        this.repositoryRegistry.activate(workspace.primaryRepoId);
      }

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
      const bindingDomains = this.store
        .getWorkspaceManifest(mission.mission_id)
        ?.repositories.find(
          (repository) => repository.repoId === this.repoIdForMission(mission.mission_id),
        )?.writableDomains;
      const scopedPlan = planned.map((task) => ({
        ...task,
        write_domains:
          task.mutates_repo && bindingDomains
            ? intersectWriteDomains(task.write_domains.length > 0 ? task.write_domains : ["**"], bindingDomains)
            : task.write_domains,
      }));
      if (scopedPlan.some((task) => task.mutates_repo && task.write_domains.length === 0)) {
        const summary = "Planner requested mutation outside the workspace manifest's writable domains";
        this.store.classifyFailure({
          classificationId: id("FC"),
          missionId: mission.mission_id,
          taskId: null,
          executionId: null,
          category: "WORKSPACE_SCOPE_MISMATCH",
          evidenceRefs: [],
          fingerprint: `workspace-plan:${this.repoIdForMission(mission.mission_id) ?? "none"}`,
          summary,
          classifiedAt: new Date().toISOString(),
        });
        this.store.transitionMission(mission.mission_id, "BLOCKED");
        const blocked = this.store.getMission(mission.mission_id)!;
        return {
          mission: blocked,
          intent,
          verdict: this.gate.evaluate(blocked),
          completed: false,
          failureReason: summary,
        };
      }
      for (const t of scopedPlan) {
        this.store.createTask({
          mission_id: mission.mission_id,
          ...t,
          ...(this.repoIdForMission(mission.mission_id) ? { repo_id: this.repoIdForMission(mission.mission_id) } : {}),
        });
      }
      this.store.transitionMission(mission.mission_id, "READY");

      // Schedule + execute.
      this.store.transitionMission(mission.mission_id, "EXECUTING");
      this.phase(this.store.getMission(mission.mission_id)!, "executing");
      await this.scheduler.runMission(mission.mission_id, opts.signal);

      if (opts.signal?.aborted) {
        const current = this.store.getMission(mission.mission_id)!;
        if (current.status !== "CANCELED") {
          if (canTransitionMission(current.status, "CANCELING")) {
            this.store.transitionMission(mission.mission_id, "CANCELING");
          }
          if (canTransitionMission(this.store.getMission(mission.mission_id)!.status, "CANCELED")) {
            this.store.transitionMission(mission.mission_id, "CANCELED");
          }
        }
        await this.broker.cleanupMission(mission.mission_id);
        const canceled = this.store.getMission(mission.mission_id)!;
        this.report(mission.mission_id, `[mission ${mission.mission_id}] canceled by caller`);
        return {
          mission: canceled,
          intent,
          verdict: this.gate.evaluate(canceled),
          completed: false,
          failureReason: "canceled by caller",
        };
      }

      // Auto-resume: a mission that paused because its retry window ran out
      // watches the recovery probe (with a real probe only) and resumes itself on
      // the first healthy answer, for up to auto_resume_horizon_ms after it first
      // paused. Resuming re-queues the paused tasks with a fresh window, so an
      // outage of many hours never turns into a failed mission.
      const resumeHorizon = this.scheduler.resilienceConfig.auto_resume_horizon_ms ?? 0;
      if (resumeHorizon > 0 && this.store.getMission(mission.mission_id)?.status === "PAUSED_INFRASTRUCTURE") {
        const deadline = this.scheduler.now() + resumeHorizon;
        while (
          this.store.getMission(mission.mission_id)?.status === "PAUSED_INFRASTRUCTURE" &&
          (await this.scheduler.awaitRecovery(deadline, opts.signal, mission.mission_id))
        ) {
          this.report(mission.mission_id, `[mission ${mission.mission_id}] gateway healthy again — resuming`);
          await this.scheduler.resumePausedMission(mission.mission_id, opts.signal);
        }
      }

      // Resilience: if a worker's transient-infrastructure retry window exhausted
      // mid-execution, the mission is PAUSED (not FAILED) with all progress
      // preserved. Do NOT proceed to integration/validation; return a paused
      // verdict so the caller can resume it when the gateway recovers.
      const pausedMission = this.store.getMission(mission.mission_id)!;
      if (pausedMission.status === "PAUSED_INFRASTRUCTURE") {
        this.report(
          mission.mission_id,
          `[mission ${mission.mission_id}] PAUSED: infrastructure retry window exhausted (auto-resume on recovery)`,
        );
        return {
          mission: pausedMission,
          intent,
          verdict: {
            can_complete: false,
            reasons: ["paused: infrastructure retry window exhausted"],
            missing_gates: [],
            unresolved_findings: 0,
            running_tasks: 0,
          },
          completed: false,
          failureReason: null,
          paused: true,
        };
      }

      const finalized = await this.finalizeMission(mission.mission_id, opts.signal);
      return { ...finalized, intent };
    } finally {
      this.progress.delete(mission.mission_id);
    }
  }

  /**
   * Resume a PAUSED_INFRASTRUCTURE mission once the gateway is healthy.
   *
   * A paused mission is not a failure: all progress is preserved and the
   * interrupted task is left resumable. This re-runs the paused task(s) when the
   * recovery probe reports the gateway healthy (or unconditionally with
   * `{ force: true }`), returning the updated mission. When the gateway is still
   * down the mission is left paused (call again on the next probe).
   */
  async resume(missionId: string, opts?: { force?: boolean; signal?: AbortSignal }): Promise<Mission> {
    this.activateMissionRepository(missionId);
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    if (mission.status !== "PAUSED_INFRASTRUCTURE") return mission;
    if (opts?.signal?.aborted) return this.cancelMission(missionId);
    if (!opts?.force && !(await this.scheduler.gatewayHealthy(opts?.signal))) {
      return opts?.signal?.aborted ? this.cancelMission(missionId) : mission;
    }
    this.phase(mission, "executing");
    this.report(missionId, `[mission ${missionId}] resuming after infrastructure recovery`);
    await this.scheduler.resumePausedMission(missionId, opts?.signal);
    const resumed = this.store.getMission(missionId)!;
    if (resumed.status === "PAUSED_INFRASTRUCTURE") return resumed;
    if (opts?.signal?.aborted) return this.cancelMission(missionId);
    return (await this.finalizeMission(missionId, opts?.signal)).mission;
  }

  /** Complete the lifecycle after scheduler work settles, whether initial or resumed. */
  private async finalizeMission(missionId: string, signal?: AbortSignal): Promise<FinalizationResult> {
    if (signal?.aborted) return this.canceledFinalization(missionId);
    // Post-execution: integrate, validate + review if the mission mutated or
    // requires gates. If integration did not land the change, the mission must
    // not complete — otherwise it reports success over an unchanged repository.
    let post = await this.postExecution(this.store.getMission(missionId)!, signal);
    if (signal?.aborted) return this.canceledFinalization(missionId);
    let integrated = post.integrationOk;

    // Completion gate, with bounded repair rounds (spec 07): a blocking reviewer
    // finding creates repair work, and the repaired result is re-validated and
    // re-reviewed before the gate is consulted again.
    let verdict = this.gate.evaluate(this.store.getMission(missionId)!);
    let repairRounds = 0;
    while ((!verdict.can_complete || !integrated) && repairRounds < this.maxRepairRounds) {
      if (signal?.aborted) return this.canceledFinalization(missionId);
      const openBlocking = this.store
        .listFindings(missionId)
        .filter((f) => f.severity === "blocking" && f.status === "open");
      const failedGates = this.store
        .listTasks(missionId)
        .filter(
          (t) =>
            (t.kind === "validation" || t.kind === "integration" || t.kind === "review") &&
            t.status === "FAILED" &&
            this.broker.hasBackend(t.kind as "validation" | "integration" | "review"),
        );
      if (openBlocking.length === 0 && failedGates.length === 0) break;
      repairRounds++;

      if (this.store.getMission(missionId)!.status !== "REPAIRING") {
        this.store.transitionMission(missionId, "REPAIRING");
      }
      this.phase(this.store.getMission(missionId)!, "repairing");
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
      const successfulMutations = this.store
        .listTasks(missionId)
        .filter((task) => task.mutates_repo && task.status === "SUCCEEDED");
      // Preserve an explicitly direct-checkout mission's execution model for
      // repairs. Otherwise a standalone orchestrator with no Git provider can
      // run the original task but its automatically-created repair fails before
      // the backend starts. Any mission that used (or mixed in) worktrees keeps
      // the safer isolated repair path.
      const repairIsolation =
        successfulMutations.length > 0 && successfulMutations.every((task) => task.isolation === "none")
          ? "none"
          : "worktree";
      for (const obj of objectives) {
        const repair = this.store.createTask({
          mission_id: missionId,
          kind: "agent",
          role: "implementer",
          objective: obj.objective,
          mutates_repo: true,
          write_domains: this.writableDomainsForMission(missionId),
          isolation: repairIsolation,
          repo_id: this.repoIdForMission(missionId),
        });
        this.store.transitionTask(repair.task_id, "READY");
        const repaired = await this.runSingleTask(missionId, repair.task_id, { signal });
        if (signal?.aborted) return this.canceledFinalization(missionId);
        if (repaired && obj.findingId) this.store.resolveFinding(obj.findingId);
      }
      post = await this.postExecution(this.store.getMission(missionId)!, signal);
      if (signal?.aborted) return this.canceledFinalization(missionId);
      integrated = post.integrationOk;
      if (post.reviewAttempted && !post.reviewOk) {
        verdict = this.gate.evaluate(this.store.getMission(missionId)!);
        break;
      }
      verdict = this.gate.evaluate(this.store.getMission(missionId)!);
    }

    await this.broker.cleanupMission(missionId, { keepBranches: !integrated });
    if (!integrated) {
      const preserved = this.broker.preservedBranches(missionId);
      if (preserved.length > 0) {
        this.store.addFinding({
          mission_id: missionId,
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

    const finalMission = this.store.getMission(missionId)!;
    if (verdict.can_complete && integrated) {
      const pre = finalMission.status;
      if (pre !== "FINAL_VALIDATION" && pre !== "REVIEWING") {
        this.store.transitionMission(missionId, "FINAL_VALIDATION");
      }
      this.observeGatePassed(missionId);
      for (const taskId of verdict.superseded_by_recovery ?? []) {
        this.store.addFinding({
          mission_id: missionId,
          task_id: taskId,
          severity: "minor",
          category: "integration",
          file: null,
          line: null,
          summary: `FAILED status of task ${taskId} superseded by recovery: its commits were merged after a wall-clock timeout, then validated and reviewed for completeness`,
          evidence: null,
          recommended_action: "None required; recorded so the completion over a failed task is auditable.",
        });
      }
      this.store.completeMission(missionId);
      this.phase(this.store.getMission(missionId)!, "complete");
      return {
        mission: this.store.getMission(missionId)!,
        verdict,
        completed: true,
        failureReason: null,
      };
    }

    const unresolvedBlocking = this.store
      .listFindings(missionId)
      .filter((f) => f.severity === "blocking" && f.status !== "resolved").length;
    const hasBlocking =
      unresolvedBlocking > 0 || (finalMission.required_gates.length > 0 && verdict.reasons.length > 0);
    if (hasBlocking) {
      if (finalMission.status !== "BLOCKED") this.store.transitionMission(missionId, "BLOCKED");
    } else {
      this.store.failMission(missionId, verdict.reasons.join("; "));
    }
    const stopped = this.store.getMission(missionId)!;
    const reason = verdict.reasons.join("; ") || "completion requirements were not satisfied";
    const summary = `Mission ${stopped.status.toLowerCase()}: ${reason}. No workers remain active.`;
    this.observability?.clearWaiting(missionId);
    this.observability?.activity(missionId, { type: "error", summary, meaningfulProgress: true });
    this.report(missionId, `[mission ${missionId}] ${summary}`);
    return {
      mission: stopped,
      verdict,
      completed: false,
      failureReason: reason,
    };
  }

  /**
   * Post-execution validation + review, respecting required gates. Reports
   * whether each stage was attempted and whether it succeeded, so the caller
   * can refuse to complete when a mandatory re-review did not actually run.
   */
  private async postExecution(
    mission: Mission,
    signal?: AbortSignal,
  ): Promise<{
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
        write_domains: this.writableDomainsForMission(mission.mission_id),
        isolation: "none",
        repo_id: this.repoIdForMission(mission.mission_id),
      });
      this.store.transitionTask(integ.task_id, "READY");
      integrationOk = await this.runSingleTask(mission.mission_id, integ.task_id, { signal });
      if (signal?.aborted) {
        return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk: false };
      }
      // A green merge is not proof the work landed: harvesting a worktree can
      // fail silently, and merging an empty branch is trivially clean. Require
      // the checkout to actually differ from the mission's base commit.
      if (integrationOk) {
        const landed = await this.broker.changedFilesSinceBase(mission.mission_id);
        if (landed !== null && landed.length === 0) {
          integrationOk = false;
          // Distinguish a genuinely empty worker branch (tip == base, no edits)
          // from a merge/harvest bug where committed work exists on a branch but
          // did not reach the checkout. The first is an implementer that produced
          // nothing; the second is a pipeline defect and must not be reported as
          // "the workers produced no work" — that would hide a lost integration.
          const committed = this.broker.hasCommittedWorkerWork(mission.mission_id);
          this.store.addFinding({
            mission_id: mission.mission_id,
            task_id: integ.task_id,
            severity: "blocking",
            category: "integration",
            file: null,
            line: null,
            summary: committed
              ? "Integration merged but the base checkout is unchanged despite committed worker work — a merge/harvest bug; the worker branches are preserved and must be inspected"
              : "Integration produced no change: the worker branches held no committed work",
            evidence: null,
            recommended_action: committed
              ? "Inspect the preserved worker branches (git branch | grep pi-eng-orch) and the merge result; the worker's committed work must be recovered and integrated manually."
              : "The implementer must actually edit files; harvested worktrees were empty.",
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
        repo_id: this.repoIdForMission(mission.mission_id),
      });
      this.store.transitionTask(task.task_id, "READY");
      validationAttempted = true;
      validationOk = await this.runSingleTask(mission.mission_id, task.task_id, { signal });
      if (signal?.aborted) {
        return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk };
      }
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
      // Work recovered from a timed-out worker was committed before the worker
      // finished: a green build and a generic review can both miss that only
      // part of its objective was done. Name each recovered task and its
      // objective in the review request; the completion gate counts only a
      // review that carried this note (see CompletionGate.gather).
      const recovered = this.recoveredTasks(mission.mission_id);
      const recoveryNote = recovered
        .map(
          (t) =>
            `\n\nRecovered work — verify task ${t.task_id} objective is fully met (its commits were recovered after a wall-clock timeout, so it may be incomplete; report a blocking finding for anything missing). Objective: ${t.objective}`,
        )
        .join("");
      const task = this.store.createTask({
        mission_id: mission.mission_id,
        kind: "review",
        role,
        objective: `Fresh independent review of the integrated change. Mission: ${mission.goal}${recoveryNote}`,
        mutates_repo: false,
        isolation: "none",
        depends_on: this.lastValidationTaskId(mission.mission_id),
        repo_id: this.repoIdForMission(mission.mission_id),
      });
      this.store.transitionTask(task.task_id, "READY");
      reviewAttempted = true;
      reviewOk = await this.runSingleTask(mission.mission_id, task.task_id, {
        reviewedRecovered: recovered.map((t) => t.task_id),
        signal,
      });
      if (signal?.aborted) {
        return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk };
      }
      // From REVIEWING the mission moves to final validation (or repair handled
      // by the caller via the completion gate).
      this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
    }
    return { validationAttempted, validationOk, reviewAttempted, reviewOk, integrationOk };
  }

  /** Tasks whose recovered commits a SUCCEEDED integration merged (broker evidence). */
  private recoveredTasks(missionId: string): OrchestrationTask[] {
    const ids = new Set(
      this.store
        .listExecutions(missionId)
        .filter((e) => e.backend === "integration" && e.status === "SUCCEEDED")
        .flatMap((e) => (e.recovered_merged ?? []).map((r) => r.task_id)),
    );
    return [...ids].map((id) => this.store.getTask(id)).filter((t): t is OrchestrationTask => t !== undefined);
  }

  private writableDomainsForMission(missionId: string): string[] {
    const repoId = this.repoIdForMission(missionId);
    return (
      this.store
        .getWorkspaceManifest(missionId)
        ?.repositories.find((repository) => repository.repoId === repoId)
        ?.writableDomains.slice() ?? ["**"]
    );
  }

  private lastValidationTaskId(missionId: string): string[] {
    return this.store
      .listTasks(missionId)
      .filter((t) => t.kind === "validation")
      .map((t) => t.task_id);
  }

  /** Run one task to settlement. Returns true iff it reached SUCCEEDED. */
  private async runSingleTask(
    missionId: string,
    taskId: string,
    extra: { reviewedRecovered?: string[]; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const task = this.store.getTask(taskId)!;
    this.store.transitionTask(taskId, "RUNNING");
    this.report(
      missionId,
      `[mission ${missionId}] ${task.kind}:${task.role} starting — ${task.objective.slice(0, 120)}`,
    );
    try {
      // execute() itself can throw — e.g. no backend is registered for the task
      // kind. Left outside the try it propagated out of postExecution and
      // orchestrate and left the mission stranded in INTEGRATING / VALIDATING /
      // REVIEWING. The scheduler path was hardened the same way; this one was not.
      const handle = await this.broker.execute({
        taskId,
        missionId,
        repoId: task.repo_id,
        kind: brokerKind(task.kind),
        role: task.role,
        objective: task.objective,
        mutatesRepo: task.mutates_repo,
        writeDomains: task.write_domains,
        isolation: task.isolation,
        modelRequirements: task.execution_requirements,
        ...(extra.reviewedRecovered?.length ? { reviewedRecovered: extra.reviewedRecovered } : {}),
      });
      const onAbort = (): void => {
        void handle.cancel();
      };
      if (extra.signal?.aborted) await handle.cancel();
      else extra.signal?.addEventListener("abort", onAbort, { once: true });
      const outcome = await handle.result().finally(() => extra.signal?.removeEventListener("abort", onAbort));
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
        // Include the worker's own result summary so failures are diagnosable
        // from the event log (guard aborts, budgets, timeouts otherwise vanish).
        const detail = outcome.summary ? `: ${outcome.summary}` : "";
        this.store.transitionTask(taskId, "FAILED", "system", {
          failure_reason: `${outcome.exitStatus}${detail}`,
        });
        this.report(
          missionId,
          `[mission ${missionId}] ${task.kind}:${task.role} FAILED (${outcome.exitStatus}${detail})`,
        );
        return false;
      }
      this.store.transitionTask(taskId, "SUCCEEDED");
      this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} succeeded`);
      return true;
    } catch (err) {
      if (extra.signal?.aborted) {
        await this.broker.cancelByTask(taskId);
        if (this.store.getTask(taskId)?.status === "RUNNING") this.store.transitionTask(taskId, "CANCELED");
        this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} canceled`);
        return false;
      }
      if (this.store.getTask(taskId)?.status === "RUNNING") this.store.transitionTask(taskId, "FAILED");
      this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} errored`);
      return false;
    }
  }

  /** Settle a caller-aborted mission without allowing later gate work to run. */
  private async cancelMission(missionId: string): Promise<Mission> {
    let mission = this.store.getMission(missionId)!;
    if (mission.status === "CANCELED") return mission;
    if (canTransitionMission(mission.status, "CANCELING")) {
      mission = this.store.transitionMission(missionId, "CANCELING");
    }
    if (canTransitionMission(mission.status, "CANCELED")) {
      mission = this.store.transitionMission(missionId, "CANCELED");
    }
    await this.broker.cleanupMission(missionId);
    this.report(missionId, `[mission ${missionId}] canceled by caller`);
    return mission;
  }

  private async canceledFinalization(missionId: string): Promise<FinalizationResult> {
    const mission = await this.cancelMission(missionId);
    return {
      mission,
      verdict: this.gate.evaluate(mission),
      completed: false,
      failureReason: "canceled by caller",
    };
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

function intersectWriteDomains(requested: string[], authorized: string[]): string[] {
  const intersection = new Set<string>();
  const contains = (outer: string, inner: string): boolean => {
    if (outer === "**") return true;
    if (outer === inner) return true;
    if (!outer.endsWith("/**")) return false;
    const prefix = outer.slice(0, -3).replace(/\/$/, "");
    return inner === prefix || inner.startsWith(`${prefix}/`);
  };
  for (const request of requested) {
    for (const allow of authorized) {
      if (contains(request, allow)) intersection.add(allow);
      else if (contains(allow, request)) intersection.add(request);
    }
  }
  return [...intersection];
}
