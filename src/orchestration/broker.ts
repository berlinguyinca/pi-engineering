/**
 * Unified execution broker (spec 03).
 *
 * The parent session requests LOGICAL work; the broker chooses the low-level
 * backend (agent child session, subprocess, review, integration) based on task
 * semantics and available capabilities. It exposes a common `execute` contract
 * with cancellation and steering.
 *
 * Backends:
 *   - `agent`     -> a fresh child session/subagent (via injected runner)
 *   - `process`   -> a supervised deterministic subprocess (via injected runner)
 *   - `review`    -> a fresh independent reviewer (via injected reviewer)
 *   - `integration`-> merge/integration of worker handoffs (via injected integrator)
 *   - `validation`-> deterministic validation (via injected validator)
 *   - `research`  -> a bounded research agent (via injected runner)
 *
 * The broker is backend-agnostic: real implementations are wired by the
 * orchestrator; tests inject deterministic fakes.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { id } from "../core/ids.ts";
import { sharedAdmissionController } from "../gateway/config.ts";
import type {
  CandidateLifecycle,
  GitRepo,
  IntegrationRunRecord,
  NestedRepoPublication,
  PromotionResult,
  WorktreeInfo,
} from "../git/GitRepo.ts";
import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import { WAITING_FOR_INFERENCE_SUMMARY, sanitizeWorkerActivity } from "../workers/activity.ts";
import type { CheckpointProgressClaim } from "../workers/checkpointProgressTool.ts";
import type { CheckpointManager, CheckpointSnapshot } from "./checkpoints.ts";
import { EvidenceUnavailableError, buildCandidateEvidenceIdentity } from "./evidence.ts";
import type { GateEvidencePublication, LateExecutionEvidence, MissionStore } from "./missionStore.ts";
import { isNestedPublicationAcceptable } from "./nestedPublicationGate.ts";
import type { DispatchAuthority } from "./ownership.ts";
import { replacementRecoveryFingerprint, replacementTaskFingerprintSpec } from "./recovery.ts";
import type { ExecutionBackend, RecoveredMerge, ReviewEvidence, ValidationEvidence } from "./types.ts";
import { canonicalizeWriteDomain } from "./workset.ts";

export interface ExecutionRequestInput {
  taskId: string;
  missionId: string;
  repoId?: string;
  kind: "agent" | "process" | "review" | "integration" | "validation" | "research";
  role?: string;
  objective: string;
  contextRef?: string;
  mutatesRepo?: boolean;
  writeDomains?: string[];
  isolation?: "none" | "worktree";
  capabilities?: string[];
  modelRequirements?: Record<string, unknown>;
  /** Verified durable checkpoint imported into this fresh execution. */
  recovery?: CheckpointRecoveryContext;
  timeoutPolicy?: { timeoutMs?: number; maxAttempts?: number };
  checkpointId?: string;
  deliverables?: string[];
  executionBudgetMs?: number;
  checkpointPolicy?: { activity_milestone: number; before_deadline_ms: number };
  requiredOutputArtifacts?: string[];
  /**
   * Review only: recovered tasks whose objective the review request asks to
   * verify. Recorded on the execution as `reviewed_recovered`.
   */
  reviewedRecovered?: string[];
  /** Verified current candidate used as the base for fresh gate-repair work. */
  candidateBaseSha?: string;
  acceptanceCriteria?: Array<{ acceptanceId: string; criterion: string }>;
  /** Renewable fencing held by the caller for the complete dispatch. */
  authority?: DispatchAuthority;
}

export interface CheckpointRecoveryContext {
  recoveryDecisionId: string;
  expectedReplacementFingerprint: string;
  originalTaskId: string;
  originalExecutionId: string;
  supersessionId: string;
  missionId: string;
  repoId: string;
  missionGeneration: number;
  candidateGeneration: number;
  fencingToken: number;
  resumptionGeneration: number;
  checkpointId: string;
  candidateSha: string;
  sourceBranch: string;
  sourceWorktree: string;
  committedPaths: readonly string[];
  formerlyDirtyPaths: readonly string[];
  completedDeliverables: readonly string[];
  artifactRefs: readonly string[];
  artifactHashes: readonly string[];
}

export interface ExecutionHandle {
  executionId: string;
  taskId: string;
  missionId: string;
  backend: ExecutionBackend;
  cancel(): Promise<void>;
  steer(request: string): Promise<void>;
  /** Resolves when the execution settles; throws on failure/cancel. */
  result(): Promise<ExecutionOutcome>;
  status(): string;
}

export interface ExecutionOutcome {
  executionId: string;
  exitStatus: string;
  summary: string;
  artifactRefs: string[];
  usage: Record<string, unknown>;
  findings?: Array<Record<string, unknown>>;
  /**
   * Machine-readable failure marker, when the backend reports one (e.g. the
   * worker's `transient:<category>` marker). Carries the structured failure
   * reason so the mission scheduler can classify a NON-throwing failure and
   * route a transient infrastructure failure into the time-based resilience
   * window instead of immediately failing the task.
   */
  error?: string;
  /**
   * Integration only: recovered worker commits this integration verifiably
   * merged (set by the broker, not the runner). Persisted on the execution as
   * `recovered_merged` for the completion gate.
   */
  recoveredMerged?: RecoveredMerge[];
  /** Content hashes of accessible artifacts produced by this backend. */
  artifactHashes?: string[];
  /** The model the attempt ran on, when the backend knows it. */
  model?: { provider: string; id: string };
  validationEvidence?: Pick<
    ValidationEvidence,
    "command" | "profile" | "exitCode" | "testSummary" | "noTargets" | "accessible" | "acceptanceResults"
  >;
  reviewEvidence?: Pick<
    ReviewEvidence,
    | "reviewerSessionId"
    | "model"
    | "provider"
    | "verdict"
    | "independenceMode"
    | "findings"
    | "outputValid"
    | "accessible"
    | "acceptanceResults"
  >;
}

export class RepositoryLifecycleInventoryUnavailableError extends Error {
  readonly code = "PERSISTENCE_UNAVAILABLE";
  readonly repoId: string;

  constructor(repoId: string) {
    super(`PERSISTENCE_UNAVAILABLE: required Git lifecycle inventory is unavailable for repository ${repoId}`);
    this.name = "RepositoryLifecycleInventoryUnavailableError";
    this.repoId = repoId;
  }
}

export interface CleanupFailure {
  repoId: string;
  path: string;
  branch: string;
  preserved: boolean;
  reason: string;
}

export interface CleanupResult {
  failures: CleanupFailure[];
}

export interface DurableRepositoryDiagnostic {
  repoId: string;
  recordKind: "candidate" | "integration-run" | "promotion" | "cleanup" | "repository";
  file: string;
  reason: string;
}

type BackendSettlement =
  | { kind: "backend_result"; outcome: ExecutionOutcome }
  | { kind: "backend_error"; error: unknown };

function lateEvidence(
  settlement: BackendSettlement,
  input: ExecutionRequestInput,
  handoffs: IntegrationHandoff[] = [],
): LateExecutionEvidence {
  const outcome = settlement.kind === "backend_result" ? settlement.outcome : undefined;
  return {
    kind: settlement.kind,
    exitStatus: outcome?.exitStatus ?? null,
    summary: outcome?.summary ?? null,
    error:
      outcome?.error ??
      (settlement.kind === "backend_error"
        ? settlement.error instanceof Error
          ? settlement.error.message
          : String(settlement.error)
        : null),
    artifactRefs: [...(outcome?.artifactRefs ?? [])],
    findings: (outcome?.findings ?? []).map((finding) => ({ ...finding })),
    handoffs: handoffs.map((handoff) => ({
      branch: handoff.worktree.branch,
      path: handoff.worktree.path,
      ref: handoff.ref ?? null,
      recovered: handoff.recovered ?? false,
      summary: handoff.summary,
      artifacts: [...handoff.artifacts],
    })),
    recovery: (outcome?.recoveredMerged ?? []).map((recovered) => ({
      ...recovered,
    })),
    gate: {
      requiredOutputArtifacts: [...(input.requiredOutputArtifacts ?? [])],
      reviewedRecovered: [...(input.reviewedRecovered ?? [])],
      usage: { ...(outcome?.usage ?? {}) },
    },
  };
}

function artifactIdentity(ref: string): string | null {
  const match = /^artifact:\/\/([^/]+)\/.+/.exec(ref);
  return match?.[1] ?? null;
}

function artifactHash(ref: string): string {
  return `sha256:${createHash("sha256").update(ref).digest("hex")}`;
}

/** Backend runner contracts — injected, so the broker stays deterministic-testable. */
export interface AgentRunner {
  /** Spawn a fresh agent child. Returns a handle that resolves on completion. */
  runAgent(input: {
    role: string;
    repoId?: string;
    objective: string;
    contextRef?: string;
    worktree?: string | null;
    /** True only when `worktree` is one this broker allocated for the run. */
    isolatedWorktree?: boolean;
    modelRequirements?: Record<string, unknown>;
    recovery?: CheckpointRecoveryContext;
    deliverables?: readonly string[];
    /** Owning mission and task, for model bookkeeping and operator logs. */
    missionId?: string;
    taskId?: string;
    signal: AbortSignal;
    onActivity?: (event: WorkerActivity) => void;
  }): Promise<ExecutionOutcome>;
  onSteer?: (steer: string) => void;
}

function validateRecoveryPaths(values: string[], field: string): string[] {
  const strings = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`checkpoint recovery ${field} is invalid`);
    }
    return [...value];
  };
  const paths = strings(values, field);
  const unsafePath = (path: string): boolean =>
    path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "..");
  if (paths.some(unsafePath)) {
    throw new Error("checkpoint recovery committed paths are unsafe");
  }
  return paths;
}

export interface ProcessRunner {
  runProcess(input: {
    repoId?: string;
    objective: string;
    worktree?: string | null;
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface ReviewRunner {
  candidateScoped?: boolean;
  runReview(input: {
    repoId?: string;
    objective: string;
    contextRef?: string;
    acceptanceCriteria?: Array<{ acceptanceId: string; criterion: string }>;
    worktree?: string | null;
    /** Owning mission and task: the reviewer avoids the mission's producing models. */
    missionId?: string;
    taskId?: string;
    signal: AbortSignal;
    onActivity?: (event: WorkerActivity) => void;
  }): Promise<ExecutionOutcome & { findings?: Array<Record<string, unknown>> }>;
}

/** One branch handed to the integrator. */
export interface IntegrationHandoff {
  worktree: { path: string; branch: string };
  summary: string;
  artifacts: string[];
  /**
   * Exact commit to merge instead of the branch tip. Set for recovered work:
   * the branch tip also carries the broker's harvest auto-commit of the
   * worker's uncommitted (half-done) edits, which must not be integrated.
   */
  ref?: string;
  /**
   * Committed work recovered from a wall-clock-timed-out execution. Handed off
   * after every clean branch; a conflict on it must not fail the integration.
   */
  recovered?: boolean;
}

export interface IntegrationRunner {
  /** Declares that the runner merges and verifies exclusively in `candidate`. */
  candidateScoped?: boolean;
  runIntegration(input: {
    repoId?: string;
    objective: string;
    handoffs: IntegrationHandoff[];
    candidate?: WorktreeInfo;
    candidateLifecycle?: CandidateLifecycle;
    integrationRun?: IntegrationRunRecord;
    authority?: DispatchAuthority;
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface ValidationRunner {
  candidateScoped?: boolean;
  runValidation(input: {
    repoId?: string;
    objective: string;
    worktree?: string | null;
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface BrokerBackends {
  agent?: AgentRunner;
  process?: ProcessRunner;
  review?: ReviewRunner;
  integration?: IntegrationRunner;
  validation?: ValidationRunner;
}

/** Largest delay setTimeout honours (2^31-1 ms, ~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The worker's machine-readable failure marker for a wall-clock timeout. Only
 * an explicitly configured (opt-in) wall-clock limit produces it.
 */
const WALL_CLOCK_TIMEOUT_MARKER = "timeout";

/**
 * Failure marker for an execution that showed no activity (no tool, model,
 * checkpoint or inference-wait signal) for the inactivity window: a hung
 * worker, not a slow one. The scheduler resumes it rather than failing it.
 */
export const INACTIVITY_MARKER = "inactivity";

/** Abort reason names, so every settlement path can tell the two apart. */
const TIMEOUT_ABORT = "TimeoutError";
const INACTIVITY_ABORT = "InactivityError";

/** Why the broker itself aborted an execution, or null for a caller cancel. */
function clockAbort(signal: AbortSignal): "timeout" | "inactivity" | null {
  const reason = signal.reason;
  if (!(reason instanceof DOMException)) return null;
  if (reason.name === TIMEOUT_ABORT) return "timeout";
  if (reason.name === INACTIVITY_ABORT) return "inactivity";
  return null;
}

function terminalMarker(reason: "canceled" | "timeout" | "inactivity"): string {
  return reason === "timeout" ? WALL_CLOCK_TIMEOUT_MARKER : reason === "inactivity" ? INACTIVITY_MARKER : "canceled";
}

/** Backends whose runners stream worker activity the inactivity watchdog can observe. */
const ACTIVITY_REPORTING_BACKENDS: ReadonlySet<ExecutionBackend> = new Set(["agent", "research", "review"]);

/** Default inactivity window: one full hour with no sign of life at all. */
export const DEFAULT_WORKER_INACTIVITY_MS = 60 * 60_000;

/**
 * True while this process is waiting on the model gateway (an admission hold,
 * a cooldown, or a queue for a slot). Waiting for inference capacity is not a
 * stall: a mission waits as long as the gateway asks it to.
 */
export function processWaitingForInference(): boolean {
  const status = sharedAdmissionController().status();
  return status.waiting > 0 || status.cooldownMs > 0;
}

function pathAllowed(path: string, domains: string[]): boolean {
  const normalized = canonicalizeWriteDomain(path);
  return domains.some((domain) => {
    const pattern = canonicalizeWriteDomain(domain);
    if (pattern === "**") return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3).replace(/\/$/, "");
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized === pattern;
  });
}

/**
 * OPT-IN execution wall-clock limit in ms, or undefined (the default): no
 * execution has a maximum duration. Fixed windows (10, then 30 minutes) killed
 * healthy workers mid-task far more often than they caught hung ones — a task
 * that takes eight hours takes eight hours. Hung workers are caught by the
 * inactivity watchdog instead (`workerInactivityMs`). An operator who really
 * wants a ceiling sets `PI_ENGINEERING_WORKER_TIMEOUT_MS`.
 */
export function workerTimeoutMs(): number | undefined {
  const env = Number.parseInt(process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS ?? "", 10);
  // setTimeout fires IMMEDIATELY for delays above 2^31-1 ms, which would turn a
  // generous override into an instant abort.
  if (Number.isFinite(env) && env > 0) return Math.min(env, MAX_TIMER_MS);
  return undefined;
}

/**
 * How long an execution may show no activity at all before it is treated as
 * hung. Default one hour; `PI_ENGINEERING_WORKER_INACTIVITY_MS` overrides it.
 */
export function workerInactivityMs(): number {
  const env = Number.parseInt(process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return Math.min(env, MAX_TIMER_MS);
  return DEFAULT_WORKER_INACTIVITY_MS;
}

export interface BrokerOptions {
  store: MissionStore;
  backends: BrokerBackends;
  /**
   * Explicit, opt-in wall-clock limit per execution. Unset (the default) means
   * no execution has a maximum duration.
   */
  defaultTimeoutMs?: number;
  /**
   * Abort an activity-reporting execution (agent/research/review) after this
   * long with no worker activity. Time spent waiting for inference capacity
   * never counts. Default `workerInactivityMs()`.
   */
  inactivityTimeoutMs?: number;
  /**
   * Extra probe: true keeps every execution's window open. Default none — an
   * execution is waiting only while its own worker reports it.
   */
  inferenceWaiting?: () => boolean;
  /** Git provider used to allocate isolated worktrees for mutating tasks. */
  git?: GitRepo | null;
  /** Base ref (commit) worktrees are created at. Defaults to current HEAD. */
  baseRef?: string;
  resolveRepository?: (
    repoId: string,
    writableDomains: string[],
    missionId: string,
  ) => Promise<{ repoId: string; root: string; git: GitRepo }>;
  /** Execution-local live worker activity with durable orchestration identity. */
  onActivity?: (
    event: WorkerActivity & {
      missionId: string;
      taskId: string;
      executionId: string;
    },
  ) => void;
  /** Periodic liveness detail for every backend while it is running. */
  activityHeartbeatMs?: number;
  checkpoints?: CheckpointManager;
  /** Content authority for artifact-backed checkpoint progress claims. */
  artifacts?: Pick<ArtifactStore, "readContentByUri" | "putImmutable" | "verifyAndDispatch">;
  /** Maximum cancellation delay while waiting for the backend writer to acknowledge abort. */
  cancellationAckTimeoutMs?: number;
}

export class ExecutionBroker {
  private readonly store: MissionStore;
  private readonly backends: BrokerBackends;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly inactivityTimeoutMs: number;
  private readonly inferenceWaiting: () => boolean;
  private readonly git: GitRepo | null;
  private readonly baseRef: string;
  private readonly resolveRepository?: BrokerOptions["resolveRepository"];
  private readonly onActivity?: BrokerOptions["onActivity"];
  private readonly activityHeartbeatMs: number;
  private readonly checkpoints?: CheckpointManager;
  private readonly artifacts?: BrokerOptions["artifacts"];
  private readonly cancellationAckTimeoutMs: number;
  /** In-flight execution state for cancellation + allocated worktrees. */
  /** Executions canceled by an operator interrupt (pause): their tasks stay resumable. */
  private readonly resumableCancels = new Set<string>();
  private readonly active = new Map<
    string,
    {
      abort: AbortController;
      status: string;
      worktree: string | null;
      taskId: string;
      missionId: string;
      cancelCheckpoint?: () => Promise<void>;
      terminalPromise?: Promise<ExecutionOutcome>;
      authority?: DispatchAuthority;
    }
  >();
  /** Allocated worktrees, cleaned up when their execution settles. */
  readonly allocatedWorktrees = new Map<
    string,
    {
      path: string;
      branch: string;
      git: GitRepo;
      repoId?: string;
      writeDomains: string[];
    }
  >();
  /** Mission-scoped worktrees awaiting integration (merged+cleaned by the integrator). */
  private readonly missionWorktrees = new Map<
    string,
    Array<{
      path: string;
      branch: string;
      git: GitRepo;
      repoId?: string;
      writeDomains: string[];
    }>
  >();
  /** Successfully integrated worktrees awaiting separately owned cleanup. */
  private readonly deferredCleanup = new Map<
    string,
    Array<{
      path: string;
      branch: string;
      git: GitRepo;
      repoId?: string;
      writeDomains: string[];
    }>
  >();
  private readonly missionRepositories = new Map<string, { repoId?: string; root: string; git: GitRepo }>();
  /**
   * ADDITIVE (defect-4): per-mission execution-start baseline of nested
   * standalone repo HEADs, captured once when the mission's first task
   * resolves its repository.
   */
  private readonly nestedBaselines = new Map<string, Promise<Map<string, string>>>();
  /** Isolated integration candidates. Failed/red/canceled candidates remain inspectable. */
  private readonly missionCandidates = new Map<string, { lifecycle: CandidateLifecycle; git: GitRepo }>();
  /** Commit each mission's worktrees were actually forked from (landing invariant). */
  private readonly resolvedBases = new Map<string, string>();
  /** Branches intentionally kept after cleanup because their work never merged. */
  private readonly preserved = new Map<string, string[]>();
  /** Worktree paths whose dirty contents could not be made immutable and therefore must remain mounted. */
  private readonly retainedWorktrees = new Map<string, Set<string>>();
  /**
   * Worker branches whose execution FAILED. Their partial edits are preserved
   * (never merged, never force-deleted) so a failed run's work stays
   * recoverable instead of being destroyed with the worktree teardown.
   */
  /**
   * missionId -> branch -> the LAST settled failure on that branch: its marker
   * (outcome.error, else summary) and, for a wall-clock timeout, the worker's
   * own tip captured BEFORE the harvest auto-commit. A later successful
   * execution on the same branch (a retry of the task) deletes the entry.
   */
  private readonly failedBranches = new Map<
    string,
    Map<string, { marker: string; taskId: string; recoverRef?: string }>
  >();
  /** Missions where at least one worker branch carried commits since base (own commits recognized at harvest). */
  private readonly committedWork = new Map<string, boolean>();

  constructor(opts: BrokerOptions) {
    this.store = opts.store;
    this.backends = opts.backends;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? workerTimeoutMs();
    this.inactivityTimeoutMs = opts.inactivityTimeoutMs ?? workerInactivityMs();
    if (!Number.isFinite(this.inactivityTimeoutMs) || this.inactivityTimeoutMs <= 0) {
      throw new Error("ExecutionBroker inactivityTimeoutMs must be finite and positive");
    }
    // Per execution by default: each execution's own "waiting for inference
    // capacity" activity keeps its window open. A process-wide probe would let
    // one queued worker hide every other worker hanging.
    this.inferenceWaiting = opts.inferenceWaiting ?? (() => false);
    this.git = opts.git ?? null;
    this.baseRef = opts.baseRef ?? "";
    this.resolveRepository = opts.resolveRepository;
    this.onActivity = opts.onActivity;
    this.activityHeartbeatMs = opts.activityHeartbeatMs ?? 15_000;
    this.checkpoints = opts.checkpoints;
    this.artifacts = opts.artifacts;
    this.cancellationAckTimeoutMs = opts.cancellationAckTimeoutMs ?? 5_000;
  }

  private durableRecoveryContext(input: ExecutionRequestInput): CheckpointRecoveryContext | undefined {
    const task = this.store.getTask(input.taskId);
    const authority = task?.recovery_authority;
    if (!authority) return undefined;
    const checkpoint = this.store.getTaskCheckpoint(authority.checkpointId);
    const original = this.store.getTask(authority.originalTaskId);
    const execution = this.store.getExecution(authority.originalExecutionId);
    const decision = this.store.getRecoveryDecision(authority.recoveryDecisionId);
    const lineage = this.store
      .listTaskSupersessions(input.missionId)
      .find((entry) => entry.supersessionId === authority.supersessionId);
    const manifest = this.store.getWorkspaceManifest(input.missionId);
    const expected =
      task && checkpoint && manifest && decision && lineage
        ? replacementRecoveryFingerprint({
            decision,
            lineage,
            replacement: replacementTaskFingerprintSpec(task),
            manifest,
            checkpoint,
          })
        : "";
    const invalid = [
      !task || task.mission_id !== input.missionId ? "replacement task" : null,
      !manifest ? "workspace manifest" : null,
      !checkpoint || checkpoint.missionId !== input.missionId || checkpoint.taskId !== authority.originalTaskId
        ? "checkpoint"
        : null,
      !original || original.mission_id !== input.missionId ? "original task" : null,
      !execution || execution.execution_id !== checkpoint?.executionId || execution.task_id !== authority.originalTaskId
        ? "original execution"
        : null,
      execution?.mission_id !== input.missionId || original?.assigned_execution_id !== authority.originalExecutionId
        ? "execution lineage"
        : null,
      execution?.repo_id !== checkpoint?.repoId || execution?.base_sha !== checkpoint?.baseSha
        ? "execution repository"
        : null,
      execution?.mission_generation !== checkpoint?.missionGeneration ||
      execution?.candidate_generation !== checkpoint?.candidateGeneration ||
      execution?.fencing_token !== checkpoint?.fencingToken ||
      execution?.checkpoint_id !== checkpoint?.checkpointId
        ? "execution authority"
        : null,
      checkpoint?.repoId !== task?.repo_id || input.repoId !== task?.repo_id ? "repository" : null,
      checkpoint?.missionGeneration !== original?.mission_generation ? "mission generation" : null,
      checkpoint?.candidateGeneration !== original?.candidate_generation ? "candidate generation" : null,
      checkpoint?.fencingToken !== original?.fencing_token ? "fencing token" : null,
      !decision ||
      decision.missionId !== input.missionId ||
      decision.resumptionGeneration !== authority.resumptionGeneration
        ? "recovery decision"
        : null,
      !lineage ||
      lineage.failedTaskId !== authority.originalTaskId ||
      !lineage.replacementTaskIds.includes(input.taskId)
        ? "supersession"
        : null,
      lineage?.recoveryDecisionId !== authority.recoveryDecisionId ? "supersession decision" : null,
      lineage?.expectedReplacementFingerprints?.[input.taskId] !== expected ? "lineage fingerprint" : null,
      authority.expectedReplacementFingerprint !== expected ? "replacement fingerprint" : null,
    ].filter((entry): entry is string => entry !== null);
    if (
      invalid.length > 0 ||
      !checkpoint?.candidateSha?.trim() ||
      !checkpoint.branch?.trim() ||
      !checkpoint.worktree?.trim()
    ) {
      throw new Error(
        `checkpoint recovery identity/integrity mismatch: ${[...invalid, "preserved work"].filter((v, i, a) => (invalid.length > 0 ? i < invalid.length : v === "preserved work")).join(", ")}`,
      );
    }
    if (!isAbsolute(checkpoint.worktree)) throw new Error("checkpoint recovery source worktree must be absolute");
    const committedPaths = validateRecoveryPaths(checkpoint.committedChanges, "committed paths");
    const formerlyDirtyPaths = validateRecoveryPaths(checkpoint.preservedUncommittedChanges, "formerly dirty paths");
    if (formerlyDirtyPaths.some((path) => !committedPaths.includes(path))) {
      throw new Error("checkpoint recovery cannot reproduce formerly dirty paths from the immutable candidate");
    }
    if (
      checkpoint.artifactRefs.length !== checkpoint.artifactHashes.length ||
      checkpoint.artifactRefs.some((ref) => !ref.trim()) ||
      checkpoint.artifactHashes.some((hash) => !/^sha256:[a-f0-9]{64}$/i.test(hash))
    ) {
      throw new Error("checkpoint recovery artifact identities do not match");
    }
    return Object.freeze({
      recoveryDecisionId: authority.recoveryDecisionId,
      expectedReplacementFingerprint: expected,
      originalTaskId: authority.originalTaskId,
      originalExecutionId: authority.originalExecutionId,
      supersessionId: authority.supersessionId,
      missionId: input.missionId,
      repoId: checkpoint.repoId,
      missionGeneration: checkpoint.missionGeneration,
      candidateGeneration: checkpoint.candidateGeneration,
      fencingToken: checkpoint.fencingToken,
      resumptionGeneration: authority.resumptionGeneration,
      checkpointId: checkpoint.checkpointId,
      candidateSha: checkpoint.candidateSha,
      sourceBranch: checkpoint.branch,
      sourceWorktree: checkpoint.worktree,
      committedPaths: Object.freeze(committedPaths),
      formerlyDirtyPaths: Object.freeze(formerlyDirtyPaths),
      completedDeliverables: Object.freeze([...checkpoint.completedDeliverables]),
      artifactRefs: Object.freeze([...checkpoint.artifactRefs]),
      artifactHashes: Object.freeze([...checkpoint.artifactHashes]),
    }) as CheckpointRecoveryContext;
  }

  private async preliminaryRecoveryContext(
    input: ExecutionRequestInput,
  ): Promise<CheckpointRecoveryContext | undefined> {
    const recovery = this.durableRecoveryContext(input);
    if (!recovery) return undefined;
    for (const [index, ref] of recovery.artifactRefs.entries()) {
      let content: string | undefined;
      try {
        content = await this.artifacts?.readContentByUri(ref);
      } catch {
        content = undefined;
      }
      const expectedHash = recovery.artifactHashes[index]!;
      const actualHash = content === undefined ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (actualHash !== expectedHash) throw new Error(`checkpoint recovery artifact content mismatch for ${ref}`);
    }
    return recovery;
  }

  /** Read/hash current canonical bytes and invoke the runner in one call stack. */
  private dispatchWithVerifiedRecovery<T>(
    input: ExecutionRequestInput,
    dispatch: (recovery: CheckpointRecoveryContext | undefined) => T,
  ): T {
    const recovery = this.durableRecoveryContext(input);
    if (!recovery) return dispatch(undefined);
    if (!this.artifacts) {
      if (recovery.artifactRefs.length > 0) throw new Error("checkpoint recovery artifact store is unavailable");
      input.recovery = recovery;
      return dispatch(recovery);
    }
    return this.artifacts.verifyAndDispatch(recovery.artifactRefs, recovery.artifactHashes, () => {
      input.recovery = recovery;
      return dispatch(recovery);
    });
  }

  private assertReplacementSpec(input: ExecutionRequestInput): void {
    const task = this.store.getTask(input.taskId);
    if (!task) return;
    const lineages = this.store
      .listTaskSupersessions(input.missionId)
      .filter((entry) => entry.replacementTaskIds.includes(input.taskId));
    if (lineages.length === 0) {
      if (task.replacement_spec_fingerprint) {
        throw new Error("replacement replay fingerprint/full-spec mismatch: missing durable recovery lineage");
      }
      return;
    }
    if (lineages.length !== 1) {
      throw new Error("replacement replay fingerprint/full-spec mismatch: multiple durable recovery lineages");
    }
    if (!task.replacement_spec_fingerprint) {
      throw new Error("replacement replay fingerprint/full-spec mismatch: missing replacement fingerprint");
    }
    const lineage = lineages[0]!;
    const decision = lineage?.recoveryDecisionId
      ? this.store.getRecoveryDecision(lineage.recoveryDecisionId)
      : undefined;
    const manifest = this.store.getWorkspaceManifest(input.missionId);
    const checkpoint = task.recovery_authority
      ? (this.store.getTaskCheckpoint(task.recovery_authority.checkpointId) ?? null)
      : null;
    if (!lineage || !decision || !manifest || (task.recovery_authority && !checkpoint)) {
      throw new Error("replacement replay fingerprint/full-spec mismatch: incomplete durable authority");
    }
    const expected = replacementRecoveryFingerprint({
      decision,
      lineage,
      replacement: replacementTaskFingerprintSpec(task),
      manifest,
      checkpoint,
    });
    if (
      expected !== task.replacement_spec_fingerprint ||
      lineage.expectedReplacementFingerprints?.[task.task_id] !== expected
    ) {
      throw new Error(`replacement replay fingerprint/full-spec mismatch: ${task.task_id}`);
    }
  }

  private async checkpointSnapshot(
    executionId: string,
    input: ExecutionRequestInput,
    repository: { repoId?: string; root: string; git: GitRepo } | null,
    assertOrigin: () => void,
  ): Promise<CheckpointSnapshot> {
    const info = this.allocatedWorktrees.get(executionId);
    if (!info || !repository) {
      return {
        candidateSha: null,
        branch: null,
        worktree: null,
        committedChanges: [],
        preservedUncommittedChanges: [],
      };
    }
    const binding = this.store
      .getWorkspaceManifest(input.missionId)
      ?.repositories.find((candidate) => candidate.repoId === input.repoId);
    const baseSha = binding?.baseSha ?? this.store.getMission(input.missionId)?.base_ref ?? "";
    const candidateSha = await repository.git.headCommitIn(info.path);
    assertOrigin();
    const preservedUncommittedChanges = await repository.git.statusPathsIn(info.path);
    assertOrigin();
    const verifiedCandidateSha = await repository.git.headCommitIn(info.path);
    assertOrigin();
    if (candidateSha !== verifiedCandidateSha) {
      throw new Error("checkpoint snapshot HEAD changed while cancellation state was being collected");
    }
    return {
      candidateSha: verifiedCandidateSha,
      branch: info.branch,
      worktree: info.path,
      committedChanges: baseSha
        ? await repository.git.changedFiles(baseSha, verifiedCandidateSha).then((paths) => {
            assertOrigin();
            return paths;
          })
        : [],
      preservedUncommittedChanges,
    };
  }

  /** Commit cancellation state until hooks leave a clean, immutable branch tip. */
  private async preserveCheckpointWork(
    executionId: string,
    checkpointId: string,
    assertOrigin: () => void,
  ): Promise<string[] | null> {
    const info = this.allocatedWorktrees.get(executionId);
    if (!info) return null;
    const preserved = new Set<string>();
    // A successful hook may mutate files after Git has staged the current
    // snapshot. Re-scan and commit those mutations before claiming durability.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dirty = await info.git.statusPathsIn(info.path);
      assertOrigin();
      for (const path of dirty) preserved.add(path);
      if (dirty.length === 0) return [...preserved].sort();
      await info.git.commitAll(
        info.path,
        `pi-eng: preserve checkpoint ${checkpointId} for ${executionId} (${attempt})`,
        { assertAuthoritative: assertOrigin },
      );
      assertOrigin();
    }
    const remaining = await info.git.statusPathsIn(info.path);
    assertOrigin();
    for (const path of remaining) preserved.add(path);
    if (remaining.length > 0) {
      throw new Error(`checkpoint preservation did not reach an immutable snapshot: ${remaining.join(", ")}`);
    }
    return [...preserved].sort();
  }

  private retainWorktree(missionId: string, executionId: string): void {
    const info = this.allocatedWorktrees.get(executionId);
    if (!info) return;
    const retained = this.retainedWorktrees.get(missionId) ?? new Set<string>();
    retained.add(info.path);
    this.retainedWorktrees.set(missionId, retained);
    const preserved = this.preserved.get(missionId) ?? [];
    if (!preserved.includes(info.branch)) preserved.push(info.branch);
    this.preserved.set(missionId, preserved);
  }

  private isRetainedWorktree(path: string): boolean {
    return [...this.retainedWorktrees.values()].some((paths) => paths.has(path));
  }

  private retainMissionWorktrees(missionId: string): void {
    const retained = this.retainedWorktrees.get(missionId) ?? new Set<string>();
    const branches = this.preserved.get(missionId) ?? [];
    for (const worktree of this.missionWorktrees.get(missionId) ?? []) {
      retained.add(worktree.path);
      if (!branches.includes(worktree.branch)) branches.push(worktree.branch);
    }
    this.retainedWorktrees.set(missionId, retained);
    this.preserved.set(missionId, branches);
  }

  private markBranchIntegrationIneligible(
    executionId: string,
    missionId: string,
    taskId: string,
    marker: string,
  ): void {
    const info = this.allocatedWorktrees.get(executionId);
    if (!info) return;
    const byBranch =
      this.failedBranches.get(missionId) ?? new Map<string, { marker: string; taskId: string; recoverRef?: string }>();
    byBranch.set(info.branch, { marker, taskId });
    this.failedBranches.set(missionId, byBranch);
    const preserved = this.preserved.get(missionId) ?? [];
    if (!preserved.includes(info.branch)) preserved.push(info.branch);
    this.preserved.set(missionId, preserved);
  }

  private async repositoryFor(
    input: ExecutionRequestInput,
  ): Promise<{ repoId?: string; root: string; git: GitRepo } | null> {
    if (input.repoId) {
      if (!this.resolveRepository) {
        const binding = this.store
          .getWorkspaceManifest(input.missionId)
          ?.repositories.find((repository) => repository.repoId === input.repoId);
        if (!binding) throw new Error(`WORKSPACE_SCOPE_MISMATCH: unknown repository binding ${input.repoId}`);
        if (this.git)
          return {
            repoId: input.repoId,
            root: binding.canonicalRoot,
            git: this.git,
          };
        if (!input.mutatesRepo || input.isolation === "none") return null;
        throw new Error(`WORKSPACE_SCOPE_MISMATCH: no repository provider for ${input.repoId}`);
      }
      const resolved = await this.resolveRepository(input.repoId, input.writeDomains ?? [], input.missionId);
      if (resolved.repoId !== input.repoId) {
        throw new Error(`WORKSPACE_SCOPE_MISMATCH: resolved ${resolved.repoId} for ${input.repoId}`);
      }
      return resolved;
    }
    if (this.resolveRepository && input.mutatesRepo) {
      throw new Error("WORKSPACE_SCOPE_MISMATCH: mutating execution has no repository binding");
    }
    if (!this.git) return null;
    return { root: this.git.root, git: this.git };
  }

  private async buildGateEvidencePublication(
    input: ExecutionRequestInput,
    executionId: string,
    backend: ExecutionBackend,
    outcome: ExecutionOutcome,
    repository: { repoId?: string; root: string; git: GitRepo } | null,
  ): Promise<GateEvidencePublication | null> {
    if (!input.repoId || !["integration", "validation", "review"].includes(backend)) return null;
    const manifest = this.store.getWorkspaceManifest(input.missionId);
    const binding = manifest?.repositories.find((candidate) => candidate.repoId === input.repoId);
    const execution = this.store.getExecution(executionId);
    const task = this.store.getTask(input.taskId);
    // Legacy/non-gated broker uses may not have a workspace manifest. Do not
    // synthesize evidence for them; absence remains visible to the gate.
    if (!manifest || !binding || !execution || !task) return null;
    if (!repository) throw new EvidenceUnavailableError(`no repository-scoped Git target for ${input.repoId}`);

    const candidateTarget = this.missionCandidates.get(input.missionId);
    const candidateSha = candidateTarget
      ? await candidateTarget.git.headCommitIn(candidateTarget.lifecycle.path)
      : await repository.git.headCommit();
    const diff = await repository.git.captureDiff(binding.baseSha, candidateSha);
    const diffHash = artifactHash(diff);
    const acceptanceIds = [...new Set(task.acceptance_ids ?? [])].sort();
    const priorArtifacts = this.store.getCandidate(input.missionId, input.repoId)?.identity.artifactHashes ?? [];
    const candidateArtifacts =
      backend === "integration"
        ? [...new Set(outcome.artifactHashes ?? outcome.artifactRefs.map(artifactHash))].sort()
        : priorArtifacts;
    const identity = buildCandidateEvidenceIdentity({
      workspaceManifestHash: manifest.hash,
      missionGeneration: execution.mission_generation ?? task.mission_generation ?? 0,
      repoId: input.repoId,
      baseSha: binding.baseSha,
      candidateSha,
      diffHash,
      acceptanceIds,
      artifactHashes: candidateArtifacts,
    });
    return {
      executionId,
      exitStatus: outcome.exitStatus,
      artifactRefs: [...outcome.artifactRefs],
      usage: structuredClone(outcome.usage),
      ...(outcome.recoveredMerged?.length ? { recoveredMerged: [...outcome.recoveredMerged] } : {}),
      ...(backend === "review" && input.reviewedRecovered?.length
        ? { reviewedRecovered: [...input.reviewedRecovered] }
        : {}),
      identity,
      reason: backend === "integration" ? "integration" : `${backend} target`,
      ...(backend === "validation" && outcome.validationEvidence
        ? {
            validationEvidence: {
              evidenceId: id("VE"),
              missionId: input.missionId,
              taskId: input.taskId,
              executionId,
              ...outcome.validationEvidence,
            },
          }
        : {}),
      ...(backend === "review" && outcome.reviewEvidence
        ? {
            reviewEvidence: {
              evidenceId: id("RE"),
              missionId: input.missionId,
              taskId: input.taskId,
              executionId,
              ...outcome.reviewEvidence,
            },
          }
        : {}),
    };
  }

  /**
   * Cancel one execution through the broker: abort the runner, settle the
   * execution as CANCELED, and release its worktree. Cancellation MUST go here
   * rather than poking the store, otherwise the runner keeps going, the worktree
   * leaks, and the eventual result overwrites CANCELED with SUCCEEDED.
   */
  async cancelExecution(executionId: string, taskId?: string, opts: { resumable?: boolean } = {}): Promise<boolean> {
    const entry = this.active.get(executionId);
    if (!entry) return false;
    if (opts.resumable) this.resumableCancels.add(executionId);
    entry.abort.abort();
    await this.terminalizeAfterGrace(executionId, "canceled", taskId ?? entry.taskId);
    // A cancel that lands while a hung (inactive) execution is settling joins
    // that settlement, which leaves the task RUNNING for a resume. The caller
    // asked for cancellation, so the task must not be resumed — unless this is
    // an operator interrupt (pause), whose task must stay resumable.
    const cancelledTask = taskId ?? entry.taskId;
    if (this.store.getTask(cancelledTask)?.status === "RUNNING") {
      if (opts.resumable) {
        this.store.transitionTask(cancelledTask, "RETRYING", "system", {
          failure_reason: "interrupted by the operator; resumable",
        });
      } else {
        this.store.transitionTask(cancelledTask, "CANCELED");
      }
    }
    return true;
  }

  /** Revoke every active backend from an older explicit resumption before new dispatch. */
  async cancelStaleResumptionExecutions(missionId: string, currentGeneration: number): Promise<void> {
    const stale = [...this.active.entries()].filter(
      ([, entry]) =>
        entry.missionId === missionId &&
        (entry.authority?.resumptionGeneration ?? entry.authority?.missionIdentity.resumptionGeneration ?? 0) !==
          currentGeneration,
    );
    await Promise.all(stale.map(([executionId, entry]) => this.cancelExecution(executionId, entry.taskId)));
  }

  private terminalizeAfterGrace(
    executionId: string,
    reason: "canceled" | "timeout" | "inactivity",
    taskId: string,
  ): Promise<ExecutionOutcome> {
    const entry = this.active.get(executionId);
    if (!entry) return Promise.resolve(this.terminalizeExecution(executionId, reason, taskId));
    if (entry.terminalPromise) return entry.terminalPromise;
    entry.terminalPromise = (async () => {
      this.markBranchIntegrationIneligible(executionId, entry.missionId, taskId, terminalMarker(reason));
      const checkpoint = entry.cancelCheckpoint?.();
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let checkpointSettled = true;
      try {
        checkpointSettled = checkpoint
          ? await Promise.race([
              checkpoint.then(
                () => true,
                () => false,
              ),
              new Promise<false>((resolve) => {
                graceTimer = setTimeout(() => resolve(false), this.cancellationAckTimeoutMs);
                graceTimer.unref?.();
              }),
            ])
          : true;
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
      if ((reason !== "canceled" || !checkpointSettled) && entry.worktree) {
        this.retainWorktree(entry.missionId, executionId);
      }
      const outcome = this.terminalizeExecution(executionId, reason, taskId);
      try {
        await this.preserveCandidate(entry.missionId, entry.authority);
      } catch (error) {
        this.retainMissionWorktrees(entry.missionId);
        this.store.addFinding({
          mission_id: entry.missionId,
          task_id: taskId,
          severity: "major",
          category: "integration",
          file: null,
          line: null,
          summary: `Candidate preservation failed during cancellation; diagnostics retained: ${error instanceof Error ? error.message : String(error)}`,
          evidence: null,
          recommended_action: "Reacquire repository authority before cleanup or candidate lifecycle reconciliation.",
        });
      }
      if (reason === "canceled" && checkpointSettled && entry.worktree) {
        await this.releaseWorktree(executionId, true, entry.authority).catch((error) => {
          this.retainWorktree(entry.missionId, executionId);
          this.store.addFinding({
            mission_id: entry.missionId,
            task_id: taskId,
            severity: "major",
            category: "integration",
            file: null,
            line: null,
            summary: `Canceled worktree cleanup failed; worktree retained: ${error instanceof Error ? error.message : String(error)}`,
            evidence: null,
            recommended_action: "Reacquire repository authority before retrying cleanup.",
          });
        });
      }
      return outcome;
    })();
    return entry.terminalPromise;
  }

  private terminalizeExecution(
    executionId: string,
    reason: "canceled" | "timeout" | "inactivity",
    taskId: string,
  ): ExecutionOutcome {
    const existing = this.store.getExecution(executionId);
    const error = terminalMarker(reason);
    const failed = reason !== "canceled";
    const outcome: ExecutionOutcome = {
      executionId,
      exitStatus: "failed",
      summary:
        reason === "timeout"
          ? "Execution exceeded its configured wall-clock limit and cancellation grace"
          : reason === "inactivity"
            ? "Execution showed no activity for the inactivity window (hung worker); its work is preserved for resumption"
            : "Execution was canceled",
      artifactRefs: [],
      usage: {},
      error,
    };
    if (existing?.status === "RUNNING") {
      this.store.setExecutionStatus(executionId, failed ? "FAILED" : "CANCELED", {
        exit_status: error,
      });
    }
    const task = this.store.getTask(taskId);
    // A hung (inactive) execution leaves its task RUNNING: the scheduler owns
    // the decision to resume it from its checkpoint instead of failing it.
    if (task?.status === "RUNNING" && reason !== "inactivity") {
      if (reason === "canceled" && this.resumableCancels.has(executionId)) {
        // An operator interrupt (pause): the task stays resumable.
        this.store.transitionTask(taskId, "RETRYING", "system", {
          failure_reason: "interrupted by the operator; resumable",
        });
      } else {
        this.store.transitionTask(taskId, failed ? "FAILED" : "CANCELED");
      }
    }
    this.resumableCancels.delete(executionId);
    this.active.delete(executionId);
    return outcome;
  }

  private observeLate(
    executionId: string,
    reason: string,
    settlement: BackendSettlement,
    input: ExecutionRequestInput,
    handoffs: IntegrationHandoff[] = [],
  ): void {
    void this.store.recordLateExecution(executionId, reason, lateEvidence(settlement, input, handoffs));
  }

  /** Cancel the in-flight execution of a task, if any. */
  async cancelByTask(taskId: string, opts: { resumable?: boolean } = {}): Promise<boolean> {
    let canceled = false;
    for (const [executionId, entry] of [...this.active]) {
      if (entry.taskId === taskId) {
        canceled = (await this.cancelExecution(executionId, taskId, opts)) || canceled;
      }
    }
    return canceled;
  }

  /** Allocate an isolated worktree for a mutating, worktree-isolated task. */
  private async allocateWorktree(
    executionId: string,
    input: ExecutionRequestInput,
    repository: { repoId?: string; root: string; git: GitRepo } | null,
  ): Promise<string | null> {
    if (!input.mutatesRepo || input.isolation !== "worktree") return null;
    if (!repository) {
      // Keep the failing behavior (a mutating task must not run without its
      // isolated checkout) but name the state that was missing: the generic
      // message made it impossible to tell a missing workspace-manifest
      // binding from a missing broker git provider. The "git provider"
      // wording is preserved — the failure classifier (recordTerminalFailure)
      // keys off it.
      const binding = input.repoId
        ? this.store.getWorkspaceManifest(input.missionId)?.repositories.find((repo) => repo.repoId === input.repoId)
        : undefined;
      const detail = [
        `repoId=${input.repoId ?? "none bound"}`,
        `manifest binding=${binding ? "present" : "absent"}`,
        `broker git provider=${this.git ? "present" : "absent"}`,
        `repository resolver=${this.resolveRepository ? "configured" : "absent"}`,
      ].join(", ");
      throw new Error(`Required isolated worktree allocation failed: no git provider is available (${detail})`);
    }
    try {
      // The mission's declared base_ref wins: a mission planned against commit X
      // must branch from X. Falling back to a broker-level ref captured earlier
      // (the runtime's HEAD at open) silently based the worker on a NEWER commit,
      // which turns a real conflict into a clean merge where the worker's version
      // wins over the incumbent.
      const missionBase = this.store.getMission(input.missionId)?.base_ref?.trim();
      const recoveryCandidateSha = input.recovery?.candidateSha;
      let base = missionBase || this.baseRef || (await repository.git.headCommit());
      const preservedCandidateSha = recoveryCandidateSha ?? input.candidateBaseSha;
      if (typeof preservedCandidateSha === "string" && preservedCandidateSha.trim()) {
        const resolvedRecovery = await repository.git.resolveCommit(preservedCandidateSha);
        if (resolvedRecovery !== preservedCandidateSha) {
          throw new Error(`repair candidate is unavailable in repository: ${preservedCandidateSha}`);
        }
        base = preservedCandidateSha;
      }
      // Remember what we actually forked from. A mission may be handed an empty
      // base_ref, and without a base the 'did the work land' invariant has nothing
      // to diff against — the fork point recorded here is the fallback.
      this.resolvedBases.set(input.missionId, base);
      const branch = `pi-eng-orch-${input.taskId}`;
      const wt = await repository.git.createWorktree(base, branch, input.authority);
      const info = {
        path: wt.path,
        branch: wt.branch,
        git: repository.git,
        repoId: repository.repoId,
        writeDomains: [...(input.writeDomains ?? [])],
      };
      this.allocatedWorktrees.set(executionId, info);
      // A retried task re-creates its branch (same name): replace, never
      // duplicate, or integration would hand the same branch off twice.
      const mission = (this.missionWorktrees.get(input.missionId) ?? []).filter((w) => w.branch !== info.branch);
      mission.push(info);
      this.missionWorktrees.set(input.missionId, mission);
      try {
        this.store.assertExecutionAuthoritative(executionId);
        input.authority?.assertAuthoritative();
      } catch (error) {
        this.retainWorktree(input.missionId, executionId);
        const terminal = this.store.getExecution(executionId);
        this.markBranchIntegrationIneligible(
          executionId,
          input.missionId,
          input.taskId,
          terminal?.exit_status === WALL_CLOCK_TIMEOUT_MARKER ? WALL_CLOCK_TIMEOUT_MARKER : "canceled",
        );
        throw error;
      }
      return wt.path;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Required isolated worktree allocation failed: ${detail}`, { cause: error });
    }
  }

  /**
   * Commit a finished worker's edits onto its branch. A worktree directory is
   * removed after the task settles, and uncommitted edits die with it — without
   * this harvest, a mutating mission can report COMPLETE having changed the
   * repository not at all. The branch is kept so integration can merge it.
   *
   * Returns true when the worktree held edits that were successfully committed
   * onto the branch (i.e. the work landed and can be integrated). When a worker
   * edited files but the commit itself failed, those edits are otherwise lost
   * silently and the mission would surface only an opaque "integration produced
   * no change" with no trace of the real cause. In that case a finding is
   * recorded so operators and the PI WEB panel see exactly why the work did not
   * land.
   */
  private async harvestWorktree(
    executionId: string,
    authority?: DispatchAuthority,
  ): Promise<"harvested" | "empty" | "unverified"> {
    const wt = this.allocatedWorktrees.get(executionId);
    if (!wt) return "empty";
    const git = wt.git;
    const ex = this.store.getExecution(executionId);
    const missionId = ex?.mission_id;
    const base = missionId
      ? this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId)
      : undefined;
    // A worker that already committed directly onto its worker branch has
    // advanced it past the mission base — that IS the work landing, not
    // "nothing to harvest". Compare the branch TIP to the base commit rather
    // than trusting a clean tree as "empty". Being ahead does NOT end the
    // harvest: a worker that commits as it goes can still leave its last step
    // uncommitted, and returning here dropped that step with the worktree.
    // (Timeout recovery is unaffected: its ref is captured before this runs,
    // so this harvest commit is still excluded from a recovered merge.)
    let ahead = false;
    let status: string;
    try {
      if (base) {
        ahead = await git.branchAheadOf(base, wt.branch);
        if (ahead && missionId) this.committedWork.set(missionId, true);
      }
      status = (await git.statusIn(wt.path)).trim();
    } catch (error) {
      if (missionId) this.retainWorktree(missionId, executionId);
      if (ex) {
        this.store.addFinding({
          mission_id: ex.mission_id,
          task_id: ex.task_id,
          severity: "major",
          category: "integration",
          file: null,
          line: null,
          summary: "Git harvest safety query failed; no handoff was published and the worktree was retained",
          evidence: error instanceof Error ? error.message : String(error),
          recommended_action:
            "Restore trustworthy Git query access, then inspect and re-harvest the retained worktree.",
        });
      }
      return "unverified";
    }
    if (status.length === 0 && ahead) return "harvested";
    if (status.length === 0) {
      // A mutating worker reported SUCCESS but produced nothing to commit.
      // Without this, the mission surfaces only the later opaque "Integration
      // produced no change" block and the operator cannot tell WHICH worker
      // came back empty. Record it here, attributed to the worker's task, so
      // the PI WEB panel and the mission record name the culprit directly.
      const ex = this.store.getExecution(executionId);
      if (ex) {
        this.store.addFinding({
          mission_id: ex.mission_id,
          task_id: ex.task_id,
          severity: "minor",
          category: "integration",
          file: null,
          line: null,
          summary: `Worker branch held no committed work (${wt.branch}); harvested worktree was empty`,
          evidence: null,
          recommended_action:
            "The implementer must actually edit files and commit them; an empty worktree cannot integrate.",
        });
      }
      return "empty";
    }
    try {
      await git.commitAll(wt.path, `pi-eng: orchestration work for ${executionId}`, authority);
      if (missionId) this.committedWork.set(missionId, true);
      return "harvested";
    } catch (err) {
      const ex = this.store.getExecution(executionId);
      if (ex) {
        this.store.addFinding({
          mission_id: ex.mission_id,
          task_id: ex.task_id,
          severity: "major",
          category: "integration",
          file: null,
          line: null,
          summary: "Worker edits could not be harvested (worktree commit failed); the work will not integrate",
          evidence: err instanceof Error ? err.message : String(err),
          recommended_action:
            "Resolve the commit failure and re-run the mission, or recover the worker's uncommitted edits from the preserved worktree branch.",
        });
      }
      return "unverified";
    }
  }

  /**
   * The worker's own tip when it committed work past the mission base, else
   * undefined. An undeterminable count is recorded as a finding rather than
   * silently read as "nothing to recover".
   */
  private async workerCommittedTip(
    executionId: string,
    missionId: string,
    worktree: string,
  ): Promise<string | undefined> {
    const git = this.allocatedWorktrees.get(executionId)?.git;
    if (!git) return undefined;
    const base = this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId);
    let tip: string | undefined;
    let count: number | null = null;
    try {
      tip = await git.headCommitIn(worktree);
      if (base) count = await git.revListCount(`${base}..${tip}`);
    } catch {
      count = null;
    }
    if (count === null) {
      this.recoveryFinding(executionId, "Could not count a timed-out worker's commits; its work was not recovered");
      return undefined;
    }
    return count > 0 ? tip : undefined;
  }

  private recoveryFinding(executionId: string, summary: string, evidence: string | null = null): void {
    const ex = this.store.getExecution(executionId);
    if (!ex) return;
    this.store.addFinding({
      mission_id: ex.mission_id,
      task_id: ex.task_id,
      severity: "minor",
      category: "integration",
      file: null,
      line: null,
      summary,
      evidence,
      recommended_action:
        "Review the recovered commits: they were made before the worker hit its wall-clock budget and were merged after every clean branch.",
    });
  }

  private workspaceScopeFailure(executionId: string, paths: string[], domains: string[]): void {
    const execution = this.store.getExecution(executionId);
    if (!execution) return;
    const summary = `Worker changed paths outside authorized domains (${domains.join(", ") || "none"}): ${paths.join(", ")}`;
    this.store.classifyFailure({
      classificationId: id("FC"),
      missionId: execution.mission_id,
      taskId: execution.task_id,
      executionId,
      category: "WORKSPACE_SCOPE_MISMATCH",
      evidenceRefs: [],
      fingerprint: `workspace-scope:${execution.task_id}:${paths.sort().join("|")}`,
      summary,
      classifiedAt: new Date().toISOString(),
    });
    this.store.addFinding({
      mission_id: execution.mission_id,
      task_id: execution.task_id,
      severity: "blocking",
      category: "integration",
      file: paths[0] ?? null,
      line: null,
      summary,
      evidence: null,
      recommended_action: "Restrict the implementation to the manifest's authorized writable domains.",
    });
  }

  private classifyWorkspaceMismatch(input: ExecutionRequestInput, executionId: string, summary: string): void {
    this.store.classifyFailure({
      classificationId: id("FC"),
      missionId: input.missionId,
      taskId: input.taskId,
      executionId,
      category: "WORKSPACE_SCOPE_MISMATCH",
      evidenceRefs: [],
      fingerprint: `workspace-binding:${input.repoId ?? "missing"}:${summary}`,
      summary,
      classifiedAt: new Date().toISOString(),
    });
  }

  private async outOfScopeWorktreePaths(executionId: string, input: ExecutionRequestInput): Promise<string[]> {
    if (!input.repoId || !input.mutatesRepo) return [];
    const wt = this.allocatedWorktrees.get(executionId);
    if (!wt) return [];
    const domains = input.writeDomains ?? [];
    const base = this.store.getMission(input.missionId)?.base_ref?.trim() || this.resolvedBases.get(input.missionId);
    const changed = new Set<string>();
    if (base) {
      const tip = await wt.git.headCommitIn(wt.path);
      for (const path of await wt.git.changedFiles(base, tip)) changed.add(path);
    }
    for (const path of await wt.git.statusPathsIn(wt.path)) changed.add(path);
    return [...changed].filter((path) => !pathAllowed(path, domains)).sort();
  }

  private async releaseWorktree(executionId: string, keepBranch = true, authority?: DispatchAuthority): Promise<void> {
    const wt = this.allocatedWorktrees.get(executionId);
    if (wt && this.isRetainedWorktree(wt.path)) return;
    if (wt) {
      // Keep the branch: it carries the harvested work until integration merges it.
      try {
        await wt.git.removeWorktree({ path: wt.path, branch: wt.branch }, { keepBranch }, authority);
      } catch (error) {
        const missionId = this.store.getExecution(executionId)?.mission_id;
        if (missionId) {
          this.retainWorktree(missionId, executionId);
          this.store.addFinding({
            mission_id: missionId,
            task_id: this.store.getExecution(executionId)?.task_id ?? null,
            severity: "major",
            category: "integration",
            file: null,
            line: null,
            summary: `Worktree cleanup failed; diagnostics retained: ${error instanceof Error ? error.message : String(error)}`,
            evidence: null,
            recommended_action: "Reacquire repository authority before retrying cleanup.",
          });
        }
        return;
      }
    }
    this.allocatedWorktrees.delete(executionId);
  }

  /** True if the execution left RUNNING already (e.g. canceled via the store). */
  private settledElsewhere(executionId: string): boolean {
    const ex = this.store.listExecutions().find((e) => e.execution_id === executionId);
    return !!ex && ex.status !== "RUNNING";
  }

  /**
   * Whether a backend is registered for this task kind. A gate task that failed
   * because nothing can run it is an unavailable capability, not broken work —
   * spawning an implementer to 'fix' it would burn rounds for nothing.
   */
  hasBackend(kind: ExecutionRequestInput["kind"]): boolean {
    const key = this.backendForKind(kind) as keyof BrokerBackends;
    return !!this.backends[key];
  }

  /** Branches allocated for a mission that still await an integration merge. */
  pendingIntegrations(missionId: string): number {
    return (this.missionWorktrees.get(missionId) ?? []).length;
  }

  /**
   * Whether any of a mission's worker branches carried commits since base.
   *
   * Recognized at harvest time: an implementer that commits directly onto its
   * worker branch (leaving a clean tree) is recorded here. The orchestrator uses
   * this to distinguish a genuinely empty worker branch from a merge/harvest bug
   * where committed work exists on a branch but did not reach the checkout.
   */
  hasCommittedWorkerWork(missionId: string): boolean {
    return this.committedWork.get(missionId) ?? false;
  }

  /**
   * Files the main checkout changed relative to the mission's base commit.
   *
   * This is the invariant behind 'the work landed'. Harvesting a worktree can
   * fail silently and merging an empty branch is trivially clean, so a green
   * integration alone does not prove the repository changed. Returns null when
   * it cannot be determined (no git provider, or the base ref is unknown), in
   * which case the caller must not treat it as 'nothing landed'.
   */
  async changedFilesSinceBase(missionId: string): Promise<string[] | null> {
    const git = this.missionRepositories.get(missionId)?.git ?? this.git;
    if (!git) return null;
    const base = this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId);
    if (!base) return null;
    const candidate = this.missionCandidates.get(missionId);
    const head = candidate ? await git.headCommitIn(candidate.lifecycle.path) : await git.headCommit();
    return await git.changedFiles(base, head);
  }

  /** Recompute candidate content identity from Git; durable metadata is not trusted as mutation proof. */
  async verifiedCandidateContent(missionId: string): Promise<{
    candidateSha: string;
    diffHash: string;
    hasChanges: boolean;
  } | null> {
    const manifest = this.store.getWorkspaceManifest(missionId);
    const candidate = this.store.getCandidate(missionId);
    if (!manifest || !candidate || !this.resolveRepository) return null;
    const binding = manifest.repositories.find((entry) => entry.repoId === candidate.identity.repoId);
    if (!binding) return null;
    const repository = await this.resolveRepository(binding.repoId, [], missionId);
    const target = this.missionCandidates.get(missionId);
    const candidateSha = target
      ? await target.git.headCommitIn(target.lifecycle.path)
      : await repository.git.resolveCommit(candidate.identity.candidateSha);
    if (candidateSha !== candidate.identity.candidateSha) return null;
    const diff = await repository.git.captureDiff(binding.baseSha, candidateSha);
    const diffHash = artifactHash(diff);
    if (diffHash !== candidate.identity.diffHash) return null;
    return {
      candidateSha,
      diffHash,
      hasChanges: candidateSha !== binding.baseSha && diff.trim().length > 0,
    };
  }

  /** Read-only fail-closed preflight for Git journals consumed by recovery. */
  async durableRepositoryDiagnostics(missionId: string): Promise<DurableRepositoryDiagnostic[]> {
    const repoIds = [
      ...new Set(
        [
          ...(this.store.getWorkspaceManifest(missionId)?.repositories.map((repository) => repository.repoId) ?? []),
          ...this.store.listTasks(missionId).map((task) => task.repo_id),
        ].filter((repoId): repoId is string => typeof repoId === "string" && repoId.trim().length > 0),
      ),
    ];
    const diagnostics: DurableRepositoryDiagnostic[] = [];
    for (const repoId of repoIds) {
      try {
        const git = this.resolveRepository ? (await this.resolveRepository(repoId, [], missionId)).git : this.git;
        if (!git) throw new RepositoryLifecycleInventoryUnavailableError(repoId);
        if (
          typeof git.loadCandidateLifecycleInventory !== "function" ||
          typeof git.loadIntegrationRunInventory !== "function" ||
          typeof git.loadPromotionLifecycleInventory !== "function" ||
          typeof git.loadPendingBranchCleanupInventory !== "function"
        ) {
          throw new RepositoryLifecycleInventoryUnavailableError(repoId);
        }
        const inventories = [
          ["candidate", await git.loadCandidateLifecycleInventory(missionId, repoId)],
          ["integration-run", await git.loadIntegrationRunInventory(missionId, repoId)],
          ["promotion", await git.loadPromotionLifecycleInventory(missionId, repoId)],
          ["cleanup", await git.loadPendingBranchCleanupInventory(missionId, repoId)],
        ] as const;
        for (const [recordKind, inventory] of inventories) {
          diagnostics.push(
            ...inventory.diagnostics.map((diagnostic) => ({
              repoId,
              recordKind,
              ...diagnostic,
            })),
          );
        }
      } catch (error) {
        if (error instanceof RepositoryLifecycleInventoryUnavailableError) throw error;
        diagnostics.push({
          repoId,
          recordKind: "repository",
          file: "",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return diagnostics;
  }

  /** Canonical durable Git assets preserved in exact stop diagnostics. */
  async durableRepositoryStateRefs(missionId: string): Promise<string[]> {
    const repoIds = [
      ...new Set(
        [
          ...(this.store.getWorkspaceManifest(missionId)?.repositories.map((repository) => repository.repoId) ?? []),
          ...this.store.listTasks(missionId).map((task) => task.repo_id),
        ].filter((repoId): repoId is string => typeof repoId === "string" && repoId.trim().length > 0),
      ),
    ];
    const refs: string[] = [];
    for (const repoId of repoIds) {
      const git = this.resolveRepository ? (await this.resolveRepository(repoId, [], missionId)).git : this.git;
      if (!git) throw new RepositoryLifecycleInventoryUnavailableError(repoId);
      if (
        typeof git.loadCandidateLifecycleInventory !== "function" ||
        typeof git.loadIntegrationRunInventory !== "function" ||
        typeof git.loadPromotionLifecycleInventory !== "function" ||
        typeof git.loadPendingBranchCleanupInventory !== "function"
      ) {
        throw new RepositoryLifecycleInventoryUnavailableError(repoId);
      }
      const [candidates, runs, promotions, cleanups] = await Promise.all([
        git.loadCandidateLifecycleInventory(missionId, repoId),
        git.loadIntegrationRunInventory(missionId, repoId),
        git.loadPromotionLifecycleInventory(missionId, repoId),
        git.loadPendingBranchCleanupInventory(missionId, repoId),
      ]);
      refs.push(
        ...candidates.records.flatMap((record) => [
          `candidate-record:${record.candidateId}`,
          record.path,
          record.branch,
          record.candidateSha,
        ]),
        ...runs.records.map((record) => `integration-run-record:${record.candidateId}:${record.runId}`),
        ...promotions.records.map(
          (record) => `promotion-record:${record.candidateId}:${record.originRepositoryGeneration}:${record.state}`,
        ),
        ...cleanups.records.flatMap((record) => [
          `cleanup-record:${record.missionId}:${record.repoId}:${record.path}:${record.branch}:${record.state}`,
          record.path,
          record.branch,
        ]),
      );
    }
    return [...new Set(refs)];
  }

  /** Release any worktrees still tracked for a finished mission. */
  async cleanupMission(
    missionId: string,
    opts: {
      keepBranches?: boolean;
      authority?: DispatchAuthority;
      authorityForRepo?: (repoId: string) => Promise<DispatchAuthority>;
    } = {},
  ): Promise<CleanupResult> {
    const deferred = this.deferredCleanup.get(missionId) ?? [];
    if (deferred.length > 0) {
      const active = this.missionWorktrees.get(missionId) ?? [];
      const branches = new Set(active.map((worktree) => worktree.branch));
      for (const worktree of deferred) {
        if (!branches.has(worktree.branch)) active.push(worktree);
      }
      this.missionWorktrees.set(missionId, active);
      this.deferredCleanup.delete(missionId);
    }
    const candidateRepoId = this.missionCandidates.get(missionId)?.lifecycle.repoId;
    const repoIds = [
      ...new Set([
        ...(this.missionWorktrees.get(missionId) ?? []).map((worktree) => worktree.repoId ?? ""),
        ...(candidateRepoId ? [candidateRepoId] : []),
        ...this.store
          .listTasks(missionId)
          .map((task) => task.repo_id)
          .filter((repoId): repoId is string => typeof repoId === "string"),
      ]),
    ];
    const failures: CleanupFailure[] = [];
    for (const repoId of repoIds) {
      let acquired: DispatchAuthority | undefined;
      try {
        acquired = opts.authorityForRepo ? await opts.authorityForRepo(repoId) : opts.authority;
        const assertOrigin = acquired ? () => acquired!.assertAuthoritative() : undefined;
        const trackedGit =
          (this.missionWorktrees.get(missionId) ?? []).find((worktree) => (worktree.repoId ?? "") === repoId)?.git ??
          (this.missionCandidates.get(missionId)?.lifecycle.repoId === repoId
            ? this.missionCandidates.get(missionId)?.git
            : undefined);
        const cleanupGit =
          trackedGit ??
          (this.resolveRepository ? (await this.resolveRepository(repoId, [], missionId)).git : undefined);
        const cleanupInventory = cleanupGit
          ? await cleanupGit.loadPendingBranchCleanupInventory(missionId, repoId)
          : { records: [], diagnostics: [] };
        const pendingBranchCleanups = cleanupInventory.records;
        for (const diagnostic of cleanupInventory.diagnostics) {
          failures.push({
            repoId,
            path: diagnostic.file,
            branch: "",
            preserved: true,
            reason: diagnostic.reason,
          });
        }
        const trackedBranches = new Set(
          (this.missionWorktrees.get(missionId) ?? [])
            .filter((worktree) => (worktree.repoId ?? "") === repoId)
            .map((worktree) => worktree.branch),
        );
        failures.push(
          ...(await this.releaseMissionWorktrees(missionId, opts.keepBranches === true, assertOrigin, repoId)),
        );
        for (const pending of pendingBranchCleanups.filter((record) => !trackedBranches.has(record.branch))) {
          try {
            await cleanupGit!.removeWorktree(
              { path: pending.path, branch: pending.branch },
              { cleanupIdentity: { missionId, repoId } },
              acquired,
            );
          } catch (error) {
            failures.push({
              repoId,
              path: pending.path,
              branch: pending.branch,
              preserved: true,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const candidate = this.missionCandidates.get(missionId);
        if (candidate?.lifecycle.repoId === repoId && candidate.lifecycle.state === "promoted") {
          try {
            assertOrigin?.();
            await candidate.git.removeWorktree(
              {
                path: candidate.lifecycle.path,
                branch: candidate.lifecycle.branch,
              },
              { keepBranch: true },
              acquired,
            );
            this.missionCandidates.delete(missionId);
          } catch (error) {
            failures.push({
              repoId,
              path: candidate.lifecycle.path,
              branch: candidate.lifecycle.branch,
              preserved: true,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const worktree of (this.missionWorktrees.get(missionId) ?? []).filter(
          (candidate) => (candidate.repoId ?? "") === repoId,
        )) {
          failures.push({
            repoId,
            path: worktree.path,
            branch: worktree.branch,
            preserved: true,
            reason,
          });
        }
        const candidate = this.missionCandidates.get(missionId)?.lifecycle;
        if (candidate?.repoId === repoId) {
          failures.push({
            repoId,
            path: candidate.path,
            branch: candidate.branch,
            preserved: true,
            reason,
          });
        }
      } finally {
        if (opts.authorityForRepo && acquired) {
          try {
            const closeError = await acquired.close();
            if (closeError) {
              failures.push({
                repoId,
                path: "",
                branch: "",
                preserved: false,
                reason: `repository cleanup authority release failed: ${closeError.message}`,
              });
            }
          } catch (error) {
            failures.push({
              repoId,
              path: "",
              branch: "",
              preserved: false,
              reason: `repository cleanup authority release failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
    }
    for (const failure of failures) {
      this.store.addFinding({
        mission_id: missionId,
        task_id: null,
        severity: "major",
        category: "integration",
        file: null,
        line: null,
        summary: `Pending repository cleanup for ${failure.repoId || "unbound repository"}: ${failure.branch} at ${failure.path}; preserved=${failure.preserved}; ${failure.reason}`,
        evidence: null,
        recommended_action: "Acquire fresh repository authority and retry the exact pending cleanup.",
      });
    }
    return { failures };
  }

  private deferMissionWorktreeCleanup(missionId: string): void {
    const worktrees = this.missionWorktrees.get(missionId) ?? [];
    const deferred = this.deferredCleanup.get(missionId) ?? [];
    const branches = new Set(deferred.map((worktree) => worktree.branch));
    const preserved = this.preserved.get(missionId) ?? [];
    for (const worktree of worktrees) {
      if (!branches.has(worktree.branch)) deferred.push(worktree);
      if (!preserved.includes(worktree.branch)) preserved.push(worktree.branch);
    }
    if (deferred.length > 0) this.deferredCleanup.set(missionId, deferred);
    this.preserved.set(missionId, preserved);
    this.missionWorktrees.delete(missionId);
  }

  /** Remove + clean all mission worktrees (after integration). */
  private async releaseMissionWorktrees(
    missionId: string,
    keepBranches = false,
    assertOrigin?: () => void,
    repoId?: string,
  ): Promise<CleanupFailure[]> {
    const all = this.missionWorktrees.get(missionId) ?? [];
    const wts = all.filter((worktree) => repoId === undefined || (worktree.repoId ?? "") === repoId);
    const retained = this.retainedWorktrees.get(missionId) ?? new Set<string>();
    const survivors: typeof wts = [];
    const failures: CleanupFailure[] = [];
    try {
      assertOrigin?.();
      for (const wt of wts) {
        assertOrigin?.();
        if (retained.has(wt.path)) {
          survivors.push(wt);
          continue;
        }
        // SAFETY: a worker branch must never be force-deleted (git branch -D)
        // while its work is not contained in the integrated checkout. A branch
        // whose tip IS an ancestor of HEAD was merged (its work landed) and may be
        // dropped so branches do not accumulate. A branch whose tip is NOT an
        // ancestor of HEAD still carries unmerged work and is the only copy of
        // what the worker produced — removeWorktree without keepBranch would run
        // `git branch -D` and orphan the real commits into the object store.
        // Preserve it regardless of whether integration reported success.
        if (wt.git) {
          let keep = keepBranches;
          try {
            const head = this.missionCandidates.get(missionId)?.lifecycle.candidateSha ?? (await wt.git.headCommit());
            assertOrigin?.();
            if (!(await wt.git.isAncestor(wt.branch, head))) keep = true;
            assertOrigin?.();
          } catch (error) {
            assertOrigin?.();
            survivors.push(wt);
            failures.push({
              repoId: wt.repoId ?? "",
              path: wt.path,
              branch: wt.branch,
              preserved: true,
              reason: `Git cleanup safety query failed; worktree and branch retained: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
          assertOrigin?.();
          try {
            await wt.git.removeWorktree(
              { path: wt.path, branch: wt.branch },
              {
                keepBranch: keep,
                cleanupIdentity: { missionId, repoId: wt.repoId ?? "" },
              },
              assertOrigin ? { assertAuthoritative: assertOrigin } : undefined,
            );
          } catch (error) {
            assertOrigin?.();
            keep = true;
            survivors.push(wt);
            failures.push({
              repoId: wt.repoId ?? "",
              path: wt.path,
              branch: wt.branch,
              preserved: true,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
          assertOrigin?.();
          if (keep) {
            const list = this.preserved.get(missionId) ?? [];
            if (!list.includes(wt.branch)) list.push(wt.branch);
            this.preserved.set(missionId, list);
          }
        }
      }
      assertOrigin?.();
    } catch (error) {
      if (assertOrigin) {
        this.retainMissionWorktrees(missionId);
      }
      throw error;
    }
    const untouched = all.filter((worktree) => !wts.includes(worktree));
    if (survivors.length > 0 || untouched.length > 0)
      this.missionWorktrees.set(missionId, [...untouched, ...survivors]);
    else this.missionWorktrees.delete(missionId);
    for (const [execId, info] of [...this.allocatedWorktrees]) {
      if (wts.some((w) => w.branch === info.branch) && !retained.has(info.path)) {
        this.allocatedWorktrees.delete(execId);
      }
    }
    return failures;
  }

  /**
   * Drop preserved worker branches that carry zero unique commits since the
   * mission base (byte-identical "empty shell" branches) and return the
   * branches that still hold unmerged worker work. An empty branch is deleted
   * (it carries nothing, so preserving it only forces manual cleanup) and
   * excluded from the preserved inventory; a branch with real unmerged commits
   * is left untouched. If the base or git cannot be determined the branch is
   * conservatively kept (fail-closed), preserving today's behavior.
   */
  async pruneEmptyPreservedBranches(missionId: string): Promise<string[]> {
    const branches = this.preservedBranches(missionId);
    if (branches.length === 0) return branches;
    const git = this.missionRepositories.get(missionId)?.git ?? this.git;
    const base =
      this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId) || this.baseRef.trim();
    if (!git || !base) return branches;
    const survivors: string[] = [];
    for (const branch of branches) {
      let count: number | null = null;
      try {
        count = await git.revListCount(`${base}..${branch}`);
      } catch {
        count = null;
      }
      // "unknown" is not "no commits": when the count cannot be determined we
      // keep the branch preserved so unmerged work is never silently lost.
      if (count === null || count > 0) {
        survivors.push(branch);
        continue;
      }
      try {
        await git.deleteBranch(branch);
      } catch {
        survivors.push(branch);
        continue;
      }
      this.forgetPreservedBranch(missionId, branch);
    }
    return survivors;
  }

  private forgetPreservedBranch(missionId: string, branch: string): void {
    const preserved = (this.preserved.get(missionId) ?? []).filter((name) => name !== branch);
    if (preserved.length > 0) this.preserved.set(missionId, preserved);
    else this.preserved.delete(missionId);
    const worktrees = this.missionWorktrees.get(missionId);
    if (worktrees) {
      const remaining = worktrees.filter((worktree) => worktree.branch !== branch);
      if (remaining.length > 0) this.missionWorktrees.set(missionId, remaining);
      else this.missionWorktrees.delete(missionId);
    }
  }

  /** Branches kept after cleanup so unmerged worker work stays recoverable. */
  preservedBranches(missionId: string): string[] {
    const branches = [...(this.preserved.get(missionId) ?? [])];
    for (const worktree of this.missionWorktrees.get(missionId) ?? []) {
      if (!branches.includes(worktree.branch)) branches.push(worktree.branch);
    }
    const candidate = this.missionCandidates.get(missionId)?.lifecycle.branch;
    if (candidate && !branches.includes(candidate)) branches.push(candidate);
    return branches;
  }

  candidateWorktree(missionId: string): WorktreeInfo | undefined {
    const candidate = this.missionCandidates.get(missionId)?.lifecycle;
    return candidate ? { path: candidate.path, branch: candidate.branch } : undefined;
  }

  async hasCandidateForPromotion(missionId: string): Promise<boolean> {
    if (this.missionCandidates.has(missionId)) return true;
    // ADDITIVE (defect-4): a recorded nested standalone repo publication is
    // candidate evidence for the mission even without an anchored worktree or
    // integration task.
    if (await this.hasAcceptableNestedPublication(missionId)) return true;
    if (!this.resolveRepository) return false;
    const integrationTask = this.store
      .listTasks(missionId)
      .filter((task) => task.kind === "integration" && task.repo_id && task.status === "SUCCEEDED")
      .at(-1);
    if (!integrationTask?.repo_id) return false;
    const repository = await this.resolveRepository(integrationTask.repo_id, integrationTask.write_domains, missionId);
    const boundBase =
      this.store
        .getWorkspaceManifest(missionId)
        ?.repositories.find((binding) => binding.repoId === integrationTask.repo_id)?.baseSha ??
      this.store.getMission(missionId)?.base_ref;
    return (await repository.git.loadCandidateLifecycles(missionId, integrationTask.repo_id)).some(
      (record) =>
        record.missionGeneration === (integrationTask.mission_generation ?? 0) &&
        record.candidateGeneration === (integrationTask.candidate_generation ?? 0) &&
        record.baseSha === boundBase &&
        ["integrating", "promotion_intent", "promoted"].includes(record.state),
    );
  }

  /**
   * ADDITIVE (defect-4): recorded nested standalone repo publications for this
   * mission that are acceptable candidate evidence (nested HEAD advanced and
   * the work is on the nested remote, or the repo has no remote) AND whose
   * nested HEAD still equals the recorded headSha (the validation step's
   * re-verification). Fail-closed: no git provider, no anchored repo, or any
   * error yields no evidence.
   */
  async nestedPublicationsForMission(missionId: string): Promise<NestedRepoPublication[]> {
    const repository = this.missionRepositories.get(missionId);
    const git = repository?.git ?? this.git;
    if (!git) return [];
    const repoId = repository?.repoId ?? this.store.getWorkspaceManifest(missionId)?.repositories[0]?.repoId;
    if (!repoId) return [];
    try {
      const inventory = await git.loadNestedRepoPublications(missionId, repoId);
      const verified: NestedRepoPublication[] = [];
      for (const record of inventory.records) {
        if (!isNestedPublicationAcceptable(record)) continue;
        const { verified: headMatches } = await git.verifyNestedRepoPublication(record);
        if (headMatches) verified.push(record);
      }
      return verified;
    } catch {
      return [];
    }
  }

  /** ADDITIVE (defect-4): true when the mission has acceptable, re-verified nested publication evidence. */
  async hasAcceptableNestedPublication(missionId: string): Promise<boolean> {
    return (await this.nestedPublicationsForMission(missionId)).length > 0;
  }

  /**
   * ADDITIVE (defect-4): the review evidence for the mission's nested
   * publications — the recorded diff stats, so review does not need the nested
   * worktree. Empty string when there is no nested evidence.
   */
  async nestedPublicationReviewDiffs(missionId: string): Promise<string> {
    const records = await this.nestedPublicationsForMission(missionId);
    if (records.length === 0) return "";
    return records
      .map(
        (record) =>
          `=== ${record.nestedPath} (${record.baseSha.slice(0, 7)}..${record.headSha.slice(0, 7)}) ===\n${record.diffStat}`,
      )
      .join("\n\n");
  }

  /**
   * ADDITIVE (defect-4): memoized per-mission nested HEAD baseline. Captured
   * at execution start (first task repository resolution) so that
   * recordNestedPublicationsForMission can detect nested HEAD advancement over
   * the execution window.
   */
  private nestedBaselineFor(missionId: string, git: GitRepo): void {
    if (!this.nestedBaselines.has(missionId)) {
      this.nestedBaselines.set(
        missionId,
        git.captureNestedRepoHeads().catch(() => new Map<string, string>()),
      );
    }
  }

  /**
   * ADDITIVE (defect-4): record a durable nested repo publication for every
   * nested standalone repo whose HEAD advanced between execution start and
   * now. Called at finalization, before the completion gate evaluates
   * candidate evidence. Without a captured baseline (e.g. after a process
   * restart) no records are produced — fail-closed, no false evidence.
   */
  async recordNestedPublicationsForMission(missionId: string): Promise<NestedRepoPublication[]> {
    const repository = this.missionRepositories.get(missionId);
    const git = repository?.git ?? this.git;
    if (!git) return [];
    const repoId = repository?.repoId ?? this.store.getWorkspaceManifest(missionId)?.repositories[0]?.repoId;
    if (!repoId) return [];
    try {
      const baseHeads = (await this.nestedBaselines.get(missionId)) ?? undefined;
      return await git.recordNestedRepoPublications({ missionId, anchoredRepoId: repoId, baseHeads });
    } catch {
      return [];
    }
  }

  private async preserveCandidate(missionId: string, authority?: DispatchAuthority): Promise<void> {
    const candidate = this.missionCandidates.get(missionId);
    if (!candidate || candidate.lifecycle.state === "promoted") return;
    candidate.lifecycle = {
      ...candidate.lifecycle,
      state: "preserved",
      updatedAt: new Date().toISOString(),
    };
    await candidate.git.persistCandidateLifecycle(candidate.lifecycle, authority);
  }

  /** Sole incumbent mutation: called only after current candidate gates pass. */
  async promoteCandidate(missionId: string, authority?: DispatchAuthority): Promise<boolean> {
    let candidate = this.missionCandidates.get(missionId);
    if (!candidate && this.resolveRepository) {
      authority?.assertAuthoritative();
      const missionGeneration = authority?.missionIdentity.generation;
      const integrationTask = this.store
        .listTasks(missionId)
        .filter(
          (task) =>
            task.kind === "integration" &&
            task.repo_id &&
            task.status === "SUCCEEDED" &&
            (missionGeneration === undefined || task.mission_generation === missionGeneration),
        )
        .at(-1);
      if (integrationTask?.repo_id) {
        const repository = await this.resolveRepository(
          integrationTask.repo_id,
          integrationTask.write_domains,
          missionId,
        );
        const boundBase =
          this.store
            .getWorkspaceManifest(missionId)
            ?.repositories.find((binding) => binding.repoId === integrationTask.repo_id)?.baseSha ??
          this.store.getMission(missionId)?.base_ref;
        const lifecycles = (await repository.git.loadCandidateLifecycles(missionId, integrationTask.repo_id)).filter(
          (record) =>
            record.missionGeneration === (integrationTask.mission_generation ?? 0) &&
            record.candidateGeneration === (integrationTask.candidate_generation ?? 0) &&
            record.baseSha === boundBase &&
            ["integrating", "promotion_intent", "promoted"].includes(record.state),
        );
        if (lifecycles.length > 1) throw new Error("CANDIDATE_AMBIGUOUS: multiple open candidates match promotion");
        const lifecycle = lifecycles[0];
        if (lifecycle) {
          const reconciled = await repository.git.reconcileCandidateWorktree(lifecycle, authority);
          if (reconciled) {
            candidate = { lifecycle, git: repository.git };
            this.missionCandidates.set(missionId, candidate);
          }
        }
      }
    }
    if (!candidate) return false;
    authority?.assertAuthoritative();
    const worktree = {
      path: candidate.lifecycle.path,
      branch: candidate.lifecycle.branch,
    };
    const result = await candidate.git.promoteCandidate(
      worktree,
      candidate.lifecycle.baseSha,
      authority,
      candidate.lifecycle,
    );
    if (!result.promoted) throw new Error(result.reason ?? "candidate promotion failed");
    try {
      await candidate.git.removeWorktree(worktree, { keepBranch: true }, authority);
      this.missionCandidates.delete(missionId);
    } catch (error) {
      // Promotion is committed. A stale cleanup token retains the worktree/ref
      // for a later authoritative reconciliation; it cannot undo promotion.
      this.store.addFinding({
        mission_id: missionId,
        task_id: null,
        severity: "major",
        category: "integration",
        file: null,
        line: null,
        summary: `Promoted candidate cleanup is pending; diagnostics retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`,
        evidence: candidate.lifecycle.candidateSha,
        recommended_action: "Acquire fresh repository cleanup authority and retry candidate worktree removal.",
      });
    }
    return true;
  }

  async reconcileCommittedPromotions(
    missionId: string,
    repoId: string,
    authority: DispatchAuthority,
  ): Promise<PromotionResult[]> {
    if (!this.resolveRepository) return [];
    authority.assertAuthoritative();
    const repository = await this.resolveRepository(repoId, [], missionId);
    authority.assertAuthoritative();
    return repository.git.reconcileCommittedPromotions(missionId, repoId, authority);
  }

  /** Map a task kind to a broker backend. */
  private backendForKind(kind: ExecutionRequestInput["kind"]): ExecutionBackend {
    switch (kind) {
      case "agent":
        return "agent";
      case "process":
        return "process";
      case "review":
        return "review";
      case "integration":
        return "integration";
      case "validation":
        return "validation";
      case "research":
        return "research";
    }
  }

  async execute(rawInput: ExecutionRequestInput): Promise<ExecutionHandle> {
    if (rawInput.recovery || Object.keys(rawInput.modelRequirements ?? {}).some((key) => key.startsWith("recovery"))) {
      throw new Error("checkpoint recovery caller fields are forbidden; durable task authority is required");
    }
    const input: ExecutionRequestInput = {
      ...rawInput,
      writeDomains: (rawInput.writeDomains ?? []).map(canonicalizeWriteDomain),
    };
    this.assertReplacementSpec(input);
    input.recovery = await this.preliminaryRecoveryContext(input);
    input.authority?.assertAuthoritative();
    const executionStartedAt = Date.now();
    // No budget unless one was explicitly asked for (task-level or the opt-in
    // broker default): an execution runs as long as it shows activity.
    const executionBudgetMs: number | undefined =
      input.executionBudgetMs ?? input.timeoutPolicy?.timeoutMs ?? this.defaultTimeoutMs;
    if (executionBudgetMs !== undefined && (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0)) {
      throw new Error("INVALID_TASK_BUDGET: execution budget must be finite and positive");
    }
    if (
      input.checkpointPolicy &&
      (!Number.isInteger(input.checkpointPolicy.activity_milestone) ||
        input.checkpointPolicy.activity_milestone <= 0 ||
        !Number.isFinite(input.checkpointPolicy.before_deadline_ms) ||
        input.checkpointPolicy.before_deadline_ms <= 0 ||
        (executionBudgetMs !== undefined && input.checkpointPolicy.before_deadline_ms >= executionBudgetMs))
    ) {
      throw new Error("INVALID_CHECKPOINT_POLICY: checkpoint lead must be finite, positive, and below budget");
    }
    const executionDeadlineAt = executionBudgetMs === undefined ? undefined : executionStartedAt + executionBudgetMs;
    const watchInactivity = ACTIVITY_REPORTING_BACKENDS.has(this.backendForKind(input.kind));
    const backend = this.backendForKind(input.kind);
    const checkpointId = input.checkpointId ?? (this.checkpoints && input.repoId ? id("TCP") : undefined);
    const task = this.store.getTask(input.taskId);
    const binding = this.store
      .getWorkspaceManifest(input.missionId)
      ?.repositories.find((repository) => repository.repoId === input.repoId);
    const execution = this.store.createExecution({
      task_id: input.taskId,
      mission_id: input.missionId,
      backend,
      model: (input.modelRequirements as { model?: string } | undefined)?.model ?? null,
      thinking_level: (input.modelRequirements as { thinking?: string } | undefined)?.thinking ?? null,
      mission_generation: input.authority?.missionIdentity.generation,
      resumption_generation:
        input.authority?.resumptionGeneration ?? input.authority?.missionIdentity.resumptionGeneration,
      fencing_token: input.authority?.missionIdentity.fencingToken,
      checkpoint_id: checkpointId,
      repo_id: input.repoId,
      base_sha: binding?.baseSha ?? this.store.getMission(input.missionId)?.base_ref,
      candidate_generation: task?.candidate_generation,
    });
    this.store.assignTaskExecution(input.taskId, execution.execution_id);

    const abort = new AbortController();
    let resultPromise: Promise<ExecutionOutcome> | undefined;
    const handle: ExecutionHandle = {
      executionId: execution.execution_id,
      taskId: input.taskId,
      missionId: input.missionId,
      backend,
      status: () =>
        this.active.get(execution.execution_id)?.status ??
        this.store.getExecution(execution.execution_id)?.status ??
        "PENDING",
      cancel: async () => {
        await this.cancelExecution(execution.execution_id, input.taskId);
      },
      steer: async (request) => {
        this.store.steerTask(input.taskId, request);
        const runner = this.backends[backend as keyof BrokerBackends] as { onSteer?: (s: string) => void } | undefined;
        runner?.onSteer?.(request);
      },
      result: () => {
        if (resultPromise) return resultPromise;
        const runOperation = async (): Promise<ExecutionOutcome> => {
          if (abort.signal.aborted) {
            const terminal = this.store.getExecution(execution.execution_id);
            if (terminal?.status === "CANCELED") {
              return this.terminalizeExecution(execution.execution_id, "canceled", input.taskId);
            }
            if (terminal?.status === "FAILED" && terminal.exit_status === WALL_CLOCK_TIMEOUT_MARKER) {
              return this.terminalizeExecution(execution.execution_id, "timeout", input.taskId);
            }
            if (terminal?.status === "FAILED" && terminal.exit_status === INACTIVITY_MARKER) {
              return this.terminalizeExecution(execution.execution_id, "inactivity", input.taskId);
            }
            throw new Error("execution aborted before dispatch");
          }
          // Opt-in only: a configured wall-clock limit.
          const timer =
            executionDeadlineAt === undefined
              ? undefined
              : setTimeout(
                  () =>
                    abort.abort(
                      new DOMException(`Execution exceeded its configured ${executionBudgetMs}ms limit`, TIMEOUT_ABORT),
                    ),
                  Math.max(0, executionDeadlineAt - Date.now()),
                );
          // The limit timer and the inactivity watchdog stay referenced: while
          // an execution is in flight they may be the only thing that will
          // ever settle it, and an unref'd watchdog lets the event loop drain
          // with the awaited result still pending. Both are cleared when the
          // execution settles, so they never outlive it.
          const activityStartedAt = Date.now();
          let lastActivityAt = activityStartedAt;
          // THIS execution's worker last said it is waiting for inference capacity.
          let waitingForInference = false;
          // Hung-worker detection: abort only after a full inactivity window
          // with no worker activity. Waiting on the model gateway is liveness,
          // not silence, so it keeps the window open however long it lasts.
          const inactivityTimer = watchInactivity
            ? setInterval(
                () => {
                  if (abort.signal.aborted) return;
                  const at = Date.now();
                  let waiting = waitingForInference;
                  try {
                    waiting ||= this.inferenceWaiting();
                  } catch {
                    // an injected probe failing never counts as waiting
                  }
                  if (waiting) {
                    lastActivityAt = at;
                    return;
                  }
                  if (at - lastActivityAt < this.inactivityTimeoutMs) return;
                  abort.abort(
                    new DOMException(
                      `Execution showed no activity for ${this.inactivityTimeoutMs}ms (hung worker)`,
                      INACTIVITY_ABORT,
                    ),
                  );
                },
                Math.max(5, Math.min(30_000, Math.floor(this.inactivityTimeoutMs / 4))),
              )
            : undefined;
          let activitySettled = false;
          let activityTimer: ReturnType<typeof setInterval> | undefined;
          let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
          let repository: {
            repoId?: string;
            root: string;
            git: GitRepo;
          } | null = null;
          let meaningfulActivity = 0;
          const completedDeliverables = new Set<string>();
          const checkpointClaims = new Map<string, CheckpointProgressClaim>();
          const capturedCheckpointArtifacts = new Map<string, { refs: string[]; hashes: string[] }>();
          const rejectedCheckpointClaims = new Set<string>();
          let checkpointScheduling = true;
          let retainWorktreeOnCleanup = false;
          let detachedAfterTerminalAbort = false;
          let cleanupOwnedByCancellation = false;
          let cancelCheckpointPromise: Promise<void> | undefined;
          let checkpointChain = Promise.resolve();
          let writerStarted = false;
          let acknowledgeWriterSettled!: () => void;
          const writerSettled = new Promise<void>((resolve) => {
            acknowledgeWriterSettled = resolve;
          });
          const awaitWriterQuiescence = async (): Promise<void> => {
            if (!writerStarted) return;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                writerSettled,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("backend writer did not acknowledge cancellation or quiesce")),
                    this.cancellationAckTimeoutMs,
                  );
                }),
              ]);
            } finally {
              if (timeout) clearTimeout(timeout);
            }
          };
          const assertOrigin = (): void => {
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
          };
          const writeCheckpoint = async (
            declaredCompleted: string[] = [],
            artifactRefs: string[] = [],
            artifactHashes: string[] = [],
            requiredPreservedPaths: string[] | null = null,
          ): Promise<CheckpointSnapshot | undefined> => {
            if (!this.checkpoints || !checkpointId || !input.repoId) return undefined;
            assertOrigin();
            const snapshot = await this.checkpointSnapshot(execution.execution_id, input, repository, assertOrigin);
            assertOrigin();
            for (const claim of checkpointClaims.values()) {
              const claimIdentity = `${claim.deliverable}:${claim.candidateSha}:${claim.evidencePaths.join(",")}:${claim.artifactRefs.join(",")}`;
              let captured = capturedCheckpointArtifacts.get(claimIdentity);
              let artifactsValid = claim.artifactRefs.length === 0;
              if (!captured && claim.artifactRefs.length > 0 && this.artifacts) {
                const refs: string[] = [];
                const hashes: string[] = [];
                artifactsValid = true;
                for (const ref of claim.artifactRefs) {
                  let content: string | undefined;
                  try {
                    content = await this.artifacts.readContentByUri(ref);
                  } catch {
                    content = undefined;
                  }
                  if (content === undefined) {
                    artifactsValid = false;
                    break;
                  }
                  const digest = createHash("sha256").update(content).digest("hex");
                  const immutable = await this.artifacts.putImmutable(
                    "checkpoint",
                    checkpointId,
                    content,
                    `Immutable checkpoint evidence captured from ${ref}`,
                  );
                  refs.push(immutable.uri);
                  hashes.push(`sha256:${digest}`);
                }
                if (artifactsValid) {
                  captured = { refs, hashes };
                  capturedCheckpointArtifacts.set(claimIdentity, captured);
                }
              } else if (captured) {
                artifactsValid = true;
              }
              // Which conjunct(s) failed — the rejection finding must name the
              // specific condition, not just that the claim was rejected.
              const failReasons: string[] = [];
              if (input.deliverables?.includes(claim.deliverable) !== true)
                failReasons.push("deliverable-not-declared");
              if (snapshot.candidateSha === null) failReasons.push("no-candidate-sha");
              else if (claim.candidateSha !== snapshot.candidateSha) failReasons.push("sha-mismatch");
              if (claim.evidencePaths.length === 0) failReasons.push("no-evidence-paths");
              else if (!claim.evidencePaths.every((path) => snapshot.committedChanges.includes(path)))
                failReasons.push("paths-not-committed");
              if (!artifactsValid) failReasons.push("artifacts-invalid");
              const valid = failReasons.length === 0;
              if (valid) {
                completedDeliverables.add(claim.deliverable);
                artifactRefs.push(...(captured?.refs ?? []));
                artifactHashes.push(...(captured?.hashes ?? []));
                continue;
              }
              if (!rejectedCheckpointClaims.has(claimIdentity)) {
                rejectedCheckpointClaims.add(claimIdentity);
                this.store.addFinding({
                  mission_id: input.missionId,
                  task_id: input.taskId,
                  severity: "major",
                  category: "checkpoint_progress",
                  file: null,
                  line: null,
                  summary: `Rejected unauthenticated checkpoint progress for ${claim.deliverable}: ${failReasons.join(", ")}`,
                  evidence: `claimed=${claim.candidateSha}; actual=${snapshot.candidateSha ?? "none"}; paths=${claim.evidencePaths.join(",")}; artifacts=${claim.artifactRefs.join(",") || "none"}`,
                  recommended_action:
                    "Commit the declared deliverable, then report the exact current candidate SHA and committed evidence paths.",
                });
              }
            }
            if (
              requiredPreservedPaths !== null &&
              (!snapshot.candidateSha ||
                snapshot.preservedUncommittedChanges.length > 0 ||
                requiredPreservedPaths.some((path) => !snapshot.committedChanges.includes(path)))
            ) {
              throw new Error("checkpoint final snapshot does not contain every preserved path");
            }
            assertOrigin();
            await this.checkpoints.persist({
              taskId: input.taskId,
              executionId: execution.execution_id,
              completedDeliverables: [...new Set([...completedDeliverables, ...declaredCompleted])],
              artifactRefs,
              artifactHashes,
              model: execution.model,
              snapshot,
            });
            assertOrigin();
            return snapshot;
          };
          const persistCheckpoint = (
            completedDeliverables: string[] = [],
            artifactRefs: string[] = [],
            artifactHashes: string[] = [],
          ): Promise<void> => {
            checkpointChain = checkpointChain.then(async () => {
              await writeCheckpoint(completedDeliverables, artifactRefs, artifactHashes);
            });
            return checkpointChain;
          };
          const queueCheckpoint = (
            completed: string[] = [...completedDeliverables],
            artifactRefs: string[] = [],
            artifactHashes: string[] = [],
          ): void => {
            if (!checkpointScheduling) return;
            void persistCheckpoint(completed, artifactRefs, artifactHashes).catch((error) => {
              retainWorktreeOnCleanup = true;
              this.retainWorktree(input.missionId, execution.execution_id);
              if (this.store.getExecution(execution.execution_id)?.status !== "RUNNING") {
                void this.store.recordLateExecution(execution.execution_id, "checkpoint authority lost", {
                  kind: "checkpoint",
                  exitStatus: null,
                  summary: "Rejected queued checkpoint from a terminal execution",
                  error: error instanceof Error ? error.message : String(error),
                  artifactRefs: [...artifactRefs],
                  findings: [],
                  handoffs: [],
                  recovery: [],
                  gate: null,
                });
              }
            });
          };
          const emitActivity = (event: WorkerActivity): void => {
            if (activitySettled || abort.signal.aborted) return;
            const safe = sanitizeWorkerActivity(event);
            if (!safe) return;
            for (const claim of safe.claims ?? []) {
              checkpointClaims.set(claim.deliverable, claim);
            }
            if (safe.kind !== "heartbeat") {
              lastActivityAt = Date.now();
              waitingForInference = safe.summary === WAITING_FOR_INFERENCE_SUMMARY;
            }
            if (safe.meaningfulProgress && input.checkpointPolicy?.activity_milestone) {
              meaningfulActivity++;
              if (meaningfulActivity % input.checkpointPolicy.activity_milestone === 0) queueCheckpoint();
            }
            try {
              this.onActivity?.({
                ...safe,
                missionId: input.missionId,
                taskId: input.taskId,
                executionId: execution.execution_id,
              });
            } catch {
              // Observability is never a participant in execution.
            }
          };
          const onAbort = (): void => {
            if (activitySettled) return;
            if (activityTimer) clearInterval(activityTimer);
            activityTimer = undefined;
            const timedOut = clockAbort(abort.signal) !== null;
            const safe = sanitizeWorkerActivity({
              kind: "execution",
              phase: timedOut ? "failed" : "canceled",
              stage: backend,
              summary: "",
              meaningfulProgress: false,
            });
            if (safe) {
              try {
                this.onActivity?.({
                  ...safe,
                  missionId: input.missionId,
                  taskId: input.taskId,
                  executionId: execution.execution_id,
                });
              } catch {
                // Observability is never a participant in execution.
              }
            }
            activitySettled = true;
          };
          emitActivity({
            kind: "execution",
            phase: "started",
            stage: backend,
            summary: "",
            meaningfulProgress: false,
          });
          activityTimer =
            this.activityHeartbeatMs > 0
              ? setInterval(() => {
                  const at = Date.now();
                  emitActivity({
                    kind: "heartbeat",
                    stage: backend,
                    summary: "",
                    meaningfulProgress: false,
                    elapsedMs: Math.max(0, at - activityStartedAt),
                    lastActivityMs: Math.max(0, at - lastActivityAt),
                  });
                }, this.activityHeartbeatMs)
              : undefined;
          activityTimer?.unref?.();
          abort.signal.addEventListener("abort", onAbort, { once: true });
          let worktree: string | null = null;
          try {
            input.authority?.assertAuthoritative();
            repository = await this.repositoryFor(input);
            this.store.assertExecutionAuthoritative(execution.execution_id);
            input.authority?.assertAuthoritative();
            if (repository) {
              this.missionRepositories.set(input.missionId, repository);
              // ADDITIVE (defect-4): capture the nested standalone repo HEADs
              // once per mission as the execution-start baseline for
              // publication detection. Fail-closed: if the provider lacks the
              // nested API or the scan throws, there is simply no baseline and
              // no publication records are produced (no false evidence).
              try {
                this.nestedBaselineFor(input.missionId, repository.git);
              } catch {
                // provider without the nested repo API — no baseline, no records
              }
            }
            const repositoryBinding = input.repoId
              ? this.store
                  .getWorkspaceManifest(input.missionId)
                  ?.repositories.find((candidate) => candidate.repoId === input.repoId)
              : undefined;
            const restrictedRepository =
              repositoryBinding === undefined
                ? this.resolveRepository !== undefined
                : !repositoryBinding.writableDomains.map(canonicalizeWriteDomain).includes("**");
            if (
              input.repoId &&
              input.mutatesRepo &&
              input.kind !== "integration" &&
              input.isolation !== "worktree" &&
              restrictedRepository
            ) {
              throw new Error(
                `WORKSPACE_SCOPE_MISMATCH: restricted domains require an isolated worktree (${(input.writeDomains ?? []).join(", ") || "none"})`,
              );
            }
            // Allocate an isolated worktree before dispatch so mutating workers
            // edit their own checkout (spec 05). This remains inside the cleanup
            // boundary because cancellation can remove the active entry while
            // allocation is in flight.
            worktree = await this.allocateWorktree(execution.execution_id, input, repository);
            const active = this.active.get(execution.execution_id);
            if (worktree && active) active.worktree = worktree;
            if (this.checkpoints && checkpointId && input.checkpointPolicy && executionDeadlineAt !== undefined) {
              checkpointTimer = setTimeout(
                () => queueCheckpoint(),
                Math.max(0, executionDeadlineAt - input.checkpointPolicy.before_deadline_ms - Date.now()),
              );
              checkpointTimer.unref?.();
            }
            const activeForCheckpoint = this.active.get(execution.execution_id);
            if (activeForCheckpoint && this.checkpoints && checkpointId) {
              activeForCheckpoint.cancelCheckpoint = () => {
                checkpointScheduling = false;
                if (checkpointTimer) clearTimeout(checkpointTimer);
                if (activityTimer) clearInterval(activityTimer);
                if (!cancelCheckpointPromise) {
                  checkpointChain = checkpointChain.then(async () => {
                    await awaitWriterQuiescence();
                    assertOrigin();
                    const preservedPaths = await this.preserveCheckpointWork(
                      execution.execution_id,
                      checkpointId,
                      assertOrigin,
                    );
                    assertOrigin();
                    await writeCheckpoint([...completedDeliverables], [], [], preservedPaths);
                  });
                  cancelCheckpointPromise = checkpointChain.catch((error) => {
                    retainWorktreeOnCleanup = true;
                    this.retainWorktree(input.missionId, execution.execution_id);
                    throw error;
                  });
                }
                return cancelCheckpointPromise;
              };
            }
            if (abort.signal.aborted) {
              detachedAfterTerminalAbort = true;
              return this.terminalizeAfterGrace(
                execution.execution_id,
                clockAbort(abort.signal) ?? "canceled",
                input.taskId,
              );
            }
            // The hung-worker window measures the WORKER's silence. Worktree
            // allocation and checkpoint restore before this point are the
            // broker's own work, so the window starts when the worker does.
            lastActivityAt = Date.now();
            writerStarted = true;
            const backendSettlement: Promise<BackendSettlement> = this.dispatch(
              input,
              backend,
              execution.execution_id,
              abort.signal,
              worktree,
              emitActivity,
              repository,
            )
              .then((outcome) => ({ kind: "backend_result" as const, outcome }))
              .catch((error: unknown) => ({
                kind: "backend_error" as const,
                error,
              }))
              .finally(acknowledgeWriterSettled);
            let removeAbortRaceListener = (): void => {};
            const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
              const listener = (): void => resolve({ kind: "aborted" });
              removeAbortRaceListener = () => abort.signal.removeEventListener("abort", listener);
              if (abort.signal.aborted) resolve({ kind: "aborted" });
              else
                abort.signal.addEventListener("abort", listener, {
                  once: true,
                });
            });
            const first = await Promise.race([backendSettlement, aborted]);
            removeAbortRaceListener();
            if (first.kind === "aborted") {
              const clock = clockAbort(abort.signal);
              const timedOut = clock !== null;
              if (worktree && this.store.getExecution(execution.execution_id)?.status === "RUNNING") {
                const info = this.allocatedWorktrees.get(execution.execution_id);
                const byBranch =
                  this.failedBranches.get(input.missionId) ??
                  new Map<string, { marker: string; taskId: string; recoverRef?: string }>();
                if (info) {
                  byBranch.set(info.branch, {
                    marker:
                      clock === "inactivity" ? INACTIVITY_MARKER : timedOut ? WALL_CLOCK_TIMEOUT_MARKER : "canceled",
                    taskId: input.taskId,
                  });
                  this.failedBranches.set(input.missionId, byBranch);
                }
              }
              const terminalOutcome = await this.terminalizeAfterGrace(
                execution.execution_id,
                clock ?? "canceled",
                input.taskId,
              );
              if (timedOut && worktree) retainWorktreeOnCleanup = true;
              detachedAfterTerminalAbort = true;
              cleanupOwnedByCancellation = true;
              void backendSettlement.then((late) =>
                this.observeLate(
                  execution.execution_id,
                  clock === "inactivity" ? "inactivity abort" : timedOut ? "hard timeout" : "cancellation",
                  late,
                  input,
                ),
              );
              emitActivity({
                kind: "execution",
                phase: timedOut ? "failed" : "canceled",
                stage: backend,
                summary: "",
                meaningfulProgress: false,
              });
              return terminalOutcome;
            }
            if (first.kind === "backend_error") {
              if (abort.signal.aborted) {
                this.observeLate(execution.execution_id, "cancellation", first, input);
                return this.terminalizeAfterGrace(execution.execution_id, "canceled", input.taskId);
              }
              throw first.error;
            }
            let outcome = first.outcome;
            const escaped = await this.outOfScopeWorktreePaths(execution.execution_id, input);
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            if (escaped.length > 0) {
              this.workspaceScopeFailure(execution.execution_id, escaped, input.writeDomains ?? []);
              outcome = {
                ...outcome,
                exitStatus: "failed",
                summary: `WORKSPACE_SCOPE_MISMATCH: out-of-scope changes: ${escaped.join(", ")}`,
                error: "WORKSPACE_SCOPE_MISMATCH",
              };
            }
            if (outcome.exitStatus === "succeeded" && input.requiredOutputArtifacts?.length) {
              const identities = new Set(outcome.artifactRefs.map(artifactIdentity).filter((value) => value !== null));
              const missing = input.requiredOutputArtifacts.filter((identity) => !identities.has(identity));
              if (missing.length > 0) {
                outcome = {
                  ...outcome,
                  exitStatus: "failed",
                  summary: `Required output artifact identities missing: ${missing.join(", ")}`,
                  error: "INVALID_WORKER_OUTPUT",
                };
              }
            }
            queueCheckpoint(
              outcome.exitStatus === "succeeded" ? [...(input.deliverables ?? [])] : [],
              outcome.artifactRefs,
              outcome.artifactRefs.map(artifactHash),
            );
            await checkpointChain;
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            // Persist the worker's edits onto its branch before the worktree is
            // torn down, otherwise integration has nothing to merge — and on a
            // FAILED execution, otherwise the worker's partial work dies with the
            // worktree. Harvest whenever there is a worktree (success or failure);
            // failed branches are then excluded from integration and preserved.
            if (input.mutatesRepo && worktree && escaped.length === 0) {
              input.authority?.assertAuthoritative();
              this.store.assertExecutionAuthoritative(execution.execution_id);
              const info = this.allocatedWorktrees.get(execution.execution_id);
              let failed = outcome.exitStatus !== "succeeded";
              // Captured BEFORE the harvest: the harvest commits the worker's
              // uncommitted edits too, and those are exactly what a timed-out
              // worker had not finished.
              const recoverRef =
                failed && outcome.error === WALL_CLOCK_TIMEOUT_MARKER && info
                  ? await this.workerCommittedTip(execution.execution_id, input.missionId, worktree)
                  : undefined;
              const harvest = await this.harvestWorktree(execution.execution_id, input.authority);
              if (harvest === "unverified") {
                this.markBranchIntegrationIneligible(
                  execution.execution_id,
                  input.missionId,
                  input.taskId,
                  "git_harvest_unverified",
                );
                outcome = {
                  ...outcome,
                  exitStatus: "failed",
                  summary: "Worker result rejected because Git harvest could not be verified",
                  error: "GIT_HARVEST_UNVERIFIED",
                };
                failed = true;
              }
              input.authority?.assertAuthoritative();
              this.store.assertExecutionAuthoritative(execution.execution_id);
              if (info) {
                // Last settled outcome wins: a retry that succeeds on the same
                // branch clears the earlier failure instead of being excluded.
                const byBranch =
                  this.failedBranches.get(input.missionId) ??
                  new Map<string, { marker: string; taskId: string; recoverRef?: string }>();
                if (failed) {
                  byBranch.set(info.branch, {
                    marker: outcome.error ?? outcome.summary ?? "failed",
                    taskId: input.taskId,
                    ...(recoverRef ? { recoverRef } : {}),
                  });
                } else {
                  byBranch.delete(info.branch);
                }
                this.failedBranches.set(input.missionId, byBranch);
              }
            }
            if (input.mutatesRepo && worktree && escaped.length > 0) {
              const info = this.allocatedWorktrees.get(execution.execution_id);
              if (info) {
                const byBranch = this.failedBranches.get(input.missionId) ?? new Map();
                byBranch.set(info.branch, {
                  marker: "WORKSPACE_SCOPE_MISMATCH",
                  taskId: input.taskId,
                });
                this.failedBranches.set(input.missionId, byBranch);
              }
            }
            // Settle first: evidence is accepted only from a successfully
            // completed authoritative execution, never from a live writer.
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            const succeeded = outcome.exitStatus === "succeeded";
            if (!succeeded && (backend === "integration" || backend === "validation" || backend === "review")) {
              await this.preserveCandidate(input.missionId, input.authority);
            }
            const gatePublication = succeeded
              ? await this.buildGateEvidencePublication(input, execution.execution_id, backend, outcome, repository)
              : null;
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            if (gatePublication) {
              await this.store.publishGateEvidenceIfAuthoritative(gatePublication);
            } else {
              this.store.setExecutionStatus(execution.execution_id, succeeded ? "SUCCEEDED" : "FAILED", {
                exit_status: outcome.exitStatus,
                artifact_refs: outcome.artifactRefs,
                usage: outcome.usage,
                // Failure visibility: backend outcomes (integration/validation/review)
                // carry error + summary; without propagation the store recorded
                // empty detail and real failures were undiagnosable.
                ...(outcome.error ? { error: outcome.error } : {}),
                ...(outcome.summary ? { summary: outcome.summary } : {}),
                ...(outcome.recoveredMerged?.length ? { recovered_merged: outcome.recoveredMerged } : {}),
                ...(backend === "review" && input.reviewedRecovered?.length
                  ? { reviewed_recovered: [...input.reviewedRecovered] }
                  : {}),
              });
            }
            this.active.delete(execution.execution_id);
            emitActivity({
              kind: "execution",
              phase: outcome.exitStatus === "succeeded" ? "completed" : "failed",
              stage: backend,
              summary: "",
              meaningfulProgress: outcome.exitStatus === "succeeded",
            });
            return outcome;
          } catch (err) {
            let authorityError: Error | undefined;
            try {
              input.authority?.assertAuthoritative();
              this.store.assertExecutionAuthoritative(execution.execution_id);
            } catch (error) {
              authorityError = error instanceof Error ? error : new Error(String(error));
            }
            if (!authorityError && (input.repoId || this.resolveRepository)) {
              const summary = err instanceof Error ? err.message : String(err);
              if (/WORKSPACE_SCOPE_MISMATCH|repository binding|authorized root|unknown repo/i.test(summary)) {
                this.classifyWorkspaceMismatch(input, execution.execution_id, summary);
              }
            }
            if (authorityError) {
              if (backend === "integration") this.retainMissionWorktrees(input.missionId);
              void this.store.recordLateExecution(
                execution.execution_id,
                authorityError.message,
                lateEvidence({ kind: "backend_error", error: err }, input),
              );
            } else if (!this.settledElsewhere(execution.execution_id)) {
              const clock = clockAbort(abort.signal);
              if (abort.signal.aborted && clock === null) {
                this.store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
              } else {
                this.store.setExecutionStatus(execution.execution_id, "FAILED", {
                  exit_status:
                    clock === "inactivity"
                      ? INACTIVITY_MARKER
                      : clock === "timeout"
                        ? WALL_CLOCK_TIMEOUT_MARKER
                        : err instanceof Error
                          ? err.message
                          : String(err),
                });
              }
            }
            this.active.delete(execution.execution_id);
            emitActivity({
              kind: "execution",
              phase: "failed",
              stage: backend,
              summary: "",
              meaningfulProgress: false,
            });
            throw err;
          } finally {
            activitySettled = true;
            if (activityTimer) clearInterval(activityTimer);
            if (checkpointTimer) clearTimeout(checkpointTimer);
            checkpointScheduling = false;
            if (!detachedAfterTerminalAbort) {
              await cancelCheckpointPromise?.catch(() => undefined);
              await checkpointChain.catch(() => undefined);
            }
            abort.signal.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
            if (inactivityTimer) clearInterval(inactivityTimer);
            if (!retainWorktreeOnCleanup && !cleanupOwnedByCancellation) {
              await this.releaseWorktree(execution.execution_id, true, input.authority);
            }
          }
        };
        const operationPromise = Promise.resolve().then(runOperation);
        let removeAbortListener = (): void => {};
        const authoritativeAbort = new Promise<ExecutionOutcome>((resolve, reject) => {
          const settle = (): void => {
            void this.terminalizeAfterGrace(
              execution.execution_id,
              clockAbort(abort.signal) ?? "canceled",
              input.taskId,
            ).then(resolve, reject);
          };
          removeAbortListener = () => abort.signal.removeEventListener("abort", settle);
          if (abort.signal.aborted) settle();
          else abort.signal.addEventListener("abort", settle, { once: true });
        });
        resultPromise = Promise.race([operationPromise, authoritativeAbort]).finally(removeAbortListener);
        return resultPromise;
      },
    };

    this.active.set(execution.execution_id, {
      abort,
      status: "PENDING",
      worktree: null,
      taskId: input.taskId,
      missionId: input.missionId,
      authority: input.authority,
    });
    input.authority?.assertAuthoritative();
    this.store.setExecutionStatus(execution.execution_id, "RUNNING", {});
    this.active.get(execution.execution_id)!.status = "RUNNING";
    if (input.repoId && (backend === "integration" || backend === "validation" || input.mutatesRepo)) {
      this.store.invalidateRepositoryEvidence(
        input.missionId,
        input.repoId,
        backend === "integration"
          ? "integration started"
          : backend === "validation"
            ? "validation attempt started"
            : "candidate-affecting execution started",
      );
    }
    if (input.repoId && backend === "review") {
      this.store.invalidateRepositoryReviewEvidence(input.missionId, input.repoId, "review attempt started");
    }
    if (backend === "validation" || backend === "review") {
      try {
        await this.store.flush();
      } catch (error) {
        abort.abort(error);
        this.active.delete(execution.execution_id);
        this.store.rejectLateExecution(execution.execution_id, "gate invalidation durability barrier failed");
        throw error;
      }
    }
    return handle;
  }

  private async dispatch(
    input: ExecutionRequestInput,
    backend: ExecutionBackend,
    executionId: string,
    signal: AbortSignal,
    worktree: string | null,
    onActivity: (event: WorkerActivity) => void,
    repository: { repoId?: string; root: string; git: GitRepo } | null,
  ): Promise<ExecutionOutcome> {
    if (
      input.repoId &&
      repository &&
      !this.missionCandidates.has(input.missionId) &&
      ((backend === "integration" && this.backends.integration?.candidateScoped === true) ||
        (backend === "validation" && this.backends.validation?.candidateScoped === true) ||
        (backend === "review" && this.backends.review?.candidateScoped === true))
    ) {
      input.authority?.assertAuthoritative();
      const task = this.store.getTask(input.taskId);
      const missionGeneration = input.authority?.missionIdentity.generation ?? task?.mission_generation ?? 0;
      const candidateGeneration = task?.candidate_generation ?? 0;
      const boundBase =
        this.store
          .getWorkspaceManifest(input.missionId)
          ?.repositories.find((binding) => binding.repoId === input.repoId)?.baseSha ??
        this.store.getMission(input.missionId)?.base_ref;
      const records = await repository.git.loadCandidateLifecycles(input.missionId, input.repoId);
      const exactGeneration = records.filter(
        (record) =>
          record.missionId === input.missionId &&
          record.repoId === input.repoId &&
          record.missionGeneration === missionGeneration &&
          record.candidateGeneration === candidateGeneration &&
          record.baseSha === boundBase,
      );
      let matching = exactGeneration.filter(
        (record) => record.state === "integrating" || record.state === "promotion_intent",
      );
      if (matching.length === 0 && backend !== "integration") {
        const [completedPromotions, integrationRuns] = await Promise.all([
          repository.git.loadPromotionLifecycles(input.missionId, input.repoId),
          repository.git.loadIntegrationRuns(input.missionId, input.repoId),
        ]);
        matching = exactGeneration.filter((record) => {
          if (record.state !== "promoted" || !record.integrationRunId) return false;
          const run = integrationRuns.find(
            (candidateRun) =>
              candidateRun.candidateId === record.candidateId &&
              candidateRun.runId === record.integrationRunId &&
              candidateRun.missionId === record.missionId &&
              candidateRun.repoId === record.repoId &&
              candidateRun.missionGeneration === record.missionGeneration &&
              candidateRun.candidateGeneration === record.candidateGeneration &&
              candidateRun.candidateSha === record.candidateSha &&
              candidateRun.state === "completed",
          );
          if (!run) return false;
          return completedPromotions.some(
            (promotion) =>
              promotion.state === "completed" &&
              promotion.candidateId === record.candidateId &&
              promotion.attempt === record.attempt &&
              promotion.integrationRunId === record.integrationRunId &&
              promotion.repoId === record.repoId &&
              promotion.missionGeneration === missionGeneration &&
              promotion.candidateGeneration === candidateGeneration &&
              promotion.candidateRepositoryGeneration === record.repositoryGeneration &&
              promotion.baseSha === record.baseSha &&
              promotion.candidateSha === record.candidateSha,
          );
        });
      }
      if (matching.length === 0 && backend === "integration") {
        const parentIds = new Set(exactGeneration.map((record) => record.parentCandidateId).filter(Boolean));
        matching = exactGeneration.filter(
          (record) => record.state === "preserved" && !parentIds.has(record.candidateId),
        );
      }
      if (matching.length > 1) {
        throw new Error("CANDIDATE_AMBIGUOUS: multiple open candidates match the exact durable generation");
      }
      const lifecycle = matching[0];
      if (lifecycle) {
        input.authority?.assertAuthoritative();
        const reconciled = await repository.git.reconcileCandidateWorktree(lifecycle, input.authority);
        if (reconciled) {
          this.missionCandidates.set(input.missionId, {
            lifecycle,
            git: repository.git,
          });
        }
      }
    }
    const base = {
      objective: input.objective,
      contextRef: input.contextRef,
      worktree,
      signal,
      onActivity,
      acceptanceCriteria: input.acceptanceCriteria,
    };
    switch (backend) {
      case "agent":
      case "research": {
        const runner = this.backends.agent;
        if (!runner) throw new Error(`no agent backend registered for ${backend}`);
        return this.dispatchWithVerifiedRecovery(input, (recovery) =>
          runner.runAgent({
            repoId: input.repoId,
            role: input.role ?? "worker",
            objective: input.objective,
            contextRef: input.contextRef,
            worktree: base.worktree,
            isolatedWorktree: worktree !== null,
            modelRequirements: input.modelRequirements,
            recovery,
            deliverables: input.deliverables,
            missionId: input.missionId,
            taskId: input.taskId,
            signal,
            onActivity: base.onActivity,
          }),
        );
      }
      case "process": {
        const runner = this.backends.process;
        if (!runner) throw new Error("no process backend registered");
        return this.dispatchWithVerifiedRecovery(input, () =>
          runner.runProcess({
            repoId: input.repoId,
            objective: input.objective,
            worktree: base.worktree,
            signal,
          }),
        );
      }
      case "review": {
        const runner = this.backends.review;
        if (!runner) throw new Error("no review backend registered");
        const candidatePath = this.missionCandidates.get(input.missionId)?.lifecycle.path;
        if (input.repoId && runner.candidateScoped === true && !candidatePath) {
          throw new Error("CANDIDATE_UNAVAILABLE: review cannot fall back to the incumbent checkout");
        }
        return this.dispatchWithVerifiedRecovery(input, () =>
          runner.runReview({
            repoId: input.repoId,
            objective: input.objective,
            contextRef: input.contextRef,
            acceptanceCriteria: input.acceptanceCriteria,
            worktree: candidatePath ?? null,
            missionId: input.missionId,
            taskId: input.taskId,
            signal,
            onActivity: base.onActivity,
          }),
        );
      }
      case "integration": {
        const runner = this.backends.integration;
        if (!runner) throw new Error("no integration backend registered");
        const assertOrigin = (): void => {
          input.authority?.assertAuthoritative();
          this.store.assertExecutionAuthoritative(executionId);
        };
        assertOrigin();
        if (!repository) throw new Error("integration requires a repository-scoped Git provider");
        let candidate = this.missionCandidates.get(input.missionId);
        const parent = candidate?.lifecycle.state === "preserved" ? candidate.lifecycle : undefined;
        if (parent) candidate = undefined;
        if (input.repoId && runner.candidateScoped === true && !candidate) {
          const baseSha =
            this.store.getMission(input.missionId)?.base_ref?.trim() ||
            this.resolvedBases.get(input.missionId) ||
            (await repository.git.headCommit());
          assertOrigin();
          const lifecycle = await repository.git.createCandidateWorktree(
            baseSha,
            {
              missionId: input.missionId,
              repoId: input.repoId,
              missionGeneration: this.store.getExecution(executionId)?.mission_generation ?? 0,
              candidateGeneration: this.store.getExecution(executionId)?.candidate_generation ?? 0,
              repositoryGeneration: input.authority?.repositoryIdentity?.generation ?? 0,
              attempt: executionId,
              parentCandidateId: parent?.candidateId,
              seedSha: parent?.candidateSha,
            },
            input.authority,
          );
          candidate = { lifecycle, git: repository.git };
          this.missionCandidates.set(input.missionId, candidate);
        }
        assertOrigin();
        // Failed executions are excluded from the merge by default (their
        // work is presumed incomplete — a degenerate loop that committed
        // garbage must not be auto-merged); their branches are preserved
        // separately (see failedBranches). EXCEPTION: a worker killed by the
        // WALL-CLOCK timeout after committing real work leaves a completed
        // deliverable on its branch, which used to be stranded forever
        // (observed: MSN-1xh24o, a 367-line console change lost twice).
        //
        // Only the commits the WORKER made are recovered — the exact tip
        // captured before the harvest auto-commit, never the branch tip — and
        // they are handed off LAST, after every clean branch, so a conflict or
        // breakage in them cannot block good work. Note the integration checks
        // run AFTER merging into the checkout; they report a broken tree but
        // do not roll a recovered merge back.
        const failedByBranch = this.failedBranches.get(input.missionId);
        const handoffs: IntegrationHandoff[] = [];
        const recovered: IntegrationHandoff[] = [];
        const recoveredMeta: RecoveredMerge[] = [];
        const baseCommit =
          this.store.getMission(input.missionId)?.base_ref?.trim() || this.resolvedBases.get(input.missionId);
        for (const w of this.missionWorktrees.get(input.missionId) ?? []) {
          const failure = failedByBranch?.get(w.branch);
          if (failure === undefined) {
            if (w.repoId && baseCommit) {
              const escaped = (await w.git.changedFiles(baseCommit, w.branch)).filter(
                (path) => !pathAllowed(path, w.writeDomains),
              );
              assertOrigin();
              if (escaped.length > 0) {
                assertOrigin();
                this.workspaceScopeFailure(executionId, escaped, w.writeDomains);
                return {
                  executionId,
                  exitStatus: "failed",
                  summary: `WORKSPACE_SCOPE_MISMATCH: integration rejected out-of-scope paths: ${escaped.join(", ")}`,
                  artifactRefs: [],
                  usage: {},
                  error: "WORKSPACE_SCOPE_MISMATCH",
                };
              }
            }
            assertOrigin();
            handoffs.push({
              worktree: w,
              summary: input.objective,
              artifacts: [],
            });
            continue;
          }
          // Exactly the worker's wall-clock marker (PiWorkerExecutor: error
          // "timeout"). A substring match also caught `gateway:queue_timeout`
          // and `transient:timeout` — gateway/transport failures whose partial
          // work must stay preserve-only.
          if (failure.marker !== WALL_CLOCK_TIMEOUT_MARKER || !failure.recoverRef) continue;
          const ahead = repository ? await repository.git.revListCount(`HEAD..${failure.recoverRef}`) : 0;
          assertOrigin();
          if (ahead === null) {
            assertOrigin();
            this.recoveryFinding(
              executionId,
              `Could not count recoverable commits on ${w.branch}; its timed-out work was not recovered`,
            );
            continue;
          }
          if (ahead > 0) {
            assertOrigin();
            recoveredMeta.push({
              task_id: failure.taskId,
              branch: w.branch,
              ref: failure.recoverRef,
            });
            recovered.push({
              worktree: w,
              ref: failure.recoverRef,
              recovered: true,
              summary: `${input.objective} [recovered: ${ahead} commit(s) from a timed-out execution]`,
              artifacts: [],
            });
            this.recoveryFinding(
              executionId,
              `Recovering ${ahead} commit(s) from a timed-out execution on ${w.branch} (merged after clean branches)`,
              failure.recoverRef,
            );
          }
        }
        assertOrigin();
        handoffs.push(...recovered);
        const integrationRun =
          candidate && runner.candidateScoped === true
            ? await candidate.git.beginIntegrationRun(
                candidate.lifecycle,
                executionId,
                handoffs.map((handoff) => handoff.ref ?? handoff.worktree.branch),
                input.authority,
              )
            : undefined;
        assertOrigin();
        // After integration, release the merged worktrees (fire-and-forget
        // cleanup so the return value stays a plain Promise<ExecutionOutcome>).
        // What recovery actually landed is decided here, from git, not from
        // the runner's prose: a recovered ref counts only when the integration
        // succeeded AND the exact worker commit is an ancestor of HEAD after it
        // (a skipped or conflicting recovered handoff is not). This is the
        // completion gate's evidence for superseding the timed-out task.
        const git = repository?.git ?? null;
        let outcome = await this.dispatchWithVerifiedRecovery(input, () =>
          runner.runIntegration({
            repoId: input.repoId,
            objective: input.objective,
            handoffs,
            candidate: candidate
              ? {
                  path: candidate.lifecycle.path,
                  branch: candidate.lifecycle.branch,
                }
              : undefined,
            candidateLifecycle: candidate?.lifecycle,
            integrationRun,
            authority: input.authority,
            signal,
          }),
        );
        try {
          assertOrigin();
        } catch (error) {
          this.retainMissionWorktrees(input.missionId);
          this.observeLate(
            executionId,
            "integration authority lost",
            { kind: "backend_result", outcome },
            input,
            handoffs,
          );
          throw error;
        }
        if (candidate) {
          const candidateSha = await candidate.git.headCommitIn(candidate.lifecycle.path);
          assertOrigin();
          if (integrationRun) {
            integrationRun.candidateSha = candidateSha;
            integrationRun.state = outcome.exitStatus === "succeeded" ? "completed" : "preserved";
            integrationRun.updatedAt = new Date().toISOString();
            await candidate.git.persistIntegrationRun(integrationRun, input.authority);
          }
          candidate.lifecycle = {
            ...candidate.lifecycle,
            candidateSha,
            integrationRunId:
              outcome.exitStatus === "succeeded" ? integrationRun?.runId : candidate.lifecycle.integrationRunId,
            state: outcome.exitStatus === "succeeded" ? "integrating" : "preserved",
            updatedAt: new Date().toISOString(),
          };
          await candidate.git.persistCandidateLifecycle(candidate.lifecycle, input.authority);
        }
        if (outcome.exitStatus === "succeeded" && git && recoveredMeta.length > 0) {
          let head: string | null = null;
          try {
            head = candidate ? await git.headCommitIn(candidate.lifecycle.path) : await git.headCommit();
          } catch {
            head = null;
          }
          assertOrigin();
          if (head) {
            const merged: RecoveredMerge[] = [];
            for (const recoveredMerge of recoveredMeta) {
              let isMerged = false;
              try {
                isMerged = await git.isAncestor(recoveredMerge.ref, head);
              } catch {
                isMerged = false;
              }
              assertOrigin();
              if (isMerged) merged.push(recoveredMerge);
            }
            if (merged.length > 0) outcome = { ...outcome, recoveredMerged: merged };
          }
        }
        // Transfer cleanup to the mission-owned reconciliation path. Destructive
        // Git operations cannot safely straddle a revocable execution-authority
        // await, even after a successful merge.
        assertOrigin();
        this.deferMissionWorktreeCleanup(input.missionId);
        assertOrigin();
        return outcome;
      }
      case "validation": {
        const runner = this.backends.validation;
        if (!runner) throw new Error("no validation backend registered");
        const candidatePath = this.missionCandidates.get(input.missionId)?.lifecycle.path;
        if (input.repoId && runner.candidateScoped === true && !candidatePath) {
          throw new Error("CANDIDATE_UNAVAILABLE: validation cannot fall back to the incumbent checkout");
        }
        return this.dispatchWithVerifiedRecovery(input, () =>
          runner.runValidation({
            repoId: input.repoId,
            objective: input.objective,
            worktree: candidatePath ?? base.worktree,
            signal,
          }),
        );
      }
    }
  }
}
