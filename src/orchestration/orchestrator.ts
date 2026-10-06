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

import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { id } from "../core/ids.ts";
import { GitRepo } from "../git/GitRepo.ts";
import type { EventStoreBackend } from "../platform/eventstore/backend.ts";
import type { GatewayResilienceConfig } from "../resilience/config.ts";
import type { RecoveryProbe } from "../resilience/probe.ts";
import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import { type BrokerBackends, ExecutionBroker } from "./broker.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { CompletionGate } from "./completionGate.ts";
import { hashCandidateEvidenceIdentity, normalizeReviewSeverity, taskCoverageFingerprint } from "./evidence.ts";
import { IntentRouter, workflowMutatesRepo } from "./intentRouter.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";
import { computeProgress } from "./observability/progress.ts";
import type { ActivityType, WaitingReason } from "./observability/types.ts";
import type { DispatchAuthority, MissionOwnership } from "./ownership.ts";
import { deriveRequiredGates, mutationFactFromChangedFiles } from "./policies.ts";
import {
  FailureClassifier,
  RecoveryPlanner,
  type RecoveryPlannerOptions,
  replacementRecoveryFingerprint,
  replacementTaskFingerprintSpec,
} from "./recovery.ts";
import type { RepositoryRegistry } from "./repositoryRegistry.ts";
import { brokerKind } from "./scheduler.ts";
import { MissionScheduler } from "./scheduler.ts";
import type { ProtectedUserCriteria, SpecControllerResult, SpecScopeEnvelope } from "./specApproval.ts";
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
import {
  DEFAULT_WORKSET_POLICY,
  type WorksetPolicy,
  WorksetValidationError,
  canonicalizeWriteDomain,
  splitWorksetDeliverables,
  validateWorkset,
} from "./workset.ts";
import { WorkspaceManifestResolver, WorkspaceScopeError, createWorkspaceManifest } from "./workspaceManifest.ts";

/** Effective autonomous-spec-approval policy version bound into every approval. */
const SPEC_APPROVAL_POLICY_VERSION = "spec-approval-policy-v1";

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
  | "task_id"
> & { task_id?: string };

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
  limits?: {
    maxActive?: number;
    maxAgents?: number;
    maxSubprocesses?: number;
    maxPerRole?: number;
  };
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
  /** Artifact authority used to validate checkpoint evidence references. */
  artifacts?: Pick<ArtifactStore, "readContentByUri" | "putImmutable" | "verifyAndDispatch">;
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
  /** Durable controller authority renewed immediately before worker dispatch. */
  ownership?: MissionOwnership;
  /** Bounds planner work before the first executable dispatch. */
  worksetPolicy?: Partial<WorksetPolicy>;
  /**
   * Time limits. Nothing here is a default duration cap: a mission and its
   * tasks run as long as they show activity, and only the caller's signal
   * (the user cancelling) ends a healthy mission early.
   */
  timeLimits?: {
    /** Hung-worker window: abort a worker after this long with no activity. */
    workerInactivityMs?: number;
    /** OPT-IN: cancel the whole mission after this much wall-clock time. */
    maxMissionWallClockMs?: number;
    /** Whether the process is waiting on the model gateway (never a stall). */
    inferenceWaiting?: () => boolean;
  };
  /**
   * Autonomous spec approval hook (design 2026-09-28). When provided and the
   * routed workflow is a material mutation, the orchestrator runs the durable
   * spec controller to review + approve the exact plan and materializes tasks
   * ONLY from the current approval before dispatch. Defaults to off so the
   * existing fast path is preserved for non-material workflows and legacy runs.
   */
  specApproval?: (input: {
    missionId: string;
    protectedInputs: ProtectedUserCriteria;
    acceptanceIds: string[];
    envelope: SpecScopeEnvelope;
  }) => Promise<SpecControllerResult>;
  /** Durable mission-wide recovery budget shared by retries and blocked repair. */
  recovery?: RecoveryPlannerOptions;
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

export interface OrchestrateOptions {
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
  /** Per-mission progress hooks; missions may overlap on one orchestrator. */
  private readonly progress = new Map<string, (line: string) => void>();
  private readonly observedExecutions = new Set<string>();
  private readonly taskExecutions = new Map<string, string>();
  private readonly workspaceResolver?: WorkspaceManifestResolver;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly launchCwd: string;
  private readonly ownership?: MissionOwnership;
  private readonly ownershipByMission = new Map<string, import("./types.ts").MissionLease>();
  private readonly recoveryOwnershipByFlight = new Map<string, import("./types.ts").MissionLease>();
  private readonly recoveryTaskGenerations = new Map<string, number>();
  private readonly missionRepoIds = new Map<string, string>();
  private readonly worksetPolicy: WorksetPolicy;
  private readonly maxMissionWallClockMs?: number;
  private readonly specApproval?: OrchestratorOptions["specApproval"];
  private readonly recoveryPlanner: RecoveryPlanner;
  private readonly failureClassifier = new FailureClassifier();
  private readonly blockedRepairFlights = new Map<string, Promise<Mission>>();

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.ownership = opts.ownership;
    this.router = opts.router ?? new IntentRouter();
    this.limits = opts.limits ?? {};
    this.maxRepairRounds = opts.maxRepairRounds ?? 2;
    this.worksetPolicy = { ...DEFAULT_WORKSET_POLICY, ...opts.worksetPolicy };
    this.maxMissionWallClockMs = opts.timeLimits?.maxMissionWallClockMs;
    this.specApproval = opts.specApproval;
    this.recoveryPlanner = new RecoveryPlanner(opts.recovery);
    const checkpoints = new CheckpointManager({ store: this.store });
    this.broker = new ExecutionBroker({
      store: this.store,
      backends: opts.backends,
      git: opts.git ?? null,
      resolveRepository: opts.repositoryRegistry
        ? async (repoId, writableDomains, missionId) => {
            const manifest = this.store.getWorkspaceManifest(missionId);
            if (!manifest) throw new Error(`WORKSPACE_SCOPE_MISMATCH: mission ${missionId} has no active manifest`);
            const context = await opts.repositoryRegistry!.resolveForExecution(
              missionId,
              manifest.generation,
              manifest.hash,
              repoId,
              writableDomains,
            );
            return {
              repoId: context.repoId,
              root: context.root,
              git: context.git,
            };
          }
        : undefined,
      baseRef: opts.baseRef ?? "",
      onActivity: (event) => this.observeWorkerActivity(event),
      checkpoints,
      artifacts: opts.artifacts,
      ...(opts.timeLimits?.workerInactivityMs !== undefined
        ? { inactivityTimeoutMs: opts.timeLimits.workerInactivityMs }
        : {}),
      ...(opts.timeLimits?.inferenceWaiting ? { inferenceWaiting: opts.timeLimits.inferenceWaiting } : {}),
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
      acquireAuthority: this.ownership ? (task) => this.acquireTaskAuthority(task) : undefined,
      recovery: opts.recovery,
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
    this.workspaceResolver = opts.workspaceResolver ?? new WorkspaceManifestResolver();
    this.repositoryRegistry = opts.repositoryRegistry;
    this.launchCwd = opts.launchCwd ?? ".";
  }

  /**
   * Repair one durable BLOCKED episode. Every material side effect is preceded
   * by its durable recovery plan, and replay observes the existing episode
   * instead of creating duplicate replacement work.
   */
  async repairBlockedMission(missionId: string, signal?: AbortSignal): Promise<Mission> {
    const resumptionGeneration = this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    const flightKey = `${missionId}:${resumptionGeneration}`;
    const active = this.blockedRepairFlights.get(flightKey);
    if (active) return active;
    const flight = this.performBlockedMissionRepair(missionId, resumptionGeneration, signal);
    this.blockedRepairFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.blockedRepairFlights.get(flightKey) === flight) this.blockedRepairFlights.delete(flightKey);
    }
  }

  private assertRecoveryGeneration(missionId: string, expected: number): void {
    const current = this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (current !== expected) throw new Error(`STALE_RECOVERY_GENERATION: expected ${expected}, current ${current}`);
  }

  private async performBlockedMissionRepair(
    missionId: string,
    expectedResumptionGeneration: number,
    signal?: AbortSignal,
  ): Promise<Mission> {
    await this.activateMissionRepository(missionId);
    this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) {
      for (const decision of this.store
        .listRecoveryDecisions(missionId)
        .filter((entry) => entry.status === "started")) {
        this.store.transitionRecovery(decision.recoveryId, mission.status === "COMPLETE" ? "succeeded" : "failed");
      }
      await this.store.flush();
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      return this.store.getMission(missionId)!;
    }
    if (mission.status !== "BLOCKED" && mission.status !== "REPAIRING") return mission;
    const blockedEpisodeId = mission.blocked_episode_id;
    const priorStop = this.store.listMissionStops(missionId).at(-1);
    const priorResumption = this.store.listMissionResumptions(missionId).at(-1);
    if (priorStop && (!priorResumption || priorResumption.stopGeneration < priorStop.generation)) return mission;

    let acquiredLease: Awaited<ReturnType<MissionOwnership["acquire"]>> | undefined;
    const recoveryLeaseKey = `${missionId}:${expectedResumptionGeneration}`;
    if (this.ownership) {
      acquiredLease = await this.ownership.acquire(missionId, {
        resumptionGeneration: expectedResumptionGeneration,
      });
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      this.recoveryOwnershipByFlight.set(recoveryLeaseKey, acquiredLease);
    }
    try {
      await this.broker.cancelStaleResumptionExecutions(missionId, expectedResumptionGeneration);
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const repositoryDiagnostics = await this.broker.durableRepositoryDiagnostics(missionId);
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      if (repositoryDiagnostics.length > 0) {
        for (const diagnostic of repositoryDiagnostics) {
          this.store.addFinding({
            mission_id: missionId,
            task_id: null,
            severity: "blocking",
            category: "persistence",
            file: diagnostic.file || null,
            line: null,
            summary: `Corrupt durable ${diagnostic.recordKind} record for ${diagnostic.repoId}`,
            evidence: diagnostic.reason,
            recommended_action: "Repair or quarantine the named durable record before mission recovery.",
          });
        }
        this.store.stopMission(missionId, {
          reason: "durable repository recovery records failed canonical identity validation",
          preservedWork: this.store
            .listTaskCheckpoints(missionId)
            .flatMap((checkpoint) => [checkpoint.worktree, checkpoint.branch])
            .filter((value): value is string => !!value?.trim()),
          attemptedRecoveries: [],
          resumeCondition: "repair or quarantine every reported durable repository record",
        });
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }
      const reconciledOrphans = this.store.reconcileOrphanedExecutions(missionId);
      await this.store.flush();
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const classifications = this.store.listFailureClassifications(missionId);
      const classification = classifications.at(-1);
      if (!classification) throw new Error(`blocked mission ${missionId} has no durable failure classification`);
      const resumptionGeneration = this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const recoveryStartRecord = this.store.getCandidate(missionId);
      const verifiedRecoveryStart = recoveryStartRecord ? await this.broker.verifiedCandidateContent(missionId) : null;
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const recoveryStartCandidate = recoveryStartRecord?.identityHash ?? null;
      const recoveryStartContent = verifiedRecoveryStart
        ? {
            candidateSha: verifiedRecoveryStart.candidateSha,
            diffHash: verifiedRecoveryStart.diffHash,
          }
        : null;
      for (const stale of this.store
        .listRecoveryDecisions(missionId)
        .filter((entry) => entry.status === "started" && (entry.resumptionGeneration ?? 0) !== resumptionGeneration)) {
        this.store.transitionRecovery(stale.recoveryId, "failed");
      }
      let repairDecision = this.store
        .listRecoveryDecisions(missionId)
        .find(
          (entry) =>
            entry.blockedEpisodeId === blockedEpisodeId &&
            (entry.resumptionGeneration ?? 0) === resumptionGeneration &&
            (entry.status === "planned" || entry.status === "started"),
        );
      if (!repairDecision) {
        const history = this.store.listRecoveryDecisions(missionId);
        const choice = this.recoveryPlanner.decide({
          classification,
          history,
          now: this.scheduler.now(),
          resumptionGeneration,
        });

        if (choice.action === "STOP") {
          const existing = this.store.getRecoveryDecision(choice.recoveryId);
          const decision = existing ?? this.store.planRecovery(choice);
          await this.store.flush();
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          if (decision.status === "planned") this.store.transitionRecovery(decision.recoveryId, "exhausted");
          const attemptedRecoveries = history.map((entry) => entry.recoveryId);
          const preservedWork = await this.preservedMissionWork(missionId);
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          this.store.stopMission(missionId, {
            reason: choice.expectedMaterialChange,
            preservedWork,
            attemptedRecoveries,
            resumeCondition: "provide new material evidence or increase the approved recovery budget",
          });
          await this.store.flush();
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          return this.store.getMission(missionId)!;
        }

        repairDecision = this.store.planRecovery({
          ...choice,
          startingCandidateIdentityHash: recoveryStartCandidate,
          startingCandidateContent: recoveryStartContent,
        });
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      }

      if (repairDecision.action === "WAIT_FOR_REQUIREMENT") {
        if (repairDecision.status === "planned") this.store.transitionRecovery(repairDecision.recoveryId, "started");
        if (this.store.getMission(missionId)?.status === "BLOCKED") {
          this.store.transitionMission(missionId, "WAITING_FOR_USER");
        }
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }
      if (repairDecision.action === "CREATE_REPAIR_TASKS" && !repairDecision.startingCandidateContent) {
        if (repairDecision.status === "planned") this.store.transitionRecovery(repairDecision.recoveryId, "failed");
        this.store.addFinding({
          mission_id: missionId,
          task_id: classification.taskId,
          severity: "blocking",
          category: "recovery_candidate_baseline",
          file: null,
          line: null,
          summary: "Gate repair requires an independently Git-verified current candidate.",
          evidence: repairDecision.recoveryId,
          recommended_action: "Reconstruct the current candidate from Git before dispatching repair work.",
        });
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }
      if (repairDecision.action === "PAUSE_FOR_PERSISTENCE" || repairDecision.action === "PROBE_AND_BACKOFF") {
        if (repairDecision.status === "planned") this.store.transitionRecovery(repairDecision.recoveryId, "started");
        const preservedWork = await this.preservedMissionWork(missionId);
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        this.store.stopMission(missionId, {
          reason: repairDecision.expectedMaterialChange,
          preservedWork,
          attemptedRecoveries: [repairDecision.recoveryId],
          resumeCondition:
            repairDecision.action === "PAUSE_FOR_PERSISTENCE"
              ? "durable writes must succeed and persistence diagnostics must clear"
              : repairDecision.deadline
                ? `a healthy provider probe must succeed before ${repairDecision.deadline}`
                : "a healthy provider probe must succeed (no deadline: the mission waits for capacity)",
        });
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }

      const manifestGenerationBefore = this.store.getWorkspaceManifest(missionId)?.generation;
      if (repairDecision.action === "REBUILD_WORKSPACE_MANIFEST") {
        try {
          const current = this.store.getWorkspaceManifest(missionId);
          const resolved = this.repositoryRegistry
            ? await this.workspaceResolver!.resolve(mission.user_request, this.launchCwd)
            : await this.workspaceResolver!.resolveRepository(mission.repository);
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          const rebuilt = createWorkspaceManifest(resolved, missionId, (current?.generation ?? 0) + 1);
          if (this.repositoryRegistry) {
            const staged = await this.repositoryRegistry.stage(rebuilt);
            this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
            const probes = await staged.probe(resolved.primaryRepoId);
            this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
            if (probes.some((probe) => !probe.ok)) throw new Error("rebuilt workspace manifest failed role probes");
            await this.store.bindWorkspaceManifestDurably(
              rebuilt,
              current ? { generation: current.generation, hash: current.hash } : null,
            );
            this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
            try {
              staged.activate();
            } catch {
              await this.repositoryRegistry.ensureActive(rebuilt, resolved.primaryRepoId);
              this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
            }
          } else {
            await this.store.bindWorkspaceManifestDurably(
              rebuilt,
              current ? { generation: current.generation, hash: current.hash } : null,
            );
            this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          }
          this.missionRepoIds.set(missionId, resolved.primaryRepoId);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("STALE_RECOVERY_GENERATION")) throw error;
          const summary = `workspace manifest rebuild failed: ${error instanceof Error ? error.message : String(error)}`;
          this.store.addFinding({
            mission_id: missionId,
            task_id: classification.taskId,
            severity: "blocking",
            category: "workspace_manifest_rebuild",
            file: null,
            line: null,
            summary,
            evidence: repairDecision.recoveryId,
            recommended_action: "Correct the repository binding or role probe failure before resuming recovery.",
          });
          if (repairDecision.status === "planned") this.store.transitionRecovery(repairDecision.recoveryId, "failed");
          await this.store.flush();
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          return this.store.getMission(missionId)!;
        }
      }

      const invalidationsBefore = this.store.listEvidenceInvalidations(missionId).length;
      const candidateIdentityBefore =
        repairDecision.startingCandidateIdentityHash !== undefined
          ? repairDecision.startingCandidateIdentityHash
          : recoveryStartCandidate;

      const unresolvedFailedTasks = this.store
        .listTasks(missionId)
        .filter(
          (task) =>
            task.status === "FAILED" &&
            !this.store.listTaskSupersessions(missionId).some((lineage) => lineage.failedTaskId === task.task_id),
        );
      const actionTaskId = classification.taskId;
      const failedTasks = unresolvedFailedTasks.filter((task) => {
        switch (repairDecision.action) {
          case "CHECKPOINT_SPLIT_AND_REPLACE":
          case "REPAIR_WORKER_OUTPUT":
          case "FENCE_RECONCILE_AND_RESUME":
            return actionTaskId ? task.task_id === actionTaskId : false;
          case "REBUILD_INTEGRATION_CANDIDATE":
            return task.kind === "integration" && (!actionTaskId || task.task_id === actionTaskId);
          case "CREATE_REPAIR_TASKS":
            return (
              ["validation", "review", "agent"].includes(task.kind) && (!actionTaskId || task.task_id === actionTaskId)
            );
          case "REBUILD_WORKSPACE_MANIFEST":
          case "REPAIR_BLOCKED_MISSION":
            return true;
          case "RECONSTRUCT_EVIDENCE":
            return false;
          default:
            return false;
        }
      });
      const importsCheckpoint = [
        "CHECKPOINT_SPLIT_AND_REPLACE",
        "REPAIR_WORKER_OUTPUT",
        "FENCE_RECONCILE_AND_RESUME",
        "REPAIR_BLOCKED_MISSION",
      ].includes(repairDecision.action);
      for (const failed of failedTasks) {
        const checkpoint = importsCheckpoint
          ? this.store.listTaskCheckpoints(missionId, failed.task_id).at(-1)
          : undefined;
        try {
          if (!checkpoint && repairDecision.action === "CHECKPOINT_SPLIT_AND_REPLACE") {
            throw new Error("checkpoint repair identity/integrity mismatch: durable checkpoint is missing");
          }
          if (!checkpoint) continue;
          this.assertRepairCheckpoint(failed, checkpoint);
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error);
          this.store.addFinding({
            mission_id: missionId,
            task_id: failed.task_id,
            severity: "blocking",
            category: "checkpoint_integrity",
            file: checkpoint?.worktree ?? null,
            line: null,
            summary,
            evidence: checkpoint?.checkpointId ?? null,
            recommended_action: "Reconcile the exact checkpoint origin and preserved work before retrying recovery.",
          });
          if (repairDecision.status === "planned") this.store.transitionRecovery(repairDecision.recoveryId, "failed");
          const preservedWork = await this.preservedMissionWork(missionId);
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          this.store.stopMission(missionId, {
            reason: summary,
            preservedWork,
            attemptedRecoveries: [repairDecision.recoveryId],
            resumeCondition:
              "a canonical checkpoint with matching execution, generation, repository, and artifacts is required",
          });
          await this.store.flush();
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          return this.store.getMission(missionId)!;
        }
      }
      for (const failed of failedTasks) {
        const checkpoint = importsCheckpoint
          ? this.store.listTaskCheckpoints(missionId, failed.task_id).at(-1)
          : undefined;
        const remaining = checkpoint?.remainingDeliverables.length
          ? checkpoint.remainingDeliverables
          : (failed.deliverables ?? []).length
            ? (failed.deliverables ?? [])
            : [failed.objective];
        const supersessionId = `${repairDecision.recoveryId}-SUP-${failed.task_id}`;
        const replacementFingerprints: Record<string, string> = {};
        const replacementTaskIds = remaining.map(
          (_deliverable, index) => `${repairDecision.recoveryId}-TSK-${failed.task_id}-${index + 1}`,
        );
        const lineageFingerprintSpec = {
          supersessionId,
          failedTaskId: failed.task_id,
          repoId: failed.repo_id ?? "",
          acceptanceIds: [...(failed.acceptance_ids ?? [])],
          coverageFingerprint: taskCoverageFingerprint(failed),
          replacementTaskIds,
        };
        const replacements = remaining.map((deliverable, index) => {
          const replacementId = replacementTaskIds[index]!;
          const createsRepair = repairDecision.action === "CREATE_REPAIR_TASKS";
          const role = createsRepair ? "implementer" : failed.role;
          const mutatesRepo = createsRepair ? true : failed.mutates_repo;
          const replacementSpec = replacementTaskFingerprintSpec({
            task_id: replacementId,
            mission_id: missionId,
            kind: createsRepair ? "agent" : failed.kind,
            role,
            objective: createsRepair
              ? `Repair the repository defect exposed by ${failed.kind}: ${failed.objective}. Then leave the candidate ready for fresh gates.`
              : `Recover ${failed.objective}: complete remaining deliverable ${deliverable}`,
            depends_on: [...failed.depends_on],
            priority: failed.priority,
            mutates_repo: mutatesRepo,
            write_domains: createsRepair ? this.writableDomainsForMission(missionId) : [...failed.write_domains],
            isolation: createsRepair ? "worktree" : failed.isolation,
            execution_requirements: { ...failed.execution_requirements },
            max_attempts: 1,
            failure_policy: "block",
            repo_id: failed.repo_id,
            acceptance_ids: [...(failed.acceptance_ids ?? [])],
            deliverables: [deliverable],
            // A wall-clock budget is inherited only while limits are configured:
            // tasks planned under the retired implicit 30-minute default must
            // not pass that clock on to the work that recovers them.
            execution_budget_ms:
              this.worksetPolicy.maxTaskBudgetMs === undefined ? undefined : failed.execution_budget_ms,
            checkpoint_policy: failed.checkpoint_policy,
            required_output_artifacts: [...(failed.required_output_artifacts ?? [])],
            candidate_generation: (failed.candidate_generation ?? 0) + index + 1,
            repair_base_candidate_sha: createsRepair
              ? (repairDecision.startingCandidateContent?.candidateSha ?? undefined)
              : undefined,
          });
          const manifest = this.store.getWorkspaceManifest(missionId);
          const fingerprint = replacementRecoveryFingerprint({
            decision: repairDecision,
            lineage: lineageFingerprintSpec,
            replacement: replacementSpec,
            manifest: manifest!,
            checkpoint: checkpoint ?? null,
          });
          replacementFingerprints[replacementId] = fingerprint;
          const existing = this.store.getTask(replacementId);
          if (existing) {
            this.recoveryTaskGenerations.set(existing.task_id, expectedResumptionGeneration);
            const existingFingerprint = manifest
              ? replacementRecoveryFingerprint({
                  decision: repairDecision,
                  lineage: lineageFingerprintSpec,
                  replacement: replacementTaskFingerprintSpec(existing),
                  manifest,
                  checkpoint: checkpoint ?? null,
                })
              : "";
            const exact =
              existingFingerprint === fingerprint &&
              existing.replacement_spec_fingerprint === fingerprint &&
              (!checkpoint ||
                (existing.recovery_authority?.expectedReplacementFingerprint === fingerprint &&
                  existing.recovery_authority?.recoveryDecisionId === repairDecision.recoveryId &&
                  existing.recovery_authority?.checkpointId === checkpoint.checkpointId &&
                  existing.recovery_authority?.supersessionId === supersessionId));
            if (!exact) throw new Error(`replacement replay fingerprint/full-spec mismatch: ${replacementId}`);
            return existing;
          }
          const created = this.store.createTask({
            ...replacementSpec,
            replacement_spec_fingerprint: fingerprint,
            recovery_authority: checkpoint
              ? {
                  recoveryDecisionId: repairDecision.recoveryId,
                  expectedReplacementFingerprint: fingerprint,
                  originalTaskId: failed.task_id,
                  originalExecutionId: checkpoint.executionId,
                  checkpointId: checkpoint.checkpointId,
                  supersessionId,
                  resumptionGeneration: repairDecision.resumptionGeneration ?? 0,
                }
              : undefined,
          });
          this.recoveryTaskGenerations.set(created.task_id, expectedResumptionGeneration);
          return created;
        });
        if (!this.store.listTaskSupersessions(missionId).some((lineage) => lineage.failedTaskId === failed.task_id)) {
          this.store.supersedeTask({
            supersessionId,
            missionId,
            failedTaskId: failed.task_id,
            replacementTaskIds: replacements.map((task) => task.task_id),
            repoId: failed.repo_id ?? "",
            acceptanceIds: [...(failed.acceptance_ids ?? [])],
            coverageFingerprint: taskCoverageFingerprint(failed),
            reason: checkpoint
              ? `resume remaining work from checkpoint ${checkpoint.checkpointId}`
              : "bounded replacement",
            createdAt: new Date(this.scheduler.now()).toISOString(),
            recoveryDecisionId: repairDecision.recoveryId,
            expectedReplacementFingerprints: replacementFingerprints,
          });
        }
      }
      for (const candidate of this.store.listCandidates(missionId)) {
        const reason = `blocked mission repair ${repairDecision.recoveryId}`;
        if (
          this.store
            .listEvidenceInvalidations(missionId)
            .some(
              (entry) =>
                entry.reason === reason && hashCandidateEvidenceIdentity(entry.identity) === candidate.identityHash,
            )
        )
          continue;
        this.store.invalidateEvidence({
          invalidationId: id("EI"),
          missionId,
          identity: candidate.identity,
          reason,
          invalidatedAt: new Date(this.scheduler.now()).toISOString(),
        });
      }
      await this.store.flush();
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      if (this.store.getMission(missionId)?.status === "BLOCKED") {
        this.store.transitionMission(missionId, "REPAIRING", "system", {
          recoveryDecisionId: repairDecision.recoveryId,
        });
      }
      const recoveryLineages = this.store
        .listTaskSupersessions(missionId)
        .filter((lineage) => lineage.recoveryDecisionId === repairDecision.recoveryId);
      for (const lineage of recoveryLineages) {
        for (const taskId of lineage.replacementTaskIds) {
          if (this.store.getTask(taskId)?.status === "PENDING") this.store.transitionTask(taskId, "READY");
        }
      }
      await this.store.flush();
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      await this.scheduler.runMission(missionId, signal);
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const replacementsFailed = recoveryLineages.some(
        (lineage) => !this.store.isTaskSatisfiedBySupersession(lineage.failedTaskId),
      );
      if (replacementsFailed) {
        this.store.transitionRecovery(repairDecision.recoveryId, "failed");
        if (this.store.getMission(missionId)?.status === "REPAIRING") {
          this.store.transitionMission(missionId, "BLOCKED");
        }
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }
      const recoveryMutatesRepository = recoveryLineages.some((lineage) =>
        lineage.replacementTaskIds.some((taskId) => this.store.getTask(taskId)?.mutates_repo === true),
      );
      if (recoveryMutatesRepository && this.broker.pendingIntegrations(missionId) > 0) {
        const integrationTaskId = `${repairDecision.recoveryId}-integration`;
        let integrationTask = this.store.getTask(integrationTaskId);
        if (!integrationTask) {
          integrationTask = this.store.createTask({
            task_id: integrationTaskId,
            mission_id: missionId,
            kind: "integration",
            role: "integrator",
            objective: `Integrate recovery repair ${repairDecision.recoveryId} before evaluating materiality.`,
            mutates_repo: true,
            write_domains: this.writableDomainsForMission(missionId),
            isolation: "none",
            repo_id: this.repoIdForMission(missionId),
            ...this.boundedTaskFields(missionId, ["integrated recovery candidate"], []),
          });
        }
        this.recoveryTaskGenerations.set(integrationTask.task_id, expectedResumptionGeneration);
        if (integrationTask.status === "PENDING") this.store.transitionTask(integrationTask.task_id, "READY");
        const currentStatus = this.store.getMission(missionId)?.status;
        if (currentStatus && currentStatus !== "INTEGRATING" && canTransitionMission(currentStatus, "INTEGRATING")) {
          this.store.transitionMission(missionId, "INTEGRATING");
        }
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        const integrated = await this.runSingleTask(missionId, integrationTask.task_id, { signal });
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        if (!integrated) {
          this.store.transitionRecovery(repairDecision.recoveryId, "failed");
          if (canTransitionMission(this.store.getMission(missionId)!.status, "BLOCKED")) {
            this.store.transitionMission(missionId, "BLOCKED");
          }
          await this.store.flush();
          this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
          return this.store.getMission(missionId)!;
        }
      }
      const verifiedCandidateContent = await this.broker.verifiedCandidateContent(missionId);
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      const contentBaseline = repairDecision.startingCandidateContent;
      const gitMaterialDelta =
        !!verifiedCandidateContent?.hasChanges &&
        (!contentBaseline ||
          (verifiedCandidateContent.candidateSha !== contentBaseline.candidateSha &&
            verifiedCandidateContent.diffHash !== contentBaseline.diffHash));
      const materialDelta = (() => {
        switch (repairDecision.action) {
          case "REBUILD_WORKSPACE_MANIFEST":
            return this.store.getWorkspaceManifest(missionId)?.generation !== manifestGenerationBefore;
          case "RECONSTRUCT_EVIDENCE":
            return this.store.listEvidenceInvalidations(missionId).length > invalidationsBefore;
          case "FENCE_RECONCILE_AND_RESUME":
            return reconciledOrphans.length > 0 || failedTasks.length > 0;
          case "CHECKPOINT_SPLIT_AND_REPLACE":
          case "REPAIR_WORKER_OUTPUT":
          case "REBUILD_INTEGRATION_CANDIDATE":
          case "REPAIR_BLOCKED_MISSION":
            return recoveryMutatesRepository ? gitMaterialDelta : failedTasks.length > 0 || recoveryLineages.length > 0;
          case "CREATE_REPAIR_TASKS":
            return gitMaterialDelta;
          default:
            return false;
        }
      })();
      if (!materialDelta) {
        this.store.transitionRecovery(repairDecision.recoveryId, "failed");
        const currentStatus = this.store.getMission(missionId)?.status;
        if (currentStatus && canTransitionMission(currentStatus, "BLOCKED"))
          this.store.transitionMission(missionId, "BLOCKED");
        await this.store.flush();
        this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
        return this.store.getMission(missionId)!;
      }
      const finalized = await this.finalizeMission(
        missionId,
        expectedResumptionGeneration,
        signal,
        repairDecision.action === "CREATE_REPAIR_TASKS" ? candidateIdentityBefore : undefined,
      );
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      this.store.transitionRecovery(repairDecision.recoveryId, finalized.completed ? "succeeded" : "failed");
      await this.store.flush();
      this.assertRecoveryGeneration(missionId, expectedResumptionGeneration);
      return finalized.mission;
    } finally {
      const leaseToRelease = this.recoveryOwnershipByFlight.get(recoveryLeaseKey) ?? acquiredLease;
      if (leaseToRelease && this.ownership) {
        try {
          await this.ownership.release(leaseToRelease);
        } catch (error) {
          await this.store.recordOwnershipReleaseFailure({
            missionId,
            generation: leaseToRelease.generation,
            fencingToken: leaseToRelease.fencingToken,
            ownerId: leaseToRelease.ownerId,
            renewBy: leaseToRelease.renewBy,
            error,
          });
        }
      }
      if (this.recoveryOwnershipByFlight.get(recoveryLeaseKey) === leaseToRelease) {
        this.recoveryOwnershipByFlight.delete(recoveryLeaseKey);
      }
      for (const [taskId, generation] of this.recoveryTaskGenerations) {
        if (generation === expectedResumptionGeneration) this.recoveryTaskGenerations.delete(taskId);
      }
    }
  }

  private repoIdForMission(missionId: string): string | undefined {
    return this.missionRepoIds.get(missionId) ?? this.store.getWorkspaceManifest(missionId)?.repositories[0]?.repoId;
  }

  private async preservedMissionWork(missionId: string): Promise<string[]> {
    const durableRepositoryRefs = await this.broker.durableRepositoryStateRefs(missionId);
    const preserved = [
      ...new Set(
        [
          ...this.store
            .listTaskCheckpoints(missionId)
            .flatMap((checkpoint) => [
              checkpoint.worktree,
              checkpoint.branch,
              checkpoint.candidateSha,
              ...checkpoint.committedChanges,
              ...checkpoint.preservedUncommittedChanges,
              ...checkpoint.artifactRefs,
            ]),
          ...this.store
            .listCandidates(missionId)
            .flatMap((candidate) => [
              candidate.identity.candidateSha,
              candidate.identity.diffHash,
              ...candidate.identity.artifactHashes,
            ]),
          ...durableRepositoryRefs,
        ].filter((value): value is string => !!value?.trim()),
      ),
    ];
    return preserved;
  }

  private assertRepairCheckpoint(failed: OrchestrationTask, checkpoint: import("./types.ts").TaskCheckpoint): void {
    const execution = this.store.getExecution(checkpoint.executionId);
    const manifestRepository = this.store
      .getWorkspaceManifest(checkpoint.missionId)
      ?.repositories.find((repository) => repository.repoId === checkpoint.repoId);
    const sameAcceptance =
      JSON.stringify([...checkpoint.acceptanceIds].sort()) ===
      JSON.stringify([...(failed.acceptance_ids ?? [])].sort());
    const invalid = [
      checkpoint.missionId !== failed.mission_id ? "mission" : null,
      checkpoint.taskId !== failed.task_id ? "task" : null,
      checkpoint.repoId !== failed.repo_id ? "repository" : null,
      !execution || execution.task_id !== failed.task_id || execution.mission_id !== failed.mission_id
        ? "execution"
        : null,
      !manifestRepository || manifestRepository.baseSha !== checkpoint.baseSha ? "base" : null,
      checkpoint.missionGeneration !== (failed.mission_generation ?? 0) ? "mission generation" : null,
      checkpoint.candidateGeneration !== (failed.candidate_generation ?? 0) ? "candidate generation" : null,
      checkpoint.fencingToken !== (failed.fencing_token ?? 0) ? "fencing token" : null,
      !sameAcceptance ? "acceptance coverage" : null,
      checkpoint.committedChanges.some((entry) => !entry.trim()) ? "committed changes" : null,
      checkpoint.preservedUncommittedChanges.some((entry) => !entry.trim()) ? "uncommitted changes" : null,
      (checkpoint.committedChanges.length > 0 || checkpoint.preservedUncommittedChanges.length > 0) &&
      (!checkpoint.branch?.trim() || !checkpoint.worktree?.trim())
        ? "preserved work identity"
        : null,
    ].filter((entry): entry is string => entry !== null);
    if (invalid.length > 0) throw new Error(`checkpoint repair identity/integrity mismatch: ${invalid.join(", ")}`);
  }

  private async activateMissionRepository(missionId: string): Promise<void> {
    const repoId = this.repoIdForMission(missionId);
    const manifest = this.store.getWorkspaceManifest(missionId);
    if (repoId && manifest && this.repositoryRegistry) {
      this.missionRepoIds.set(missionId, repoId);
      await this.repositoryRegistry.ensureActive(manifest, repoId);
    }
  }

  private phase(mission: Mission, phase: string): void {
    this.onPhase?.(mission, phase);
    this.report(mission.mission_id, `[mission ${mission.mission_id}] phase ${phase}`);
    this.observability?.phaseChanged(mission.mission_id, phase);
  }

  private observeWorkerActivity(
    event: WorkerActivity & {
      missionId: string;
      taskId: string;
      executionId: string;
    },
  ): void {
    const obs = this.observability;
    if (!this.observedExecutions.has(event.executionId)) {
      this.observedExecutions.add(event.executionId);
      this.taskExecutions.set(`${event.missionId}:${event.taskId}`, event.executionId);
      const task = this.store.getTask(event.taskId);
      obs?.workerStarted(event.missionId, event.executionId, {
        taskId: event.taskId,
        runtime: "pi",
      });
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
      obs.activity(missionId, {
        type: "worker_completed",
        summary: "Task completed",
        workerId,
      });
    } else if (obs && status === "FAILED") {
      obs.workerFailed(missionId, workerId);
      obs.activity(missionId, {
        type: "error",
        summary: "Task failed",
        workerId,
      });
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
    opts: OrchestrateOptions = { repository: ".", baseRef: "" },
  ): Promise<OrchestrateResult> {
    const limitMs = this.maxMissionWallClockMs;
    if (limitMs === undefined) return this.orchestrateMission(request, opts);
    // Opt-in mission wall-clock limit: reaching it cancels the mission exactly
    // as the user would, so all work is preserved and the reason is named.
    const limited = new AbortController();
    const forward = (): void => limited.abort(opts.signal?.reason);
    if (opts.signal?.aborted) forward();
    else opts.signal?.addEventListener("abort", forward, { once: true });
    let limitReached = false;
    const timer = setTimeout(() => {
      limitReached = true;
      limited.abort(new DOMException(`configured mission wall-clock limit of ${limitMs}ms reached`, "TimeoutError"));
    }, limitMs);
    timer.unref?.();
    try {
      const result = await this.orchestrateMission(request, { ...opts, signal: limited.signal });
      return limitReached && !result.completed
        ? {
            ...result,
            failureReason: `configured mission wall-clock limit (limits.max_mission_wall_clock_ms = ${limitMs}ms) reached; work is preserved`,
          }
        : result;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", forward);
    }
  }

  private async orchestrateMission(request: string, opts: OrchestrateOptions): Promise<OrchestrateResult> {
    const intent = this.router.route({
      request,
      changedFiles: opts.changedFiles,
      mutationRequested:
        opts.mutationRequested ?? workflowMutatesRepo(this.router.route({ request }).suggested_workflow),
    });
    const risk = this.router.risk({ request });
    const material = workflowMutatesRepo(intent.suggested_workflow) || opts.mutationRequested === true;
    const executable = intent.suggested_workflow !== "conversation" || material || (opts.changedFiles?.length ?? 0) > 0;
    let workspace: Awaited<ReturnType<WorkspaceManifestResolver["resolve"]>> | undefined;
    let workspaceError: WorkspaceScopeError | undefined;
    if (executable && this.workspaceResolver) {
      try {
        workspace = this.repositoryRegistry
          ? await this.workspaceResolver.resolve(request, this.launchCwd)
          : await this.workspaceResolver.resolveRepository(opts.repository);
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
    if (primaryBinding && opts.baseRef && !workspaceError && this.repositoryRegistry) {
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
    const expectedResumptionGeneration = this.store.listMissionResumptions(mission.mission_id).at(-1)?.generation ?? 0;
    if (this.ownership) {
      this.ownershipByMission.set(mission.mission_id, await this.ownership.acquire(mission.mission_id));
    }
    // A live controller keeps its mission lease alive for the whole mission,
    // not only while a worker holds a dispatch authority: a mission waiting
    // hours for gateway capacity (or between tasks) is alive, and an expired
    // lease used to fence its own next dispatch. A dead process stops renewing,
    // so crash recovery still sees the lease expire.
    let leaseRenewal: Promise<void> = Promise.resolve();
    const leaseKeepAlive = this.ownership
      ? setInterval(() => {
          if (!this.ownershipByMission.has(mission.mission_id)) return;
          leaseRenewal = leaseRenewal.then(() => this.renewMissionOwnership(mission.mission_id)).catch(() => undefined);
        }, this.ownership.renewalIntervalMs)
      : undefined;
    leaseKeepAlive?.unref?.();
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

      if (workspace && !this.repositoryRegistry) {
        const manifest = createWorkspaceManifest(workspace, mission.mission_id);
        this.store.bindWorkspaceManifest(manifest);
        await this.store.flush();
        this.missionRepoIds.set(mission.mission_id, workspace.primaryRepoId);
      }

      if (workspace && this.repositoryRegistry) {
        let probes: Awaited<ReturnType<RepositoryRegistry["probe"]>>;
        try {
          const manifest = createWorkspaceManifest(workspace, mission.mission_id);
          const staged = await this.repositoryRegistry.stage(manifest);
          probes = await staged.probe(workspace.primaryRepoId);
          if (probes.some((probe) => !probe.ok)) throw new Error("workspace manifest failed role probes");
          await this.store.bindWorkspaceManifestDurably(manifest, null);
          staged.activate();
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
        const activeManifest = this.store.getWorkspaceManifest(mission.mission_id)!;
        this.repositoryRegistry.activate(
          mission.mission_id,
          activeManifest.generation,
          activeManifest.hash,
          workspace.primaryRepoId,
        );
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
        this.store.updateMission(mission.mission_id, {
          required_gates: dedupe([...gates]),
        });
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
        this.store.completeMission(mission.mission_id, {
          expectedResumptionGeneration,
        });
        this.observeGatePassed(mission.mission_id);
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

      // ── Autonomous spec approval ──────────────────────────────────────────
      // Material mutations must pass a reviewed, approved, exact-revision contract
      // before any implementation task is created. When configured, the durable
      // controller reviews/refines/approves and materializes the approved task set
      // idempotently from the current approval; the downstream planner loop is
      // skipped so no task is created without a current approval.
      let specApprovalMaterialized = false;
      if (this.specApproval && workflowMutatesRepo(intent.suggested_workflow)) {
        const manifest = this.store.getWorkspaceManifest(mission.mission_id);
        if (!manifest || manifest.repositories.length === 0) {
          this.store.transitionMission(mission.mission_id, "BLOCKED");
          const blocked = this.store.getMission(mission.mission_id)!;
          return {
            mission: blocked,
            intent,
            verdict: this.gate.evaluate(blocked),
            completed: false,
            failureReason:
              "SPEC_APPROVAL_UNAVAILABLE: autonomous spec approval requires an authorized repository-bound workspace manifest",
          };
        }
        const plannedMission = this.store.getMission(mission.mission_id)!;
        const repository = manifest.repositories[0]!;
        const protectedInputs: ProtectedUserCriteria = {
          userRequest: mission.user_request,
          constraints: [...mission.constraints],
          acceptance: plannedMission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [{ id: criterion.acceptance_id, text: criterion.criterion }] : [],
          ),
          requiredGates: [...plannedMission.required_gates],
          workspace: {
            manifestHash: manifest.hash,
            manifestGeneration: manifest.generation,
            repositoryId: repository.repoId,
            repositoryRoot: repository.canonicalRoot,
            baseSha: repository.baseSha,
          },
          policyVersion: SPEC_APPROVAL_POLICY_VERSION,
        };
        const envelope: SpecScopeEnvelope = {
          repositoryId: repository.repoId,
          repositoryRoot: repository.canonicalRoot,
          writableDomains: repository.writableDomains,
          baseSha: repository.baseSha,
        };
        const specResult = await this.specApproval({
          missionId: mission.mission_id,
          protectedInputs,
          acceptanceIds: protectedInputs.acceptance.map((entry) => entry.id),
          envelope,
        });
        if (!specResult.approved || !specResult.approval) {
          this.store.transitionMission(mission.mission_id, "BLOCKED");
          const blocked = this.store.getMission(mission.mission_id)!;
          return {
            mission: blocked,
            intent,
            verdict: this.gate.evaluate(blocked),
            completed: false,
            failureReason: specResult.state.stopReason ?? "SPEC_APPROVAL_STOPPED",
          };
        }
        specApprovalMaterialized = true;
      }

      if (!specApprovalMaterialized) {
        // Plan/decompose into tasks.
        const planned = await this.planner(this.store.getMission(mission.mission_id)!, risk);
        const plannedMission = this.store.getMission(mission.mission_id)!;
        const manifest = this.store.getWorkspaceManifest(mission.mission_id);
        const acceptanceIds = plannedMission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        );
        const normalized = planned.map((task) => ({
          ...task,
          task_id: task.task_id ?? id("TSK"),
          acceptance_ids: task.acceptance_ids ? [...task.acceptance_ids] : [],
          deliverables: task.deliverables?.length ? [...task.deliverables] : [task.objective],
          execution_budget_ms: task.execution_budget_ms ?? this.worksetPolicy.maxTaskBudgetMs,
          checkpoint_policy: task.checkpoint_policy ?? {
            activity_milestone: 5,
            before_deadline_ms: 30_000,
          },
          required_output_artifacts: [...(task.required_output_artifacts ?? [])],
        }));
        let worksetError: WorksetValidationError | undefined;
        let decomposedPlan: typeof normalized = [];
        try {
          decomposedPlan = splitWorksetDeliverables(normalized, this.worksetPolicy.maxDeliverablesPerTask).tasks;
        } catch (error) {
          if (error instanceof WorksetValidationError) worksetError = error;
          else throw error;
        }
        const expandedByOriginal = new Map<string, typeof normalized>();
        if (!worksetError) {
          try {
            for (const task of decomposedPlan) {
              const repositories =
                manifest && manifest.repositories.length > 1 && !task.repo_id && task.kind !== "aggregation"
                  ? manifest.repositories
                  : [
                      manifest?.repositories.find(
                        (repository) =>
                          repository.repoId === (task.repo_id ?? this.repoIdForMission(mission.mission_id)),
                      ),
                    ];
              const expanded = repositories.map((repository) => {
                const repoId = repository?.repoId ?? task.repo_id ?? this.repoIdForMission(mission.mission_id);
                return {
                  ...task,
                  task_id: repositories.length > 1 && repoId ? `${task.task_id}@${repoId}` : task.task_id,
                  ...(repoId ? { repo_id: repoId } : {}),
                  write_domains:
                    task.mutates_repo && repository
                      ? intersectWriteDomains(
                          task.write_domains.length > 0 ? task.write_domains : ["**"],
                          repository.writableDomains,
                        )
                      : task.write_domains,
                };
              });
              expandedByOriginal.set(task.task_id, expanded);
            }
          } catch (error) {
            if (error instanceof WorksetValidationError) worksetError = error;
            else throw error;
          }
        }
        const expanded = [...expandedByOriginal.values()].flat().map((task) => ({
          ...task,
          depends_on: task.depends_on.flatMap((dependency) => {
            const candidates = expandedByOriginal.get(dependency);
            if (!candidates) return [dependency];
            const sameRepository = candidates.find((candidate) => candidate.repo_id === task.repo_id);
            return sameRepository ? [sameRepository.task_id] : candidates.map((candidate) => candidate.task_id);
          }),
        }));
        let scopedPlan = expanded;
        if (manifest && !worksetError) {
          try {
            scopedPlan = validateWorkset({
              manifest,
              acceptanceIds,
              tasks: scopedPlan,
              policy: this.worksetPolicy,
            }) as typeof scopedPlan;
          } catch (error) {
            if (error instanceof WorksetValidationError) worksetError = error;
            else throw error;
          }
        }
        if (scopedPlan.some((task) => task.mutates_repo && task.write_domains.length === 0) || worksetError) {
          const summary =
            worksetError?.message ?? "Planner requested mutation outside the workspace manifest's writable domains";
          const category =
            worksetError?.code === "TASK_BUDGET_EXCEEDED"
              ? "TASK_BUDGET_EXHAUSTED"
              : worksetError?.code === "CYCLIC_DEPENDENCY" || worksetError?.code === "UNKNOWN_DEPENDENCY"
                ? "DEADLOCKED_DAG"
                : worksetError?.code === "UNKNOWN_REPOSITORY" ||
                    worksetError?.code === "MISSING_REPOSITORY_BINDING" ||
                    worksetError?.code === "WRITE_DOMAIN_OUTSIDE_REPOSITORY" ||
                    worksetError?.code === "CROSS_REPOSITORY_MUTATION_UNSUPPORTED"
                  ? "WORKSPACE_SCOPE_MISMATCH"
                  : "REQUIREMENT_AMBIGUITY";
          this.store.classifyFailure({
            classificationId: id("FC"),
            missionId: mission.mission_id,
            taskId: null,
            executionId: null,
            category,
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
          });
        }
      }
      this.store.transitionMission(mission.mission_id, "READY");

      // Schedule + execute.
      this.store.transitionMission(mission.mission_id, "EXECUTING");
      this.phase(this.store.getMission(mission.mission_id)!, "executing");
      await this.renewMissionOwnership(mission.mission_id);
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
        await this.cleanupCanceledMission(mission.mission_id);
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

      // Only an operator-configured (opt-in) wall-clock limit produces a
      // "timeout" execution: there is no implicit time budget. Such a timeout
      // with a durable partial checkpoint is not an integration candidate.
      // Stop at the public repair boundary so recovery can split exactly the
      // remaining deliverables and fence the late worker.
      const timedCheckpoint = this.store
        .listTasks(mission.mission_id)
        .filter((task) => task.status === "FAILED" && task.assigned_execution_id)
        .map((task) => ({
          task,
          execution: this.store.getExecution(task.assigned_execution_id!),
          checkpoint: this.store.listTaskCheckpoints(mission.mission_id, task.task_id).at(-1),
        }))
        .find(
          ({ execution, checkpoint }) =>
            execution?.exit_status === "timeout" && (checkpoint?.remainingDeliverables.length ?? 0) > 0,
        );
      if (timedCheckpoint) {
        const summary =
          "configured task wall-clock limit (limits.max_task_wall_clock_ms) reached after a durable partial checkpoint";
        const classification = this.failureClassifier.classify({
          missionId: mission.mission_id,
          taskId: timedCheckpoint.task.task_id,
          executionId: timedCheckpoint.execution!.execution_id,
          summary,
          evidenceRefs: [timedCheckpoint.checkpoint!.checkpointId],
          category: "TASK_BUDGET_EXHAUSTED",
          observedAt: new Date(this.scheduler.now()).toISOString(),
        });
        this.store.classifyFailure(classification);
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

      const finalized = await this.finalizeMission(mission.mission_id, expectedResumptionGeneration, opts.signal);
      return { ...finalized, intent };
    } finally {
      if (leaseKeepAlive) clearInterval(leaseKeepAlive);
      // Never release under an in-flight renewal: it would write the stale
      // lease back after the release.
      await leaseRenewal;
      this.progress.delete(mission.mission_id);
      const identity = this.ownershipByMission.get(mission.mission_id);
      if (identity && this.ownership) {
        try {
          await this.ownership.release(identity);
        } catch (error) {
          await this.store.recordOwnershipReleaseFailure({
            missionId: identity.missionId,
            generation: identity.generation,
            fencingToken: identity.fencingToken,
            ownerId: identity.ownerId,
            renewBy: identity.renewBy,
            error,
          });
        }
        this.ownershipByMission.delete(mission.mission_id);
      }
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
    const expectedResumptionGeneration = this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    this.activateMissionRepository(missionId);
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    if (mission.status !== "PAUSED_INFRASTRUCTURE") return mission;
    if (opts?.signal?.aborted) return this.cancelMission(missionId);
    if (!opts?.force && !(await this.scheduler.gatewayHealthy(opts?.signal))) {
      return opts?.signal?.aborted ? this.cancelMission(missionId) : mission;
    }
    if (this.ownership) this.ownershipByMission.set(missionId, await this.ownership.acquire(missionId));
    try {
      this.phase(mission, "executing");
      this.report(missionId, `[mission ${missionId}] resuming after infrastructure recovery`);
      await this.renewMissionOwnership(missionId);
      await this.scheduler.resumePausedMission(missionId, opts?.signal);
      const resumed = this.store.getMission(missionId)!;
      if (resumed.status === "PAUSED_INFRASTRUCTURE") return resumed;
      if (opts?.signal?.aborted) return this.cancelMission(missionId);
      return (await this.finalizeMission(missionId, expectedResumptionGeneration, opts?.signal)).mission;
    } finally {
      const identity = this.ownershipByMission.get(missionId);
      if (identity && this.ownership) {
        try {
          await this.ownership.release(identity);
        } catch (error) {
          await this.store.recordOwnershipReleaseFailure({
            missionId: identity.missionId,
            generation: identity.generation,
            fencingToken: identity.fencingToken,
            ownerId: identity.ownerId,
            renewBy: identity.renewBy,
            error,
          });
        }
      }
      this.ownershipByMission.delete(missionId);
    }
  }

  /** Complete the lifecycle after scheduler work settles, whether initial or resumed. */
  private async finalizeMission(
    missionId: string,
    expectedResumptionGeneration: number,
    signal?: AbortSignal,
    requiredCandidateChangeFrom?: string | null,
  ): Promise<FinalizationResult> {
    if (signal?.aborted) return this.canceledFinalization(missionId);
    await this.reconcileCommittedPromotions(missionId);
    if (signal?.aborted) return this.canceledFinalization(missionId);
    // Post-execution: integrate, validate + review if the mission mutated or
    // requires gates. If integration did not land the change, the mission must
    // not complete — otherwise it reports success over an unchanged repository.
    let post = await this.postExecution(this.store.getMission(missionId)!, signal);
    if (signal?.aborted) return this.canceledFinalization(missionId);
    let integrated = post.integrationOk;
    if (
      requiredCandidateChangeFrom !== undefined &&
      (this.store.getCandidate(missionId)?.identityHash ?? null) === requiredCandidateChangeFrom
    ) {
      const evidence = requiredCandidateChangeFrom ?? "no-prior-candidate";
      if (
        !this.store
          .listFindings(missionId)
          .some((finding) => finding.category === "recovery_material_delta" && finding.evidence === evidence)
      ) {
        this.store.addFinding({
          mission_id: missionId,
          task_id: null,
          severity: "blocking",
          category: "recovery_material_delta",
          file: null,
          line: null,
          summary: "Recovery repair did not produce a new candidate evidence identity.",
          evidence,
          recommended_action: "Produce a repository mutation and rebuild candidate evidence before rerunning gates.",
        });
      }
    }

    // Completion gate, with bounded repair rounds (spec 07): a blocking reviewer
    // finding creates repair work, and the repaired result is re-validated and
    // re-reviewed before the gate is consulted again.
    let verdict = this.gate.evaluate(this.store.getMission(missionId)!);
    let repairRounds =
      requiredCandidateChangeFrom !== undefined
        ? this.maxRepairRounds
        : this.store.listRecoveryDecisions(missionId).filter((decision) => decision.action === "CREATE_REPAIR_TASKS")
            .length;
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

      const blockerTask = failedGates.at(-1);
      let classification = this.store
        .listFailureClassifications(missionId)
        .reverse()
        .find((entry) => entry.taskId === blockerTask?.task_id);
      if (!classification) {
        classification = this.failureClassifier.classify({
          missionId,
          taskId: blockerTask?.task_id ?? openBlocking.at(-1)?.task_id ?? null,
          executionId: blockerTask?.assigned_execution_id ?? null,
          summary: blockerTask?.failure_reason ?? openBlocking.at(-1)?.summary ?? "review repair required",
          evidenceRefs: openBlocking.map((finding) => finding.finding_id),
          category: blockerTask?.kind === "validation" ? "VALIDATION_FAILED" : "REVIEW_FAILED",
          observedAt: new Date(this.scheduler.now()).toISOString(),
        });
        this.store.classifyFailure(classification);
      }
      const recoveryChoice = this.recoveryPlanner.decide({
        classification,
        history: this.store.listRecoveryDecisions(missionId),
        now: this.scheduler.now(),
        resumptionGeneration: this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0,
      });
      if (recoveryChoice.action === "STOP") {
        const stopped =
          this.store.getRecoveryDecision(recoveryChoice.recoveryId) ?? this.store.planRecovery(recoveryChoice);
        if (stopped.status === "planned") this.store.transitionRecovery(stopped.recoveryId, "exhausted");
        this.store.stopMission(missionId, {
          reason: recoveryChoice.expectedMaterialChange,
          preservedWork: await this.preservedMissionWork(missionId),
          attemptedRecoveries: this.store.listRecoveryDecisions(missionId).map((decision) => decision.recoveryId),
          resumeCondition: "new candidate evidence or an explicitly increased recovery budget is required",
        });
        await this.store.flush();
        break;
      }
      const gateRecovery =
        this.store.getRecoveryDecision(recoveryChoice.recoveryId) ??
        this.store.planRecovery({
          ...recoveryChoice,
          startingCandidateIdentityHash: this.store.getCandidate(missionId)?.identityHash ?? null,
        });
      if (gateRecovery.status === "planned") this.store.transitionRecovery(gateRecovery.recoveryId, "started");
      await this.store.flush();

      const repairCandidate = this.store.getCandidate(missionId);
      if (repairCandidate) {
        this.store.invalidateEvidence({
          invalidationId: id("EI"),
          missionId,
          identity: repairCandidate.identity,
          reason: "repair changed candidate-relevant inputs",
          invalidatedAt: new Date().toISOString(),
        });
      }

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
          ...this.boundedTaskFields(missionId, ["repair"], []),
        });
        this.store.transitionTask(repair.task_id, "READY");
        const repaired = await this.runSingleTask(missionId, repair.task_id, {
          signal,
        });
        if (signal?.aborted) return this.canceledFinalization(missionId);
        if (repaired && obj.findingId) this.store.resolveFinding(obj.findingId);
      }
      post = await this.postExecution(this.store.getMission(missionId)!, signal);
      if (signal?.aborted) return this.canceledFinalization(missionId);
      integrated = post.integrationOk;
      if (post.reviewAttempted && !post.reviewOk) {
        verdict = this.gate.evaluate(this.store.getMission(missionId)!);
        if (this.store.getRecoveryDecision(gateRecovery.recoveryId)?.status === "started") {
          this.store.transitionRecovery(gateRecovery.recoveryId, "failed");
          await this.store.flush();
        }
        break;
      }
      verdict = this.gate.evaluate(this.store.getMission(missionId)!);
      if (this.store.getRecoveryDecision(gateRecovery.recoveryId)?.status === "started") {
        this.store.transitionRecovery(
          gateRecovery.recoveryId,
          verdict.can_complete && integrated ? "succeeded" : "failed",
        );
        await this.store.flush();
      }
    }

    // Promotion is the only incumbent mutation. It occurs after both gate
    // attempts are current and green, under a fresh repository fencing check.
    // Failed/red/canceled candidates remain mounted/ref-addressable for diagnosis.
    const hasCandidateForPromotion = await this.broker.hasCandidateForPromotion(missionId);
    if (verdict.can_complete && integrated && hasCandidateForPromotion) {
      const integrationTask = this.store
        .listTasks(missionId)
        .filter((task) => task.kind === "integration" && task.repo_id)
        .at(-1);
      if (!integrationTask) {
        integrated = false;
      } else if (!this.ownership) {
        // Legacy in-memory orchestrators have no lease provider. Production
        // runtimes always supply ownership; retain compatibility for isolated
        // deterministic harnesses while still using the guarded Git primitive.
        integrated = await this.broker.promoteCandidate(missionId);
      } else {
        const promotionAuthority = await this.acquireTaskAuthority(integrationTask);
        try {
          promotionAuthority.assertAuthoritative();
          integrated = await this.broker.promoteCandidate(missionId, promotionAuthority);
        } catch (error) {
          integrated = false;
          this.store.addFinding({
            mission_id: missionId,
            task_id: integrationTask.task_id,
            severity: "blocking",
            category: "integration",
            file: null,
            line: null,
            summary: `Candidate promotion rejected: ${error instanceof Error ? error.message : String(error)}`,
            evidence: null,
            recommended_action:
              "Inspect the preserved candidate and retry only from the originally bound incumbent base.",
          });
        } finally {
          await promotionAuthority.close();
        }
      }
    }
    await this.cleanupMissionWithAuthorities(missionId, !integrated);
    if (!integrated) {
      // Prune preserved branches that are byte-identical to the base (zero
      // unique commits) so they are not reported as unmerged worker work and do
      // not force manual cleanup. Only branches carrying real unmerged commits
      // stay preserved and are named in the finding.
      const preserved = await this.broker.pruneEmptyPreservedBranches(missionId);
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
      this.store.completeMission(missionId, { expectedResumptionGeneration });
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
      this.observeGatePassed(missionId);
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
      if (!this.store.listMissionStops(missionId).at(-1)) {
        this.store.stopMission(missionId, {
          reason: verdict.reasons.join("; ") || "completion requirements remain blocked",
          preservedWork: await this.preservedMissionWork(missionId),
          attemptedRecoveries: this.store.listRecoveryDecisions(missionId).map((decision) => decision.recoveryId),
          resumeCondition: "provide the missing current-candidate evidence or repair the reported blocking condition",
        });
      }
    } else {
      this.store.failMission(missionId, verdict.reasons.join("; "));
    }
    const stopped = this.store.getMission(missionId)!;
    const reason = verdict.reasons.join("; ") || "completion requirements were not satisfied";
    const summary = `Mission ${stopped.status.toLowerCase()}: ${reason}. No workers remain active.`;
    this.observability?.clearWaiting(missionId);
    this.observability?.activity(missionId, {
      type: "error",
      summary,
      meaningfulProgress: true,
    });
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
        ...this.boundedTaskFields(mission.mission_id, ["integration"], []),
      });
      this.store.transitionTask(integ.task_id, "READY");
      integrationOk = await this.runSingleTask(mission.mission_id, integ.task_id, { signal });
      if (signal?.aborted) {
        return {
          validationAttempted,
          validationOk,
          reviewAttempted,
          reviewOk,
          integrationOk: false,
        };
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
      if (!integrationOk)
        return {
          validationAttempted,
          validationOk,
          reviewAttempted,
          reviewOk,
          integrationOk,
        };
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
        ...this.boundedTaskFields(mission.mission_id, ["validation"], []),
      });
      this.store.transitionTask(task.task_id, "READY");
      validationAttempted = true;
      validationOk = await this.runSingleTask(mission.mission_id, task.task_id, { signal });
      if (signal?.aborted) {
        return {
          validationAttempted,
          validationOk,
          reviewAttempted,
          reviewOk,
          integrationOk,
        };
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
        ...this.boundedTaskFields(mission.mission_id, ["independent-review"], []),
      });
      this.store.transitionTask(task.task_id, "READY");
      reviewAttempted = true;
      reviewOk = await this.runSingleTask(mission.mission_id, task.task_id, {
        reviewedRecovered: recovered.map((t) => t.task_id),
        signal,
      });
      if (signal?.aborted) {
        return {
          validationAttempted,
          validationOk,
          reviewAttempted,
          reviewOk,
          integrationOk,
        };
      }
      // From REVIEWING the mission moves to final validation (or repair handled
      // by the caller via the completion gate).
      this.store.transitionMission(mission.mission_id, "FINAL_VALIDATION");
    }
    return {
      validationAttempted,
      validationOk,
      reviewAttempted,
      reviewOk,
      integrationOk,
    };
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

  private boundedTaskFields(
    missionId: string,
    deliverables: string[],
    requiredOutputArtifacts: string[],
  ): Pick<
    OrchestrationTask,
    "acceptance_ids" | "deliverables" | "execution_budget_ms" | "checkpoint_policy" | "required_output_artifacts"
  > {
    const mission = this.store.getMission(missionId);
    return {
      acceptance_ids: mission?.acceptance_criteria.flatMap((criterion) =>
        criterion.acceptance_id ? [criterion.acceptance_id] : [],
      ),
      deliverables,
      execution_budget_ms: this.worksetPolicy.maxTaskBudgetMs,
      checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
      required_output_artifacts: requiredOutputArtifacts,
    };
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
    if (!this.recoveryTaskGenerations.has(taskId)) await this.renewMissionOwnership(missionId);
    let task = this.store.getTask(taskId)!;
    const authority = this.ownership ? await this.acquireTaskAuthority(task) : undefined;
    if (authority) task = this.store.assignTaskAuthority(taskId, authority.missionIdentity);
    authority?.assertAuthoritative();
    this.store.transitionTask(taskId, "RUNNING");
    this.report(
      missionId,
      `[mission ${missionId}] ${task.kind}:${task.role} starting — ${task.objective.slice(0, 120)}`,
    );
    let handle: Awaited<ReturnType<ExecutionBroker["execute"]>> | undefined;
    try {
      // execute() itself can throw — e.g. no backend is registered for the task
      // kind. Left outside the try it propagated out of postExecution and
      // orchestrate and left the mission stranded in INTEGRATING / VALIDATING /
      // REVIEWING. The scheduler path was hardened the same way; this one was not.
      handle = await this.broker.execute({
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
        deliverables: task.deliverables,
        executionBudgetMs: task.execution_budget_ms,
        checkpointPolicy: task.checkpoint_policy,
        requiredOutputArtifacts: task.required_output_artifacts,
        candidateBaseSha: task.repair_base_candidate_sha,
        acceptanceCriteria: this.store.getMission(missionId)?.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id
            ? [
                {
                  acceptanceId: criterion.acceptance_id,
                  criterion: criterion.criterion,
                },
              ]
            : [],
        ),
        authority,
        ...(extra.reviewedRecovered?.length ? { reviewedRecovered: extra.reviewedRecovered } : {}),
      });
      const executionHandle = handle;
      authority?.onInvalidated(() => {
        void executionHandle.cancel();
      });
      const onAbort = (): void => {
        void executionHandle.cancel();
      };
      if (extra.signal?.aborted) await executionHandle.cancel();
      else extra.signal?.addEventListener("abort", onAbort, { once: true });
      const outcome = await executionHandle.result().finally(() => extra.signal?.removeEventListener("abort", onAbort));
      authority?.assertAuthoritative();
      // Record reviewer findings so the completion gate can block on them.
      for (const f of outcome.findings ?? []) {
        let severity: ReviewFinding["severity"];
        try {
          severity = normalizeReviewSeverity(f.severity);
        } catch {
          severity = "blocking";
        }
        this.store.addFinding({
          mission_id: missionId,
          task_id: taskId,
          severity,
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
      if (task.kind === "validation" || task.kind === "review") this.markAcceptanceFromCurrentEvidence(missionId);
      this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} succeeded`);
      return true;
    } catch (err) {
      if (authority) {
        try {
          authority.assertAuthoritative();
        } catch (authorityError) {
          await handle?.cancel().catch(() => undefined);
          if (handle) {
            this.store.rejectLateExecution(
              handle.executionId,
              authorityError instanceof Error ? authorityError.message : String(authorityError),
            );
          }
          return false;
        }
      }
      if (extra.signal?.aborted) {
        await this.broker.cancelByTask(taskId);
        if (this.store.getTask(taskId)?.status === "RUNNING") this.store.transitionTask(taskId, "CANCELED");
        this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} canceled`);
        return false;
      }
      if (this.store.getTask(taskId)?.status === "RUNNING") this.store.transitionTask(taskId, "FAILED");
      this.report(missionId, `[mission ${missionId}] ${task.kind}:${task.role} errored`);
      return false;
    } finally {
      const closeError = await authority?.close();
      if (authority && closeError) {
        const identity = authority.repositoryIdentity ?? authority.missionIdentity;
        await this.store.recordOwnershipReleaseFailure({
          missionId: identity.missionId,
          taskId,
          ...(authority.repositoryIdentity ? { repoId: authority.repositoryIdentity.repoId } : {}),
          generation: identity.generation,
          fencingToken: identity.fencingToken,
          ownerId: identity.ownerId,
          renewBy: identity.renewBy,
          error: closeError,
        });
      }
    }
  }

  private markAcceptanceFromCurrentEvidence(missionId: string): void {
    const mission = this.store.getMission(missionId);
    const repoId = this.repoIdForMission(missionId);
    const candidate = repoId ? this.store.getCandidate(missionId, repoId) : undefined;
    if (!mission || !candidate) return;
    const validation = this.store
      .listValidationEvidence(missionId)
      .filter((evidence) => evidence.identityHash === candidate.identityHash)
      .at(-1);
    const review = this.store
      .listReviewEvidence(missionId)
      .filter((evidence) => evidence.identityHash === candidate.identityHash)
      .at(-1);
    const requiresValidation = mission.required_gates.some((gate) =>
      ["validation", "migration_validation", "dependency_validation"].includes(gate),
    );
    const requiresReview = mission.required_gates.some((gate) =>
      ["independent_review", "security_review", "compatibility_review"].includes(gate),
    );
    const validationOk =
      !requiresValidation ||
      (!!validation && validation.accessible && !validation.noTargets && validation.exitCode === 0);
    const reviewOk =
      !requiresReview ||
      (!!review &&
        review.accessible &&
        review.outputValid &&
        review.verdict === "approve" &&
        review.findings.every((finding) => finding.severity !== "blocking" || finding.status === "resolved"));
    if (!validationOk || !reviewOk) return;
    const explicitPassed = new Set(
      [...(validation?.acceptanceResults ?? []), ...(review?.acceptanceResults ?? [])]
        .filter((result) => result.status === "passed")
        .map((result) => result.acceptanceId),
    );
    mission.acceptance_criteria.forEach((criterion, index) => {
      if (
        criterion.acceptance_id &&
        candidate.identity.acceptanceIds.includes(criterion.acceptance_id) &&
        explicitPassed.has(criterion.acceptance_id)
      ) {
        this.store.setCriterionStatus(missionId, index, "passed", candidate.identityHash);
      }
    });
  }

  private async renewMissionOwnership(missionId: string): Promise<void> {
    const identity = this.ownershipByMission.get(missionId);
    if (!identity || !this.ownership) return;
    this.ownershipByMission.set(missionId, await this.ownership.renew(identity));
  }

  private async acquireTaskAuthority(task: OrchestrationTask): Promise<DispatchAuthority> {
    const currentResumptionGeneration = this.store.listMissionResumptions(task.mission_id).at(-1)?.generation ?? 0;
    const lineageDecisions = this.store
      .listTaskSupersessions(task.mission_id)
      .filter((lineage) => lineage.replacementTaskIds.includes(task.task_id))
      .flatMap((lineage) =>
        lineage.recoveryDecisionId ? [this.store.getRecoveryDecision(lineage.recoveryDecisionId)] : [],
      )
      .filter((decision): decision is NonNullable<typeof decision> => decision !== undefined);
    if (lineageDecisions.length > 1) {
      throw new Error(`replacement task ${task.task_id} belongs to multiple recovery lineages`);
    }
    const activeRecoveryDecisions = this.store
      .listRecoveryDecisions(task.mission_id)
      .filter(
        (decision) =>
          (decision.resumptionGeneration ?? 0) === currentResumptionGeneration &&
          decision.blockedEpisodeId !== undefined &&
          (decision.status === "planned" || decision.status === "started") &&
          !["STOP", "WAIT_FOR_REQUIREMENT", "PAUSE_FOR_PERSISTENCE", "PROBE_AND_BACKOFF"].includes(decision.action),
      );
    const durableRecoveryGeneration =
      lineageDecisions[0]?.resumptionGeneration ??
      (activeRecoveryDecisions.length === 1 ? activeRecoveryDecisions[0]?.resumptionGeneration : undefined);
    const recoveryGeneration = durableRecoveryGeneration ?? this.recoveryTaskGenerations.get(task.task_id);
    const recoveryKey = recoveryGeneration === undefined ? undefined : `${task.mission_id}:${recoveryGeneration}`;
    const identity = recoveryKey
      ? this.recoveryOwnershipByFlight.get(recoveryKey)
      : this.ownershipByMission.get(task.mission_id);
    if (!identity || !this.ownership) throw new Error(`mission ${task.mission_id} has no active ownership`);
    if (task.mutates_repo && !task.repo_id) {
      throw new Error(`mutating task ${task.task_id} has no repository identity`);
    }
    const held = await this.ownership.maintain(identity, task.mutates_repo ? task.repo_id : undefined);
    return {
      get missionIdentity() {
        return held.missionIdentity;
      },
      get repositoryIdentity() {
        return held.repositoryIdentity;
      },
      get resumptionGeneration() {
        return held.resumptionGeneration;
      },
      assertAuthoritative: () => held.assertAuthoritative(),
      onInvalidated: (listener) => held.onInvalidated(listener),
      close: async () => {
        const error = await held.close();
        if (recoveryKey) {
          if (this.recoveryOwnershipByFlight.get(recoveryKey) === identity) {
            this.recoveryOwnershipByFlight.set(recoveryKey, held.missionIdentity);
          }
        } else {
          this.ownershipByMission.set(task.mission_id, held.missionIdentity);
        }
        return error;
      },
    };
  }

  /** Clean canceled mission work only while holding fresh repository authority. */
  private async cleanupCanceledMission(missionId: string): Promise<void> {
    try {
      await this.cleanupMissionWithAuthorities(missionId, true);
    } catch (error) {
      this.store.addFinding({
        mission_id: missionId,
        task_id: null,
        severity: "major",
        category: "integration",
        file: null,
        line: null,
        summary: `Cancellation cleanup could not acquire or retain repository authority; diagnostics preserved: ${error instanceof Error ? error.message : String(error)}`,
        evidence: null,
        recommended_action: "Reacquire repository authority before retrying cleanup.",
      });
    }
  }

  private async cleanupMissionWithAuthorities(missionId: string, keepBranches: boolean): Promise<void> {
    if (!this.ownership) {
      await this.broker.cleanupMission(missionId, { keepBranches });
      return;
    }
    const taskByRepo = new Map(
      this.store
        .listTasks(missionId)
        .filter((task) => task.repo_id && task.mutates_repo)
        .map((task) => [task.repo_id!, task]),
    );
    await this.broker.cleanupMission(missionId, {
      keepBranches,
      authorityForRepo: async (repoId) => {
        const task = taskByRepo.get(repoId);
        if (!task) throw new Error(`no authority-bearing task for repository ${repoId}`);
        return this.acquireTaskAuthority(task);
      },
    });
  }

  /** Reconcile a previously committed CAS before any new validation or review gates run. */
  private async reconcileCommittedPromotions(missionId: string): Promise<void> {
    if (!this.ownership) return;
    const taskByRepo = new Map(
      this.store
        .listTasks(missionId)
        .filter((task) => task.kind === "integration" && task.repo_id)
        .map((task) => [task.repo_id!, task]),
    );
    for (const [repoId, task] of taskByRepo) {
      const authority = await this.acquireTaskAuthority(task);
      try {
        const results = await this.broker.reconcileCommittedPromotions(missionId, repoId, authority);
        for (const result of results) {
          if (!result.promoted && result.reason?.includes("diverged")) {
            this.store.addFinding({
              mission_id: missionId,
              task_id: task.task_id,
              severity: "blocking",
              category: "integration",
              file: null,
              line: null,
              summary: `Committed promotion reconciliation failed: ${result.reason}`,
              evidence: result.candidateSha,
              recommended_action: "Inspect the exact durable promotion intent and incumbent divergence.",
            });
          }
        }
      } finally {
        await authority.close();
      }
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
    await this.cleanupCanceledMission(missionId);
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

export function intersectWriteDomains(requested: string[], authorized: string[]): string[] {
  const canonicalRequested = requested.map(canonicalizeWriteDomain);
  const canonicalAuthorized = authorized.map(canonicalizeWriteDomain);
  const intersection = new Set<string>();
  const contains = (outer: string, inner: string): boolean => {
    if (outer === "**") return true;
    if (outer === inner) return true;
    if (!outer.endsWith("/**")) return false;
    const prefix = outer.slice(0, -3).replace(/\/$/, "");
    return inner === prefix || inner.startsWith(`${prefix}/`);
  };
  for (const request of canonicalRequested) {
    for (const allow of canonicalAuthorized) {
      if (contains(request, allow)) intersection.add(allow);
      else if (contains(allow, request)) intersection.add(request);
    }
  }
  return [...intersection];
}
