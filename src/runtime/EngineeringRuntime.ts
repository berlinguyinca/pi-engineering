import { randomUUID } from "node:crypto";
import { mkdir, rename, statfs, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { BlackholeManager, type BlackholeManagerOptions } from "../blackhole/BlackholeManager.ts";
import type { RoleRouterAdapter } from "../capability/adapter.ts";
import { differentFamilyReviewerAvailable } from "../capability/registryCandidates.ts";
import { ContextBroker } from "../context/ContextBroker.ts";
import { newRunId } from "../core/ids.ts";
import type {
  Actor,
  Candidate,
  EventMeta,
  RiskLevel,
  Task,
  TaskKind,
  Telemetry,
  WorkItem,
  WorkItemStatus,
  WorkerRole,
} from "../core/types.ts";
import { ROLE_BUDGETS } from "../core/types.ts";
import { sharedAdmissionController } from "../gateway/config.ts";
import { GitRepo } from "../git/GitRepo.ts";
import { classifyError } from "../guard/transient.ts";
import { MissionCapacityScheduler } from "../inference/missionCapacityScheduler.ts";
import { Ledger } from "../ledger/Ledger.ts";
import { autospecConfigured } from "../lifecycle/autospecProbe.ts";
import { loadExecutionConfig, loadMissionLimits, loadPolicy } from "../lifecycle/policy.ts";
import type { MissionMergeQueueOptions } from "../orchestration/broker.ts";
import { selectExternalMissionsToStart } from "../orchestration/externalStartSelection.ts";
import { supervisorAdmitsMission } from "../orchestration/externalSupervision.ts";
import { workflowMutatesRepo } from "../orchestration/intentRouter.ts";
import { MAINTENANCE_STOP_REASON, OPERATOR_PAUSE_STOP_REASON, interruptibleRun } from "../orchestration/interrupt.ts";
import { emitMissionPlanned } from "../orchestration/missionLineage.ts";
import { readAutospecFlags } from "../orchestration/missionMode.ts";
import {
  PlannerTransientError,
  missionPlannerMode,
  planMission,
  plannerTimeoutMs,
} from "../orchestration/missionPlanner.ts";
import {
  MISSION_SNAPSHOT_FILENAME,
  type MissionSnapshotFile,
  acquireSnapshotPublisherLock,
  buildMissionSnapshotFile,
  mergeSnapshotFiles,
  readMissionSnapshotFile,
  tagSnapshotPublisher,
} from "../orchestration/missionSnapshot.ts";
import { MissionStore } from "../orchestration/missionStore.ts";
import { buildVerifierStages } from "../orchestration/missionWhy.ts";
import { ClockOnlyGate, MissionActivityTicker } from "../orchestration/observability/MissionActivityTicker.ts";
import { MissionObservability, boundedToolOutputPreview } from "../orchestration/observability/MissionObservability.ts";
import { type MissionAttention, attentionFromSummary } from "../orchestration/observability/attention.ts";
import { Orchestrator } from "../orchestration/orchestrator.ts";
import type { OrchestratorOptions, PlanTaskInput } from "../orchestration/orchestrator.ts";
import { MissionOwnership } from "../orchestration/ownership.ts";
import { missionCustodyKey } from "../orchestration/ownership.ts";
import { type PlanLineageEmitter, gatePlanBeforeWorkers } from "../orchestration/planReview.ts";
import { loadPlanReviewSettings } from "../orchestration/planReviewConfig.ts";
import { type RouteModel, realBackends } from "../orchestration/realBackends.ts";
import {
  DEFAULT_MISSION_RECOVERY_CEILING,
  DEFAULT_STRATEGY_MAX_ATTEMPTS,
  FailureClassifier,
  RecoveryPlanner,
  type RecoveryPlannerOptions,
  describeRecoveryOutcome,
} from "../orchestration/recovery.ts";
import { RepositoryRegistry } from "../orchestration/repositoryRegistry.ts";
import { canTransitionMission } from "../orchestration/state.ts";
import { resolveSteeringTarget } from "../orchestration/steeringResolve.ts";
import { MissionSupervisor, type SupervisorStatus } from "../orchestration/supervisor.ts";
import { SupervisorRepairBackoff } from "../orchestration/supervisorBackoff.ts";
import {
  type Mission,
  type MissionStop,
  type MissionStopQueue,
  PLANNER_CLARIFICATION_CATEGORY,
} from "../orchestration/types.ts";
import { WorkspaceManifestResolver } from "../orchestration/workspaceManifest.ts";
import { tasksConflict, topoSort } from "../plan/taskDag.ts";
import { redactSecrets } from "../platform/redact.ts";
import type { StorageHints } from "../resilience/classify.ts";
import { type GatewayResilienceConfig, resolveGatewayResilienceConfig } from "../resilience/config.ts";
import {
  CatalogRecoveryProbe,
  HttpRecoveryProbe,
  type RecoveryProbe,
  resolveCatalogProbeTarget,
} from "../resilience/probe.ts";
import { SnapshotPressureGuard } from "../resilience/snapshotPressureGuard.ts";
import { ResourceRegistry } from "../resources/ResourceRegistry.ts";
import type { StatfsReader } from "../resources/buildBudget.ts";
import { Scheduler } from "../sched/Scheduler.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { buildCoreTools, hasRecordedEvidence } from "../tools/coreTools.ts";
import { CommandVerifier, type VerificationProvider, type VerifyOutcome } from "../verify/Verifier.ts";
import { TestQuarantine } from "../verify/testQuarantine.ts";
import { LedgerWorkProjection } from "../work/ledgerProjection.ts";
import { PiWorkerExecutor } from "../workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";
import { buildContinuityConfig } from "./continuityWiring.ts";
import { type SteeringReceiver, createSteeringReceiver } from "./herdr/SteeringReceiver.ts";
import { type ExternalBridge, startExternalBridge } from "./herdr/externalAgent.ts";
import {
  type ForkRuntime,
  type WorkScopeFacts,
  createForkRuntime,
  downstreamPrNodes,
  missionForkSources,
  withFallbackForkSources,
  workForkSources,
} from "./herdr/forkWiring.ts";
import type { LineageEmitter } from "./herdr/lineage.ts";
import { type RuntimeBinding, resolveRuntimeBinding, sessionBindingInfo } from "./isolation/RuntimeBinding.ts";
import { RuntimeSession } from "./isolation/RuntimeSession.ts";
import { resolveWorktreeIdentity } from "./isolation/WorktreeIdentity.ts";
import {
  type OrchestrationNamespace,
  namespaceKey,
  openOrchestrationNamespace,
} from "./isolation/orchestrationNamespace.ts";
import { assessProcess } from "./isolation/processIdentity.ts";
import { isReloadShutdown } from "./isolation/reloadCustody.ts";
import { resolveStateRoot, worktreeRuntimeDir } from "./isolation/stateDir.ts";
import { validateMaintenanceModel } from "./maintenanceModel.ts";
import { UnavailableModels, createRouteModel, followUnavailableModels } from "./modelRouting.ts";
import {
  type PinTransition,
  adoptOperatorModelPin,
  claimMissionForSession,
  releaseMissionModelPin,
  releaseSessionMissionPins,
} from "./operatorModelPin.ts";

/**
 * Build the mission gateway recovery probe.
 *
 * Default: an authenticated `GET {baseUrl}/models` against the provider the
 * implementer is routed to (CatalogRecoveryProbe), healthy only when that
 * model is listed with capacity — so a paused mission resumes itself without
 * any configuration. PI_GATEWAY_HEALTH_URL overrides it with a plain
 * readiness probe. With no model runtime at all (a non-Pi worker) there is
 * nothing to probe and the scheduler's pass-through probe applies.
 */
function buildGatewayRecoveryProbe(
  worker: WorkerExecutor,
  routeModel: RouteModel | undefined,
  unavailable: UnavailableModels,
): RecoveryProbe | undefined {
  const url = process.env.PI_GATEWAY_HEALTH_URL;
  // Not wrapped with followUnavailableModels: the health-URL probe has no model
  // target, so it never reports a model unlisted, the unlisted-model gate never
  // engages, and the scheduler has no model to report through it. A removed
  // model is still taken over on the worker's own 404; one that answers 503
  // instead is relaunched like any outage, up to max_relaunches.
  if (url) return new HttpRecoveryProbe({ baseUrl: url, timeoutMs: 5_000 });
  if (!(worker instanceof PiWorkerExecutor)) return undefined;
  // The target is resolved through routeModel, which skips unavailable models;
  // following the record keeps a removed model out of the probe too.
  const catalog = new CatalogRecoveryProbe({
    resolve: async () => {
      const runtime = await worker.getModelRuntime();
      const routed = await routeModel?.("implementer").catch(() => undefined);
      const fallback = routed ? undefined : (await runtime.getAvailable())[0];
      const ref = routed ?? (fallback ? { provider: fallback.provider, id: fallback.id } : undefined);
      return ref ? resolveCatalogProbeTarget(runtime as never, ref) : undefined;
    },
  });
  return followUnavailableModels(catalog, unavailable);
}

export interface EngineerReport {
  work_item: WorkItem;
  risk: RiskLevel;
  incumbent_candidate: Candidate | null;
  scout_summary: string | null;
  review_summary: string | null;
  challenge_summary: string | null;
  verification: VerifyOutcome | null;
  evidence_ids: string[];
  rounds: number;
  outcome: "promoted" | "failed" | "blocked" | "stopped";
  /** Aggregate context/autonomy telemetry for the run (spec §41). */
  telemetry: Telemetry;
}

/** Max in-call snapshot publish retries before surfacing the diagnostic. */
const SNAPSHOT_PUBLISH_MAX_RETRIES = 4;
/** Base backoff (ms) between snapshot publish retries; grows linearly (~1s total). */
const SNAPSHOT_PUBLISH_BACKOFF_MS = 100;
/** Consecutive publishes skipped while another session holds the publisher lock (#427). */
const SNAPSHOT_LOCK_BUSY_MAX_ATTEMPTS = 5;
/** How long a publish waits for a live holder before skipping (#427). */
const SNAPSHOT_LOCK_WAIT_MS = 250;
/** Minimum interval between internal live-view snapshot publications. */
const SNAPSHOT_PUBLISH_INTERVAL_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Max external missions this runtime starts per supervisor pump (env override, default 1). */
function maxExternalMissions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/** Read-only tool allowlist (scout/reviewer/challenger). */
const READ_ONLY_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "ledger_read",
  "artifact_read",
  "repo_search",
  "symbol",
  "tests_for",
];
/** Implementation tool allowlist. */
const IMPLEMENT_TOOLS = [...READ_ONLY_TOOLS, "bash", "edit", "write"];
/**
 * Roles that may hydrate from SHARED durable memory. Independent reviewer and
 * clean-room challenger are deliberately excluded (INV-007): they must not
 * inherit prior candidate memory. Implementer/scout/planner may reuse promoted
 * project knowledge (constraints, decisions, root causes).
 */
const HYDRATION_ROLES: readonly string[] = ["scout", "planner", "implementer"];

/** A planner's machine-readable task spec (spec §19.2). */
interface PlannerTaskSpec {
  title: string;
  kind: TaskKind;
  risk: RiskLevel;
  depends_on: number[];
  scope_paths: string[];
}

function isPlannerTaskSpec(v: unknown): v is PlannerTaskSpec {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    typeof o.kind === "string" &&
    (o.kind === "implementation" || o.kind === "investigation" || o.kind === "test" || o.kind === "review") &&
    (o.risk === "low" || o.risk === "medium" || o.risk === "high" || o.risk === "critical") &&
    (o.depends_on === undefined || Array.isArray(o.depends_on)) &&
    (o.scope_paths === undefined || Array.isArray(o.scope_paths))
  );
}

function classifyRisk(goal: string): RiskLevel {
  if (/typo|spelling|doc\b|comment|readme|label|rename\s+variable|format/i.test(goal)) return "low";
  if (/data\s+loss|payment|security|critical|auth|schema|breaking/i.test(goal)) return "critical";
  if (/migrat|concurr|race|api\s+compat/i.test(goal)) return "high";
  return "medium";
}

/** Compact diff block for prior-attempt feedback (kept out of the main prompt). */
function diffBlock(diff: string | null): string {
  return diff ? `Prior diff:\n${diff.slice(0, 4000)}` : "Prior diff: none";
}

/** Deterministic tournament winner-selection strategies. */
export type TournamentStrategy = "findings" | "changes" | "stable";

/** Locale-independent string compare (deterministic across ICU collations). */
function idCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Compare two tournament survivors under the chosen deterministic strategy. */
export function selectionCompare(a: TournamentEntry, b: TournamentEntry, strategy: TournamentStrategy): number {
  // A candidate that ran real checks outranks one with no verification targets
  // (zero evidence), whatever the strategy.
  if (a.outcome.noTargets !== b.outcome.noTargets) return a.outcome.noTargets ? 1 : -1;
  const fa = a.candidate.changed_files?.length ?? 0;
  const fb = b.candidate.changed_files?.length ?? 0;
  switch (strategy) {
    case "stable":
      return idCompare(a.candidate.id, b.candidate.id);
    case "changes":
      if (fa !== fb) return fa - fb;
      if (a.findings.length !== b.findings.length) return a.findings.length - b.findings.length;
      return idCompare(a.candidate.id, b.candidate.id);
    default:
      // "findings" (default): fewest material findings, then fewest files.
      if (a.findings.length !== b.findings.length) return a.findings.length - b.findings.length;
      if (fa !== fb) return fa - fb;
      return idCompare(a.candidate.id, b.candidate.id);
  }
}

/** The challenger may only reorder finalists that are comparable: a real-check lead is never displaced by a no-targets runner-up. */
export function challengerMayDisplace(lead: TournamentEntry, runner: TournamentEntry): boolean {
  return lead.outcome.noTargets === runner.outcome.noTargets;
}

/** Registry id of the worktree + branch pair a candidate owns. */
/** Mission statuses after which a mission no longer uses its build caches. */
const FINISHED_MISSION_STATUSES: ReadonlySet<string> = new Set(["COMPLETE", "FAILED", "CANCELED"]);

/** State directories whose ResourceRegistry this process already reconciled. */
const reconciledStateDirs = new Set<string>();

function candidateResourceId(branch: string): string {
  return `candidate-worktree:${branch}`;
}

function materialFindings(ledger: Ledger, candidateId: string | null): string[] {
  return ledger
    .listEntities("finding")
    .filter((f) => f.status === "open" && f.candidate_id === candidateId)
    .filter((f) => f.severity === "high" || f.severity === "medium" || f.severity === "critical")
    .map((f) => `${f.id}: ${f.claim}`);
}

/** Compact finding block fed back into the next implementer prompt (bounded). */
function findingsBlock(findings: string[]): string {
  const joined = findings.join("\n");
  return joined.length > 8000 ? `${joined.slice(0, 8000)}\n… [truncated]` : joined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The durable recovery budget, resolved in ONE place from the engineering
 * policy (#112). The scheduler derived its planner from the resolved gateway
 * policy while the supervisor ran on built-in defaults, so the two could
 * disagree about how often one failure may repeat: a saturated gateway produced
 * two identical fingerprints and the supervisor STOPped the mission the
 * scheduler was still probing.
 */
export function missionRecoveryBudget(resilience: GatewayResilienceConfig): RecoveryPlannerOptions {
  return {
    missionCeiling: DEFAULT_MISSION_RECOVERY_CEILING,
    strategyMaxAttempts: DEFAULT_STRATEGY_MAX_ATTEMPTS,
    // The same OPT-IN outage ceiling the scheduler applies. Unset by default:
    // waiting for gateway capacity is bounded by capacity, never by a clock.
    decisionTtlMs: resilience.max_outage_ms,
  };
}

const SUPPORTED_SUPERVISOR_REPAIR_ACTIONS = new Set([
  "REBUILD_WORKSPACE_MANIFEST",
  "RECONSTRUCT_EVIDENCE",
  "CHECKPOINT_SPLIT_AND_REPLACE",
  "PROBE_AND_BACKOFF",
  "REPAIR_WORKER_OUTPUT",
  "CREATE_REPAIR_TASKS",
  "REBUILD_INTEGRATION_CANDIDATE",
  "FENCE_RECONCILE_AND_RESUME",
  "WAIT_FOR_REQUIREMENT",
  "PAUSE_FOR_PERSISTENCE",
  "REPAIR_BLOCKED_MISSION",
]);

/** One tournament entrant and its independent assessment. */
export interface TournamentEntry {
  candidate: Candidate;
  outcome: VerifyOutcome;
  findings: string[];
  /** True only when an independent review COMPLETED for this candidate. */
  reviewCompleted: boolean;
  winner: boolean;
}

export interface PlanReport {
  plan_work_item: WorkItem;
  tasks: Task[];
  summary: string | null;
  outcome: "planned" | "failed" | "blocked";
  telemetry: Telemetry;
}

export interface DagReport {
  plan_work_item: WorkItem;
  tasks: Task[];
  /** Tasks in dependency (topological) order. */
  order: Task[];
  outcome: "completed" | "partial" | "failed" | "blocked";
  summary: string | null;
  telemetry: Telemetry;
}

export interface TournamentReport {
  work_item: WorkItem;
  risk: RiskLevel;
  n_candidates: number;
  entries: TournamentEntry[];
  incumbent_candidate: Candidate | null;
  evidence_ids: string[];
  outcome: "promoted" | "failed" | "blocked";
  telemetry: Telemetry;
}

/** Worker roles that map onto a reportable pipeline phase. */
const PHASE_FOR_ROLE: Partial<Record<WorkerRole, RuntimePhaseEvent["phase"]>> = {
  scout: "scout",
  implementer: "implement",
  reviewer: "review",
};

/**
 * Pipeline progress, for status surfaces (the footer today, the panel later).
 *
 * Emitted best-effort and synchronously: a listener is an observer, never a
 * participant, so a throwing or slow one must not affect an engineering run.
 */
/**
 * Opened orchestration namespaces by key, so multiple runtimes over one
 * worktree in this process share one session writer, mission store, and
 * custody set.
 */
const openedOrchestrationStores = new Map<string, OrchestrationNamespace>();
/** Live mission state owners shared by sequential runtimes for one work dir. */
const openedMissionStores = new Map<string, MissionStore>();
const openedMissionObservability = new Map<string, MissionObservability>();
const openedOrchestrationStoreReferences = new Map<string, number>();
/** Concurrent same-repository initialization is single-flight. */
const openingRuntimes = new Map<string, Promise<EngineeringRuntime>>();

export interface RuntimePhaseEvent {
  workItemId: string;
  phase: "scout" | "implement" | "verify" | "review" | "settled";
  /** The work item's goal, for a human-readable label. */
  goal?: string;
  /** Model that produced this phase, known only once a worker has run. */
  model?: string;
  /**
   * Token/cost usage for this phase, when a worker reported it.
   *
   * Per-model spend is not persisted anywhere — WorkerUsage is folded into the
   * runtime's aggregate telemetry and lost per model — so this event is the
   * source the panel accumulates from.
   */
  usage?: { input: number; output: number; cost: number };
}

/** Bounded, display-safe mission state for persistent footer/panel surfaces. */
export interface RuntimeMissionActivityEvent {
  /** UI observation time; never evidence of worker activity. */
  observedAt?: string;
  waitingReason?: string;
  waitingSince?: string;
  lastOutputAt?: string;
  workersDetail?: Array<{
    workerId: string;
    taskId?: string;
    model?: string;
    route?: string;
    node?: string;
    currentActivity?: string;
    currentActivityStartedAt?: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    lastMeaningfulProgressAt?: string;
    lastOutputAt?: string;
    lastOutputPreview?: string;
    status?: string;
    health?: string;
  }>;
  recentActivity?: Array<{ timestamp: string; summary: string; workerId?: string }>;
  missionId: string;
  title: string;
  phase: string;
  state: string;
  health: string;
  approximatePercent: number;
  acceptanceCoverage: { completed: number; total: number; approximatePercent: number };
  workflowProgress: { completed: number; total: number; approximatePercent: number };
  summary: string;
  activeWorkers: number;
  waitingWorkers: number;
  failedWorkers: number;
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt: string | null;
  action: string;
  reason: string;
  recovery: { attempt: number; maxAttempts: number };
  nextAction: string;
  nextActionAt: string | null;
  owner: string | null;
  repository: string | null;
  task: string | null;
  preservedWork: string[];
  /** Set while the operator has paused the mission (Esc); automatic repair is off. */
  operatorPausedAt?: string | null;
  /** The mission's operator model pin ("provider/id"), when it has one. */
  operatorModelPin?: string | null;
  /**
   * Why this mission deserves attention, with the fact that says so. Derived
   * from observability facts, never from model narration; absent when there is
   * nothing to say, so a surface can fall back to plain state ordering.
   */
  attention?: MissionAttention | null;
}

export interface EngineeringRuntimeOptions {
  cwd: string;
  /**
   * Optional lineage emitter (T02): mission executions, handoffs and verified
   * checkpoints are reported as typed lineage events. Absent (the default) Pi
   * emits nothing and behaves exactly as before.
   */
  lineage?: LineageEmitter;
  worker?: WorkerExecutor;
  /**
   * Optional distinct worker for the independent review + clean-room challenger
   * roles (spec §12.2, §19.3). Defaults to `worker`. Providing a different
   * model/worker here mitigates the single-model anchoring failure mode where
   * an implementer and reviewer share the same bias. This is OPTIONAL: the core
   * must not REQUIRE multiple models (project constraint) and falls back to the
   * single worker when omitted.
   */
  reviewerWorker?: WorkerExecutor;
  verifier?: VerificationProvider;
  model?: Model<any>;
  agentDir?: string;
  /** T12: inject a steering receiver (tests); undefined = decide from the global YAML and the configured control plane. */
  steeringReceiver?: SteeringReceiver | null;
  /**
   * Route mission roles through this instead of a router built from the
   * agent dir's policy and discovered models. Hosts and tests that must not
   * depend on the operator's installed providers supply their own. Only
   * routing is replaced: without `model`, a Pi worker still discovers the
   * review fallback model from its runtime.
   */
  roleRouter?: Pick<RoleRouterAdapter, "route">;
  /**
   * Merge-queue policy and hooks for mission promotion (issue #153), layered
   * over the runtime defaults: independence required only when
   * PI_ENGINEERING_REQUIRE_INDEPENDENT_REVIEW is set, and a different-family
   * reviewer counted as available when the session registry serves one.
   */
  mergeQueue?: MissionMergeQueueOptions;
  /**
   * Concise operator-facing inference status lines (fault-tolerance spec
   * §26): "model X penalized · falling back to Y", "waiting for inference
   * capacity · 45s", … One short line per event, never a stack trace. The
   * resilient runtime is armed with it in open() once the capability pool
   * exists (spec §23 production arming).
   */
  inferenceStatus?: (line: string) => void;
  /** Override the durable state directory (default: <repoRoot>/.pi-eng). */
  workDir?: string;
  /** Test seam: the filesystem reader behind mission build disk admission (default: real statfs). */
  buildStatfs?: StatfsReader;
  /**
   * Autonomous-stop gate (spec §14.5, roadmap spec §13). When the roadmap is
   * complete, `engineer()` refuses to invent new work. Returns true when the
   * roadmap is complete (new autonomous work must stop). Optional: omitted
   * means the gate is open (no autonomous stop).
   */
  roadmapComplete?: () => Promise<boolean>;
  /**
   * Optional Blackhole session-memory integration. When provided, each worker
   * session gets an isolated per-session memory store, background memory
   * workers can run, and promotion emits ledger events. Omitted or disabled
   * leaves the runtime behaving exactly as before (backward compatible).
   * The ledger is supplied by the runtime itself at open time.
   */
  blackhole?: Omit<BlackholeManagerOptions, "ledger">;
  /**
   * Optional progress hook for status surfaces. Best-effort: exceptions from a
   * listener are swallowed so status rendering can never fail a run.
   */
  onPhase?: (event: RuntimePhaseEvent) => void;
  /**
   * Optional concise user-facing mission-progress emitter (Communication Gate —
   * always open). Emitted on meaningful transitions (phase/task/worker/test/
   * review/stall/recovery/gate). Never suppresses ordinary Pi output.
   */
  onMissionObservabilityUpdate?: (missionId: string, message: string) => void;
  /** Persistent, non-notification UI feed. Values are redacted and bounded. */
  /** `replay` is true only for the open-time re-emission of stored missions. */
  onMissionActivity?: (event: RuntimeMissionActivityEvent, meta?: { replay: boolean }) => void;
  /** Bounded diagnostic when the live mission snapshot cannot be written. */
  onMissionSnapshotError?: (message: string) => void;
  /**
   * Overrides for the snapshot storage-pressure guard (sampler, sentinel,
   * probe scheduling, controller config, typed event hook). Production omits
   * this; the runtime owns `republish`, `workDir`, and `log`. House style of
   * `FileLockRecoveryHooks`: deterministic fault-injection seam, never used
   * in production paths.
   */
  snapshotPressureOverrides?: Partial<
    import("../resilience/snapshotPressureGuard.ts").SnapshotPressureGuardOptions & {
      config?: Partial<import("../resilience/storagePressure.ts").StoragePressureConfig>;
    }
  >;
  /**
   * TEST-ONLY fault injection: when set, each snapshot publish calls this and
   * throws the returned error (return null to allow the write). Models an
   * ENOSPC-class write failure without filling a real disk.
   */
  snapshotWriteFault?: () => unknown | null;
  /**
   * Optional orchestrator planner (spec 06). Defaults to a single implementer
   * task. Injected so deterministic tests and the extension can supply one.
   */
  orchestrationPlanner?: (
    mission: import("../orchestration/types.ts").Mission,
    risk: import("../orchestration/types.ts").RiskProfile,
  ) => Promise<PlanTaskInput[]>;
  /**
   * Pre-implementation plan gate (T03). Off unless given. When set, the default
   * planner's tasks pass through {@link gatePlanBeforeWorkers} before any worker
   * starts: risk-based skip | offer | require review bound to the plan digest.
   * A blocked plan yields no tasks (fail closed) and an open finding that says why.
   */
  planReview?: Pick<
    import("../orchestration/planReview.ts").PlanGateInput,
    "adapter" | "policy" | "emitter" | "replan" | "maxRevisions"
  > & { configNotes?: string[] };
  /**
   * Optional autonomous spec approval hook (design 2026-09-28). When provided,
   * material mutations are reviewed/refined/approved and their tasks are
   * materialized only from the current approval before dispatch. Defaults to
   * off so the existing fast path is preserved.
   */
  orchestrationSpecApproval?: OrchestratorOptions["specApproval"];
}

/**
 * Whether the runtime that wrote an in-store mission/repository lease is
 * provably gone, so custody may take the mission over without waiting for the
 * lease to expire. Owners are `session-<uuid>-…` (checked against the machine
 * registry) or legacy `runtime-<pid>-…` (checked by pid).
 */
/**
 * Mission-ownership ids of runtimes that are open in THIS process, on
 * globalThis so it spans an in-process reload. A lease written by this session
 * whose owner is no longer open here (closed, or from before a reload) belongs
 * to no live controller and must not be mistaken for live ownership.
 */
/** Manifest scope for planner pre-validation: writable domains and read-only prefixes under the repo. */
function plannerScope(
  manifest: import("../orchestration/types.ts").WorkspaceManifest | undefined,
  repoRoot: string,
): { writableDomains?: string[]; readOnlyPrefixes?: string[] } {
  if (!manifest) return {};
  const binding = manifest.repositories.find((r) => r.canonicalRoot === repoRoot) ?? manifest.repositories[0];
  const readOnlyPrefixes = manifest.authorizedRoots
    .filter((root) => root.access === "read")
    .map((root) => relative(repoRoot, root.canonicalPath))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
  return { ...(binding ? { writableDomains: binding.writableDomains } : {}), readOnlyPrefixes };
}

function liveOwnerIds(): Set<string> {
  const key = Symbol.for("pi-engineering.live-mission-owner-ids");
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let set = holder[key];
  if (!set) {
    set = new Set();
    holder[key] = set;
  }
  return set;
}

function isLeaseOwnerGone(ownerId: string, session: RuntimeSession): boolean {
  const sessionOwner = /^session-([0-9a-f-]{36})-/.exec(ownerId);
  if (sessionOwner) {
    if (sessionOwner[1] === session.sessionId) return !liveOwnerIds().has(ownerId);
    const registry = session.registry();
    if (!registry) return false;
    try {
      return !registry.isSessionLive(sessionOwner[1]!);
    } catch {
      return false;
    }
  }
  const legacy = /^runtime-(\d+)-/.exec(ownerId);
  if (legacy) {
    const liveness = assessProcess({ pid: Number(legacy[1]), host: hostname(), bootId: null, processStartTime: null });
    return liveness.state === "dead";
  }
  return false;
}

/**
 * Make a runtime state directory invisible to git with a self-ignoring
 * `.gitignore` (`*`), unless one is already there.
 *
 * `.pi-eng/` lives inside the checkout it serves. Untracked and unignored, it
 * is swept up by `git stash -u`, `git clean -fd` and `git add -A`, which
 * workers routinely run in-place. A stash round-trip deletes the directory and
 * recreates it with umask-default modes and new inodes, after which the
 * ArtifactStore (correctly) refuses to open it and every later runtime open for
 * that checkout fails. Ignoring the directory keeps git's hands off it.
 */
async function ensureStateDirIgnored(dir: string): Promise<void> {
  try {
    await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * The Engineering Runtime facade. Owns the ledger, artifact store, context
 * broker, git provider, verifier, and worker executor for one repository, and
 * exposes the vertical-slice workflows: scout, implement, verify, review,
 * challenge, and the adaptive `engineer` pipeline.
 */
function snapshotErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : "unknown");
}

function describeSnapshotError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.startsWith(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export class EngineeringRuntime {
  ledger: Ledger;
  /**
   * Owned-resource journal for candidate worktrees and branches (issue #143).
   * Rooted in the runtime state dir; assigned by open().
   */
  resourceRegistry: ResourceRegistry;
  /** Stall quarantine for this runtime's verification, persisted under the state dir (issue #260). */
  testQuarantine: TestQuarantine;
  artifacts: ArtifactStore;
  broker: ContextBroker | null;
  git: GitRepo | null;
  readonly cwd: string;
  workDir: string;
  readonly worker: WorkerExecutor;
  readonly reviewerWorker: WorkerExecutor | null;
  readonly verifier: VerificationProvider;
  readonly telemetry: Telemetry;
  readonly roadmapComplete: (() => Promise<boolean>) | null;
  blackhole: BlackholeManager | null;
  /** Orchestration mission store (spec 00 §3) — durable, restart-recoverable. */
  missionStore: MissionStore | null;
  /** Durable fenced authority used by orchestration dispatch. */
  missionOwnership: MissionOwnership | null;
  /** Clock-driven owner of startup and periodic nonterminal-mission reconciliation. */
  missionSupervisor: MissionSupervisor | null;
  /** T12: outbound-only steering poller; null unless enabled in the global YAML with a control plane configured. */
  steeringReceiver: SteeringReceiver | null = null;
  forkRuntime: ForkRuntime | null = null;
  externalBridge: ExternalBridge | null = null;
  /** Orchestrator facade (spec 06) — auto-invokes workflows from intent. */
  orchestrator: Orchestrator | null;
  /** The planner the orchestrator uses to turn a mission into tasks. */
  missionPlanner: NonNullable<EngineeringRuntimeOptions["orchestrationPlanner"]> | null;
  /**
   * Mission observability service (spec 00 §observability): weighted-DAG
   * progress, health/stall/loop detection, structured events, projection. Lives
   * BESIDE the controller; the controller remains authoritative. Additive.
   */
  missionObservability: MissionObservability | null;
  /** Repository bindings authorized for orchestration missions in this runtime. */
  repositoryRegistry: RepositoryRegistry;
  /** Semantic tools whose repository services are selected from execution cwd. */
  coreTools: ReturnType<typeof buildCoreTools>;
  /**
   * Mission-level gateway resilience config (spec §resilience). Time-based
   * retry window (default 90m), 10s recovery probes, circuit breaker, and
   * auto-resume — resolved from environment with injectable defaults. Lives
   * beside the orchestrator; the orchestrator remains authoritative.
   */
  resilience: import("../resilience/config.ts").GatewayResilienceConfig;
  /**
   * Models the gateway confirmed it no longer serves (a mission worker got
   * model_not_found). Mission routing excludes them for a TTL so another model
   * takes over; the interactive session model is not affected.
   */
  readonly unavailableModels = new UnavailableModels();
  readonly supportsMaintenanceModelSelection = true;
  private maintenanceModelRouter?: Pick<RoleRouterAdapter, "registry" | "select">;
  private maintenanceModelBaseline?: { contextWindow?: number; input?: readonly string[]; reasoning?: boolean };
  private readonly onPhase: ((event: RuntimePhaseEvent) => void) | null;
  private readonly onMissionSnapshotError: ((message: string) => void) | null;
  /** TEST-ONLY write-fault injector (see EngineeringRuntimeOptions). */
  private readonly snapshotWriteFault: (() => unknown | null) | null;
  /** Guard construction overrides (sampler/sentinel/schedule/config/events). */
  private readonly snapshotPressureOverrides: Partial<
    import("../resilience/snapshotPressureGuard.ts").SnapshotPressureGuardOptions & {
      config?: Partial<import("../resilience/storagePressure.ts").StoragePressureConfig>;
    }
  > | null;
  private readonly onMissionActivity: ((event: RuntimeMissionActivityEvent, meta?: { replay: boolean }) => void) | null;
  /** Work item whose phases are currently being reported (status surfaces only). */
  private missionActivityTicker: MissionActivityTicker | null = null;
  private readonly missionActivityClock = new ClockOnlyGate();
  private unsubscribeMissionActivity: (() => void) | null = null;
  private currentWorkItemId = "";
  private currentPhaseGoal = "";
  private snapshotPublishPending: Promise<MissionSnapshotFile | null> | null = null;
  private snapshotPublishDirty = false;
  private snapshotPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotPublishRetries = 0;
  /** Consecutive publishes skipped because another session held the publisher lock (#427). */
  private snapshotLockBusyAttempts = 0;
  /**
   * FR-03/04/05 — storage-pressure wiring: the controller the snapshot
   * publisher is connected to (lazy; healthy runs never construct it).
   */
  private snapshotPressure: SnapshotPressureGuard | null = null;
  /** Last successfully published snapshot; returned while publishing is paused. */
  private lastPublishedSnapshot: MissionSnapshotFile | null = null;
  /** Exactly one stale-tagged publish attempt is made after a new suspension. */
  private snapshotPublishFinalAttempt = false;
  /** This runtime's mission-ownership identity (`session-<session-id>-<uuid>`). */
  private ownershipId: string | null = null;
  /** In-process key of the orchestration namespace this runtime shares. */
  private orchestrationPath: string | null = null;
  /** Where this runtime's orchestration namespace lives (worktree / override / fallback). */
  runtimeBinding: RuntimeBinding | null = null;
  private closed = false;
  private openReferences = 1;
  private readonly maintenanceObservedMissions = new Set<string>();
  private readonly missionResumeFlights = new Map<string, Promise<import("../orchestration/types.ts").Mission>>();
  private readonly supervisorSettlementFlights = new Map<string, Promise<void>>();
  /** Spaces out supervisor repairs that keep reporting the same unchanged decision. */
  private readonly supervisorRepairBackoff = new SupervisorRepairBackoff();
  /** External missions currently being started by this runtime's pump (dedupes in-flight starts). */
  private readonly runningExternal = new Set<string>();
  private externalPumpStopped = false;

  /**
   * Serializes git mutations that touch the shared main repo (worktree create,
   * promotion merge). Parallel DAG execution (M13) runs independent tasks'
   * worker sessions concurrently but routes every repo-mutating git operation
   * through this lock so concurrent tasks never race the shared index (the
   * index.lock race that previously forced the DAG to be sequential).
   */
  private gitLock: Promise<unknown> = Promise.resolve();

  private withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitLock.then(fn);
    this.gitLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Record why publication failed on each live mission (deduplicated per message). */
  private recordSnapshotPublicationFinding(code: string, detail: string): void {
    // One open finding per mission, keyed on category: the detail embeds a
    // fresh temp path on every attempt, so it lives in evidence, not the
    // summary, and a repeated failure never adds findings (which would
    // republish and loop).
    try {
      for (const mission of this.missionStore?.listMissions() ?? []) {
        if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) continue;
        const known = this.missionStore!.listFindings(mission.mission_id).some(
          (f) => f.category === "snapshot-publication" && f.status === "open",
        );
        if (known) continue;
        this.missionStore!.addFinding({
          mission_id: mission.mission_id,
          task_id: null,
          severity: "minor",
          category: "snapshot-publication",
          file: null,
          line: null,
          summary: `Mission snapshot publication failed (${code})`,
          evidence: detail,
          recommended_action: "Check disk space and permissions of the work directory, then /mission resume.",
        });
      }
    } catch {
      // The store that failed to publish may fail to record too; the warning still carries the detail.
    }
  }

  /**
   * Publish the versioned mission snapshot file the PI WEB plugin reads
   * (spec 08). Writes `<workDir>/orchestration-snapshot.json` and returns the
   * snapshot. Never throws; callers may fire-and-forget it after any mission
   * mutation.
   */
  async publishMissionSnapshot(opts?: { force?: boolean }): Promise<MissionSnapshotFile | null> {
    if (!this.missionStore) return null;
    // FR-04: while a storage incident is suspended, do not touch the disk at
    // all — the recovery probe republishes after resume. Callers still get the
    // last successfully published snapshot so live views degrade gracefully.
    // `force` bypasses the gate: it is the recovery republish pipeline itself.
    if (!opts?.force && this.snapshotPressure?.publishPaused) return this.lastPublishedSnapshot;
    this.snapshotPublishDirty = true;
    if (this.snapshotPublishPending) return this.snapshotPublishPending;
    this.snapshotPublishPending = (async () => {
      let latest: MissionSnapshotFile | null = null;
      let lastError: unknown;
      while (this.snapshotPublishDirty) {
        this.snapshotPublishDirty = false;
        try {
          // A snapshot is presented as the durable mission view. Do not publish
          // newer in-memory state over a failed event-log head: retry queued
          // writes in order and surface persistent failure through the existing
          // operator diagnostic hook.
          await this.missionStore!.flush();
          await this.missionObservability?.flush();
          const missions = this.missionStore!.listMissions().map((m) => ({
            mission: m,
            tasks: this.missionStore!.listTasks(m.mission_id),
            findings: this.missionStore!.listFindings(m.mission_id),
            observability: this.missionObservability?.projection(m.mission_id) ?? null,
            stop: this.currentMissionStop(m.mission_id),
            spec: this.buildSpecApprovalSnapshot(m.mission_id),
            executions: this.missionStore!.listExecutions(m.mission_id),
            classifications: this.missionStore!.listFailureClassifications(m.mission_id),
            verifierStages: buildVerifierStages(this.missionStore!.listValidationEvidence(m.mission_id)),
            lifecycle: this.missionStore!.getCanonicalLifecycle(m.mission_id),
          }));
          // FR-04: after recovery is granted, the republish finalizes the stale
          // tag before the file is built so the freshly written file is clean;
          // while suspended the guard is a no-op and the tag survives.
          this.snapshotPressure?.notePublishSuccess();
          latest = buildMissionSnapshotFile(missions, this.snapshotPressure?.state() ?? null);
          // TEST-ONLY fault seam (see EngineeringRuntimeOptions.snapshotWriteFault):
          // throws at the exact point an fs write would fail, so tests can
          // model ENOSPC without filling a disk.
          const writeFault = this.snapshotWriteFault?.();
          if (writeFault) throw writeFault;
          const path = join(this.workDir, MISSION_SNAPSHOT_FILENAME);
          const published = await this.writeSnapshotMerged(path, latest);
          if (!published) {
            // Another session holds the publisher lock. Skipping loses nothing —
            // the snapshot stays dirty and the next mutation republishes — but a
            // publisher must not spin against a long-lived holder, so this flight
            // gives up after a bounded number of attempts.
            this.snapshotLockBusyAttempts += 1;
            if (this.snapshotLockBusyAttempts >= SNAPSHOT_LOCK_BUSY_MAX_ATTEMPTS) {
              this.snapshotLockBusyAttempts = 0;
              this.snapshotPublishDirty = true;
              break;
            }
            this.snapshotPublishDirty = true;
            await delay(SNAPSHOT_PUBLISH_BACKOFF_MS * this.snapshotLockBusyAttempts);
            continue;
          }
          this.snapshotLockBusyAttempts = 0;
          // A successful publish resets the in-call retry counter so the next
          // failure starts fresh instead of inheriting an elevated backoff.
          this.snapshotPublishRetries = 0;
          this.snapshotPublishFinalAttempt = false;
          this.lastPublishedSnapshot = published;
        } catch (error) {
          latest = null;
          lastError = error;
          // FR-03/04: a recoverable storage incident SUSPENDS instead of
          // retrying — no retry storm against a full disk. One best-effort
          // stale-tagged attempt is made, then the write yields to the recovery
          // probe, which republishes after resume (no duplicate finding: the
          // incident event already notified once).
          if (await this.noteSnapshotStoragePressure(error)) {
            this.snapshotPublishRetries = 0;
            if (!this.snapshotPublishFinalAttempt) {
              this.snapshotPublishFinalAttempt = true;
              this.snapshotPublishDirty = true;
              continue;
            }
            this.snapshotPublishDirty = false;
            break;
          }
          // Retry within this call with bounded backoff instead of giving up on
          // the first error. A transient non-storage error self-heals once the
          // condition clears; only after the in-call retries are exhausted do we
          // surface the diagnostic and leave retry to a later observability
          // change. The dirty flag stays set across retries so a concurrent
          // publish call coalesces into this flight.
          if (this.snapshotPublishRetries < SNAPSHOT_PUBLISH_MAX_RETRIES) {
            this.snapshotPublishRetries += 1;
            this.snapshotPublishDirty = true;
            await delay(SNAPSHOT_PUBLISH_BACKOFF_MS * this.snapshotPublishRetries);
            continue;
          }
          this.snapshotPublishDirty = false;
          this.snapshotPublishRetries = 0;
          const detail = describeSnapshotError(lastError);
          this.recordSnapshotPublicationFinding(snapshotErrorCode(lastError), detail);
          try {
            this.onMissionSnapshotError?.(
              `Mission snapshot publication failed (${detail}); live mission detail may be stale.`,
            );
          } catch {
            // Diagnostics are observers, never participants in execution.
          }
          break;
        }
      }
      return latest;
    })().finally(() => {
      this.snapshotPublishPending = null;
      if (this.snapshotPublishDirty) void this.publishMissionSnapshot();
    });
    return this.snapshotPublishPending;
  }

  /**
   * Write the snapshot as a merge under the publisher lock (#427).
   *
   * Several `pi` sessions share one `.pi-eng` directory. Each one only knows the
   * missions IT holds live, so a plain write made the published file whichever
   * session wrote last — a blocked mission read back as absent minutes later.
   * Here the write reads the file first, replaces only this publisher's entries,
   * and keeps every other publisher's, so no session can erase another's view.
   *
   * Returns null when a live holder owns the publisher lock: merging without it
   * would have both publishers merge against the pre-merge file, which is the
   * same loss with extra steps. The caller leaves the snapshot dirty instead.
   */
  private async writeSnapshotMerged(path: string, snapshot: MissionSnapshotFile): Promise<MissionSnapshotFile | null> {
    const lock = await acquireSnapshotPublisherLock({
      dir: this.workDir,
      pid: process.pid,
      waitMs: SNAPSHOT_LOCK_WAIT_MS,
    });
    if (!lock) return null;
    try {
      const existing = await readMissionSnapshotFile(path);
      const tag = { ownerPid: process.pid, publishedAtMs: Date.now() };
      const merged = mergeSnapshotFiles(existing, tagSnapshotPublisher(snapshot, tag), tag);
      const temporary = join(this.workDir, `.${MISSION_SNAPSHOT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(merged, null, 2), "utf8");
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      // The tags describe the FILE this process wrote, not the logical snapshot the
      // runtime reasons about. Returning them would make the value differ by code path
      // — a disk-backed read carries tags, an in-memory retry does not — and callers
      // that compare consecutive publishes would see a change that is only bookkeeping.
      return {
        ...merged,
        missions: merged.missions.map(({ ownerPid: _owner, publishedAtMs: _at, ...rest }) => rest),
      };
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /**
   * Classify a snapshot publish failure. On a recoverable storage incident
   * this suspends the pressure controller (pauses snapshot retries, tags the
   * published snapshot stale, starts the recovery probe). Returns true while
   * the publisher is paused — the caller must stop retrying.
   */
  private async noteSnapshotStoragePressure(error: unknown): Promise<boolean> {
    const guard = this.snapshotPressureGuard;
    await guard.notePublishError(error, await this.storagePressureHints());
    return guard.publishPaused;
  }

  /** Coalesce high-frequency observability updates before rebuilding the full snapshot. */
  private scheduleMissionSnapshot(): void {
    if (this.snapshotPublishTimer || this.closed) return;
    this.snapshotPublishTimer = setTimeout(() => {
      this.snapshotPublishTimer = null;
      void this.publishMissionSnapshot();
    }, SNAPSHOT_PUBLISH_INTERVAL_MS);
    this.snapshotPublishTimer.unref?.();
  }

  /** Best-effort measurement hints for storage classification (never throws). */
  private async storagePressureHints(): Promise<StorageHints> {
    const hints: StorageHints = { path: this.workDir };
    try {
      const st = await statfs(this.workDir);
      hints.freeBytes = st.bavail * st.bsize;
      hints.freeInodes = st.ffree;
    } catch {
      // Hints are best-effort; classification falls back to the errno code.
    }
    return hints;
  }

  /** The storage-pressure guard, created lazily on first need. */
  private get snapshotPressureGuard(): SnapshotPressureGuard {
    if (!this.snapshotPressure) {
      this.snapshotPressure = new SnapshotPressureGuard({
        ...(this.snapshotPressureOverrides ?? {}),
        workDir: this.workDir,
        // The recovery republish pipeline (bypasses the pause gate).
        republish: () => this.publishMissionSnapshot({ force: true }),
        log: (_level, message) => {
          try {
            this.onMissionSnapshotError?.(message);
          } catch {
            // Diagnostics are observers, never participants in execution.
          }
        },
        // (#416) The suspend marks which tasks were RUNNING so their later
        // failures classify as DISK_SUSPENDED (checkpoint-resume, capacity
        // budget) instead of generic noise; the recovery event closes the
        // episode so post-recovery failures are judged normally again. The
        // override-supplied observer still runs — this hook chains, never
        // replaces.
        onEvent: (event) => {
          try {
            this.snapshotPressureOverrides?.onEvent?.(event);
          } catch {
            // Observer failures never participate in execution.
          }
          const store = this.missionStore;
          if (!store) return;
          try {
            if (event.kind === "incident") {
              for (const mission of store.listMissions()) {
                if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) continue;
                const running = store
                  .listTasks(mission.mission_id)
                  .filter((task) => task.status === "RUNNING")
                  .map((task) => task.task_id);
                if (running.length === 0) continue;
                store.markDiskSuspendEpisode(mission.mission_id, {
                  taskIds: running,
                  ...(event.incident.path ? { incidentPath: event.incident.path } : {}),
                });
              }
            } else if (event.kind === "recovered") {
              for (const mission of store.listMissions()) store.resolveDiskSuspendEpisode(mission.mission_id);
            }
          } catch {
            // Episode bookkeeping is durable best-effort here: the store is the
            // authority and never depends on this hook (a lost mark degrades
            // to today's generic classification, never to corruption).
          }
        },
      });
    }
    return this.snapshotPressure;
  }

  private currentMissionStop(missionId: string) {
    const generation = this.missionStore?.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    return (
      this.missionStore
        ?.listMissionStops(missionId)
        .filter((stop) => stop.resumptionGeneration === generation)
        .at(-1) ?? null
    );
  }

  /** Project the durable autonomous-spec-approval state into the mission snapshot. */
  private buildSpecApprovalSnapshot(
    missionId: string,
  ): import("../orchestration/missionSnapshot.ts").MissionSpecInput | null {
    const store = this.missionStore;
    if (!store) return null;
    const approval = store.getSpecApproval(missionId);
    const revision = store.getSpecRevision(missionId);
    const invalidation = store.getSpecInvalidation(missionId);
    const stages = store.listSpecStages(missionId);
    if (!approval && !revision && stages.length === 0) return null;
    const latestStage = stages.at(-1) ?? null;
    return {
      phase: approval ? "materialize" : latestStage ? latestStage.stage : "idle",
      revisionNumber: revision?.revisionNumber ?? 0,
      semanticSpecHash: revision?.semanticSpecHash ?? null,
      planHash: revision?.planHash ?? null,
      semanticRoundsUsed: 0,
      semanticRoundsLimit: 2,
      activeStage: latestStage?.stage ?? null,
      activeStageDeadlineAt: latestStage?.deadlineAt ?? null,
      overallDeadlineAt: latestStage?.deadlineAt ?? null,
      approvalId: approval?.approvalId ?? null,
      invalidatedApprovalId: invalidation?.approvalId ?? null,
      warning: null,
      stopReason: null,
      resumeCondition: null,
    };
  }

  /** Notify status surfaces of pipeline progress. Never throws into the run. */
  private emitPhase(event: RuntimePhaseEvent): void {
    if (!this.onPhase) return;
    try {
      this.onPhase(event);
    } catch {
      // A status listener is an observer, never a participant.
    }
  }

  /** Project observability into a compact surface event without raw commands or metadata. */
  private emitMissionActivity(missionId: string, observedAt = new Date().toISOString(), replay = false): void {
    if (!this.onMissionActivity) return;
    this.missionActivityTicker?.watch(missionId);
    const projection = this.missionObservability?.projection(missionId);
    if (!projection) return;
    const summary = projection.summary;
    const mission = this.missionStore?.getMission(missionId);
    const safe = (value: string) =>
      redactSecrets(
        [...value]
          .map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? " " : character;
          })
          .join(""),
      )
        .trim()
        .slice(0, 240);
    const raw = summary.currentActivity?.summary ?? summary.currentObjective ?? summary.title;
    const bounded = redactSecrets(raw)
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 240);
    try {
      const event: RuntimeMissionActivityEvent = {
        observedAt,
        waitingReason: summary.waitingReason,
        waitingSince: summary.waitingSince,
        lastOutputAt: projection.workers
          .map((worker) => worker.lastOutputAt)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1),
        workersDetail: [...projection.workers]
          .sort((a, b) => {
            const priority = (worker: typeof a) =>
              worker.health === "stalled" ? 0 : worker.state === "running" || worker.state === "waiting" ? 1 : 2;
            return priority(a) - priority(b);
          })
          .slice(0, 32)
          .map((worker) => ({
            workerId: safe(worker.workerId),
            taskId: worker.taskId ? safe(worker.taskId) : undefined,
            model: worker.model ? safe(worker.model) : undefined,
            route: worker.route ? safe(worker.route) : undefined,
            node: worker.node ? safe(worker.node) : undefined,
            currentActivity: worker.currentActivity ? safe(worker.currentActivity) : undefined,
            currentActivityStartedAt: worker.currentActivityStartedAt,
            startedAt: worker.startedAt,
            lastHeartbeatAt: worker.lastHeartbeatAt,
            lastMeaningfulProgressAt: worker.lastMeaningfulProgressAt,
            lastOutputAt: worker.lastOutputAt,
            lastOutputPreview: worker.lastOutputPreview
              ? boundedToolOutputPreview(worker.lastOutputPreview)
              : undefined,
            status: worker.state,
            health: worker.health,
          })),
        recentActivity: projection.activity.slice(-8).map((activity) => ({
          timestamp: activity.at,
          summary: safe(activity.summary),
          workerId: activity.workerId ? safe(activity.workerId) : undefined,
        })),
        missionId,
        title: redactSecrets(summary.title)
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 160),
        phase: summary.phase,
        state: summary.state,
        health: summary.health,
        approximatePercent: summary.progress.approximatePercent,
        acceptanceCoverage: { ...summary.acceptanceCoverage },
        workflowProgress: { ...summary.workflowProgress },
        summary: bounded,
        activeWorkers: summary.workers.active,
        waitingWorkers: summary.workers.waiting,
        failedWorkers: summary.workers.failed,
        ...(summary.lastHeartbeatAt ? { lastHeartbeatAt: summary.lastHeartbeatAt } : {}),
        lastMeaningfulProgressAt: summary.lastMeaningfulProgressAt,
        action: safe(summary.action),
        reason: redactSecrets(summary.reason)
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 240),
        recovery: { ...summary.recovery },
        nextAction: redactSecrets(summary.nextAction)
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 240),
        nextActionAt: summary.nextActionAt,
        owner: summary.owner,
        repository: summary.repository,
        task: summary.task,
        preservedWork: summary.preservedWork.map((value) => redactSecrets(value).slice(0, 240)).slice(0, 8),
        operatorPausedAt: mission?.operator_paused_at ?? null,
        attention: attentionFromSummary(summary, {
          now: Date.parse(observedAt) || Date.now(),
          // The counters live per worker; the strongest one across live workers
          // is what an operator would act on.
          loopSignals: projection.workers
            .filter((worker) => worker.state === "running" || worker.state === "waiting")
            .flatMap((worker) => this.missionObservability?.loopSignals(missionId, worker.workerId) ?? []),
          operatorPausedAt: mission?.operator_paused_at ?? null,
          review: { blockingOpen: projection.review.blockingOpen },
          tests: { failed: projection.tests.failed },
        }),
        operatorModelPin: mission?.operator_model_pin
          ? `${mission.operator_model_pin.provider}/${mission.operator_model_pin.id}`
          : null,
      };
      this.missionActivityClock.remember(
        missionId,
        [
          event.waitingSince,
          event.lastOutputAt,
          event.lastHeartbeatAt,
          event.lastMeaningfulProgressAt,
          ...(event.workersDetail ?? []).flatMap((worker) => [
            worker.currentActivityStartedAt,
            worker.lastHeartbeatAt,
            worker.lastMeaningfulProgressAt,
            worker.lastOutputAt,
          ]),
        ],
        Date.parse(observedAt),
      );
      this.onMissionActivity(event, { replay });
    } catch {
      // UI listeners are observers, never participants in mission execution.
    }
  }

  private constructor(opts: EngineeringRuntimeOptions) {
    this.cwd = opts.cwd;
    this.maintenanceModelBaseline = opts.model
      ? { contextWindow: opts.model.contextWindow, input: opts.model.input, reasoning: opts.model.reasoning }
      : undefined;
    this.workDir = opts.workDir ?? "";
    this.worker = opts.worker ?? new PiWorkerExecutor({ model: opts.model, agentDir: opts.agentDir });
    this.reviewerWorker = opts.reviewerWorker ?? null;
    this.verifier = opts.verifier ?? new CommandVerifier();
    this.roadmapComplete = opts.roadmapComplete ?? null;
    this.onPhase = opts.onPhase ?? null;
    this.onMissionSnapshotError = opts.onMissionSnapshotError ?? null;
    this.snapshotWriteFault = opts.snapshotWriteFault ?? null;
    this.snapshotPressureOverrides = opts.snapshotPressureOverrides ?? null;
    this.onMissionActivity = opts.onMissionActivity ?? null;
    this.blackhole = null;
    this.telemetry = {
      workers: {},
      toolCalls: 0,
      verifyStages: 0,
      evidence: 0,
      blockedOrFailedWorkers: 0,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      turns: 0,
    };
    // Assigned by open().
    this.ledger = undefined as unknown as Ledger;
    this.resourceRegistry = undefined as unknown as ResourceRegistry;
    this.testQuarantine = undefined as unknown as TestQuarantine;
    this.artifacts = undefined as unknown as ArtifactStore;
    this.broker = null;
    this.git = null;
    this.missionStore = null;
    this.missionOwnership = null;
    this.missionSupervisor = null;
    this.orchestrator = null;
    this.missionPlanner = null;
    this.missionObservability = null;
    this.repositoryRegistry = new RepositoryRegistry();
    this.coreTools = [];
    // Resolve the time-based gateway resilience config from environment.
    this.resilience = resolveGatewayResilienceConfig();
  }

  static async open(opts: EngineeringRuntimeOptions): Promise<EngineeringRuntime> {
    const git = await GitRepo.open(opts.cwd);
    const repoRoot = git ? git.root : opts.cwd;
    const workDir = opts.workDir ?? join(repoRoot, ".pi-eng");
    // Orchestration state is namespaced by git WORKTREE identity (common dir +
    // worktree root), never by launch directory or repository name, and every
    // session writes its own stream, so concurrent sessions never contend.
    const session = RuntimeSession.current();
    const identity = await resolveWorktreeIdentity(repoRoot);
    const binding = resolveRuntimeBinding({ identity, workDir, sessionId: session.sessionId });
    const openKey = `${resolve(repoRoot)}\0${resolve(workDir)}\0${namespaceKey(binding)}`;
    const existing = openingRuntimes.get(openKey);
    if (existing) {
      const runtime = await existing;
      runtime.retainOpenReference();
      return runtime;
    }
    const opening = EngineeringRuntime.openResolved(opts, git, repoRoot, workDir, binding, session);
    openingRuntimes.set(openKey, opening);
    try {
      return await opening;
    } finally {
      // Only initialization is shared. A later open must rebuild dynamic
      // profile/credential-dependent services while reusing live mission state.
      if (openingRuntimes.get(openKey) === opening) openingRuntimes.delete(openKey);
    }
  }

  private static async openResolved(
    opts: EngineeringRuntimeOptions,
    git: GitRepo | null,
    repoRoot: string,
    workDir: string,
    binding: RuntimeBinding,
    session: RuntimeSession,
  ): Promise<EngineeringRuntime> {
    await mkdir(workDir, { recursive: true });
    await ensureStateDirIgnored(workDir);
    const ledger = await Ledger.create(join(workDir, "ledger.jsonl"));
    const artifacts = await ArtifactStore.create(join(workDir, "artifacts"));
    const broker = await ContextBroker.open(repoRoot);
    const rt = new EngineeringRuntime(opts);
    rt.ledger = ledger;
    rt.resourceRegistry = new ResourceRegistry(workDir, hostname());
    rt.testQuarantine = new TestQuarantine(workDir);
    // Records this host left in `releasing` (a crash between beginRelease and
    // completeRelease) are finished or rolled back before any mission work.
    await rt.reconcileResources(workDir);
    rt.artifacts = artifacts;
    rt.broker = broker;
    rt.git = git;
    rt.workDir = workDir;
    // Orchestration: durable mission store + orchestrator wired to the existing
    // worker/verifier/git primitives. Restart-recoverable via the session event
    // streams of this worktree's namespace (merged on read). Runtimes over the
    // same namespace in this process share one writer, mission store and
    // custody set. A legacy `.pi-eng/orchestration.jsonl` is imported, never
    // modified.
    const orchestrationPath = namespaceKey(binding);
    rt.runtimeBinding = binding;
    if (rt.worker instanceof PiWorkerExecutor && binding.kind !== "memory") {
      rt.worker.setTranscriptDir(worktreeRuntimeDir(resolveStateRoot(), binding.identity.worktreeId));
    }
    try {
      let namespace = openedOrchestrationStores.get(orchestrationPath);
      if (!namespace) {
        const registry = await session.ensureRegistered();
        namespace = await openOrchestrationNamespace({
          binding,
          sessionId: session.sessionId,
          registry,
          leases: () => RuntimeSession.current().registry()?.leases ?? null,
          leaseOwner: () => session.leaseOwner(),
        });
        openedOrchestrationStores.set(orchestrationPath, namespace);
      }
      const orchestrationBackend = namespace.backend;
      const custody = namespace.custody;
      // An unbound session binds to the first worktree runtime it opens;
      // later moves are explicit rebinds driven by workspace activity.
      if (!session.binding) session.bindTo(sessionBindingInfo(binding));
      openedOrchestrationStoreReferences.set(
        orchestrationPath,
        (openedOrchestrationStoreReferences.get(orchestrationPath) ?? 0) + 1,
      );
      rt.orchestrationPath = orchestrationPath;
      rt.missionStore = openedMissionStores.get(orchestrationPath) ?? MissionStore.open(orchestrationBackend);
      openedMissionStores.set(orchestrationPath, rt.missionStore);
      if (opts.lineage) rt.missionStore.setLineage(opts.lineage);
      rt.ownershipId = `session-${session.sessionId}-${randomUUID()}`;
      liveOwnerIds().add(rt.ownershipId);
      rt.missionOwnership = new MissionOwnership(rt.missionStore, {
        ownerId: rt.ownershipId,
        custody,
        isOwnerGone: (ownerId) => isLeaseOwnerGone(ownerId, session),
      });
      // Register the workspace authority for every mission so the repository
      // binding survives a runtime restart (reopen/resume). A manifest whose
      // bound worktree has been reclaimed (cleanup, disk pressure) must not
      // prevent the orchestrator from starting: register each one defensively
      // and log, rather than letting a single stale manifest abort init.
      for (const mission of rt.missionStore.listMissions()) {
        const manifest = rt.missionStore.getWorkspaceManifest(mission.mission_id);
        if (manifest) {
          try {
            await rt.repositoryRegistry.register(manifest);
          } catch (error) {
            console.warn(
              `[pi-engineering] Skipping workspace registration for ${mission.mission_id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      // Mission observability shares the SAME durable event store as the mission
      // controller: its `mission.obs.*` events are ignored by MissionStore replay
      // and replayed by the observability service, so progress/activity/workers/
      // tests/review survive restart/reconnect (spec 01/05). Communication gate
      // is always open — the update emitter never suppresses ordinary Pi output.
      rt.missionObservability = openedMissionObservability.get(orchestrationPath) ?? null;
      if (!rt.missionObservability) {
        rt.missionObservability = MissionObservability.open({
          backend: orchestrationBackend,
          store: rt.missionStore,
          onUpdate: opts.onMissionObservabilityUpdate,
        });
        openedMissionObservability.set(orchestrationPath, rt.missionObservability);
      }
      rt.missionActivityTicker = new MissionActivityTicker({
        state: (missionId) => rt.missionStore?.getMission(missionId)?.status,
        emit: (missionId, observedAt) => {
          // Clock-only tick: skip the rebuild and redraw while no displayed age has changed.
          if (!rt.missionActivityClock.due(missionId, Date.parse(observedAt))) return;
          rt.emitMissionActivity(missionId, observedAt);
        },
      });
      rt.unsubscribeMissionActivity = rt.missionObservability.subscribe((missionId) => {
        rt.scheduleMissionSnapshot();
        rt.emitMissionActivity(missionId);
      });
      for (const missionId of rt.missionObservability.listMissionIds()) {
        rt.emitMissionActivity(missionId, undefined, true);
      }
      // Route orchestration worker roles through the capability router so per-role
      // model placement (policy.routing.roles, e.g. a pinned implementer/reviewer)
      // is honored by the mission pipeline, matching the lifecycle roleRunner
      // path. Degrades to the worker's construction-time default model when the
      // router cannot be built, so core never requires discovery or network.
      let routeModel: RouteModel | undefined;
      const holdPin = (await loadExecutionConfig(repoRoot)).hold_mission_model;
      let reviewFallbackModel = opts.model ? { provider: opts.model.provider, id: opts.model.id } : undefined;
      // The operator's explicit model switch (Pi `/model`), adopted by this
      // session's missions at their next inference boundary and persisted on
      // the mission (src/runtime/operatorModelPin.ts).
      const currentOperatorPin = (missionId: string) =>
        rt.missionStore
          ? adoptOperatorModelPin({
              store: rt.missionStore,
              missionId,
              sessionId: RuntimeSession.current().sessionId,
              onTransition: (transition) => rt.reportPinTransition(transition),
            })
          : null;
      let routerAdapter: RoleRouterAdapter | Pick<RoleRouterAdapter, "route"> | undefined;
      try {
        const { createRoleRouter } = await import("../capability/adapter.ts");
        const sharedRuntime = rt.worker instanceof PiWorkerExecutor ? await rt.worker.getModelRuntime() : undefined;
        if (!reviewFallbackModel && sharedRuntime) {
          const available = (await sharedRuntime.getAvailable())[0];
          if (available) reviewFallbackModel = { provider: available.provider, id: available.id };
        }
        routerAdapter =
          opts.roleRouter ??
          (rt.worker instanceof PiWorkerExecutor
            ? await createRoleRouter({
                cwd: repoRoot,
                agentDir: opts.agentDir,
                modelRuntime: sharedRuntime,
                allowModelNetwork: false,
              })
            : undefined);
        // Models the gateway stopped serving are excluded for a TTL, so a
        // mission's workers (and the recovery probe) move to another model.
        // Custom executors own model execution unless the caller supplies a
        // router. An absent Pi catalog is not an explicitly empty routing pool.
        routeModel = routerAdapter
          ? createRouteModel({
              router: routerAdapter,
              unavailable: rt.unavailableModels,
              reviewFallbackModel,
              operatorPin: currentOperatorPin,
              holdPin,
            })
          : undefined;
      } catch {
        // No router: role pins and ranking are unavailable, an operator pin
        // still places every role.
        routeModel = createRouteModel({
          unavailable: rt.unavailableModels,
          reviewFallbackModel,
          operatorPin: currentOperatorPin,
          holdPin,
        });
      }
      const maintenanceRouter = routerAdapter as RoleRouterAdapter | undefined;
      if (maintenanceRouter?.registry && typeof maintenanceRouter.select === "function")
        rt.maintenanceModelRouter = maintenanceRouter;
      // Production arming (fault-tolerance spec §23): the capability pool
      // (registry + router) now exists, so arm the worker's resilient runtime
      // with capability-based fallback (RoleRouter + RequiredModelEnvelope),
      // the durable WAITING_FOR_INFERENCE_CAPACITY park — persisted as the
      // real mission state, not a comment — and operator status lines. The
      // install is idempotent-but-updatable, so this re-arm updates the live
      // runtime even though the executor armed itself earlier.
      if (rt.worker instanceof PiWorkerExecutor) {
        const pool = routerAdapter as RoleRouterAdapter | undefined;
        if (pool?.registry && pool.router) {
          rt.worker.rearmResilience({
            capabilityRegistry: pool.registry,
            roleRouter: pool.router,
            inferenceScheduler: new MissionCapacityScheduler({
              registry: () => pool.registry,
              transitionMission: (missionId, state) => {
                try {
                  // The durable fact is the state transition itself; the
                  // orchestrator's observability surfaces it like any other
                  // mission transition.
                  rt.missionStore?.transitionMission(missionId, state, "system");
                } catch {
                  // guarded transition — the orchestrator owns the state
                }
              },
            }),
            ...(opts.inferenceStatus ? { inferenceStatus: opts.inferenceStatus } : {}),
          });
        }
      }
      const registryWorker = rt.worker instanceof PiWorkerExecutor ? rt.worker : undefined;
      const backends = realBackends({
        worker: rt.worker,
        verifier: rt.verifier,
        artifacts: rt.artifacts,
        git: rt.git,
        cwd: repoRoot,
        quarantine: rt.testQuarantine,
        // Mission verification builds into a per-mission target dir under the
        // runtime state dir, is refused on a full disk, and frees idle caches
        // of finished missions under pressure (R-BUILD, issue #259). A mission
        // this store does not know is treated as active, never collected.
        build: {
          stateDir: workDir,
          registry: rt.resourceRegistry,
          ...(opts.buildStatfs ? { statfs: opts.buildStatfs } : {}),
          isMissionActive: (missionId) => {
            const status = rt.missionStore?.getMission(missionId)?.status;
            return status === undefined || !FINISHED_MISSION_STATUSES.has(status);
          },
        },
        routeModel,
        // A takeover mark is gateway-confirmed (404 model_not_found or a model
        // pruned from the runtime); an attempt that succeeds clears it.
        onModelUnavailable: (model, context) => rt.unavailableModels.mark(model, context, { confirmed: true }),
        onModelServed: (model) => rt.unavailableModels.clear(model),
        isModelUnavailable: (model) => rt.unavailableModels.has(model),
        reviewFallbackModel,
        // Gate roles routing cannot place (no repo policy, candidates dead) are
        // placed from the session's model registry.
        registryModels: registryWorker
          ? async () =>
              (await (await registryWorker.getModelRuntime()).getAvailable()).map((model) => ({
                provider: model.provider,
                id: model.id,
                contextWindow: model.contextWindow,
                input: model.input,
                reasoning: model.reasoning,
                // Match PiModelRuntimeSource: Pi registry models support tools.
                toolCall: true,
              }))
          : undefined,
        enabledModels: () => {
          try {
            return SettingsManager.create(repoRoot, opts.agentDir ?? getAgentDir()).getEnabledModels();
          } catch {
            return undefined;
          }
        },
        currentOperatorPin,
        repository: async (repoId) => {
          if (repoId) {
            const context = await rt.repositoryRegistry.resolveActiveForExecution(repoId);
            return { git: context.git, cwd: context.root };
          }
          if (!rt.git) throw new Error(`No legacy Git repository is bound for ${repoRoot}`);
          return { git: rt.git, cwd: repoRoot };
        },
      });
      // The default plan honours the routed workflow class. A research or
      // investigation mission MUST NOT get a repo-mutating worker: mutation is
      // derived from the workflow, never assumed. (Dogfood caught the planner
      // hardcoding mutates_repo:true, which let a read-only "why is this failing?"
      // request write to the repository.)
      // Plan review is opt-in: an explicit option, else the `plan_review` block of
      // the repo's engineering.yaml; absent means OFF and nothing below changes.
      const planReviewSettings =
        opts.planReview !== undefined ? opts.planReview : await loadPlanReviewSettings(repoRoot, opts.agentDir);
      const defaultPlanner: NonNullable<typeof opts.orchestrationPlanner> = async (mission) => {
        const mutates = workflowMutatesRepo(mission.workflow_class);
        const acceptanceIds = mission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        );
        const single = (): PlanTaskInput => ({
          kind: "agent",
          role: mutates ? "implementer" : "investigator",
          objective: mission.goal,
          mutates_repo: mutates,
          write_domains: mutates ? ["**"] : [],
          isolation: mutates ? "worktree" : "none",
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: acceptanceIds,
          deliverables: mutates ? ["implementation", "targeted-tests"] : ["investigation-report"],
          // No execution_budget_ms: a task runs as long as it shows activity
          // (an opt-in limits.max_task_wall_clock_ms is applied by the
          // orchestrator when configured).
          checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
          max_attempts: 3,
          failure_policy: "retry",
        });
        // Non-trivial goals get ONE planner call (PLANNER_PROMPT) on the best
        // "planner"-routed model so independent work gets real write domains;
        // a malformed plan falls back to the single task and never blocks.
        const planWith = (planGoal: string, objective: string) =>
          planMission({
            goal: planGoal,
            mutates,
            mode: missionPlannerMode(),
            acceptanceIds,
            single: () => ({ ...single(), objective }),
            ...plannerScope(rt.missionStore?.getWorkspaceManifest(mission.mission_id), repoRoot),
            runPlanner: async (task) => {
              const route = await routeModel?.("planner", { missionId: mission.mission_id }).catch(() => undefined);
              // Bounded: a hard timeout aborts the one call; thinking is allowed
              // for role "planner" (thinkingPolicy) and the role's token budget applies.
              const abort = new AbortController();
              const timer = setTimeout(() => abort.abort(), plannerTimeoutMs());
              try {
                const run = await rt.worker.run({
                  role: "planner",
                  task,
                  tools: READ_ONLY_TOOLS,
                  cwd: repoRoot,
                  signal: abort.signal,
                  maxContextTokens: ROLE_BUDGETS.planner.hardMaxTokens,
                  ...(route ? { modelOverride: { provider: route.provider, id: route.id } } : {}),
                });
                if (abort.signal.aborted) throw new Error(`planner timed out after ${plannerTimeoutMs()} ms`);
                if (run.error) {
                  if (run.error.startsWith("transient:") || classifyError(run.error).retryable) {
                    throw new PlannerTransientError(run.error);
                  }
                  throw new Error(run.error);
                }
                return run.result;
              } catch (error) {
                if (error instanceof PlannerTransientError || abort.signal.aborted) throw error;
                if (classifyError(error).retryable) throw new PlannerTransientError(String(error));
                throw error;
              } finally {
                clearTimeout(timer);
              }
            },
          });
        const planned = await planWith(mission.goal, mission.goal);
        if (planned.fallbackReason) {
          rt.missionStore?.addFinding({
            mission_id: mission.mission_id,
            task_id: null,
            severity: "minor",
            category: "mission_planner",
            file: null,
            line: null,
            summary: "Mission planner output unusable; ran the goal as a single task.",
            evidence: planned.fallbackReason.slice(0, 1000),
            recommended_action: "None required; the mission continues with one task.",
          });
        }
        if (planned.notes?.length) {
          rt.missionStore?.addFinding({
            mission_id: mission.mission_id,
            task_id: null,
            severity: "minor",
            category: "mission_planner",
            file: null,
            line: null,
            summary: "Mission planner intent was only partly honoured.",
            evidence: planned.notes.join("; ").slice(0, 1000),
            recommended_action: "None required; the allowed scope was kept.",
          });
        }
        if (planned.clarification) {
          rt.missionStore?.addFinding({
            mission_id: mission.mission_id,
            task_id: null,
            severity: "minor",
            category: PLANNER_CLARIFICATION_CATEGORY,
            file: null,
            line: null,
            summary: "Mission planner needs clarification of the goal.",
            evidence: planned.clarification.slice(0, 1000),
            recommended_action: "Confirm or restate what this mission should do.",
          });
        }
        if (planReviewSettings && rt.missionStore && !planned.clarification && planned.tasks.length > 0) {
          // Herdr projection: the mission node first (the plan's `produced` edge needs it), then the gate's own
          // revision / decision events through the same emitter. Null without a configured `herdr:` block.
          emitMissionPlanned(opts.lineage, {
            missionId: mission.mission_id,
            title: mission.title || mission.goal.slice(0, 80),
            source: "standalone",
          });
          const gated = await gatePlanBeforeWorkers({
            // Changes requested: plan again with the reviewer's feedback as input.
            // The single-task fallback carries the feedback too, so the revision
            // always differs and needs its own decision.
            replan: async ({ annotations, revision }) => {
              const feedback = annotations.length
                ? annotations.map((a) => `- ${a}`).join("\n")
                : "- (the reviewer asked for changes without comments)";
              const augmented = `${mission.goal}\n\nA plan reviewer requested changes to revision ${revision.revision}. Address this feedback:\n${feedback}`;
              const replanned = await planWith(augmented, augmented);
              return replanned.tasks.length > 0 ? replanned.tasks : revision.tasks;
            },
            ...planReviewSettings,
            emitter: (planReviewSettings as { emitter?: PlanLineageEmitter | null }).emitter ?? opts.lineage ?? null,
            missionId: mission.mission_id,
            goal: mission.goal,
            plan: async () => planned.tasks,
            ledger: rt.missionStore,
          });
          if (gated.status === "blocked") {
            rt.missionStore.addFinding({
              mission_id: mission.mission_id,
              task_id: null,
              severity: "major",
              category: PLANNER_CLARIFICATION_CATEGORY,
              file: null,
              line: null,
              summary: `Plan review blocked implementation (${gated.code}).`,
              evidence: [gated.reason, ...(planReviewSettings.configNotes ?? [])].join("\n").slice(0, 1000),
              recommended_action:
                gated.code === "plannotator_unavailable"
                  ? "Restore the plan review service or record an explicit operator override with a reason."
                  : "Revise the plan and resubmit for review.",
            });
            return [];
          }
          if (planReviewSettings.configNotes?.length) {
            rt.missionStore.addFinding({
              mission_id: mission.mission_id,
              task_id: null,
              severity: "minor",
              category: "plan_review_config",
              file: null,
              line: null,
              summary: "Plan review configuration was only partly honoured.",
              evidence: planReviewSettings.configNotes.join("\n").slice(0, 1000),
              recommended_action: "Fix or remove the ignored plan_review settings.",
            });
          }
          return gated.tasks;
        }
        return planned.tasks;
      };
      rt.missionPlanner = opts.orchestrationPlanner ?? defaultPlanner;
      const limits = await loadMissionLimits(repoRoot, opts.agentDir);
      const recoveryBudget = missionRecoveryBudget(rt.resilience);
      // Optional AutoSpec design gate for orchestrated missions (T04). Nothing from
      // the integration is imported unless an `autospec` block exists or a layer is unparsable.
      let completionEvidence: ConstructorParameters<typeof Orchestrator>[0]["completionEvidence"];
      let autospecOn = false;
      try {
        if (await autospecConfigured(repoRoot, opts.agentDir ? { agentDir: opts.agentDir } : {})) {
          autospecOn = true;
          const provider = await import("../integrations/autospec/provider.ts");
          const autospecConfig = await provider.loadAutoSpecConfig(
            repoRoot,
            opts.agentDir ? { agentDir: opts.agentDir } : {},
          );
          completionEvidence = (_mission, candidates) =>
            provider.missionDesignGateReasons(autospecConfig, {
              repoRoot,
              candidates: candidates.map((c) => ({
                baseSha: c.identity.baseSha,
                candidateSha: c.identity.candidateSha,
              })),
            });
        }
      } catch (error) {
        // Configured-but-unloadable must block, not silently disable.
        const why = error instanceof Error ? error.message : String(error);
        if (autospecOn) completionEvidence = () => [`autospec_config: integration failed to load: ${why}`];
      }
      // Context-threshold continuity: enables the phase-boundary handoff, the live context trigger and the quota handoff.
      const continuityModels = registryWorker
        ? async () =>
            (await (await registryWorker.getModelRuntime()).getAvailable()).map((model) => ({
              provider: model.provider,
              id: model.id,
              contextWindow: model.contextWindow,
            }))
        : async () => [];
      const rolePins: Record<string, string | undefined> = {};
      try {
        const { policy } = await loadPolicy({ cwd: repoRoot, agentDir: opts.agentDir ?? getAgentDir() });
        for (const [role, cfg] of Object.entries(policy.routing.roles)) rolePins[role] = cfg?.model;
      } catch {
        // Pins only sharpen the quota_fallbacks validation; without them that one check is skipped.
      }
      const phaseHandoff = await buildContinuityConfig({
        agentDir: opts.agentDir ?? getAgentDir(),
        rolePins,
        models: continuityModels,
        isModelUnavailable: (model) => rt.unavailableModels.has(model),
        log: (line) => console.error(line),
      });
      rt.orchestrator = new Orchestrator({
        phaseHandoff,
        ...(completionEvidence ? { completionEvidence } : {}),
        recovery: recoveryBudget,
        store: rt.missionStore,
        backends,
        mergeQueue: {
          requireIndependentReview: /^(1|true|yes)$/i.test(process.env.PI_ENGINEERING_REQUIRE_INDEPENDENT_REVIEW ?? ""),
          // A live session model in the operator's enabled scope whose family
          // differs from the reviewer's could have reviewed independently.
          differentFamilyReviewerAvailable: async ({ reviewer }) => {
            if (!(rt.worker instanceof PiWorkerExecutor)) return false;
            try {
              const models = (await (await rt.worker.getModelRuntime()).getAvailable()).map((model) => ({
                provider: model.provider,
                id: model.id,
                contextWindow: model.contextWindow,
                input: model.input,
                reasoning: model.reasoning,
                toolCall: true,
              }));
              let enabledPatterns: string[] | undefined;
              try {
                enabledPatterns = SettingsManager.create(repoRoot, opts.agentDir ?? getAgentDir()).getEnabledModels();
              } catch {
                enabledPatterns = undefined;
              }
              return differentFamilyReviewerAvailable(models, reviewer.model, {
                enabledPatterns,
                isUnavailable: (model) => rt.unavailableModels.has(model),
              });
            } catch {
              return false;
            }
          },
          ...opts.mergeQueue,
        },
        worksetPolicy: { maxTaskBudgetMs: limits.max_task_wall_clock_ms },
        // Re-read `limits` before every mission/resume so an operator edit to
        // engineering.yaml applies without restarting pi (the caps above are the
        // snapshot taken at construction).
        limitsProvider: () => loadMissionLimits(repoRoot, opts.agentDir),
        timeLimits: {
          // The environment override (PI_ENGINEERING_WORKER_INACTIVITY_MS) wins.
          workerInactivityMs: process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS ? undefined : limits.worker_inactivity_ms,
          maxMissionWallClockMs: limits.max_mission_wall_clock_ms,
        },
        observability: rt.missionObservability,
        planner: opts.orchestrationPlanner ?? defaultPlanner,
        specApproval: opts.orchestrationSpecApproval,
        // Missions remember the session that started them: its operator
        // model pin applies to them and to no other session's missions.
        parentSessionId: session.sessionId,
        git: rt.git,
        artifacts: rt.artifacts,
        // A repo with no commit yet is a legitimate target: no base until the first commit.
        baseRef: rt.git ? await rt.git.headCommit().catch(() => "") : "",
        workspaceResolver: new WorkspaceManifestResolver(),
        repositoryRegistry: rt.repositoryRegistry,
        launchCwd: opts.cwd,
        ownership: rt.missionOwnership,
        // Mission-level gateway resilience: a worker transient-infra failure retries
        // within the (env-resolved) time-based window, parking the mission in a
        // WAITING state, and pauses (not fails) on exhaustion. When an operator sets
        // PI_GATEWAY_HEALTH_URL, a real HTTP recovery probe is used so recovery is
        // detected without burning a full worker session; otherwise the scheduler's
        // pass-through probe applies.
        resilience: rt.resilience,
        probe: buildGatewayRecoveryProbe(rt.worker, routeModel, rt.unavailableModels),
        onPhase: (mission, phase) => {
          const mapped: RuntimePhaseEvent["phase"] =
            phase === "complete" ? "settled" : phase === "classified" ? "scout" : "implement";
          rt.emitPhase({ workItemId: mission.mission_id, goal: mission.goal, phase: mapped });
          // Keep the PI WEB mission snapshot fresh as missions progress.
          rt.scheduleMissionSnapshot();
        },
      });
      if (opts.blackhole) rt.blackhole = await BlackholeManager.open({ ...opts.blackhole, ledger: rt.ledger });
      // Bind the semantic tools (ledger_read, repo_search, ...) to THIS runtime so
      // worker sessions get the tools their prompts require and always address the
      // shared ledger/broker regardless of their cwd (a candidate worktree must not
      // open a separate empty ledger).
      const tools = buildCoreTools(async (cwd) => {
        const context = await rt.repositoryRegistry.resolve(cwd);
        return {
          ledger: rt.ledger,
          artifacts: rt.artifacts,
          broker: context?.contextBroker ?? rt.broker,
          currentWorkItemId: () => rt.ledger.listWorkItems().at(-1)?.id ?? null,
          actor: () => ({ type: "system" }),
          orchestrator: rt.orchestrator,
          baseRef: async () => (context ? context.git.headCommit() : (rt.git?.headCommit() ?? "")),
          repoId: context?.repoId,
          repositoryRoot: context?.root,
        };
      });
      rt.coreTools = tools;
      if (rt.worker instanceof PiWorkerExecutor) rt.worker.setCustomTools(tools);
      // A distinct reviewer worker also needs the shared-ledger tools bound.
      if (rt.reviewerWorker instanceof PiWorkerExecutor) rt.reviewerWorker.setCustomTools(tools);
      // Supervision is the final initialized service: reconciliation can
      // dispatch repair workers, so every fallible backend and every semantic
      // tool binding must already be ready. The same consumer handles startup,
      // explicit ticks, and interval ticks.
      const supervisedStore = rt.missionStore;
      rt.missionSupervisor = new MissionSupervisor({
        store: supervisedStore,
        observability: rt.missionObservability,
        // The same budget the scheduler plans with: the supervisor and the
        // scheduler must never disagree about how often one failure repeats.
        recoveryPlanner: new RecoveryPlanner(recoveryBudget),
        onStatuses: (statuses) => rt.consumeSupervisorStatuses(statuses),
        planningInFlight: (missionId) => rt.orchestrator?.isPlanning(missionId) ?? false,
        runInFlight: (missionId) => rt.orchestrator?.hasLiveRun(missionId) ?? false,
        // Other live sessions in this worktree see the same missions; each
        // mission is supervised only by its custodian, and a dead custodian's
        // missions are adopted automatically.
        beforeTick: () => {
          supervisedStore.syncExternal();
        },
        admit: async (mission) => {
          // Externally submitted missions in NEW belong to the external pump, not the
          // supervisor lifecycle: the pump adopts them via runSubmittedMission, which
          // acquires the lease and moves them past NEW. Supervising them while their
          // submission receipt lease is live misreads "no tasks yet" as
          // REQUIREMENT_AMBIGUITY and blocks them before the pump can start them.
          if (!supervisorAdmitsMission(mission)) return false;
          const claim = await custody.claim(missionCustodyKey(mission.mission_id));
          if (claim.ok) supervisedStore.syncExternal();
          return claim.ok;
        },
      });
      await rt.missionSupervisor.reconcileOnStartup();
      rt.missionSupervisor.start();
      rt.steeringReceiver = await EngineeringRuntime.startSteering(rt, opts);
      // Pi as an external coworker agent: only when `pi-engineering herdr join` stored a credential AND the global YAML
      // names a control plane. Otherwise null: no timer, no request.
      rt.externalBridge = await startExternalBridge({
        agentDir: opts.agentDir ?? getAgentDir(),
        stateDir: resolveStateRoot(),
        log: (message) => console.error(message),
      }).catch(() => null);
      return rt;
    } catch (error) {
      rt.steeringReceiver?.stop();
      rt.forkRuntime?.stop();
      rt.externalBridge?.stop();
      rt.externalPumpStopped = true;
      rt.missionActivityTicker?.close();
      rt.missionActivityClock.clear();
      rt.unsubscribeMissionActivity?.();
      await rt.missionSupervisor?.shutdown();
      if (rt.ownershipId) liveOwnerIds().delete(rt.ownershipId);
      EngineeringRuntime.releaseOrchestrationReference(orchestrationPath);
      throw error;
    }
  }

  /**
   * Where Mission-less work lives: this session's checkout root and the branch it is on, read through GitRepo (the
   * same helpers every other git fact uses). Undefined on a detached HEAD or outside a repository, which the fork
   * wiring reports as an unresolvable origin rather than guessing a base.
   */
  private async sessionForkScope(): Promise<WorkScopeFacts | undefined> {
    const git = this.git;
    if (!git) return undefined;
    const branch = await git.currentBranch();
    return branch ? { repository: git.root, base_ref: branch } : undefined;
  }

  /**
   * T12. Start the steering poller only when the GLOBAL engineering YAML enables it and a Herdr control plane is
   * configured; otherwise nothing is constructed and no network call is ever made. The poller can reach exactly two
   * things: `MissionStore.steerTask` (labelled, untrusted text) and `Orchestrator.resume`.
   */
  private static async startSteering(
    rt: EngineeringRuntime,
    opts: EngineeringRuntimeOptions,
  ): Promise<SteeringReceiver | null> {
    const store = rt.missionStore;
    if (!store) return null;
    const orchestrator = (): NonNullable<EngineeringRuntime["orchestrator"]> => {
      if (!rt.orchestrator) throw new Error("orchestrator is not running");
      return rt.orchestrator;
    };
    const ports: import("../orchestration/steering.ts").SteeringPorts = {
      now: () => Date.now() / 1000,
      resolve: (nodeId) => resolveSteeringTarget(store, nodeId),
      steerRunning: (taskId, text) => orchestrator().broker.steerRunningTask(taskId, text, "herdr-steering"),
      resumeMission: async (missionId) => {
        const mission = await orchestrator().resume(missionId);
        return { changed: mission.status !== "PAUSED_INFRASTRUCTURE" };
      },
      log: (message) => console.error(message),
    };
    if (opts.steeringReceiver !== undefined) return opts.steeringReceiver;
    // T13: forks and promotion. Constructed only when the global YAML enables `forks:`; otherwise the port is absent
    // and a fork/promote request is acknowledged `unsupported`.
    rt.forkRuntime = await createForkRuntime({
      agentDir: opts.agentDir ?? getAgentDir(),
      stateDir: resolveStateRoot(),
      lineage: opts.lineage ?? null,
      log: (message) => console.error(message),
      sources: (() => {
        const host = {
          boundRoot: (repoId: string) => rt.repositoryRegistry.get(repoId).root,
          openRoot: async (path: string) => (await GitRepo.open(path))?.root ?? null,
          links: store,
          downstreamPrs: (taskId: string) => downstreamPrNodes(store, taskId),
        };
        // Mission-less work (Ledger work items and the sessions that ran them) forks and hands off too: the work read
        // model names the task, and the repository and base branch come from this session's own checkout.
        const projection = new LedgerWorkProjection(rt.ledger);
        return withFallbackForkSources(
          missionForkSources(store, host),
          workForkSources(
            () => projection.graph(),
            () => rt.sessionForkScope(),
            host,
          ),
        );
      })(),
    });
    if (rt.forkRuntime) ports.forks = rt.forkRuntime.port;
    const receiver = await createSteeringReceiver({
      agentDir: opts.agentDir ?? getAgentDir(),
      stateDir: resolveStateRoot(),
      ports,
    });
    receiver?.start();
    return receiver;
  }

  /**
   * The logical orchestration event stream of this runtime's namespace: every
   * session's stream (and imported legacy history) merged, with this session's
   * unflushed appends included once they land. Consumers must use this rather
   * than reading a particular JSONL file.
   */
  orchestrationEvents(): import("../platform/eventstore/backend.ts").StoredEvent[] {
    const namespace = this.orchestrationPath ? openedOrchestrationStores.get(this.orchestrationPath) : undefined;
    if (!namespace) return [];
    const backend = namespace.backend as typeof namespace.backend & { refresh?: () => unknown };
    backend.refresh?.();
    return backend.all();
  }

  /** Release this runtime's share of its orchestration namespace. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.externalPumpStopped = true;
    if (this.snapshotPublishTimer) {
      clearTimeout(this.snapshotPublishTimer);
      this.snapshotPublishTimer = null;
    }
    if (this.openReferences > 1) {
      this.openReferences--;
      if (this.orchestrationPath) EngineeringRuntime.releaseOrchestrationReference(this.orchestrationPath);
      return;
    }
    const path = this.orchestrationPath;
    try {
      this.steeringReceiver?.stop();
      this.forkRuntime?.stop();
      this.externalBridge?.stop();
      await this.missionSupervisor?.shutdown();
      await this.missionStore?.flush();
      await this.missionObservability?.flush();
    } catch (error) {
      // A failed flush has not completed shutdown. Keep the runtime and writer
      // reference live so callers can retry without losing the only durable
      // owner; supervision resumes because close did not succeed.
      this.missionSupervisor?.start();
      throw error;
    }
    if (path) EngineeringRuntime.releaseOrchestrationReference(path);
    this.closed = true;
    this.missionActivityTicker?.close();
    this.missionActivityClock.clear();
    this.unsubscribeMissionActivity?.();
    if (this.ownershipId) liveOwnerIds().delete(this.ownershipId);
    this.snapshotPressure?.dispose();
    this.orchestrator = null;
    this.missionSupervisor = null;
    this.missionOwnership = null;
    this.missionObservability = null;
    this.missionStore = null;
  }

  /** Log a mission's operator-pin change as a MODEL_TRANSITION (observability + operator notice). */
  private reportPinTransition(transition: PinTransition): void {
    const text = `MODEL_TRANSITION mission ${transition.missionId}: ${transition.from ?? "auto"} → ${transition.to ?? "auto"} (${transition.reason})`;
    this.missionObservability?.activity(transition.missionId, { type: "model_request", summary: text });
    emitTelemetry({
      level: "info",
      text: `[mission ${transition.missionId}] ${transition.to ? `model: ${transition.to} (operator pin)` : "model: auto (operator pin cleared)"} from its next worker dispatch`,
      key: `operator-pin:${transition.missionId}:${transition.to ?? "auto"}`,
      detail: { type: "MODEL_TRANSITION", ...transition },
    });
  }

  /**
   * Release one mission from its operator pin: it returns to role pins and the
   * capability router until the operator switches models again.
   */
  async clearMissionModelPin(missionId: string): Promise<import("../orchestration/types.ts").Mission> {
    if (!this.missionStore) throw new Error("Orchestrator not initialized for this directory.");
    releaseMissionModelPin({
      store: this.missionStore,
      missionId,
      onTransition: (transition) => this.reportPinTransition(transition),
    });
    await this.missionStore.flush();
    return this.missionStore.getMission(missionId)!;
  }

  /** `/engineering-model auto`: release the pins stored on this session's live missions. */
  async releaseSessionMissionPins(): Promise<string[]> {
    if (!this.missionStore) return [];
    const released = releaseSessionMissionPins({
      store: this.missionStore,
      sessionId: RuntimeSession.current().sessionId,
      onTransition: (transition) => this.reportPinTransition(transition),
    });
    await this.missionStore.flush();
    return released;
  }

  /** Explicitly cancel a mission: the only operator action that terminates a healthy mission. */
  async cancelMission(missionId: string): Promise<import("../orchestration/types.ts").Mission> {
    if (!this.missionStore || !this.orchestrator) throw new Error("Orchestrator not initialized for this directory.");
    const mission = await this.orchestrator.cancel(missionId);
    await this.missionStore.flush();
    return mission;
  }

  /** Current custody plus terminal outcomes previously observed here; never adopts sibling missions. */
  async maintenanceOwnedMissionIds(): Promise<string[]> {
    const namespace = this.orchestrationPath ? openedOrchestrationStores.get(this.orchestrationPath) : undefined;
    if (!namespace || !this.missionStore) return [];
    this.missionStore.syncExternal();
    const owned: string[] = [];
    for (const mission of this.missionStore.listMissions()) {
      const resource = missionCustodyKey(mission.mission_id);
      if (namespace.custody.holds(resource) && (await namespace.custody.claim(resource)).ok) {
        this.maintenanceObservedMissions.add(mission.mission_id);
        owned.push(mission.mission_id);
      } else if (
        this.maintenanceObservedMissions.has(mission.mission_id) &&
        ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)
      ) {
        // Completion releases custody. Keep its read-only outcome visible to
        // the maintenance receipt that observed this runtime owning it.
        owned.push(mission.mission_id);
      }
    }
    return owned;
  }

  async prepareForMaintenance(options: { timeoutMs: number }): Promise<
    { status: "ready" } | { status: "busy"; reason: string }
  > {
    if (!this.orchestrator || !this.missionStore) return { status: "ready" };
    const missionIds = await this.maintenanceOwnedMissionIds();
    const result = await this.orchestrator.prepareForMaintenance({ ...options, missionIds });
    if (result.status === "ready") {
      const namespace = this.orchestrationPath ? openedOrchestrationStores.get(this.orchestrationPath) : undefined;
      for (const missionId of missionIds) {
        // Draining releases its worker lease; retain custody of only the missions
        // this runtime proved it held before the drain, for the activation handoff.
        if (!namespace || !(await namespace.custody.claim(missionCustodyKey(missionId))).ok) {
          return { status: "busy", reason: `mission ${missionId} custody changed during maintenance` };
        }
      }
    }
    return result;
  }

  /** Release the dispatch gate after failed activation; durable mission stops remain intact. */
  endMaintenance(): void {
    this.orchestrator?.endMaintenance();
  }

  /** Automatic maintenance never clears operator pause or creates a replacement mission. */
  async resumeMissionAfterMaintenance(
    missionId: string,
    expected: {
      expectedRevision: number;
      expectedResumptionGeneration: number;
      selectedModel?: { provider: string; id: string };
      isInteractiveIdle?: () => boolean;
    },
    signal?: AbortSignal,
  ): Promise<
    | { status: "resumed"; mission: Mission; selectedModel?: { provider: string; id: string } }
    | { status: "skipped"; reason: string; code?: string }
  > {
    const store = this.missionStore;
    const orchestrator = this.orchestrator;
    if (!store || !orchestrator)
      return { status: "skipped", code: "RUNTIME_UNAVAILABLE", reason: "runtime unavailable" };
    if (!(await this.maintenanceOwnedMissionIds()).includes(missionId))
      return { status: "skipped", code: "CUSTODY_CHANGED", reason: "mission custody belongs to another session" };
    store.syncExternal();
    const mission = store.getMission(missionId);
    const generation = store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (
      !mission ||
      mission.revision !== expected.expectedRevision ||
      generation !== expected.expectedResumptionGeneration
    )
      return { status: "skipped", code: "STALE_MISSION_FENCE", reason: "mission revision or resumption changed" };
    if (
      signal?.aborted ||
      mission.operator_paused_at ||
      ["COMPLETE", "FAILED", "CANCELED", "CANCELING", "WAITING_FOR_USER", "NEEDS_ATTENTION"].includes(mission.status)
    )
      return {
        status: "skipped",
        code: "OPERATOR_INTENT",
        reason: "mission is paused, terminal, or awaiting operator input",
      };
    if (store.listExecutions(missionId).some((execution) => execution.status === "RUNNING"))
      return { status: "skipped", code: "ACTIVE_EXECUTION", reason: "mission has an active execution" };
    const stop = store
      .listMissionStops(missionId)
      .filter((item) => item.resumptionGeneration === generation)
      .at(-1);
    if (!stop) return { status: "skipped", code: "NO_DURABLE_STOP", reason: "mission has no durable stop" };
    const legacy = store.legacyCanceledRecovery(missionId);
    if (legacy.ambiguousTaskIds.length)
      return {
        status: "skipped",
        code: "LEGACY_REPAIR_REQUIRED",
        reason: `Canceled implementation tasks lack exact ownership-loss evidence: ${legacy.ambiguousTaskIds.join(", ")}. Explicit repair must reconcile preserved work and operator intent.`,
      };
    if (expected.selectedModel) {
      const refusal = await validateMaintenanceModel({
        router: this.maintenanceModelRouter,
        selectedModel: expected.selectedModel,
        previousModel: mission.operator_model_pin,
        baseline: this.maintenanceModelBaseline,
        tasks: store.listTasks(missionId),
        unavailable: this.unavailableModels,
      });
      if (refusal) return { status: "skipped", code: "MODEL_INCOMPATIBLE", reason: refusal };
      if (!(await this.maintenanceOwnedMissionIds()).includes(missionId))
        return {
          status: "skipped",
          code: "CUSTODY_CHANGED",
          reason: "mission custody changed during model validation",
        };
      if (signal?.aborted) return { status: "skipped", code: "OPERATOR_INTENT", reason: "recovery interrupted" };
    }
    const resumed = await store.resumeMissionIfCurrent(
      missionId,
      "verified runtime maintenance resumed preserved work",
      {
        revision: expected.expectedRevision,
        resumptionGeneration: expected.expectedResumptionGeneration,
        status: mission.status,
        blockedEpisodeId: mission.blocked_episode_id ?? null,
      },
      expected.selectedModel ? { ...expected.selectedModel, set_at: new Date().toISOString() } : undefined,
      expected.isInteractiveIdle,
    );
    if (!resumed)
      return {
        status: "skipped",
        code: "STALE_MISSION_FENCE",
        reason: "mission changed or operator intent prevents automatic resume",
      };
    store.syncExternal();
    if (store.getMission(missionId)?.operator_paused_at || signal?.aborted)
      return { status: "skipped", code: "OPERATOR_INTENT", reason: "operator interrupted maintenance recovery" };
    orchestrator.endMaintenance();
    let result: Mission;
    if (mission.status === "PAUSED_INFRASTRUCTURE" && stop.reason === MAINTENANCE_STOP_REASON) {
      result = await orchestrator.resume(missionId, { force: true, signal, interrupt: "pause" });
    } else {
      await this.normalizeMissionForRepair(missionId);
      result = await orchestrator.repairBlockedMission(missionId, signal);
    }
    return {
      status: "resumed",
      mission: result,
      ...(expected.selectedModel && result.operator_model_pin
        ? { selectedModel: { provider: result.operator_model_pin.provider, id: result.operator_model_pin.id } }
        : {}),
    };
  }

  /** Explicit, idempotent operator fallback for one durably stopped blocked mission. */
  resumeBlockedMission(
    missionId: string,
    signal?: AbortSignal,
    origin: "operator" | "model" = "operator",
  ): Promise<import("../orchestration/types.ts").Mission> {
    this.endMaintenance();
    const active = this.missionResumeFlights.get(missionId);
    if (active) return active;
    const flight = this.performBlockedMissionResume(missionId, signal, origin).finally(() => {
      if (this.missionResumeFlights.get(missionId) === flight) this.missionResumeFlights.delete(missionId);
    });
    this.missionResumeFlights.set(missionId, flight);
    return flight;
  }

  /**
   * Pause one named mission — the case Esc cannot express, because Esc pauses
   * the turn the operator is watching and dozens of missions run at once.
   * Works with no live turn: the store records the pause, then whatever is live
   * is stopped or parked. Only resume un-parks it; no scheduler or supervisor
   * will run it again on its own.
   */
  async pauseMission(missionId: string): Promise<import("../orchestration/types.ts").Mission> {
    if (!this.orchestrator) throw new Error("Orchestrator not initialized for this directory.");
    return this.orchestrator.pauseMission(missionId);
  }

  private recoveryBudgetExhausted(missionId: string, generation: number): boolean {
    return (this.missionStore?.listRecoveryDecisions(missionId) ?? []).some(
      (decision) => (decision.resumptionGeneration ?? 0) === generation && decision.status === "exhausted",
    );
  }

  private async performBlockedMissionResume(
    missionId: string,
    signal?: AbortSignal,
    origin: "operator" | "model" = "operator",
  ): Promise<import("../orchestration/types.ts").Mission> {
    if (!this.missionStore || !this.orchestrator) throw new Error("Orchestrator not initialized for this directory.");
    // #427: the live projection is not the authority. A mission another session
    // appended to this namespace is resumable here — declaring it unknown strands
    // work the durable log still describes perfectly.
    let mission = this.missionStore.resolveMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    // The session that resumes a mission is the one whose model choice it follows.
    claimMissionForSession(RuntimeSession.current().sessionId, missionId);
    if (["COMPLETE", "CANCELED"].includes(mission.status)) {
      throw new Error(`mission ${missionId} is terminal (${mission.status}) and cannot be resumed`);
    }

    // Reopen a FAILED mission for repair: the repair path recreates replacement
    // tasks for the failed tasks and re-runs them on the current base.
    // Transition FAILED -> BLOCKED (which stamps a fresh blocked_episode_id).
    // Reopened failed missions are re-run from their failed tasks, so the
    // durable-stop requirement below is bypassed for them.
    const reopeningFailed = mission.status === "FAILED";
    if (reopeningFailed) {
      mission = this.missionStore.transitionMission(missionId, "BLOCKED");
      await this.missionStore.flush();
    }

    // The operator resumes: automatic recovery may act on it again.
    const wasOperatorPaused = !!mission.operator_paused_at;
    this.missionStore.clearOperatorPause(missionId);
    const generation = this.missionStore.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    const stop = this.missionStore
      .listMissionStops(missionId)
      .filter((candidate) => candidate.resumptionGeneration === generation)
      .at(-1);
    if (!stop && wasOperatorPaused) {
      // Interrupted in a state it was left in (e.g. NEEDS_ATTENTION): handing
      // it back to supervision is the resume.
      await this.missionStore.flush();
      return this.missionStore.getMission(missionId)!;
    }
    if (!stop && !reopeningFailed) throw new Error(`mission ${missionId} has no current durable stop to resume`);
    // A reopened failed mission has no durable stop; use a synthetic recovery
    // source so the post-repair bookkeeping below stays well-formed.
    const recoverySource: Pick<MissionStop, "attemptedRecoveries" | "preservedWork" | "resumeCondition"> =
      stop ??
      ({
        attemptedRecoveries: [],
        preservedWork: this.missionStore
          .listTaskCheckpoints(missionId)
          .flatMap((checkpoint) => [checkpoint.worktree, checkpoint.branch])
          .filter((value): value is string => !!value?.trim()),
        resumeCondition: "operator reopened a failed mission",
      } as Pick<MissionStop, "attemptedRecoveries" | "preservedWork" | "resumeCondition">);
    if (
      (stop?.reason === OPERATOR_PAUSE_STOP_REASON || stop?.reason === MAINTENANCE_STOP_REASON) &&
      mission.status === "PAUSED_INFRASTRUCTURE"
    ) {
      // Paused by an operator interrupt: continue exactly where it stopped. The
      // interrupted tasks were left resumable; another interrupt pauses again.
      this.missionStore.resumeMission(missionId, "operator resumed an interrupted mission", origin);
      await this.missionStore.flush();
      return this.orchestrator.resume(missionId, { force: true, ...(signal ? { signal } : {}), interrupt: "pause" });
    }
    if (origin === "model" && this.recoveryBudgetExhausted(missionId, generation)) {
      // The model may not spend an exhausted budget by calling resume again.
      throw new Error(
        `recovery budget for mission ${missionId} is exhausted; only the operator can resume it (/mission resume ${missionId})`,
      );
    }
    mission = await this.normalizeMissionForRepair(missionId);
    this.missionStore.resumeMission(missionId, "operator requested mission recovery", origin);
    await this.missionStore.flush();
    // An interrupt during the operator's recovery pauses it again; it never cancels.
    const run = interruptibleRun(signal, "pause");
    run.onPause(() => this.missionStore?.markOperatorPause(missionId));
    try {
      await this.orchestrator.repairBlockedMission(missionId, run.signal);
    } catch (error) {
      await this.persistRecoveryStop(missionId, `Manual recovery failed: ${errorMessage(error)}`, recoverySource);
      throw error;
    } finally {
      run.dispose();
    }
    mission = this.missionStore.getMission(missionId)!;
    if ((mission.status === "BLOCKED" || mission.status === "REPAIRING") && !this.currentMissionStop(missionId)) {
      const generation = this.missionStore.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
      const ran = this.missionStore
        .listRecoveryDecisions(missionId)
        .filter((decision) => (decision.resumptionGeneration ?? 0) === generation)
        .at(-1);
      await this.persistRecoveryStop(
        missionId,
        `Recovery did not produce material progress: ${describeRecoveryOutcome(ran, this.orchestrator.gate.evaluate(mission))}`,
        recoverySource,
      );
    }
    return this.missionStore.getMission(missionId)!;
  }

  private async consumeSupervisorStatuses(statuses: SupervisorStatus[]): Promise<void> {
    if (!this.missionStore || !this.orchestrator) return;
    for (const status of statuses) {
      await this.consumeSupervisorStatus(status);
    }
    try {
      this.pumpExternalMissions();
    } catch (error) {
      emitTelemetry({ level: "warning", text: `external mission pump: ${redactSecrets(String(error))}` });
    }
  }

  /**
   * Start eligible external missions (`MSN-ext-*` in NEW with no live foreign
   * lease), up to `PI_ENGINEERING_MAX_EXTERNAL_MISSIONS` concurrent, on each
   * supervisor tick. Pure side effects live behind the supervisor-driven pump;
   * the scheduler never dispatches external missions itself.
   */
  private pumpExternalMissions(now = new Date()): void {
    if (this.externalPumpStopped) return;
    if (!this.missionStore || !this.orchestrator) return;
    if (!this.ownershipId) return;
    if (!readAutospecFlags(process.env).enabled) return;
    const candidates = this.missionStore
      .listMissions((mission) => mission.status === "NEW")
      .map((mission) => ({
        mission,
        lease: this.missionStore!.getMissionLease(mission.mission_id) ?? undefined,
      }));
    const toStart = selectExternalMissionsToStart(
      candidates,
      this.ownershipId,
      now,
      maxExternalMissions(),
      this.runningExternal.size,
    );
    for (const missionId of toStart) {
      if (this.runningExternal.has(missionId)) continue;
      this.runningExternal.add(missionId);
      void this.orchestrator
        .runSubmittedMission(missionId, {})
        .then((outcome) => {
          if (!outcome.started) {
            emitTelemetry({
              level: "warning",
              text: `external mission ${missionId} not started: ${redactSecrets(outcome.reason)}`,
            });
          }
        })
        .catch((error) => {
          emitTelemetry({
            level: "warning",
            text: `external mission ${missionId} start failed: ${redactSecrets(String(error))}`,
          });
        })
        .finally(() => {
          this.runningExternal.delete(missionId);
          this.scheduleMissionSnapshot();
        });
    }
  }

  private consumeSupervisorStatus(status: SupervisorStatus): Promise<void> {
    const key = [
      status.missionId,
      status.missionRevision,
      status.missionStatus,
      status.missionBlockedEpisodeId ?? "",
      status.resumptionGeneration,
    ].join(":");
    const active = this.supervisorSettlementFlights.get(key);
    if (active) return active;
    const flight = this.settleSupervisorStatus(status).finally(() => {
      if (this.supervisorSettlementFlights.get(key) === flight) this.supervisorSettlementFlights.delete(key);
    });
    this.supervisorSettlementFlights.set(key, flight);
    return flight;
  }

  private async settleSupervisorStatus(status: SupervisorStatus): Promise<void> {
    if (!this.missionStore || !this.orchestrator) return;
    let failureFence: Mission | null = null;
    try {
      const mission = this.missionStore.getMission(status.missionId);
      if (!mission || !this.isCurrentSupervisorStatus(status, mission)) return;
      // Only the operator resumes a mission the operator paused.
      if (mission.operator_paused_at) return;
      failureFence = mission;
      if (mission.status === "PAUSED_INFRASTRUCTURE") {
        if (status.action === "STOP" || status.action === "MONITOR") return;
        if (status.action !== "FENCE_RECONCILE_AND_RESUME") {
          throw new Error(`invalid worker output: unsupported supervisor action ${status.action}`);
        }
        const resumed = await this.orchestrator.resume(status.missionId);
        if (resumed.status === "PAUSED_INFRASTRUCTURE") {
          await this.persistRecoveryStop(
            status.missionId,
            `Automatic recovery ${status.action} is waiting for a healthy infrastructure probe: ${status.reason}`,
            {
              attemptedRecoveries: status.decision ? [status.decision.recoveryId] : [],
              preservedWork: status.preservedWork,
              resumeCondition: status.nextAction,
            },
            status.resumptionGeneration,
            failureFence,
          );
        }
        return;
      }
      if (status.decision && status.action !== "STOP") {
        if (status.action !== status.decision.action || !SUPPORTED_SUPERVISOR_REPAIR_ACTIONS.has(status.action)) {
          throw new Error(`invalid worker output: unsupported supervisor action ${status.action}`);
        }
        const repairFingerprint = [
          status.decision.recoveryId,
          status.missionStatus,
          status.missionBlockedEpisodeId ?? "",
        ].join("|");
        if (!this.supervisorRepairBackoff.shouldAttempt(status.missionId, repairFingerprint, Date.now())) return;
        this.supervisorRepairBackoff.recordAttempt(status.missionId, repairFingerprint, Date.now());
        failureFence = await this.normalizeMissionForRepair(status.missionId);
        await this.orchestrator.repairBlockedMission(status.missionId);
      } else if (status.health !== "HEALTHY" && status.action !== "STOP") {
        throw new Error(`invalid worker output: unsupported supervisor action ${status.action}`);
      }
    } catch (error) {
      await this.persistSupervisorFailure(status, error, failureFence);
    } finally {
      await this.publishMissionSnapshot();
      this.emitMissionActivity(status.missionId);
    }
  }

  private isCurrentSupervisorStatus(status: SupervisorStatus, mission: Mission): boolean {
    if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) return false;
    const generation = this.missionStore?.listMissionResumptions(status.missionId).at(-1)?.generation ?? 0;
    return (
      generation === status.resumptionGeneration &&
      mission.status === status.missionStatus &&
      mission.revision === status.missionRevision &&
      (mission.blocked_episode_id ?? null) === status.missionBlockedEpisodeId
    );
  }

  private async normalizeMissionForRepair(missionId: string): Promise<Mission> {
    if (!this.missionStore) throw new Error("Mission store is not initialized");
    let mission = this.missionStore.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) {
      throw new Error(`mission ${missionId} is terminal (${mission.status}) and cannot enter repair`);
    }
    if (mission.status === "REPAIRING" || mission.status === "BLOCKED") return mission;
    if (mission.status === "NEW") mission = this.missionStore.transitionMission(missionId, "CLASSIFYING");
    if (!canTransitionMission(mission.status, "BLOCKED")) {
      throw new Error(`mission ${missionId} cannot normalize ${mission.status} into a repairable BLOCKED episode`);
    }
    mission = this.missionStore.transitionMission(missionId, "BLOCKED");
    await this.missionStore.flush();
    return mission;
  }

  private async persistSupervisorFailure(
    status: SupervisorStatus,
    error: unknown,
    failureFence: Mission | null,
  ): Promise<void> {
    if (!this.missionStore) throw error;
    const mission = this.missionStore.getMission(status.missionId);
    const generation = this.missionStore.listMissionResumptions(status.missionId).at(-1)?.generation ?? 0;
    if (!mission || ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) return;
    if (generation !== status.resumptionGeneration) return;
    if (!failureFence) return;
    const exactFence =
      mission.status === failureFence.status &&
      mission.revision === failureFence.revision &&
      mission.blocked_episode_id === failureFence.blocked_episode_id;
    const enteredFencedRepair =
      failureFence.status === "BLOCKED" &&
      mission.status === "REPAIRING" &&
      mission.blocked_episode_id === failureFence.blocked_episode_id;
    if (!exactFence && !enteredFencedRepair) return;
    const reason = `Automatic recovery ${status.action} failed: ${errorMessage(error)}`;
    const classification = new FailureClassifier().classify({
      missionId: status.missionId,
      taskId: status.task,
      summary: reason,
      observedAt: new Date().toISOString(),
    });
    if (
      !this.missionStore
        .listFailureClassifications(status.missionId)
        .some((item) => item.fingerprint === classification.fingerprint)
    ) {
      this.missionStore.classifyFailure(classification);
    }
    await this.persistRecoveryStop(
      status.missionId,
      reason,
      {
        attemptedRecoveries: status.decision ? [status.decision.recoveryId] : [],
        preservedWork: status.preservedWork,
        resumeCondition: status.nextAction,
      },
      status.resumptionGeneration,
    );
  }

  private async persistRecoveryStop(
    missionId: string,
    reason: string,
    source: Pick<MissionStop, "attemptedRecoveries" | "preservedWork" | "resumeCondition">,
    expectedResumptionGeneration?: number,
    expectedMission?: Mission,
  ): Promise<void> {
    if (!this.missionStore) throw new Error("Mission store is not initialized");
    const mission = this.missionStore.getMission(missionId);
    if (!mission || ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) return;
    const currentGeneration = this.missionStore.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (expectedResumptionGeneration !== undefined && currentGeneration !== expectedResumptionGeneration) return;
    const decisions = this.missionStore.listRecoveryDecisions(missionId).map((decision) => decision.recoveryId);
    const queueState = this.queueStateForStop() ?? undefined;
    const fence = expectedMission ?? mission;
    await this.missionStore.stopMissionIfCurrent(
      missionId,
      {
        reason,
        attemptedRecoveries: [...new Set([...source.attemptedRecoveries, ...decisions])],
        preservedWork: [...source.preservedWork],
        resumeCondition: source.resumeCondition,
        // #418: a mission parked on capacity keeps the queue state the gateway
        // last reported, so hours later the operator still sees the load and the
        // hold-off instead of an open-ended "waits for capacity".
        ...(queueState ? { queue: queueState } : {}),
      },
      {
        revision: fence.revision,
        status: fence.status,
        resumptionGeneration: expectedResumptionGeneration ?? currentGeneration,
        blockedEpisodeId: fence.blocked_episode_id ?? null,
      },
    );
    await this.missionStore.flush();
  }

  /**
   * The queue state to persist with a park (#418), read from the admission
   * controller that actually honoured the wait. Test seam so a unit test can
   * present a queue without a gateway. Returns null when nothing was reported or
   * the observation has aged out — the report then says nothing about the queue.
   */
  queueStateForStop(): MissionStopQueue | null {
    if (this.queueStateOverride !== undefined) return this.queueStateOverride;
    const observed = sharedAdmissionController().queueState();
    if (!observed) return null;
    return {
      observedAtMs: observed.observedAtMs,
      ...(observed.queued !== undefined ? { queued: observed.queued } : {}),
      ...(observed.queueLimit !== undefined ? { queueLimit: observed.queueLimit } : {}),
      ...(observed.activeLimit !== undefined ? { activeLimit: observed.activeLimit } : {}),
      ...(observed.retryAfterMs !== undefined ? { retryAfterMs: observed.retryAfterMs } : {}),
      ...(observed.waitingSinceMs !== undefined ? { waitingSinceMs: observed.waitingSinceMs } : {}),
      ...(observed.reason ? { reason: observed.reason } : {}),
      ...(observed.scope ? { scope: observed.scope } : {}),
      ...(observed.provider ? { provider: observed.provider } : {}),
      ...(observed.model ? { model: observed.model } : {}),
    };
  }

  /** Test seam: present a fixed queue state as the state a park would persist. */
  private queueStateOverride?: MissionStopQueue | null;
  setQueueStateForTesting(state: MissionStopQueue | null): void {
    this.queueStateOverride = state;
  }

  private retainOpenReference(): void {
    if (this.closed || !this.orchestrationPath) throw new Error("cannot retain a closed EngineeringRuntime");
    this.openReferences++;
    openedOrchestrationStoreReferences.set(
      this.orchestrationPath,
      (openedOrchestrationStoreReferences.get(this.orchestrationPath) ?? 0) + 1,
    );
  }

  private static releaseOrchestrationReference(path: string): void {
    const references = (openedOrchestrationStoreReferences.get(path) ?? 1) - 1;
    if (references > 0) {
      openedOrchestrationStoreReferences.set(path, references);
      return;
    }
    openedOrchestrationStoreReferences.delete(path);
    openedMissionObservability.delete(path);
    openedMissionStores.delete(path);
    const namespace = openedOrchestrationStores.get(path);
    openedOrchestrationStores.delete(path);
    if (namespace) {
      // A reload stops this generation but not the session: custody stays
      // with the session, so no other live session can admit its missions in
      // the window before the next generation re-claims them.
      if (isReloadShutdown()) namespace.custody.retainForReload();
      else void namespace.custody.releaseAll().catch(() => undefined);
      namespace.backend.close();
    }
  }

  actor(runId: string, role?: WorkerRole): Actor {
    return { type: "system", run_id: runId, role };
  }

  // ------------------------------------------------------------- run a worker

  /**
   * Run lifecycle facts for the work read model. Best effort: the ledger is the
   * record, but a failed append must never fail or stall the engineering run.
   */
  private async recordAgentEvent(
    type: "agent.started" | "agent.completed" | "agent.failed",
    workItemId: string,
    actor: Actor,
    payload: Record<string, unknown>,
    meta: EventMeta,
  ): Promise<void> {
    try {
      await this.ledger.emitEvent(type, workItemId, actor, payload, meta);
    } catch {
      // intentionally swallowed; see above
    }
  }

  private async runWorker(
    role: WorkerRole,
    task: string,
    opts: {
      cwd: string;
      tools: string[];
      context?: string;
      wi: WorkItem;
      timeoutMs?: number;
      /** Override the worker (e.g. a distinct reviewer worker). Defaults to this.worker. */
      worker?: WorkerExecutor;
      /**
       * Blackhole session scope. Tournament candidates share a work item but
       * MUST have isolated working memory, so the memory identity keys on this
       * (the candidate id) rather than the work item id. Defaults to the work
       * item id (fine for non-tournament work).
       */
      sessionScope?: string;
    },
  ) {
    const runId = newRunId();
    const budget = ROLE_BUDGETS[role];
    const req: WorkerRequest = {
      role,
      task,
      tools: opts.tools,
      cwd: opts.cwd,
      context: opts.context,
      timeoutMs: opts.timeoutMs ?? 300_000,
      maxContextTokens: budget?.hardMaxTokens,
      runId,
      workItemId: opts.wi.id,
    };
    // Open an isolated per-session memory store for this worker when Blackhole
    // is enabled. The store is keyed by a STABLE session identity (project /
    // work item / role / worker), so memory persists across fix rounds of the
    // same candidate while concurrent candidates (distinct work item/worker),
    // reviewers, and challengers (distinct role) never share working memory.
    // Disabled ⇒ no store and no recall (backward compatible).
    const sessionScope = opts.sessionScope ?? opts.wi.id;
    const sessionStore = this.blackhole?.enabled
      ? this.blackhole.openSessionFor({
          project: this.cwd,
          workItem: opts.wi.id,
          role,
          workerId: sessionScope,
          runId: sessionScope,
          sessionId: sessionScope,
        })
      : null;
    // Realize in-session recall: prior memory from earlier runs of this same
    // (work item, role, worker) is recalled and appended to the worker context,
    // so repeated work is more context-efficient instead of recomputing from
    // scratch. Strict isolation still holds because each candidate/reviewer/
    // challenger has a disjoint session identity.
    let effectiveContext = opts.context;
    if (sessionStore) {
      const recalled = sessionStore.recall(20);
      if (recalled.length > 0) {
        const memoryBlock = `\n\n[blackhole session memory]\n${recalled
          .map((e) => `[${e.priority} ${e.kind}] ${e.text}`)
          .join("\n")}`;
        effectiveContext = (effectiveContext ?? "") + memoryBlock;
        req.context = effectiveContext;
      }
    }
    // Hydrate from SHARED durable memory (OpenViking / shared file): surface
    // evidence-promoted knowledge from OTHER workers/sessions so repeated or
    // parallel engineering work is not recomputed from scratch. This is the
    // cross-worker sharing read path. Provider failure degrades to nothing.
    //
    // INVARIANT: hydration is gated to non-independent roles. The independent
    // reviewer and the clean-room challenger MUST NOT inherit prior candidate
    // memory (INV-007), so they never read shared durable memory — otherwise
    // promoted candidate knowledge (promotedFrom = candidate id) would leak
    // into contexts whose prompts forbid prior reasoning.
    if (this.blackhole?.enabled && HYDRATION_ROLES.includes(role)) {
      const query = `${opts.wi.id} ${role} ${task.slice(0, 120)}`;
      const shared = await this.blackhole.hydrate(query, 10);
      if (shared.length > 0) {
        const block = `\n\n[openviking durable memory]\n${shared
          .map((r) => `[promoted ${r.promotedAt}] ${r.text}`)
          .join("\n")}`;
        effectiveContext = (effectiveContext ?? "") + block;
        req.context = effectiveContext;
      }
    }
    const executor = opts.worker ?? this.worker;
    const runMeta = { task_id: opts.wi.id, session_id: sessionScope, run_id: runId };
    await this.recordAgentEvent(
      "agent.started",
      opts.wi.id,
      this.actor(runId, role),
      { role, task: task.slice(0, 200) },
      {
        ...runMeta,
        idempotency_key: `${runId}:started`,
      },
    );
    let run: Awaited<ReturnType<WorkerExecutor["run"]>>;
    try {
      run = await executor.run(req);
    } catch (error) {
      await this.recordAgentEvent(
        "agent.failed",
        opts.wi.id,
        this.actor(runId, role),
        { role, error: error instanceof Error ? error.message : String(error) },
        { ...runMeta, idempotency_key: `${runId}:ended` },
      );
      throw error;
    }
    await this.recordAgentEvent(
      run.result.status === "completed" ? "agent.completed" : "agent.failed",
      opts.wi.id,
      { ...this.actor(runId, role), model: run.usage?.model },
      { role, status: run.result.status },
      { ...runMeta, idempotency_key: `${runId}:ended` },
    );
    // After a completed worker, record the outcome into the session store and
    // schedule a lower-priority background observer (P3) that never preempts
    // engineering work. Fire-and-forget so a memory-worker failure never fails
    // the engineering task.
    if (this.blackhole?.enabled && run.result.status === "completed" && sessionStore) {
      sessionStore.observe(run.result.summary, [runId], "P3");
      void this.blackhole
        .runMemoryWorker("observer", { project: this.cwd, workItem: opts.wi.id, role, workerId: opts.wi.id })
        .catch(() => {});
    }

    // Report the model that actually produced this phase. The executor picks
    // the model (router, fallback ladder), so it is knowable only after the
    // run — status surfaces show the session model until then.
    if (run.usage?.model && this.currentWorkItemId) {
      const phase = PHASE_FOR_ROLE[role];
      if (phase) {
        this.emitPhase({
          workItemId: this.currentWorkItemId,
          phase,
          goal: this.currentPhaseGoal || undefined,
          model: run.usage.model,
          usage: { input: run.usage.input ?? 0, output: run.usage.output ?? 0, cost: run.usage.cost },
        });
      }
    }

    // Accumulate context/autonomy telemetry.
    this.telemetry.workers[role] = (this.telemetry.workers[role] ?? 0) + 1;
    this.telemetry.toolCalls += run.toolCalls ?? 0;
    if (run.result.status !== "completed") this.telemetry.blockedOrFailedWorkers++;
    if (run.usage) {
      this.telemetry.inputTokens += run.usage.input ?? 0;
      this.telemetry.outputTokens += run.usage.output ?? 0;
      this.telemetry.contextTokens = Math.max(this.telemetry.contextTokens, run.usage.contextTokens);
      this.telemetry.turns += run.usage.turns;
    }

    // A captured observation can support a hypothesis without proving its
    // interpretation. Worker prose never auto-verifies a hypothesis (INV-006).
    for (const claim of run.result.claims) {
      const machine = await hasRecordedEvidence(claim.evidence, this);
      await this.ledger.recordEntity("hypothesis", claim.claim, "open", this.actor(runId, role), opts.wi.id, {
        evidence: machine ? [claim.evidence!] : [],
      });
    }
    for (const h of run.result.new_hypotheses) {
      await this.ledger.recordEntity("hypothesis", h, "open", this.actor(runId, role), opts.wi.id);
    }
    // Persist worker output as an artifact so large output stays out of context.
    const artifact = await this.artifacts.put(
      "workers",
      runId,
      JSON.stringify({ role, task, result: run.result }, null, 2),
      `${role} result: ${run.result.status} — ${run.result.summary.slice(0, 200)}`,
    );
    return { runId, run, artifactUri: artifact.uri };
  }

  // ------------------------------------------------------------------- scout

  async scout(
    wi: WorkItem,
    goal: string,
    contextText: string,
  ): Promise<{ summary: string; artifactUri: string; relevantFiles: string[] } | null> {
    if (!this.broker) return null;
    const task = `Investigate this repository and recommend the smallest relevant change surface for the goal:
"${goal}"
Report: relevant symbols/files, architecture constraints, testing implications, and any risks.
Also return the concrete files you think the implementer must touch as an array in details.relevant_files (paths relative to the repo root).
Use repo_search, symbol, ledger_read, and artifact_read. Do not edit files.`;
    const { run, artifactUri } = await this.runWorker("scout", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    const details = run.result.details as { relevant_files?: unknown };
    const relevantFiles = Array.isArray(details?.relevant_files)
      ? details.relevant_files.filter((f): f is string => typeof f === "string").slice(0, 10)
      : [];
    return { summary: run.result.summary, artifactUri, relevantFiles };
  }

  // ------------------------------------------------------------ implement

  /**
   * Parallel task-DAG wave computation (M13). Groups the dependency-ordered
   * tasks into waves of tasks that are (a) independent (no dependency edge)
   * and (b) write-scope-disjoint (no shared path), which may run concurrently.
   * Returns waves in dependency order.
   */
  private static computeParallelWaves(tasks: Task[]): Task[][] {
    const order = topoSort(tasks);
    const byId = new Map(order.map((t) => [t.id, t]));
    const waves: Task[][] = [];
    const waveOf = new Map<string, number>();
    for (const t of order) {
      let wave = 0;
      // This task must run after its dependencies' wave and after any
      // write-conflicting task in a later-or-equal wave.
      for (const dep of t.depends_on) {
        wave = Math.max(wave, (waveOf.get(dep) ?? -1) + 1);
      }
      for (let w = 0; w < waves.length; w++) {
        const conflict = waves[w]!.some((other) => tasksConflict(t, other));
        if (conflict) wave = Math.max(wave, w + 1);
      }
      if (wave >= waves.length) waves.length = wave + 1;
      const target = waves[wave] ?? [];
      target.push(t);
      waves[wave] = target;
      waveOf.set(t.id, wave);
    }
    return waves;
  }

  /**
   * Startup recovery for the ResourceRegistry (issue #258). Runs once per state
   * directory per process: a second runtime opened in this process cannot have
   * crashed, and re-running would roll back a release a live sibling runtime is
   * in the middle of. Every diagnostic becomes a ledger entry carrying the
   * resource id, action and reason. A failure to reconcile is a visible ledger
   * finding, never a failed open, and leaves the directory eligible for retry.
   */
  private async reconcileResources(workDir: string): Promise<void> {
    const key = resolve(workDir);
    if (reconciledStateDirs.has(key)) return;
    try {
      const diagnostics = await this.resourceRegistry.reconcile();
      reconciledStateDirs.add(key);
      for (const d of diagnostics) {
        await this.ledger
          .recordEntity(
            "finding",
            `resource ${d.id} ${d.action} at startup: ${d.reason}`,
            d.action === "quarantined" ? "open" : "resolved",
            this.actor(newRunId(), "reviewer"),
            null,
            { severity: d.action === "quarantined" ? "medium" : "low" },
          )
          .catch(() => {});
      }
    } catch (error) {
      await this.ledger
        .recordEntity(
          "finding",
          `resource registry reconcile failed at startup: ${error instanceof Error ? error.message : String(error)}`,
          "open",
          this.actor(newRunId(), "reviewer"),
          null,
          { severity: "medium" },
        )
        .catch(() => {});
    }
  }

  /**
   * Releases a candidate's worktree and branch through the ResourceRegistry
   * (issue #143). Only registry-owned resources are touched: a branch nobody
   * registered is left alone. A failed removal is never swallowed: the record is
   * kept `retained` with the reason, and a ledger finding makes it visible.
   */
  async releaseCandidate(candidate: Pick<Candidate, "id" | "branch">, wi: WorkItem): Promise<void> {
    if (!this.git || !candidate.branch) return;
    const id = candidateResourceId(candidate.branch);
    const owner = { missionId: wi.id, executionId: candidate.branch };
    let begun: Awaited<ReturnType<ResourceRegistry["beginRelease"]>>;
    try {
      begun = await this.resourceRegistry.beginRelease(id, owner, () => false);
    } catch (error) {
      await this.recordCleanupFinding(candidate, wi, id, error);
      return;
    }
    if (begun.status !== "ok" || begun.record.state === "released") return;
    try {
      // removeWorktree is non-destructive: plain `worktree remove`, and the branch is deleted
      // only when its tip is contained in another local branch/tag, else renamed to superseded/*.
      await this.git.removeWorktree({ path: begun.record.locator, branch: candidate.branch });
      await this.resourceRegistry.completeRelease(id);
    } catch (error) {
      await this.resourceRegistry
        .markRetained(id, error instanceof Error ? error.message : String(error))
        .catch(() => {});
      await this.recordCleanupFinding(candidate, wi, id, error);
    }
  }

  private async recordCleanupFinding(
    candidate: Pick<Candidate, "id" | "branch">,
    wi: WorkItem,
    resourceId: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.ledger
      .recordEntity(
        "finding",
        `candidate cleanup failed for ${candidate.branch}: ${reason}; the worktree/branch stays registered as ${resourceId}`,
        "open",
        this.actor(newRunId(), "reviewer"),
        wi.id,
        { severity: "medium", candidateId: candidate.id },
      )
      .catch(() => {});
  }

  private async createCandidateWorktree(
    wi: WorkItem,
    parentId: string | null,
    actor: Actor,
  ): Promise<{ candidate: Candidate; worktreePath: string } | { candidate: Candidate; worktreePath: null }> {
    if (!this.git) {
      // Non-git fallback: implement directly in cwd (no isolation).
      const candidate = await this.ledger.createCandidate(
        wi.id,
        "",
        "working",
        null,
        "implementer",
        "run",
        parentId,
        actor,
      );
      return { candidate, worktreePath: null };
    }
    const baseCommit = await this.git.headCommit();
    // The branch name must be unique even under concurrent candidate creation
    // (parallel tournament legs), so a readable per-workitem sequence is
    // suffixed with a random token rather than relied on for uniqueness.
    const branch = `pi-eng-${candidateSeq(this.ledger, wi.id)}-${newRunId().slice(4).toLowerCase()}`;
    // Worktree creation is safe to run concurrently (each leg gets its own branch
    // + worktree); only the promotion merge into the shared main branch must be
    // serialized (see withGitLock around mergeBranch).
    // Ownership is recorded BEFORE the worktree and branch exist, so a crash
    // mid-creation never leaves something cleanup has to guess about.
    await this.resourceRegistry.register({
      id: candidateResourceId(branch),
      kind: "worktree",
      ownerMissionId: wi.id,
      ownerExecutionId: branch,
      locator: this.git.worktreePath(branch),
      lease: `session:${RuntimeSession.current().sessionId}`,
    });
    const wt = await this.git.createWorktree(baseCommit, branch);
    const runId = newRunId();
    const candidate = await this.ledger.createCandidate(
      wi.id,
      baseCommit,
      branch,
      wt.path,
      "implementer",
      runId,
      parentId,
      actor,
    );
    return { candidate, worktreePath: wt.path };
  }

  private async implementIn(
    wi: WorkItem,
    candidate: Candidate,
    worktreePath: string | null,
    task: string,
    contextText: string,
  ) {
    const cwd = worktreePath ?? this.cwd;
    const run = await this.runWorker("implementer", task, {
      cwd,
      tools: IMPLEMENT_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 600_000,
      // Blackhole isolation: each candidate gets its own memory scope.
      sessionScope: candidate.id,
    });
    // Commit and capture diff (git only).
    if (this.git && worktreePath) {
      // Check the worktree's own status (the main repo may have untracked
      // .pi-eng/ state that must not be mistaken for implementer changes).
      const changed = await this.git.statusIn(worktreePath);
      if (changed.trim()) {
        await this.git.commitAll(worktreePath, `${wi.id}: implementation candidate`);
        const head = await this.git.headCommitIn(worktreePath);
        const diff = await this.git.captureDiff(candidate.base_commit, head);
        const files = await this.git.changedFiles(candidate.base_commit, head);
        const diffArtifact = await this.artifacts.put(
          "candidate",
          candidate.id,
          diff || "(no captured diff)",
          `${files.length} file(s) changed`,
        );
        await this.ledger.changeCandidate(
          candidate.id,
          { diff: diff || null, diff_artifact_uri: diffArtifact.uri, changed_files: files },
          wi.id,
          this.actor(run.runId, "implementer"),
        );
        return { ...run, diff: diff || null, changedFiles: files, diffArtifactUri: diffArtifact.uri };
      }
    }
    return { ...run, diff: null, changedFiles: [], diffArtifactUri: null };
  }

  async verify(wi: WorkItem, candidate: Candidate, worktreePath: string | null) {
    const runCwd = worktreePath ?? this.cwd;
    // The verification PROFILE comes from the main working tree (the trusted
    // repo owner's config), NOT from the candidate worktree. Otherwise the
    // implementer worker could rewrite package.json in its own worktree (e.g.
    // set "test": "true") and neutralize the very gate that is supposed to
    // certify it (INV-003/005 integrity). Stages still RUN in the candidate
    // worktree so they exercise the candidate's actual code.
    // Risk labels alone are insufficient: confirm the actual changed paths
    // before selecting cheap checks. Code/config changes retain normal gates
    // unless the trusted project explicitly declares a quick profile.
    const explicitChecks = /\b(?:tests?|testing|verify|verification|checks?|suite|build|lint|typecheck)\b/i.test(
      wi.goal,
    );
    const explicitFull =
      explicitChecks &&
      /\b(?:full|all|complete|entire|whole)\b[\s\S]*\b(?:tests?|verification|checks?|suite)\b|\b(?:tests?|verification|checks?|suite)\b[\s\S]*\b(?:full|all|complete|entire|whole)\b|\b(?:test:(?:full|all)|verify\s+full)\b/i.test(
        wi.goal,
      );
    const changedFiles =
      wi.risk === "low" && !explicitChecks && this.git && worktreePath
        ? await this.git.changedFiles(candidate.base_commit, await this.git.headCommitIn(runCwd))
        : undefined;
    const profile = await this.verifier.detect(this.cwd, {
      ...(explicitFull ? { full: true } : {}),
      ...(changedFiles ? { risk: wi.risk, changedFiles, baseCommit: candidate.base_commit } : {}),
    });
    const outcome = await this.verifier.run(runCwd, profile, this.artifacts, { quarantine: this.testQuarantine });
    const actor = this.actor(newRunId(), "reviewer");
    this.telemetry.verifyStages += outcome.stages.length;
    const evidenceIds: string[] = [];
    for (const ev of outcome.evidence) {
      this.telemetry.evidence++;
      const recorded = await this.ledger.recordEvidence(
        candidate.id,
        ev.type,
        ev.tool,
        ev.command,
        ev.exit_code,
        ev.status,
        ev.summary,
        ev.artifacts,
        ev.trust,
        wi.id,
        actor,
      );
      evidenceIds.push(recorded.id);
    }
    await this.ledger.changeCandidate(
      candidate.id,
      { status: outcome.passed ? "ELIGIBLE" : "VERIFYING" },
      wi.id,
      actor,
    );
    return { outcome, evidenceIds, profile };
  }

  // ----------------------------------------------------------------- review

  async review(
    wi: WorkItem,
    candidate: Candidate,
    requirement: string,
  ): Promise<{ summary: string; findingIds: string[]; completed: boolean }> {
    const diff = candidate.diff ?? "(no captured diff)";
    // The full candidate diff stays OUT of the prompt as a lazily-retrieved
    // artifact (artifact-backed large-output handling). Only a compact inline
    // preview plus the artifact URI enter the reviewer's context, so a large
    // diff no longer consumes the reviewer's hard token budget up front and the
    // reviewer reads the rest on demand via artifact_read (INV-001).
    let diffUri: string;
    try {
      diffUri = await this.ensureDiffArtifact(candidate);
    } catch (err) {
      // A failure to persist the diff artifact must not yield a clean review:
      // treat it as a review that could not complete so the candidate is never
      // promoted on an unreviewed basis (INV-007).
      const msg = err instanceof Error ? err.message : String(err);
      return {
        summary: `Could not persist candidate diff artifact for review: ${msg}`,
        findingIds: [],
        completed: false,
      };
    }
    const preview = diff.length > 2000 ? `${diff.slice(0, 2000)}\n… [truncated; full diff in artifact]` : diff;
    const files = candidate.changed_files?.length ? candidate.changed_files.slice(0, 30).join(", ") : "(unknown)";
    const task = `Independently review candidate ${candidate.id} for the work item:
"${wi.goal}"
Requirement: ${requirement}

Changed files: ${files}
Candidate diff (compact preview):
${preview}

To inspect the COMPLETE candidate diff, call artifact_read with uri "${diffUri}". If the result is truncated, keep calling artifact_read with the reported offset (e.g. offset=<n>) until you have read the full diff. Always read the full diff artifact before judging.

Report concrete findings. Return your findings EXACTLY as details.findings, an array of objects { severity, claim, evidence } where severity is one of info|low|medium|high|critical. If there are NO material issues, set details.findings to an EMPTY array. Do not put findings in the claims field. You are a reviewer; you do not approve the work, you report findings. Use artifact_read to inspect logs if referenced.`;
    const { run, runId } = await this.runWorker("reviewer", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      wi,
      timeoutMs: 240_000,
      worker: this.reviewerWorker ?? undefined,
      // Blackhole isolation: a reviewer's memory scope is the candidate under
      // review (distinct from the implementer's, and per-candidate).
      sessionScope: candidate.id,
    });
    // A completed worker is not necessarily a completed review. Validate the
    // entire role-specific payload before recording anything: dropping one
    // malformed finding could turn a reported defect into a clean approval.
    const details = run.result.details;
    const findings =
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? (details as { findings?: unknown }).findings
        : undefined;
    const validFindings =
      Array.isArray(findings) &&
      findings.every(
        (f): f is { severity: "info" | "low" | "medium" | "high" | "critical"; claim: string; evidence: string } =>
          f !== null &&
          typeof f === "object" &&
          !Array.isArray(f) &&
          ["info", "low", "medium", "high", "critical"].includes(f.severity) &&
          typeof f.claim === "string" &&
          f.claim.trim().length > 0 &&
          typeof f.evidence === "string",
      );
    const completed = run.result.status === "completed" && validFindings;
    const findingIds: string[] = [];
    if (completed) {
      for (const f of findings) {
        const entity = await this.ledger.recordEntity(
          "finding",
          f.claim,
          "open",
          this.actor(runId, "reviewer"),
          wi.id,
          {
            severity: f.severity,
            evidence: f.evidence ? [f.evidence] : [],
            candidateId: candidate.id,
          },
        );
        findingIds.push(entity.id);
      }
    }
    for (const c of run.result.claims) {
      await this.ledger.recordEntity("hypothesis", c.claim, "open", this.actor(runId, "reviewer"), wi.id, {
        evidence: (await hasRecordedEvidence(c.evidence, this)) ? [c.evidence] : [],
      });
    }
    const summary =
      run.result.status === "completed" && !validFindings
        ? `Invalid review findings: expected details.findings with severity, nonempty claim, and evidence strings. ${run.result.summary}`
        : run.result.summary;
    return { summary, findingIds, completed };
  }

  /**
   * Ensure the candidate's full diff is stored as a lazily-readable artifact
   * and return its `artifact://` URI. Candidates produced by `implementIn`
   * already carry a `diff_artifact_uri`; this covers candidates reviewed
   * directly (e.g. `/review`) whose artifact may be missing or predate artifact
   * storage. The stored content is VERIFIED against the candidate's current
   * `diff` and re-written if stale, so the reviewer can never judge an artifact
   * that diverges from the preview (a `Ledger.changeCandidate` that updates only
   * `diff` would otherwise leave a stale artifact).
   */
  private async ensureDiffArtifact(candidate: Candidate): Promise<string> {
    const content = candidate.diff ?? "(no captured diff)";
    const uri = candidate.diff_artifact_uri;
    if (uri) {
      const meta = this.artifacts.getByUri(uri);
      const stored = meta ? await this.artifacts.readContentByUri(uri) : undefined;
      if (stored === content) return uri; // fresh
    }
    // Missing, stale, or content-verified-mismatched: (re)write the artifact.
    const meta = await this.artifacts.put("candidate", candidate.id, content, "candidate diff (lazy)");
    return meta.uri;
  }

  /**
   * Run an independent review, retrying with a FRESH reviewer session when the
   * review fails to complete (budget/timeout). Each retry is a brand-new
   * session, so the accumulated context that caused the earlier overflow is
   * discarded. Returns the last result (which may still be `completed: false`
   * if every attempt failed).
   */
  private async reviewWithRetry(
    wi: WorkItem,
    candidate: Candidate,
    requirement: string,
    retries = 2,
  ): Promise<{ summary: string; findingIds: string[]; completed: boolean }> {
    let result = await this.review(wi, candidate, requirement);
    for (let i = 0; i < retries && !result.completed; i++) {
      result = await this.review(wi, candidate, requirement);
    }
    return result;
  }

  // -------------------------------------------------------------- challenge

  async challenge(
    wi: WorkItem,
    goal: string,
    contextText: string,
  ): Promise<{ summary: string; assessment: string } | null> {
    if (!this.broker) return null;
    const task = `You are a clean-room challenger. From the original requirement ONLY, derive an independent approach for:
"${goal}"
You must NOT inherit any prior candidate reasoning. Inspect the repository with repo_search/symbol to ground your approach. Propose your independent approach and call out any risks or alternative designs. Report your assessment.`;
    const { run } = await this.runWorker("clean-room-challenger", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
      worker: this.reviewerWorker ?? undefined,
    });
    const details = run.result.details as { assessment?: string };
    return { summary: run.result.summary, assessment: details?.assessment ?? run.result.summary };
  }

  /**
   * Clean-room challenger pass over the top two tournament finalists: an
   * independent session inspects both candidates' diffs (via artifact_read) and
   * picks the better approach. Returns the chosen winner candidate id, or null
   * if the challenger could not complete.
   */
  private async challengeFinalists(
    wi: WorkItem,
    goal: string,
    a: Candidate,
    b: Candidate,
  ): Promise<{ winnerCandidateId: string; summary: string } | null> {
    if (!this.broker) return null;
    const task = `You are a clean-room challenger. Two candidate implementations competed for the goal:
"${goal}"
Candidate A: ${a.id} (changed ${a.changed_files?.length ?? 0} file(s)).
Candidate B: ${b.id} (changed ${b.changed_files?.length ?? 0} file(s)).

Inspect BOTH candidates' diffs with artifact_read (uri "${a.diff_artifact_uri ?? "(no captured diff)"}" and "${b.diff_artifact_uri ?? "(no captured diff)"}"), then judge which approach is better for correctness, minimality, and maintainability. Do not inherit prior reviewer reasoning.

Return details.winner_candidate_id set to "${a.id}" or "${b.id}" for your pick.`;
    const { run } = await this.runWorker("clean-room-challenger", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      wi,
      timeoutMs: 240_000,
      worker: this.reviewerWorker ?? undefined,
    });
    if (run.result.status !== "completed") return null;
    const details = run.result.details as { winner_candidate_id?: string };
    const pick = details.winner_candidate_id;
    if (pick !== a.id && pick !== b.id) return null;
    return { winnerCandidateId: pick, summary: run.result.summary };
  }

  /**
   * One parallel leg of a candidate tournament: create an isolated worktree,
   * implement, verify, remove the worktree, and (for survivors) run the
   * independent review. Runs entirely within its own candidate scope so it is
   * safe to invoke concurrently via Promise.all (spec §12.1).
   */
  private async runTournamentCandidate(
    wi: WorkItem,
    goal: string,
    index: number,
    n: number,
    risk: RiskLevel,
    contextText: string,
    actor: Actor,
  ): Promise<{ entry: TournamentEntry; evidenceIds: string[] }> {
    let candidate: Candidate | null = null;
    let worktreePath: string | null = null;
    let branch: string | null = null;
    try {
      const cw = await this.createCandidateWorktree(wi, null, actor);
      candidate = cw.candidate;
      worktreePath = cw.worktreePath;
      branch = candidate.branch;
      const task = `Independently implement the goal in this repository (candidate ${index + 1} of ${n}, take your own approach):\n"${goal}"\nRisk level: ${risk}. Make the smallest coherent change. Use the provided context and repository tools. Run a quick targeted check before finishing.`;
      await this.implementIn(wi, candidate, worktreePath, task, contextText);
      const { outcome, evidenceIds } = await this.verify(wi, candidate, worktreePath);
      if (this.git && worktreePath) {
        await this.git
          .removeWorktree({ path: worktreePath, branch: candidate.branch }, { keepBranch: true })
          .catch(() => {});
      }

      if (!outcome.passed) {
        await this.ledger.rejectCandidate(
          candidate.id,
          wi.id,
          `verification failed: ${outcome.failedStage}`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.releaseCandidate(candidate, wi);
        return {
          entry: { candidate, outcome, findings: [], reviewCompleted: false, winner: false },
          evidenceIds,
        };
      }

      // Independent review of each survivor (INV-007). A candidate whose review
      // failed to complete is recorded as having no completed review and is
      // ineligible to win, so a review infrastructure failure can never hand the
      // tournament to an unreviewed candidate.
      this.emitPhase({ workItemId: wi.id, phase: "review", goal });
      const rev = await this.reviewWithRetry(wi, candidate, goal);
      if (!rev.completed) {
        await this.ledger.recordEntity(
          "finding",
          `Independent review of ${candidate.id} failed to complete (context budget/timeout) after retries; candidate ineligible to win.`,
          "open",
          this.actor(newRunId(), "reviewer"),
          wi.id,
          { severity: "critical", candidateId: candidate.id },
        );
      }
      return {
        entry: {
          candidate,
          outcome,
          findings: materialFindings(this.ledger, candidate.id),
          reviewCompleted: rev.completed,
          winner: false,
        },
        evidenceIds,
      };
    } catch (err) {
      // PER-LEG ERROR ISOLATION: a throwing leg must never crash the whole
      // tournament, orphan sibling legs, or leak git state (INV-003/004). We
      // record the failure as a rejected candidate + a finding, clean up any
      // created branch/worktree, and return a failed entry so the caller can
      // continue with the surviving legs.
      const msg = err instanceof Error ? err.message : String(err);
      if (!candidate) {
        candidate = await this.ledger.createCandidate(
          wi.id,
          "",
          branch ?? `pi-eng-leg-${newRunId().slice(4).toLowerCase()}`,
          null,
          "implementer",
          newRunId(),
          null,
          actor,
        );
      }
      await this.ledger.rejectCandidate(candidate.id, wi.id, `candidate leg failed: ${msg}`, actor).catch(() => {});
      await this.releaseCandidate(candidate, wi);
      await this.ledger
        .recordEntity("finding", `tournament candidate leg failed: ${msg}`, "open", actor, wi.id, {
          severity: "critical",
          candidateId: candidate.id,
        })
        .catch(() => {});
      return {
        entry: {
          candidate,
          outcome: { passed: false, failedStage: "leg-error", stages: [], evidence: [], noTargets: false },
          findings: [],
          reviewCompleted: false,
          winner: false,
        },
        evidenceIds: [],
      };
    }
  }

  // --------------------------------------------------------------- engineer

  /**
   * Candidate tournament (spec §12): spawn several INDEPENDENT implementations
   * from the same base commit, verify + review each, then deterministically
   * select and promote a winner. Falls back to a single candidate if N is 1.
   * Deterministic and testable with FakeWorkerExecutor.
   */
  async tournament(
    goal: string,
    opts: {
      n?: number;
      strategy?: TournamentStrategy;
      challengeFinalists?: boolean;
      /**
       * Run the independent candidates concurrently (default false). Safe
       * because each candidate owns an isolated worktree and nothing is merged
       * into the main branch until the winner is selected. A single serial
       * worker gains little; a concurrency-capable worker / distinct reviewer
       * worker benefits. Defaults to sequential to keep behavior conservative.
       */
      parallel?: boolean;
    } = {},
  ): Promise<TournamentReport> {
    const n = Math.max(1, Math.min(opts.n ?? 3, 5));
    const strategy = opts.strategy ?? "findings";
    const challengeFinalists = opts.challengeFinalists ?? false;
    const parallel = opts.parallel ?? false;
    const risk = classifyRisk(goal);
    const actor = this.actor(newRunId(), "planner");
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], actor);

    if (this.roadmapComplete && (await this.roadmapComplete())) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        work_item: wi,
        risk,
        n_candidates: n,
        entries: [],
        incumbent_candidate: null,
        evidence_ids: [],
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }

    if (!this.broker) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        work_item: wi,
        risk,
        n_candidates: n,
        entries: [],
        incumbent_candidate: null,
        evidence_ids: [],
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, []);

    // Phase A: independent implementations (no parent lineage). Each candidate
    // runs in its own isolated worktree and merges nothing into the main branch
    // (only the winner is merged later), so candidates may be launched
    // CONCURRENTLY when requested. Ledger writes are serialized by the
    // EventStore so concurrent producers never corrupt the durable state.
    const entries: TournamentEntry[] = [];
    const evidenceIds: string[] = [];
    if (parallel) {
      const phaseAResults = await Promise.all(
        Array.from({ length: n }, (_, i) => this.runTournamentCandidate(wi, goal, i, n, risk, contextText, actor)),
      );
      for (const r of phaseAResults) {
        entries.push(r.entry);
        evidenceIds.push(...r.evidenceIds);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const r = await this.runTournamentCandidate(wi, goal, i, n, risk, contextText, actor);
        entries.push(r.entry);
        evidenceIds.push(...r.evidenceIds);
      }
    }

    // Phase B: deterministic winner selection among verified survivors. Only
    // candidates with a completed independent review are eligible to win.
    // A lone no-targets candidate is promotable by design: work with no checks is acceptable when no criterion requires tests.
    const survivors = entries.filter((e) => e.outcome.passed && e.reviewCompleted);
    if (survivors.length === 0) {
      // No eligible winner. Candidates that passed verification but whose review
      // never completed are still recorded as rejected and their branches are
      // cleaned up, so the worktree is never left with dangling ELIGIBLE
      // candidates or stray pi-eng-* branches (INV-003/004).
      for (const e of entries.filter((x) => x.outcome.passed && !x.reviewCompleted)) {
        await this.ledger.rejectCandidate(
          e.candidate.id,
          wi.id,
          `review did not complete`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.releaseCandidate(e.candidate, wi);
      }
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        work_item: wi,
        risk,
        n_candidates: n,
        entries,
        incumbent_candidate: null,
        evidence_ids: evidenceIds,
        outcome: "failed",
        telemetry: this.telemetry,
      };
    }
    // Score per the selected deterministic winner-selection strategy.
    survivors.sort((a, b) => selectionCompare(a, b, strategy));

    // Optional clean-room challenger pass across the top finalists (spec §12.2,
    // §19.3). The challenger independently inspects the leading finalists' diffs
    // and may promote the runner-up if the leader's approach is judged worse.
    if (
      challengeFinalists &&
      survivors.length >= 2 &&
      (risk === "high" || risk === "critical") &&
      challengerMayDisplace(survivors[0]!, survivors[1]!)
    ) {
      const lead = survivors[0]!;
      const runner = survivors[1]!;
      const verdict = await this.challengeFinalists(wi, goal, lead.candidate, runner.candidate);
      if (verdict && verdict.winnerCandidateId === runner.candidate.id) {
        survivors[0] = runner;
        survivors[1] = lead;
        await this.ledger.recordEntity(
          "decision",
          `challenger selected ${runner.candidate.id} over ${lead.candidate.id} as tournament winner: ${verdict.summary.slice(0, 200)}`,
          "accepted",
          this.actor(newRunId(), "clean-room-challenger"),
          wi.id,
        );
      }
    }
    // Reject survivors whose review never completed (they lost to the winner or
    // were ineligible), keeping them recorded rather than silently dropped.
    for (const e of entries.filter((x) => !x.winner && x.outcome.passed && !x.reviewCompleted)) {
      await this.ledger.rejectCandidate(
        e.candidate.id,
        wi.id,
        `review did not complete`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.releaseCandidate(e.candidate, wi);
    }
    const winner = survivors[0]!;
    winner.winner = true;

    // Reject the losers (recorded, never silently dropped).
    for (const e of survivors.slice(1)) {
      await this.ledger.rejectCandidate(
        e.candidate.id,
        wi.id,
        `lost tournament to ${winner.candidate.id}`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.releaseCandidate(e.candidate, wi);
    }

    // Phase C: promote the winner via controlled merge. Serialized against other
    // repo-mutating git operations (parallel DAG / tournaments).
    const merge = this.git
      ? await this.withGitLock(() => this.git!.mergeBranch(winner.candidate.branch))
      : { merged: true, conflict: false, reason: null };
    let outcome: TournamentReport["outcome"] = "failed";
    let incumbent: Candidate | null = null;
    if (merge.merged) {
      await this.ledger.promoteCandidate(winner.candidate.id, wi.id, this.actor(newRunId(), "reviewer"));
      incumbent = winner.candidate;
      outcome = "promoted";
      await this.releaseCandidate(winner.candidate, wi);
    } else {
      await this.ledger.rejectCandidate(
        winner.candidate.id,
        wi.id,
        merge.conflict ? `merge conflict with incumbent` : `merge failed: ${merge.reason ?? "unknown"}`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.releaseCandidate(winner.candidate, wi);
    }

    await this.ledger.updateWorkItem(wi.id, { status: incumbent ? "COMPLETED" : "FAILED" }, actor);
    return {
      work_item: wi,
      risk,
      n_candidates: n,
      entries,
      incumbent_candidate: incumbent,
      evidence_ids: evidenceIds,
      outcome,
      telemetry: this.telemetry,
    };
  }

  // ------------------------------------------------------------------- DAG

  /**
   * Decompose a large goal into an ordered, dependency-aware task DAG (spec
   * §11, §19). A planner worker returns machine-readable tasks (title, kind,
   * risk, depends_on indices, write scope); each is recorded in the ledger with
   * its dependency edges resolved to task ids. The DAG is then runnable via
   * executePlan(), which pushes each task through the standard pipeline.
   */
  async plan(goal: string): Promise<PlanReport> {
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        plan_work_item: wi,
        tasks: [],
        summary: "Blocked: roadmap complete — autonomous stop (no new work invented).",
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    if (!this.git || !this.broker) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        plan_work_item: wi,
        tasks: [],
        summary: "Blocked: not a git repository.",
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const risk = classifyRisk(goal);
    const actor = this.actor(newRunId(), "planner");
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], actor);
    await this.ledger.recordEntity("requirement", goal, "open", actor, wi.id);
    const contextText = await this.safeContext(goal, ROLE_BUDGETS.planner.targetTokens, []);

    const task = `You are a task planner. Decompose the goal below into a dependency-aware task DAG.
Each task is one independently-implementable unit that will later be run through the standard engineer pipeline (scout -> implement -> verify -> independent review) against the current repository, in the order you specify.

Return EXACTLY as details.tasks an array of task objects with these fields:
- "title": string (the concrete, self-contained goal for that task)
- "kind": one of "implementation" | "investigation" | "test" | "review"
- "risk": one of "low" | "medium" | "high" | "critical"
- "depends_on": array of 0-based indices into this tasks array that must complete first (may be empty)
- "scope_paths": array of files/directories the task will likely modify (for conflict detection)

Rules:
- Never put two tasks in parallel that write the same file (they conflict).
- Each task must depend only on EARLIER tasks in the array.
- Prefer a small number of coherent tasks (2-6) over many trivial ones.
- The tasks must together cover the whole goal.

Goal: "${goal}"`;
    const { run } = await this.runWorker("planner", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    const details = run.result.details as { tasks?: Array<PlannerTaskSpec> };
    const raw = Array.isArray(details?.tasks) ? details.tasks.filter(isPlannerTaskSpec) : [];
    // Never silently drop planner output: record a diagnostic when tasks are
    // truncated (cap of 10) or carry invalid dependency references.
    if (raw.length > 10) {
      await this.ledger.recordEntity(
        "decision",
        `plan: planner produced ${raw.length} tasks; truncated to 10 (spec §11 recommends 2-6). Extra tasks dropped.`,
        "accepted",
        actor,
        wi.id,
      );
    }
    for (let i = 0; i < raw.length; i++) {
      const invalid = (raw[i]!.depends_on ?? []).filter(
        (d) => !Number.isInteger(d) || d < 0 || d >= raw.length || d === i,
      );
      if (invalid.length) {
        await this.ledger.recordEntity(
          "finding",
          `plan task ${i} (${raw[i]!.title}) had invalid depends_on ${JSON.stringify(invalid)}; those edges dropped.`,
          "open",
          actor,
          wi.id,
          { severity: "low" },
        );
      }
    }
    const specs = raw.slice(0, 10);
    if (specs.length === 0) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        summary: run.result.summary,
        outcome: "failed",
        telemetry: this.telemetry,
      };
    }

    // Create tasks, then resolve depends_on (indices) to real task ids.
    const created: Task[] = [];
    for (const s of specs) {
      created.push(await this.ledger.createTask(wi.id, s.title, s.kind, s.risk, actor, s.scope_paths ?? [], []));
    }
    for (let i = 0; i < created.length; i++) {
      const s = specs[i]!;
      const deps = (s.depends_on ?? [])
        .filter((d) => Number.isInteger(d) && d >= 0 && d < created.length && d !== i)
        .map((d) => created[d]!.id);
      if (deps.length) await this.ledger.updateTask(created[i]!.id, { depends_on: deps }, wi.id, actor);
    }
    await this.ledger.recordEntity(
      "decision",
      `plan: ${created.length} tasks decomposed for "${goal}" (${run.result.summary.slice(0, 160)})`,
      "accepted",
      actor,
      wi.id,
    );
    return {
      plan_work_item: wi,
      tasks: created,
      summary: run.result.summary,
      outcome: "planned",
      telemetry: this.telemetry,
    };
  }

  /**
   * Execute a planned task DAG (spec §11). Runs each task through the standard
   * engineer pipeline in dependency (topological) order, blocks tasks whose
   * dependencies failed, and links each executed task to its result work item.
   * Execution is sequential (single-model constraint) with write-scope conflict
   * detection recorded so conflicting tasks are never run concurrently.
   */
  async executePlan(
    planWorkItemId: string,
    opts: { parallel?: boolean; concurrency?: number } = {},
  ): Promise<DagReport> {
    const actor = this.actor(newRunId(), "planner");
    const wi = this.ledger.getWorkItem(planWorkItemId);
    if (!wi) {
      throw new Error(`Unknown plan work item ${planWorkItemId}; run /plan first.`);
    }
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "blocked",
        summary: "Blocked: roadmap complete — autonomous stop (no new work invented).",
        telemetry: this.telemetry,
      };
    }
    if (!this.git) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "blocked",
        summary: "Blocked: not a git repository.",
        telemetry: this.telemetry,
      };
    }
    const tasks = this.ledger.listTasks(wi.id);
    if (tasks.length === 0) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "failed",
        summary: "No tasks in this plan. Run /plan first.",
        telemetry: this.telemetry,
      };
    }

    let order: Task[];
    try {
      order = topoSort(tasks);
    } catch (err) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      const msg = err instanceof Error ? err.message : String(err);
      await this.ledger.recordEntity("finding", msg, "open", actor, wi.id, { severity: "critical" });
      return { plan_work_item: wi, tasks, order: [], outcome: "failed", summary: msg, telemetry: this.telemetry };
    }

    // Record write-scope conflicts among tasks that are otherwise parallelizable
    // (informational; execution is sequential under the single-model constraint).
    for (const [i, a] of order.entries()) {
      for (const b of order.slice(i + 1)) {
        if (a.depends_on.includes(b.id) || b.depends_on.includes(a.id)) continue;
        if (tasksConflict(a, b)) {
          await this.ledger.recordEntity(
            "decision",
            `write-scope conflict: ${a.id} and ${b.id} both modify ${a.scope_paths.filter((p) => b.scope_paths.includes(p)).join(", ")}; will not run concurrently`,
            "accepted",
            actor,
            wi.id,
          );
        }
      }
    }

    const completed: string[] = [];
    const failed: string[] = [];
    const blocked: string[] = [];
    const failedSet = new Set<string>();
    const summaries: string[] = [];
    const seen = new Set<string>();

    // Parallel execution (M13): run independent, write-scope-disjoint tasks
    // concurrently via the Scheduler. The git lock serializes repo mutations
    // so concurrent tasks never race the shared index. When `parallel` is
    // false, execution stays sequential (single-model-safe default).
    const runTask = async (t: Task): Promise<void> => {
      seen.add(t.id);
      // Idempotent re-execution: never re-run a task that already finished.
      if (t.status === "completed") {
        completed.push(t.id);
        summaries.push(`${t.id} already completed (skipped)`);
        return;
      }
      if (t.status === "failed" || t.status === "blocked") {
        failedSet.add(t.id);
        (t.status === "failed" ? failed : blocked).push(t.id);
        summaries.push(`${t.id} previously ${t.status} (skipped)`);
        return;
      }
      // A dependency failed (or was blocked): this task cannot run.
      if (t.depends_on.some((d) => failedSet.has(d))) {
        await this.ledger.setTaskStatus(t.id, "blocked", wi.id, actor);
        failedSet.add(t.id);
        blocked.push(t.id);
        summaries.push(`${t.id} blocked (dependency failed)`);
        return;
      }
      await this.ledger.setTaskStatus(t.id, "started", wi.id, actor);
      summaries.push(`running ${t.id}: ${t.title}`);
      const report = await this.engineer(t.title);
      if (report.outcome === "promoted") {
        await this.ledger.setTaskStatus(t.id, "completed", wi.id, actor);
        await this.ledger.updateTask(t.id, { result_work_item_id: report.work_item.id }, wi.id, actor);
        completed.push(t.id);
        summaries.push(`${t.id} completed -> ${report.work_item.id}`);
      } else {
        // The task's own pipeline run failed (not dependency-blocked).
        await this.ledger.setTaskStatus(t.id, "failed", wi.id, actor);
        failedSet.add(t.id);
        failed.push(t.id);
        summaries.push(`${t.id} failed (${report.outcome})`);
      }
    };

    if (opts.parallel) {
      // Waves of independent, non-conflicting tasks run concurrently; waves are
      // sequential in dependency order. Bounded by the scheduler's concurrency.
      const waves = EngineeringRuntime.computeParallelWaves(tasks);
      const scheduler = new Scheduler({ concurrency: opts.concurrency ?? 2 });
      for (const wave of waves) {
        const outcomes = await scheduler.scheduleAll(
          wave.map((t) => ({ id: t.id, source: wi.id, run: () => runTask(t) })),
        );
        void outcomes;
      }
    } else {
      for (const t of order) {
        await runTask(t);
      }
    }

    const status: WorkItemStatus =
      completed.length === tasks.length ? "COMPLETED" : completed.length === 0 ? "FAILED" : "PARTIAL";
    await this.ledger.updateWorkItem(wi.id, { status }, actor);
    const outcome: DagReport["outcome"] =
      status === "COMPLETED" ? "completed" : status === "FAILED" ? "failed" : "partial";
    return {
      plan_work_item: wi,
      tasks: this.ledger.listTasks(wi.id),
      order,
      outcome,
      summary: summaries.join("\n"),
      telemetry: this.telemetry,
    };
  }

  /**
   * Assemble + render the context package, degrading to an empty package (and
   * a ledger note) rather than aborting the whole run if the broker fails — a
   * context failure must not silently block otherwise-valid engineering work.
   */
  private async safeContext(goal: string, targetTokens: number, required: string[]): Promise<string> {
    if (!this.broker) return "";
    try {
      const pkg = await this.broker.assembleContext(goal, targetTokens, required);
      return this.broker.renderContext(pkg);
    } catch (err) {
      const note = `context assembly failed: ${String(err)}`;
      await this.ledger.recordEntity("decision", note, "open", this.actor(newRunId(), "planner"), null).catch(() => {});
      emitTelemetry({ level: "warning", text: note });
      return `# Task context (0 tokens, budget ${targetTokens})
(context assembly failed; worker must rely on tools)
`;
    }
  }

  async engineer(goal: string): Promise<EngineerReport> {
    // The status surfaces must never be left showing a task that is over, so
    // "settled" is emitted from a finally — a thrown run clears the footer too.
    let workItemId = "";
    try {
      return await this.engineerInner(goal, (id, phaseGoal) => {
        workItemId = id;
        this.currentPhaseGoal = phaseGoal;
      });
    } finally {
      if (workItemId) this.emitPhase({ workItemId, phase: "settled", goal });
      this.currentWorkItemId = "";
      this.currentPhaseGoal = "";
    }
  }

  private async engineerInner(goal: string, onWorkItem: (id: string, goal: string) => void): Promise<EngineerReport> {
    // Autonomous stop: when the roadmap is complete, do NOT invent new work.
    // Completion is derived (roadmap check), never declared (roadmap spec §13).
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        work_item: wi,
        risk: "medium",
        incumbent_candidate: null,
        scout_summary: "Skipped: roadmap complete — autonomous stop (no new work invented).",
        review_summary: null,
        challenge_summary: null,
        verification: null,
        evidence_ids: [],
        rounds: 0,
        outcome: "stopped",
        telemetry: this.telemetry,
      };
    }
    if (!this.git) {
      return {
        work_item: await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner")),
        risk: "medium",
        incumbent_candidate: null,
        scout_summary: "Skipped: not a git repository.",
        review_summary: null,
        challenge_summary: null,
        verification: null,
        evidence_ids: [],
        rounds: 0,
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const risk = classifyRisk(goal);
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], this.actor(newRunId(), "planner"));
    await this.ledger.recordEntity("requirement", goal, "open", this.actor(newRunId(), "planner"), wi.id);
    this.currentWorkItemId = wi.id;
    onWorkItem(wi.id, goal);

    // Assemble bounded task context.
    let contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, []);

    // Scout (medium+).
    let scoutSummary: string | null = null;
    if (risk !== "low") {
      this.emitPhase({ workItemId: wi.id, phase: "scout", goal });
      const scout = await this.scout(wi, goal, contextText);
      scoutSummary = scout?.summary ?? null;
      // The scout identified a concrete change surface: re-assemble the
      // implementer's context with those files as REQUIRED (content slices
      // included), so the implementer starts with the right files instead of
      // re-exploring the repo and burning tool round-trips.
      const scoutFiles = [...new Set(scout?.relevantFiles ?? [])];
      if (scoutFiles.length && this.broker) {
        contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, scoutFiles);
      }
    }

    // Clean-room challenge (spec §12.2): mandatory for high-risk work, to escape
    // anchoring and protect against a consensus built on a bad premise. The
    // independent assessment is recorded as a ledger decision.
    let challengeSummary: string | null = null;
    if ((risk === "high" || risk === "critical") && this.broker) {
      const chal = await this.challenge(wi, goal, contextText);
      if (chal) {
        challengeSummary = chal.summary;
        await this.ledger.recordEntity(
          "decision",
          `clean-room challenge: ${chal.assessment}`,
          "open",
          this.actor(newRunId(), "clean-room-challenger"),
          wi.id,
        );
      }
    }

    const maxRounds = 3;
    let parentId: string | null = null;
    let incumbent: Candidate | null = null;
    let reviewSummary: string | null = null;
    let lastVerify: VerifyOutcome | null = null;
    const evidenceIds: string[] = [];
    let rounds = 0;
    let feedback = "";

    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const { candidate, worktreePath } = await this.createCandidateWorktree(
        wi,
        parentId,
        this.actor(newRunId(), "implementer"),
      );

      const implTask = `Implement the goal in this repository:
"${goal}"
Risk level: ${risk}. Make the smallest coherent change. Use the provided context and repository tools. Run a quick targeted check (e.g. the project test command) before finishing.${feedback ? `\n\nPRIOR ATTEMPT FEEDBACK (repair these issues):\n${feedback}` : ""}`;
      this.emitPhase({ workItemId: wi.id, phase: "implement", goal });
      const impl = await this.implementIn(wi, candidate, worktreePath, implTask, contextText);

      this.emitPhase({ workItemId: wi.id, phase: "verify", goal });
      const { outcome, evidenceIds: ids, profile } = await this.verify(wi, candidate, worktreePath);
      evidenceIds.push(...ids);
      lastVerify = outcome;

      // Clean up the worktree after verification, keeping the branch until the
      // promotion decision so a promoted candidate can be merged (INV-004).
      if (this.git && worktreePath) {
        await this.git
          .removeWorktree({ path: worktreePath, branch: candidate.branch }, { keepBranch: true })
          .catch(() => {});
      }

      if (!outcome.passed) {
        await this.ledger.rejectCandidate(
          candidate.id,
          wi.id,
          `verification failed: ${outcome.failedStage}`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.releaseCandidate(candidate, wi);
        // Child candidate on next round, with the failing evidence as feedback.
        feedback = `${diffBlock(candidate.diff)}\nVerification failed at stage '${outcome.failedStage}' (exit ${outcome.stages.find((s) => !s.passed)?.exitCode ?? "?"}). Fix it.`;
        parentId = candidate.id;
        if (round === maxRounds - 1) break;
        continue;
      }

      // Independent review (separation of duties, INV-007). A candidate must
      // receive a COMPLETED independent review before it can be promoted; a
      // review that timed out or hit its budget is retried with a fresh session
      // and, if it still fails, treated as a blocking failure (never a clean
      // review).
      const rev = await this.reviewWithRetry(wi, candidate, goal);
      reviewSummary = rev.summary;
      const reviewCompleted = rev.completed;
      const findings = materialFindings(this.ledger, candidate.id);

      if (reviewCompleted && findings.length === 0) {
        // Controlled, evidence-gated promotion (INV-003, INV-005): merge the
        // verified candidate into the incumbent branch, then record it. The merge
        // is serialized through the git lock so parallel DAG legs cannot race it.
        const merge = this.git
          ? await this.withGitLock(() => this.git!.mergeBranch(candidate.branch))
          : { merged: true, conflict: false, reason: null };
        if (merge.merged) {
          await this.ledger.promoteCandidate(candidate.id, wi.id, this.actor(newRunId(), "reviewer"));
          incumbent = candidate;
          await this.releaseCandidate(candidate, wi);
          break;
        }
        // Merge conflict: keep the incumbent immutable, treat as unresolved.
        await this.ledger.rejectCandidate(
          candidate.id,
          wi.id,
          merge.conflict ? `merge conflict with incumbent` : `merge failed: ${merge.reason ?? "unknown"}`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.releaseCandidate(candidate, wi);
        if (round === maxRounds - 1) break;
        parentId = candidate.id;
        continue;
      }
      // Never promote with open material findings OR when the independent
      // review could not complete: reject this candidate and start a fix round;
      // if rounds are exhausted, fail the work item.
      await this.releaseCandidate(candidate, wi);
      const reviewBlocked = !reviewCompleted;
      if (reviewBlocked) {
        // Record a blocking finding so the failure is visible in the ledger and
        // materialFindings reflects it for any downstream caller.
        await this.ledger.recordEntity(
          "finding",
          `Independent review of ${candidate.id} failed to complete (context budget/timeout) after retries; candidate not eligible for promotion.`,
          "open",
          this.actor(newRunId(), "reviewer"),
          wi.id,
          { severity: "critical", candidateId: candidate.id },
        );
      }
      const rejectReason = reviewBlocked
        ? round === maxRounds - 1
          ? `independent review could not complete after ${maxRounds} rounds`
          : `independent review did not complete; retrying with a fresh reviewer`
        : round === maxRounds - 1
          ? `material findings unresolved after ${maxRounds} rounds`
          : `material findings: ${findings.slice(0, 3).join("; ")}`;
      await this.ledger.rejectCandidate(candidate.id, wi.id, rejectReason, this.actor(newRunId(), "reviewer"));
      feedback = reviewBlocked
        ? `${diffBlock(candidate.diff)}\nIndependent review could not complete (context budget/timeout). The next candidate must be independently reviewed before promotion.`
        : `${diffBlock(candidate.diff)}\nReviewer findings to fix:\n${findingsBlock(findings)}`;
      if (round === maxRounds - 1) break;
      parentId = candidate.id;
    }

    await this.ledger.updateWorkItem(
      wi.id,
      { status: incumbent ? "COMPLETED" : "FAILED" },
      this.actor(newRunId(), "planner"),
    );

    return {
      work_item: wi,
      risk,
      incumbent_candidate: incumbent,
      scout_summary: scoutSummary,
      review_summary: reviewSummary,
      challenge_summary: challengeSummary,
      verification: lastVerify,
      evidence_ids: evidenceIds,
      rounds,
      outcome: incumbent ? "promoted" : "failed",
      telemetry: this.telemetry,
    };
  }
}

function candidateSeq(ledger: Ledger, workItemId: string): number {
  return ledger.listCandidates(workItemId).length + 1;
}
