/**
 * AutoSpec-managed execution and verification backends (R-ADAPT).
 *
 * `AutoSpecWorkerExecutor` and `AutoSpecVerificationProvider` implement Pi's own
 * `WorkerExecutor` and `VerificationProvider` on top of the optional
 * `AutoSpecAdapter` (submit/observe/cancel). Pi stays the mission owner: every
 * call carries the owner and its fencing token, the wait is bounded, an abort
 * or a missed deadline cancels the remote run exactly once, and a remote
 * "succeeded" is a claim — verification only counts stage output.
 *
 * Nothing here is imported by core. The factory returns `null` unless both
 * `PI_AUTOSPEC_ENABLED` and `PI_AUTOSPEC_MANAGED_ENABLED` are on
 * (src/orchestration/missionMode.ts), so Pi without AutoSpec is unchanged.
 */

import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { Evidence } from "../core/types.ts";
import { type FlagEnv, readAutospecFlags } from "../orchestration/missionMode.ts";
import type {
  StageRun,
  VerificationProfile,
  VerificationProvider,
  VerifyOutcome,
  VerifyRunOptions,
} from "../verify/Verifier.ts";
import { hashProfile } from "../verify/failureBaseline.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import {
  type AutoSpecAdapter,
  type AutoSpecObservation,
  type AutoSpecOwner,
  type AutoSpecRunState,
  type AutoSpecSubmission,
  StaleFencingTokenError,
} from "./Adapters.ts";

export interface AutoSpecBackendOptions {
  /** Delay between `observe` calls. */
  pollMs?: number;
  /** Total time one remote run may take before it is cancelled. */
  deadlineMs?: number;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DEADLINE_MS = 30 * 60_000;

type Waited =
  | { kind: "terminal"; observation: AutoSpecObservation }
  | { kind: "aborted" }
  | { kind: "deadline" }
  | { kind: "stale"; error: StaleFencingTokenError }
  | { kind: "error"; message: string };

const TERMINAL: ReadonlySet<AutoSpecRunState> = new Set(["succeeded", "failed", "cancelled"]);

function pause(ms: number, stop: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void stop.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Poll `observe` until the run is terminal, the signal aborts, or the deadline
 * passes. Abort and deadline also interrupt an `observe` call that is itself
 * pending. The caller cancels exactly once on `aborted` and `deadline`.
 */
async function waitForTerminal(
  adapter: AutoSpecAdapter,
  externalId: string,
  owner: AutoSpecOwner,
  signal: AbortSignal | undefined,
  pollMs: number,
  deadlineMs: number,
): Promise<Waited> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<Waited>((resolve) => {
    if (signal?.aborted) resolve({ kind: "aborted" });
    else {
      onAbort = () => resolve({ kind: "aborted" });
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Waited>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), deadlineMs);
  });
  const interrupted = Promise.race([aborted, deadline]);
  let stopped: Waited | undefined;
  void interrupted.then((w) => {
    stopped = w;
  });
  try {
    for (;;) {
      await Promise.resolve(); // let a settled abort or deadline register before the next call
      if (stopped) return stopped;
      const step = await Promise.race([
        interrupted,
        adapter.observe(externalId, owner).then(
          (observation): Waited => ({ kind: "terminal", observation }),
          (error: unknown): Waited =>
            error instanceof StaleFencingTokenError
              ? { kind: "stale", error }
              : { kind: "error", message: error instanceof Error ? error.message : String(error) },
        ),
      ]);
      if (step.kind !== "terminal") return step;
      if (TERMINAL.has(step.observation.state)) return step;
      await pause(pollMs, interrupted);
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

async function cancelOnce(adapter: AutoSpecAdapter, externalId: string, owner: AutoSpecOwner, reason: string) {
  try {
    await adapter.cancel(externalId, owner, reason);
  } catch {
    // The run is being abandoned either way; a failed cancel must not mask the outcome.
  }
}

/** Submit, wait, and cancel on abort or deadline. Never throws. */
async function dispatch(
  adapter: AutoSpecAdapter,
  owner: AutoSpecOwner,
  submission: Omit<AutoSpecSubmission, "owner">,
  signal: AbortSignal | undefined,
  opts: AutoSpecBackendOptions,
): Promise<
  | { kind: "done"; externalId: string; observation: AutoSpecObservation }
  | { kind: "stopped"; error: string; summary: string; externalId?: string }
> {
  if (signal?.aborted) return { kind: "stopped", error: "canceled", summary: "Canceled before the run was submitted." };
  let handle: Awaited<ReturnType<AutoSpecAdapter["submit"]>>;
  try {
    handle = await adapter.submit({ ...submission, owner });
  } catch (err) {
    return {
      kind: "stopped",
      error: "autospec:submit-error",
      summary: `AutoSpec submit failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!handle.accepted) {
    return {
      kind: "stopped",
      error: "autospec:rejected",
      summary: `AutoSpec did not accept the run${handle.reason ? `: ${handle.reason}` : ""}.`,
    };
  }
  const waited = await waitForTerminal(
    adapter,
    handle.externalId,
    owner,
    signal,
    opts.pollMs ?? DEFAULT_POLL_MS,
    opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
  );
  const externalId = handle.externalId;
  switch (waited.kind) {
    case "terminal":
      return { kind: "done", externalId, observation: waited.observation };
    case "aborted":
      await cancelOnce(adapter, externalId, owner, "canceled by the owning execution");
      return {
        kind: "stopped",
        error: "canceled",
        summary: `Canceled; AutoSpec run ${externalId} was asked to stop.`,
        externalId,
      };
    case "deadline":
      await cancelOnce(adapter, externalId, owner, "deadline exceeded");
      return {
        kind: "stopped",
        error: "timeout",
        summary: `AutoSpec run ${externalId} passed its deadline and was canceled.`,
        externalId,
      };
    case "stale":
      return { kind: "stopped", error: "autospec:stale-owner", summary: waited.error.message, externalId };
    case "error":
      return {
        kind: "stopped",
        error: "autospec:observe-error",
        summary: `AutoSpec observe failed: ${waited.message}`,
        externalId,
      };
  }
}

function failedRun(error: string, summary: string, details: Record<string, unknown> = {}): WorkerRun {
  return {
    result: {
      status: "failed",
      summary,
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details,
      error,
    },
    usage: null,
    error,
  };
}

/** A `WorkerExecutor` that hands each request to AutoSpec and waits, bounded, for the verdict. */
export class AutoSpecWorkerExecutor implements WorkerExecutor {
  private readonly adapter: AutoSpecAdapter;
  private readonly owner: AutoSpecOwner;
  private readonly opts: AutoSpecBackendOptions;

  constructor(adapter: AutoSpecAdapter, owner: AutoSpecOwner, opts: AutoSpecBackendOptions = {}) {
    this.adapter = adapter;
    this.owner = owner;
    this.opts = opts;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const missionId = req.missionId ?? "unscoped";
    const taskId = req.workItemId ?? req.sessionId ?? req.role;
    const outcome = await dispatch(
      this.adapter,
      this.owner,
      {
        missionId,
        taskId,
        request: req.context ? `${req.task}\n\n${req.context}` : req.task,
        baseSha: req.baseRef ?? "",
        idempotencyKey: `${missionId}:${taskId}:${req.role}:${req.sessionId ?? randomUUID()}`,
      },
      req.signal,
      this.opts,
    );
    if (outcome.kind === "stopped") {
      return failedRun(
        outcome.error,
        outcome.summary,
        outcome.externalId ? { autospec: { externalId: outcome.externalId } } : {},
      );
    }
    const { externalId, observation } = outcome;
    const details = { autospec: { externalId, state: observation.state, sequence: observation.sequence } };
    if (observation.state !== "succeeded") {
      return failedRun(
        `autospec:${observation.state}`,
        observation.summary ?? `AutoSpec run ${externalId} ${observation.state}.`,
        details,
      );
    }
    return {
      result: {
        status: "completed",
        summary: observation.summary ?? `AutoSpec run ${externalId} succeeded.`,
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details,
      },
      usage: null,
    };
  }
}

const REPORT_STAGE = "autospec-report";

export interface AutoSpecVerifyOptions extends AutoSpecBackendOptions {
  missionId?: string;
  taskId?: string;
}

/**
 * A `VerificationProvider` that has AutoSpec run the stages. The remote verdict
 * alone is never enough: a run that succeeded but reports no stage output
 * (nothing captured, so nothing to cite) is a failed outcome.
 */
export class AutoSpecVerificationProvider implements VerificationProvider {
  private readonly adapter: AutoSpecAdapter;
  private readonly owner: AutoSpecOwner;
  private readonly opts: AutoSpecVerifyOptions;

  constructor(adapter: AutoSpecAdapter, owner: AutoSpecOwner, opts: AutoSpecVerifyOptions = {}) {
    this.adapter = adapter;
    this.owner = owner;
    this.opts = opts;
  }

  async detect(_cwd: string, opts?: { full?: boolean }): Promise<VerificationProfile> {
    return {
      name: opts?.full ? "autospec-managed-full" : "autospec-managed",
      stages: [{ name: REPORT_STAGE, command: "autospec", args: ["verify"], required: true }],
    };
  }

  async run(
    _cwd: string,
    profile: VerificationProfile,
    artifactStore: ArtifactStore,
    runOpts?: VerifyRunOptions,
  ): Promise<VerifyOutcome> {
    const startedAt = new Date().toISOString();
    const missionId = this.opts.missionId ?? "unscoped";
    const taskId = this.opts.taskId ?? "verify";
    const outcome = await dispatch(
      this.adapter,
      this.owner,
      {
        missionId,
        taskId,
        request: JSON.stringify({ kind: "verify", profile: profile.name }),
        baseSha: runOpts?.boundBaseSha ?? "",
        idempotencyKey: `${missionId}:${taskId}:verify:${randomUUID()}`,
      },
      runOpts?.signal,
      this.opts,
    );
    const profileHash = hashProfile(profile);
    const reportFailure = (warning: string): VerifyOutcome => ({
      passed: false,
      stages: [],
      evidence: [],
      failedStage: REPORT_STAGE,
      noTargets: false,
      warnings: [warning],
      profileHash,
    });
    if (outcome.kind === "stopped") return reportFailure(outcome.summary);
    const { observation, externalId } = outcome;
    if (observation.state !== "succeeded") {
      return reportFailure(observation.summary ?? `AutoSpec run ${externalId} ${observation.state}.`);
    }
    const stages = (observation.stages ?? []).filter((s) => s.output.trim().length > 0);
    if (stages.length === 0 || stages.length !== (observation.stages ?? []).length) {
      return reportFailure(
        `AutoSpec run ${externalId} reported success without stage output; not accepted as evidence.`,
      );
    }

    const stageRuns: StageRun[] = [];
    const evidence: Evidence[] = [];
    let failedStage: string | null = null;
    for (const [index, report] of stages.entries()) {
      const passed = report.exitCode === 0;
      const log = `$ ${report.command}\n--- output (reported by AutoSpec run ${externalId}) ---\n${report.output}`;
      const artifactUri = (
        await artifactStore.put(
          "verify",
          `${profile.name}-${report.name}-${Date.now().toString(36)}-${index}`,
          log,
          log.slice(0, 500),
        )
      ).uri;
      const summary: Record<string, unknown> = {
        stage: report.name,
        passed,
        exitCode: report.exitCode,
        source: "autospec",
        externalId,
      };
      stageRuns.push({
        stage: { name: report.name, command: report.command, args: [], required: true },
        exitCode: report.exitCode,
        passed,
        summary,
        artifactUri,
        ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
      });
      evidence.push({
        id: `EVID-${Math.random().toString(36).slice(2, 8)}`,
        candidate_id: null,
        type: `verify.${report.name}`,
        tool: "autospec",
        command: report.command,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: report.exitCode,
        status: passed ? "passed" : "failed",
        summary,
        artifacts: [artifactUri],
        // Reported by an external system, not captured by Pi's own process.
        trust: "observed",
      });
      if (!passed) failedStage ??= report.name;
    }
    return {
      passed: failedStage === null,
      stages: stageRuns,
      evidence,
      failedStage,
      noTargets: false,
      warnings: [],
      profileHash,
    };
  }
}

export interface AutospecBackends {
  executor: AutoSpecWorkerExecutor;
  verifier: AutoSpecVerificationProvider;
}

/**
 * The managed backends, or `null` when the feature is off (the default), the
 * managed backend is not enabled, or no adapter is installed.
 */
export function createAutospecBackends(
  env: FlagEnv,
  adapter: AutoSpecAdapter | null | undefined,
  owner: AutoSpecOwner,
  opts: AutoSpecVerifyOptions = {},
): AutospecBackends | null {
  const flags = readAutospecFlags(env);
  if (!flags.enabled || !flags.managedEnabled || !adapter) return null;
  return {
    executor: new AutoSpecWorkerExecutor(adapter, owner, opts),
    verifier: new AutoSpecVerificationProvider(adapter, owner, opts),
  };
}
