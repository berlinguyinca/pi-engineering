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
import { id } from "../core/ids.ts";
import type { GitRepo } from "../git/GitRepo.ts";
import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import { sanitizeWorkerActivity } from "../workers/activity.ts";
import type { CheckpointManager, CheckpointSnapshot } from "./checkpoints.ts";
import { buildCandidateEvidenceIdentity, hashCandidateEvidenceIdentity } from "./evidence.ts";
import type { LateExecutionEvidence, MissionStore } from "./missionStore.ts";
import type { DispatchAuthority } from "./ownership.ts";
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
  /** Renewable fencing held by the caller for the complete dispatch. */
  authority?: DispatchAuthority;
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
  validationEvidence?: Pick<
    ValidationEvidence,
    "command" | "profile" | "exitCode" | "testSummary" | "noTargets" | "accessible"
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
  >;
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
    recovery: (outcome?.recoveredMerged ?? []).map((recovered) => ({ ...recovered })),
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
    signal: AbortSignal;
    onActivity?: (event: WorkerActivity) => void;
  }): Promise<ExecutionOutcome>;
  onSteer?: (steer: string) => void;
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
  runReview(input: {
    repoId?: string;
    objective: string;
    contextRef?: string;
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
  runIntegration(input: {
    repoId?: string;
    objective: string;
    handoffs: IntegrationHandoff[];
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface ValidationRunner {
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

/** The worker's machine-readable failure marker for a wall-clock timeout. */
const WALL_CLOCK_TIMEOUT_MARKER = "timeout";

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
 * Default execution wall-clock budget in ms. The historical 10-minute default
 * repeatedly aborted fresh-context implementation workers at the boundary
 * before they could commit real work (only a trivial file-copy ever landed in
 * time), which made the mission pipeline unable to integrate anything but
 * trivial changes. 30 minutes gives a worker room to explore the repo,
 * implement, verify, and commit within one bounded run. Overridable via
 * `PI_ENGINEERING_WORKER_TIMEOUT_MS` for the whole pipeline (broker abort
 * timer and worker budget stay in lockstep).
 */
export function workerTimeoutMs(): number {
  const env = Number.parseInt(process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS ?? "", 10);
  // setTimeout fires IMMEDIATELY for delays above 2^31-1 ms, which would turn a
  // generous override into an instant abort.
  if (Number.isFinite(env) && env > 0) return Math.min(env, MAX_TIMER_MS);
  return 30 * 60_000;
}

export interface BrokerOptions {
  store: MissionStore;
  backends: BrokerBackends;
  /** Default timeout per execution. */
  defaultTimeoutMs?: number;
  /** Git provider used to allocate isolated worktrees for mutating tasks. */
  git?: GitRepo | null;
  /** Base ref (commit) worktrees are created at. Defaults to current HEAD. */
  baseRef?: string;
  resolveRepository?: (
    repoId: string,
    writableDomains: string[],
  ) => Promise<{ repoId: string; root: string; git: GitRepo }>;
  /** Execution-local live worker activity with durable orchestration identity. */
  onActivity?: (event: WorkerActivity & { missionId: string; taskId: string; executionId: string }) => void;
  /** Periodic liveness detail for every backend while it is running. */
  activityHeartbeatMs?: number;
  checkpoints?: CheckpointManager;
  /** Maximum cancellation delay while waiting for the backend writer to acknowledge abort. */
  cancellationAckTimeoutMs?: number;
}

export class ExecutionBroker {
  private readonly store: MissionStore;
  private readonly backends: BrokerBackends;
  private readonly defaultTimeoutMs: number;
  private readonly git: GitRepo | null;
  private readonly baseRef: string;
  private readonly resolveRepository?: BrokerOptions["resolveRepository"];
  private readonly onActivity?: BrokerOptions["onActivity"];
  private readonly activityHeartbeatMs: number;
  private readonly checkpoints?: CheckpointManager;
  private readonly cancellationAckTimeoutMs: number;
  /** In-flight execution state for cancellation + allocated worktrees. */
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
    }
  >();
  /** Allocated worktrees, cleaned up when their execution settles. */
  readonly allocatedWorktrees = new Map<
    string,
    { path: string; branch: string; git: GitRepo; repoId?: string; writeDomains: string[] }
  >();
  /** Mission-scoped worktrees awaiting integration (merged+cleaned by the integrator). */
  private readonly missionWorktrees = new Map<
    string,
    Array<{ path: string; branch: string; git: GitRepo; repoId?: string; writeDomains: string[] }>
  >();
  /** Successfully integrated worktrees awaiting separately owned cleanup. */
  private readonly deferredCleanup = new Map<
    string,
    Array<{ path: string; branch: string; git: GitRepo; repoId?: string; writeDomains: string[] }>
  >();
  private readonly missionRepositories = new Map<string, { repoId?: string; root: string; git: GitRepo }>();
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
    this.git = opts.git ?? null;
    this.baseRef = opts.baseRef ?? "";
    this.resolveRepository = opts.resolveRepository;
    this.onActivity = opts.onActivity;
    this.activityHeartbeatMs = opts.activityHeartbeatMs ?? 15_000;
    this.checkpoints = opts.checkpoints;
    this.cancellationAckTimeoutMs = opts.cancellationAckTimeoutMs ?? 5_000;
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
        if (this.git) return { repoId: input.repoId, root: binding.canonicalRoot, git: this.git };
        if (!input.mutatesRepo || input.isolation === "none") return null;
        throw new Error(`WORKSPACE_SCOPE_MISMATCH: no repository provider for ${input.repoId}`);
      }
      const resolved = await this.resolveRepository(input.repoId, input.writeDomains ?? []);
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

  private async recordGateEvidence(
    input: ExecutionRequestInput,
    executionId: string,
    backend: ExecutionBackend,
    outcome: ExecutionOutcome,
    repository: { repoId?: string; root: string; git: GitRepo } | null,
  ): Promise<void> {
    if (!input.repoId || !["integration", "validation", "review"].includes(backend)) return;
    const manifest = this.store.getWorkspaceManifest(input.missionId);
    const binding = manifest?.repositories.find((candidate) => candidate.repoId === input.repoId);
    const execution = this.store.getExecution(executionId);
    const task = this.store.getTask(input.taskId);
    if (!manifest || !binding || !execution || !task) return;

    let candidateSha = this.store.getCandidate(input.missionId)?.identity.candidateSha ?? binding.baseSha;
    let diffHash = this.store.getCandidate(input.missionId)?.identity.diffHash ?? artifactHash("");
    if (repository) {
      candidateSha = await repository.git.headCommit();
      const diff = await repository.git.captureDiff(binding.baseSha, candidateSha);
      diffHash = artifactHash(diff);
    }
    const acceptanceIds = [...new Set(task.acceptance_ids ?? [])].sort();
    const priorArtifacts = this.store.getCandidate(input.missionId)?.identity.artifactHashes ?? [];
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
    const candidate = this.store.recordCandidate(
      input.missionId,
      identity,
      backend === "integration" ? "integration" : `${backend} target`,
    );
    const recordedAt = new Date().toISOString();
    if (backend === "validation" && outcome.validationEvidence) {
      this.store.recordValidationEvidence({
        evidenceId: id("VE"),
        missionId: input.missionId,
        taskId: input.taskId,
        executionId,
        identity: candidate.identity,
        identityHash: candidate.identityHash,
        ...outcome.validationEvidence,
        recordedAt,
      });
    }
    if (backend === "review" && outcome.reviewEvidence) {
      this.store.recordReviewEvidence({
        evidenceId: id("RE"),
        missionId: input.missionId,
        taskId: input.taskId,
        executionId,
        identity: candidate.identity,
        identityHash: hashCandidateEvidenceIdentity(candidate.identity),
        ...outcome.reviewEvidence,
        recordedAt,
      });
    }
  }

  /**
   * Cancel one execution through the broker: abort the runner, settle the
   * execution as CANCELED, and release its worktree. Cancellation MUST go here
   * rather than poking the store, otherwise the runner keeps going, the worktree
   * leaks, and the eventual result overwrites CANCELED with SUCCEEDED.
   */
  async cancelExecution(executionId: string, taskId?: string): Promise<boolean> {
    const entry = this.active.get(executionId);
    if (!entry) return false;
    entry.abort.abort();
    await this.terminalizeAfterGrace(executionId, "canceled", taskId ?? entry.taskId);
    return true;
  }

  private terminalizeAfterGrace(
    executionId: string,
    reason: "canceled" | "timeout",
    taskId: string,
  ): Promise<ExecutionOutcome> {
    const entry = this.active.get(executionId);
    if (!entry) return Promise.resolve(this.terminalizeExecution(executionId, reason, taskId));
    if (entry.terminalPromise) return entry.terminalPromise;
    entry.terminalPromise = (async () => {
      this.markBranchIntegrationIneligible(
        executionId,
        entry.missionId,
        taskId,
        reason === "timeout" ? WALL_CLOCK_TIMEOUT_MARKER : "canceled",
      );
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
      if ((reason === "timeout" || !checkpointSettled) && entry.worktree) {
        this.retainWorktree(entry.missionId, executionId);
      }
      const outcome = this.terminalizeExecution(executionId, reason, taskId);
      if (reason === "canceled" && checkpointSettled && entry.worktree) {
        void this.releaseWorktree(executionId).catch(() => this.retainWorktree(entry.missionId, executionId));
      }
      return outcome;
    })();
    return entry.terminalPromise;
  }

  private terminalizeExecution(executionId: string, reason: "canceled" | "timeout", taskId: string): ExecutionOutcome {
    const existing = this.store.getExecution(executionId);
    const error = reason === "timeout" ? WALL_CLOCK_TIMEOUT_MARKER : "canceled";
    const outcome: ExecutionOutcome = {
      executionId,
      exitStatus: "failed",
      summary:
        reason === "timeout" ? "Execution exceeded its deadline and cancellation grace" : "Execution was canceled",
      artifactRefs: [],
      usage: {},
      error,
    };
    if (existing?.status === "RUNNING") {
      this.store.setExecutionStatus(executionId, reason === "timeout" ? "FAILED" : "CANCELED", {
        exit_status: error,
      });
    }
    const task = this.store.getTask(taskId);
    if (task?.status === "RUNNING") this.store.transitionTask(taskId, reason === "timeout" ? "FAILED" : "CANCELED");
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
  async cancelByTask(taskId: string): Promise<boolean> {
    let canceled = false;
    for (const [executionId, entry] of [...this.active]) {
      if (entry.taskId === taskId) {
        canceled = (await this.cancelExecution(executionId, taskId)) || canceled;
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
      throw new Error("Required isolated worktree allocation failed: no git provider is available");
    }
    try {
      // The mission's declared base_ref wins: a mission planned against commit X
      // must branch from X. Falling back to a broker-level ref captured earlier
      // (the runtime's HEAD at open) silently based the worker on a NEWER commit,
      // which turns a real conflict into a clean merge where the worker's version
      // wins over the incumbent.
      const missionBase = this.store.getMission(input.missionId)?.base_ref?.trim();
      const base = missionBase || this.baseRef || (await repository.git.headCommit());
      // Remember what we actually forked from. A mission may be handed an empty
      // base_ref, and without a base the 'did the work land' invariant has nothing
      // to diff against — the fork point recorded here is the fallback.
      this.resolvedBases.set(input.missionId, base);
      const branch = `pi-eng-orch-${input.taskId}`;
      const wt = await repository.git.createWorktree(base, branch);
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
  private async harvestWorktree(executionId: string): Promise<boolean> {
    const wt = this.allocatedWorktrees.get(executionId);
    if (!wt) return false;
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
    if (base) {
      try {
        ahead = await git.branchAheadOf(base, wt.branch);
        if (ahead && missionId) this.committedWork.set(missionId, true);
      } catch {
        // Fall through to the status-based harvest below.
      }
    }
    let status = "";
    try {
      status = (await git.statusIn(wt.path)).trim();
    } catch {
      // Could not even read the worktree status: the worker's own commits are
      // still harvestable work; nothing else can be said.
      return ahead;
    }
    if (status.length === 0 && ahead) return true;
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
      return false;
    }
    try {
      await git.commitAll(wt.path, `pi-eng: orchestration work for ${executionId}`);
      if (missionId) this.committedWork.set(missionId, true);
      return true;
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
      return false;
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

  private async releaseWorktree(executionId: string, keepBranch = true): Promise<void> {
    const wt = this.allocatedWorktrees.get(executionId);
    if (wt && this.isRetainedWorktree(wt.path)) return;
    if (wt) {
      // Keep the branch: it carries the harvested work until integration merges it.
      try {
        await wt.git.removeWorktree({ path: wt.path, branch: wt.branch }, { keepBranch });
      } catch {
        const missionId = this.store.getExecution(executionId)?.mission_id;
        if (missionId) this.retainWorktree(missionId, executionId);
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
    try {
      return await git.changedFiles(base, await git.headCommit());
    } catch {
      return null;
    }
  }

  /** Release any worktrees still tracked for a finished mission. */
  async cleanupMission(missionId: string, opts: { keepBranches?: boolean } = {}): Promise<void> {
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
    await this.releaseMissionWorktrees(missionId, opts.keepBranches === true);
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
  ): Promise<void> {
    const wts = this.missionWorktrees.get(missionId) ?? [];
    const retained = this.retainedWorktrees.get(missionId) ?? new Set<string>();
    const survivors: typeof wts = [];
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
            const head = await wt.git.headCommit();
            assertOrigin?.();
            if (!(await wt.git.isAncestor(wt.branch, head))) keep = true;
            assertOrigin?.();
          } catch (error) {
            if (assertOrigin) {
              assertOrigin();
            }
            keep = true; // cannot verify the work merged -> preserve (safe).
          }
          assertOrigin?.();
          try {
            await wt.git.removeWorktree({ path: wt.path, branch: wt.branch }, { keepBranch: keep });
          } catch {
            assertOrigin?.();
            keep = true;
            retained.add(wt.path);
            this.retainedWorktrees.set(missionId, retained);
            survivors.push(wt);
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
    if (survivors.length > 0) this.missionWorktrees.set(missionId, survivors);
    else this.missionWorktrees.delete(missionId);
    for (const [execId, info] of [...this.allocatedWorktrees]) {
      if (wts.some((w) => w.branch === info.branch) && !retained.has(info.path)) {
        this.allocatedWorktrees.delete(execId);
      }
    }
  }

  /** Branches kept after cleanup so unmerged worker work stays recoverable. */
  preservedBranches(missionId: string): string[] {
    return this.preserved.get(missionId) ?? [];
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
    const input = { ...rawInput, writeDomains: (rawInput.writeDomains ?? []).map(canonicalizeWriteDomain) };
    input.authority?.assertAuthoritative();
    const executionStartedAt = Date.now();
    const executionBudgetMs = input.executionBudgetMs ?? input.timeoutPolicy?.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
      throw new Error("INVALID_TASK_BUDGET: execution budget must be finite and positive");
    }
    if (
      input.checkpointPolicy &&
      (!Number.isInteger(input.checkpointPolicy.activity_milestone) ||
        input.checkpointPolicy.activity_milestone <= 0 ||
        !Number.isFinite(input.checkpointPolicy.before_deadline_ms) ||
        input.checkpointPolicy.before_deadline_ms <= 0 ||
        input.checkpointPolicy.before_deadline_ms >= executionBudgetMs)
    ) {
      throw new Error("INVALID_CHECKPOINT_POLICY: checkpoint lead must be finite, positive, and below budget");
    }
    const executionDeadlineAt = executionStartedAt + executionBudgetMs;
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
      fencing_token: input.authority?.missionIdentity.fencingToken,
      checkpoint_id: checkpointId,
      repo_id: input.repoId,
      base_sha: binding?.baseSha ?? this.store.getMission(input.missionId)?.base_ref,
      candidate_generation: task?.candidate_generation,
    });

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
        const operationPromise = (async () => {
          if (abort.signal.aborted) {
            const terminal = this.store.getExecution(execution.execution_id);
            if (terminal?.status === "CANCELED") {
              return this.terminalizeExecution(execution.execution_id, "canceled", input.taskId);
            }
            if (terminal?.status === "FAILED" && terminal.exit_status === WALL_CLOCK_TIMEOUT_MARKER) {
              return this.terminalizeExecution(execution.execution_id, "timeout", input.taskId);
            }
            throw new Error("execution aborted before dispatch");
          }
          const timer = setTimeout(
            () =>
              abort.abort(new DOMException(`Execution exceeded its ${executionBudgetMs}ms deadline`, "TimeoutError")),
            Math.max(0, executionDeadlineAt - Date.now()),
          );
          timer.unref?.();
          const activityStartedAt = Date.now();
          let lastActivityAt = activityStartedAt;
          let activitySettled = false;
          let activityTimer: ReturnType<typeof setInterval> | undefined;
          let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
          let repository: { repoId?: string; root: string; git: GitRepo } | null = null;
          let meaningfulActivity = 0;
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
            completedDeliverables: string[] = [],
            artifactRefs: string[] = [],
            artifactHashes: string[] = [],
            requiredPreservedPaths: string[] | null = null,
          ): Promise<CheckpointSnapshot | undefined> => {
            if (!this.checkpoints || !checkpointId || !input.repoId) return undefined;
            assertOrigin();
            const snapshot = await this.checkpointSnapshot(execution.execution_id, input, repository, assertOrigin);
            assertOrigin();
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
              completedDeliverables,
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
            completedDeliverables: string[] = [],
            artifactRefs: string[] = [],
            artifactHashes: string[] = [],
          ): void => {
            if (!checkpointScheduling) return;
            void persistCheckpoint(completedDeliverables, artifactRefs, artifactHashes).catch((error) => {
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
            if (safe.kind !== "heartbeat") lastActivityAt = Date.now();
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
            const timedOut = abort.signal.reason instanceof DOMException && abort.signal.reason.name === "TimeoutError";
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
          emitActivity({ kind: "execution", phase: "started", stage: backend, summary: "", meaningfulProgress: false });
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
            if (repository) this.missionRepositories.set(input.missionId, repository);
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
            if (this.checkpoints && checkpointId && input.checkpointPolicy) {
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
                    await writeCheckpoint([], [], [], preservedPaths);
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
              const timedOut =
                abort.signal.reason instanceof DOMException && abort.signal.reason.name === "TimeoutError";
              return this.terminalizeAfterGrace(
                execution.execution_id,
                timedOut ? "timeout" : "canceled",
                input.taskId,
              );
            }
            input.authority?.assertAuthoritative();
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
              .catch((error: unknown) => ({ kind: "backend_error" as const, error }))
              .finally(acknowledgeWriterSettled);
            let removeAbortRaceListener = (): void => {};
            const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
              const listener = (): void => resolve({ kind: "aborted" });
              removeAbortRaceListener = () => abort.signal.removeEventListener("abort", listener);
              if (abort.signal.aborted) resolve({ kind: "aborted" });
              else abort.signal.addEventListener("abort", listener, { once: true });
            });
            const first = await Promise.race([backendSettlement, aborted]);
            removeAbortRaceListener();
            if (first.kind === "aborted") {
              const timedOut =
                abort.signal.reason instanceof DOMException && abort.signal.reason.name === "TimeoutError";
              if (worktree && this.store.getExecution(execution.execution_id)?.status === "RUNNING") {
                const info = this.allocatedWorktrees.get(execution.execution_id);
                const byBranch =
                  this.failedBranches.get(input.missionId) ??
                  new Map<string, { marker: string; taskId: string; recoverRef?: string }>();
                if (info) {
                  byBranch.set(info.branch, {
                    marker: timedOut ? WALL_CLOCK_TIMEOUT_MARKER : "canceled",
                    taskId: input.taskId,
                  });
                  this.failedBranches.set(input.missionId, byBranch);
                }
              }
              const terminalOutcome = await this.terminalizeAfterGrace(
                execution.execution_id,
                timedOut ? "timeout" : "canceled",
                input.taskId,
              );
              if (timedOut && worktree) retainWorktreeOnCleanup = true;
              detachedAfterTerminalAbort = true;
              cleanupOwnedByCancellation = true;
              void backendSettlement.then((late) =>
                this.observeLate(execution.execution_id, timedOut ? "hard timeout" : "cancellation", late, input),
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
              const failed = outcome.exitStatus !== "succeeded";
              // Captured BEFORE the harvest: the harvest commits the worker's
              // uncommitted edits too, and those are exactly what a timed-out
              // worker had not finished.
              const recoverRef =
                failed && outcome.error === WALL_CLOCK_TIMEOUT_MARKER && info
                  ? await this.workerCommittedTip(execution.execution_id, input.missionId, worktree)
                  : undefined;
              await this.harvestWorktree(execution.execution_id);
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
                byBranch.set(info.branch, { marker: "WORKSPACE_SCOPE_MISMATCH", taskId: input.taskId });
                this.failedBranches.set(input.missionId, byBranch);
              }
            }
            // Publish terminal result evidence only after every mutation and
            // handoff decision has passed the live execution fence. The status
            // transition itself revokes that fence.
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            await this.recordGateEvidence(input, execution.execution_id, backend, outcome, repository);
            input.authority?.assertAuthoritative();
            this.store.assertExecutionAuthoritative(execution.execution_id);
            const succeeded = outcome.exitStatus === "succeeded";
            this.store.setExecutionStatus(execution.execution_id, succeeded ? "SUCCEEDED" : "FAILED", {
              exit_status: outcome.exitStatus,
              artifact_refs: outcome.artifactRefs,
              usage: outcome.usage,
              ...(outcome.recoveredMerged?.length ? { recovered_merged: outcome.recoveredMerged } : {}),
              ...(backend === "review" && input.reviewedRecovered?.length
                ? { reviewed_recovered: [...input.reviewedRecovered] }
                : {}),
            });
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
              const timedOut =
                abort.signal.reason instanceof DOMException && abort.signal.reason.name === "TimeoutError";
              if (abort.signal.aborted && !timedOut) {
                this.store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
              } else {
                this.store.setExecutionStatus(execution.execution_id, "FAILED", {
                  exit_status: timedOut ? WALL_CLOCK_TIMEOUT_MARKER : err instanceof Error ? err.message : String(err),
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
            clearTimeout(timer);
            if (!retainWorktreeOnCleanup && !cleanupOwnedByCancellation) {
              await this.releaseWorktree(execution.execution_id);
            }
          }
        })();
        let removeAbortListener = (): void => {};
        const authoritativeAbort = new Promise<ExecutionOutcome>((resolve, reject) => {
          const settle = (): void => {
            const timedOut = abort.signal.reason instanceof DOMException && abort.signal.reason.name === "TimeoutError";
            void this.terminalizeAfterGrace(
              execution.execution_id,
              timedOut ? "timeout" : "canceled",
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
    });
    input.authority?.assertAuthoritative();
    this.store.setExecutionStatus(execution.execution_id, "RUNNING", {});
    this.active.get(execution.execution_id)!.status = "RUNNING";
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
    const base = {
      objective: input.objective,
      contextRef: input.contextRef,
      worktree,
      signal,
      onActivity,
    };
    switch (backend) {
      case "agent":
      case "research": {
        const runner = this.backends.agent;
        if (!runner) throw new Error(`no agent backend registered for ${backend}`);
        return runner.runAgent({
          repoId: input.repoId,
          role: input.role ?? "worker",
          objective: input.objective,
          contextRef: input.contextRef,
          worktree: base.worktree,
          isolatedWorktree: worktree !== null,
          modelRequirements: input.modelRequirements,
          signal,
          onActivity: base.onActivity,
        });
      }
      case "process": {
        const runner = this.backends.process;
        if (!runner) throw new Error("no process backend registered");
        return runner.runProcess({ repoId: input.repoId, objective: input.objective, worktree: base.worktree, signal });
      }
      case "review": {
        const runner = this.backends.review;
        if (!runner) throw new Error("no review backend registered");
        return runner.runReview({
          repoId: input.repoId,
          objective: input.objective,
          contextRef: input.contextRef,
          signal,
          onActivity: base.onActivity,
        });
      }
      case "integration": {
        const runner = this.backends.integration;
        if (!runner) throw new Error("no integration backend registered");
        const assertOrigin = (): void => {
          input.authority?.assertAuthoritative();
          this.store.assertExecutionAuthoritative(executionId);
        };
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
            handoffs.push({ worktree: w, summary: input.objective, artifacts: [] });
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
            recoveredMeta.push({ task_id: failure.taskId, branch: w.branch, ref: failure.recoverRef });
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
        // After integration, release the merged worktrees (fire-and-forget
        // cleanup so the return value stays a plain Promise<ExecutionOutcome>).
        // What recovery actually landed is decided here, from git, not from
        // the runner's prose: a recovered ref counts only when the integration
        // succeeded AND the exact worker commit is an ancestor of HEAD after it
        // (a skipped or conflicting recovered handoff is not). This is the
        // completion gate's evidence for superseding the timed-out task.
        const git = repository?.git ?? null;
        let outcome = await runner.runIntegration({
          repoId: input.repoId,
          objective: input.objective,
          handoffs,
          signal,
        });
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
        if (outcome.exitStatus === "succeeded" && git && recoveredMeta.length > 0) {
          let head: string | null = null;
          try {
            head = await git.headCommit();
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
        return runner.runValidation({
          repoId: input.repoId,
          objective: input.objective,
          worktree: base.worktree,
          signal,
        });
      }
    }
  }
}
