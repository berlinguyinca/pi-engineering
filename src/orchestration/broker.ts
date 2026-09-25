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

import type { GitRepo } from "../git/GitRepo.ts";
import type { MissionStore } from "./missionStore.ts";
import type { ExecutionBackend, RecoveredMerge } from "./types.ts";

export interface ExecutionRequestInput {
  taskId: string;
  missionId: string;
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
  /**
   * Review only: recovered tasks whose objective the review request asks to
   * verify. Recorded on the execution as `reviewed_recovered`.
   */
  reviewedRecovered?: string[];
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
}

/** Backend runner contracts — injected, so the broker stays deterministic-testable. */
export interface AgentRunner {
  /** Spawn a fresh agent child. Returns a handle that resolves on completion. */
  runAgent(input: {
    role: string;
    objective: string;
    contextRef?: string;
    worktree?: string | null;
    modelRequirements?: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
  onSteer?: (steer: string) => void;
}

export interface ProcessRunner {
  runProcess(input: {
    objective: string;
    worktree?: string | null;
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface ReviewRunner {
  runReview(input: {
    objective: string;
    contextRef?: string;
    signal: AbortSignal;
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
    objective: string;
    handoffs: IntegrationHandoff[];
    signal: AbortSignal;
  }): Promise<ExecutionOutcome>;
}

export interface ValidationRunner {
  runValidation(input: { objective: string; worktree?: string | null; signal: AbortSignal }): Promise<ExecutionOutcome>;
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
}

export class ExecutionBroker {
  private readonly store: MissionStore;
  private readonly backends: BrokerBackends;
  private readonly defaultTimeoutMs: number;
  private readonly git: GitRepo | null;
  private readonly baseRef: string;
  /** In-flight execution state for cancellation + allocated worktrees. */
  private readonly active = new Map<
    string,
    { abort: AbortController; status: string; worktree: string | null; taskId: string }
  >();
  /** Allocated worktrees, cleaned up when their execution settles. */
  readonly allocatedWorktrees = new Map<string, { path: string; branch: string }>();
  /** Mission-scoped worktrees awaiting integration (merged+cleaned by the integrator). */
  private readonly missionWorktrees = new Map<string, { path: string; branch: string }[]>();
  /** Commit each mission's worktrees were actually forked from (landing invariant). */
  private readonly resolvedBases = new Map<string, string>();
  /** Branches intentionally kept after cleanup because their work never merged. */
  private readonly preserved = new Map<string, string[]>();
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
    this.store.setExecutionStatus(executionId, "CANCELED", { exit_status: "canceled" });
    const id = taskId ?? entry.taskId;
    if (id && this.store.getTask(id) && this.store.getTask(id)!.status === "RUNNING") {
      this.store.transitionTask(id, "CANCELED");
    }
    await this.releaseWorktree(executionId);
    this.active.delete(executionId);
    return true;
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
  private async allocateWorktree(executionId: string, input: ExecutionRequestInput): Promise<string | null> {
    if (!input.mutatesRepo || input.isolation !== "worktree" || !this.git) return null;
    try {
      // The mission's declared base_ref wins: a mission planned against commit X
      // must branch from X. Falling back to a broker-level ref captured earlier
      // (the runtime's HEAD at open) silently based the worker on a NEWER commit,
      // which turns a real conflict into a clean merge where the worker's version
      // wins over the incumbent.
      const missionBase = this.store.getMission(input.missionId)?.base_ref?.trim();
      const base = missionBase || this.baseRef || (await this.git.headCommit());
      // Remember what we actually forked from. A mission may be handed an empty
      // base_ref, and without a base the 'did the work land' invariant has nothing
      // to diff against — the fork point recorded here is the fallback.
      this.resolvedBases.set(input.missionId, base);
      const branch = `pi-eng-orch-${input.taskId}`;
      const wt = await this.git.createWorktree(base, branch);
      const info = { path: wt.path, branch: wt.branch };
      this.allocatedWorktrees.set(executionId, info);
      // A retried task re-creates its branch (same name): replace, never
      // duplicate, or integration would hand the same branch off twice.
      const mission = (this.missionWorktrees.get(input.missionId) ?? []).filter((w) => w.branch !== info.branch);
      mission.push(info);
      this.missionWorktrees.set(input.missionId, mission);
      return wt.path;
    } catch {
      // If a worktree cannot be allocated (e.g. not a git repo), fall back to
      // the main tree — the scheduler has already serialized conflicting writes.
      return null;
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
    if (!wt || !this.git) return false;
    const ex = this.store.getExecution(executionId);
    const missionId = ex?.mission_id;
    const base = missionId
      ? this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId)
      : undefined;
    // A worker that already committed directly onto its worker branch leaves a
    // clean working tree, but the branch has advanced past the mission base —
    // that IS the work landing, not "nothing to harvest". Compare the branch
    // TIP to the base commit rather than trusting a clean tree as "empty".
    if (base) {
      try {
        if (await this.git.branchAheadOf(base, wt.branch)) {
          if (missionId) this.committedWork.set(missionId, true);
          return true;
        }
      } catch {
        // Fall through to the status-based harvest below.
      }
    }
    let status = "";
    try {
      status = (await this.git.statusIn(wt.path)).trim();
    } catch {
      // Could not even read the worktree status; treat as no harvestable work.
      return false;
    }
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
      await this.git.commitAll(wt.path, `pi-eng: orchestration work for ${executionId}`);
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
    if (!this.git) return undefined;
    const base = this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId);
    let tip: string | undefined;
    let count: number | null = null;
    try {
      tip = await this.git.headCommitIn(worktree);
      if (base) count = await this.git.revListCount(`${base}..${tip}`);
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

  private async releaseWorktree(executionId: string, keepBranch = true): Promise<void> {
    const wt = this.allocatedWorktrees.get(executionId);
    if (wt && this.git) {
      // Keep the branch: it carries the harvested work until integration merges it.
      await this.git.removeWorktree({ path: wt.path, branch: wt.branch }, { keepBranch }).catch(() => {});
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
    if (!this.git) return null;
    const base = this.store.getMission(missionId)?.base_ref?.trim() || this.resolvedBases.get(missionId);
    if (!base) return null;
    try {
      return await this.git.changedFiles(base, await this.git.headCommit());
    } catch {
      return null;
    }
  }

  /** Release any worktrees still tracked for a finished mission. */
  async cleanupMission(missionId: string, opts: { keepBranches?: boolean } = {}): Promise<void> {
    await this.releaseMissionWorktrees(missionId, opts.keepBranches === true);
  }

  /** Remove + clean all mission worktrees (after integration). */
  private async releaseMissionWorktrees(missionId: string, keepBranches = false): Promise<void> {
    const wts = this.missionWorktrees.get(missionId) ?? [];
    for (const wt of wts) {
      // SAFETY: a worker branch must never be force-deleted (git branch -D)
      // while its work is not contained in the integrated checkout. A branch
      // whose tip IS an ancestor of HEAD was merged (its work landed) and may be
      // dropped so branches do not accumulate. A branch whose tip is NOT an
      // ancestor of HEAD still carries unmerged work and is the only copy of
      // what the worker produced — removeWorktree without keepBranch would run
      // `git branch -D` and orphan the real commits into the object store.
      // Preserve it regardless of whether integration reported success.
      if (this.git) {
        let keep = keepBranches;
        try {
          if (!(await this.git.isAncestor(wt.branch, await this.git.headCommit()))) keep = true;
        } catch {
          keep = true; // cannot verify the work merged -> preserve (safe).
        }
        await this.git.removeWorktree({ path: wt.path, branch: wt.branch }, { keepBranch: keep }).catch(() => {});
        if (keep) {
          const list = this.preserved.get(missionId) ?? [];
          if (!list.includes(wt.branch)) list.push(wt.branch);
          this.preserved.set(missionId, list);
        }
      }
    }
    this.missionWorktrees.delete(missionId);
    for (const [execId, info] of [...this.allocatedWorktrees]) {
      if (wts.some((w) => w.branch === info.branch)) this.allocatedWorktrees.delete(execId);
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

  async execute(input: ExecutionRequestInput): Promise<ExecutionHandle> {
    const backend = this.backendForKind(input.kind);
    const execution = this.store.createExecution({
      task_id: input.taskId,
      mission_id: input.missionId,
      backend,
      model: (input.modelRequirements as { model?: string } | undefined)?.model ?? null,
      thinking_level: (input.modelRequirements as { thinking?: string } | undefined)?.thinking ?? null,
    });

    const abort = new AbortController();
    const handle: ExecutionHandle = {
      executionId: execution.execution_id,
      taskId: input.taskId,
      missionId: input.missionId,
      backend,
      status: () => this.active.get(execution.execution_id)?.status ?? "PENDING",
      cancel: async () => {
        await this.cancelExecution(execution.execution_id, input.taskId);
      },
      steer: async (request) => {
        this.store.steerTask(input.taskId, request);
        const runner = this.backends[backend as keyof BrokerBackends] as { onSteer?: (s: string) => void } | undefined;
        runner?.onSteer?.(request);
      },
      result: async () => {
        const timeoutMs = input.timeoutPolicy?.timeoutMs ?? this.defaultTimeoutMs;
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        // Allocate an isolated worktree before dispatch so mutating workers edit
        // their own checkout (spec 05), then release it when the task settles.
        const worktree = await this.allocateWorktree(execution.execution_id, input);
        if (worktree) this.active.get(execution.execution_id)!.worktree = worktree;
        try {
          const outcome = await this.dispatch(input, backend, execution.execution_id, abort.signal, worktree);
          // A cancellation that already settled this execution must not be
          // overwritten by the runner's late success.
          if (!this.settledElsewhere(execution.execution_id)) {
            // Resolution is not success. The completion gate counts SUCCEEDED
            // executions as validation/review evidence, so recording a failed
            // validation run as SUCCEEDED would corrupt the gate's primary
            // evidence source.
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
          }
          // Persist the worker's edits onto its branch before the worktree is
          // torn down, otherwise integration has nothing to merge — and on a
          // FAILED execution, otherwise the worker's partial work dies with the
          // worktree. Harvest whenever there is a worktree (success or failure);
          // failed branches are then excluded from integration and preserved.
          if (input.mutatesRepo && worktree) {
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
          this.active.delete(execution.execution_id);
          return outcome;
        } catch (err) {
          if (!this.settledElsewhere(execution.execution_id)) {
            if (abort.signal.aborted) {
              this.store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
            } else {
              this.store.setExecutionStatus(execution.execution_id, "FAILED", {
                exit_status: err instanceof Error ? err.message : String(err),
              });
            }
          }
          this.active.delete(execution.execution_id);
          throw err;
        } finally {
          clearTimeout(timer);
          await this.releaseWorktree(execution.execution_id);
        }
      },
    };

    this.active.set(execution.execution_id, { abort, status: "PENDING", worktree: null, taskId: input.taskId });
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
  ): Promise<ExecutionOutcome> {
    const base = {
      objective: input.objective,
      contextRef: input.contextRef,
      worktree,
      signal,
    };
    switch (backend) {
      case "agent":
      case "research": {
        const runner = this.backends.agent;
        if (!runner) throw new Error(`no agent backend registered for ${backend}`);
        return runner.runAgent({
          role: input.role ?? "worker",
          objective: input.objective,
          contextRef: input.contextRef,
          worktree: base.worktree,
          modelRequirements: input.modelRequirements,
          signal,
        });
      }
      case "process": {
        const runner = this.backends.process;
        if (!runner) throw new Error("no process backend registered");
        return runner.runProcess({ objective: input.objective, worktree: base.worktree, signal });
      }
      case "review": {
        const runner = this.backends.review;
        if (!runner) throw new Error("no review backend registered");
        return runner.runReview({ objective: input.objective, contextRef: input.contextRef, signal });
      }
      case "integration": {
        const runner = this.backends.integration;
        if (!runner) throw new Error("no integration backend registered");
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
        for (const w of this.missionWorktrees.get(input.missionId) ?? []) {
          const failure = failedByBranch?.get(w.branch);
          if (failure === undefined) {
            handoffs.push({ worktree: w, summary: input.objective, artifacts: [] });
            continue;
          }
          // Exactly the worker's wall-clock marker (PiWorkerExecutor: error
          // "timeout"). A substring match also caught `gateway:queue_timeout`
          // and `transient:timeout` — gateway/transport failures whose partial
          // work must stay preserve-only.
          if (failure.marker !== WALL_CLOCK_TIMEOUT_MARKER || !failure.recoverRef) continue;
          const ahead = this.git ? await this.git.revListCount(`HEAD..${failure.recoverRef}`) : 0;
          if (ahead === null) {
            this.recoveryFinding(
              executionId,
              `Could not count recoverable commits on ${w.branch}; its timed-out work was not recovered`,
            );
            continue;
          }
          if (ahead > 0) {
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
        handoffs.push(...recovered);
        // After integration, release the merged worktrees (fire-and-forget
        // cleanup so the return value stays a plain Promise<ExecutionOutcome>).
        // What recovery actually landed is decided here, from git, not from
        // the runner's prose: a recovered ref counts only when the integration
        // succeeded AND the exact worker commit is an ancestor of HEAD after it
        // (a skipped or conflicting recovered handoff is not). This is the
        // completion gate's evidence for superseding the timed-out task.
        const git = this.git;
        const outcome = runner
          .runIntegration({ objective: input.objective, handoffs, signal })
          .then(async (o): Promise<ExecutionOutcome> => {
            if (o.exitStatus !== "succeeded" || !git || recoveredMeta.length === 0) return o;
            // Unknown HEAD: no evidence, and never a failed integration.
            const head = await git.headCommit().catch(() => null);
            if (!head) return o;
            const merged: RecoveredMerge[] = [];
            for (const r of recoveredMeta) {
              if (await git.isAncestor(r.ref, head).catch(() => false)) merged.push(r);
            }
            return merged.length > 0 ? { ...o, recoveredMerged: merged } : o;
          });
        // Release the worktrees, but delete the branches only when the merge
        // actually landed. After a conflict or a failed integration the branch is
        // the only remaining copy of the worker's output, and removeWorktree
        // without keepBranch runs `git branch -D` — which would destroy exactly
        // what an operator needs to resolve the conflict.
        outcome
          .then((o) => this.releaseMissionWorktrees(input.missionId, o.exitStatus !== "succeeded"))
          .catch(() => {});
        return outcome;
      }
      case "validation": {
        const runner = this.backends.validation;
        if (!runner) throw new Error("no validation backend registered");
        return runner.runValidation({ objective: input.objective, worktree: base.worktree, signal });
      }
    }
  }
}
