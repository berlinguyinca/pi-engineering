/**
 * Real backends for the ExecutionBroker, wiring the EXISTING pi-engineering
 * runtime primitives (spec 00 §6: reuse existing engineering/review workflows):
 *
 *   - agent/research -> fresh-context worker via WorkerExecutor
 *   - process        -> deterministic subprocess via CommandVerifier
 *   - validation     -> deterministic verification via CommandVerifier
 *   - review         -> fresh independent review via WorkerExecutor (reviewer role)
 *   - integration    -> GitRepo controlled merge (integrator role)
 *
 * These adapters are what the extension uses to run a live orchestrated
 * mission; tests inject deterministic fakes instead.
 */

import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { GitRepo } from "../git/GitRepo.ts";
import type { VerificationProvider } from "../verify/Verifier.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";
import { type ExecutionOutcome, type IntegrationHandoff, workerTimeoutMs } from "./broker.ts";

export interface RealBackendsOptions {
  worker: WorkerExecutor;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  git: GitRepo | null;
  cwd: string;
  /**
   * Optional capability-router hook: resolve a worker role to a specific
   * `{provider, id}` model placement (e.g. from `policy.routing.roles`). When
   * it returns a model, the worker runs on that model; when it returns
   * `undefined` (or is omitted) the worker falls back to its construction-time
   * default, preserving the pre-routing behavior. This is what makes per-role
   * model placement (a pinned implementer/reviewer) take effect in the mission
   * pipeline, matching the lifecycle `roleRunner` path.
   */
  routeModel?: (role: WorkerRequest["role"]) => Promise<ModelRoute | undefined>;
  /** Current/session model used when review cannot be placed on a distinct model. */
  reviewFallbackModel?: { provider: string; id: string };
  /** Resolve the repository selected by the current mission's async binding. */
  repository?: (repoId?: string) => Promise<{ git: GitRepo; cwd: string }> | { git: GitRepo; cwd: string };
}

export interface ModelRoute {
  provider: string;
  id: string;
  /** Operator-visible notice when policy had to degrade model separation. */
  warning?: string;
}

/**
 * Normalize reviewer findings of varying shapes into a uniform list of records
 * consumed by the orchestrator's finding store + the completion gate. Handles
 * three shapes: objects ({severity, summary|message|text|title}), plain strings
 * (severity defaults to "warning"), and a JSON string (possibly an array).
 * The output always carries `summary` (the human message) alongside `message`,
 * plus optional `severity`, `category`, `file`, `line`, `evidence`, and
 * `recommended_action` passthroughs.
 */
export function normalizeFindings(raw: unknown): Array<Record<string, unknown>> {
  const norm = (obj: Record<string, unknown>): Record<string, unknown> => {
    const summary = obj.summary ?? obj.message ?? obj.text ?? obj.title;
    const out: Record<string, unknown> = { summary };
    if (typeof summary === "string") {
      out.message = summary;
      for (const k of ["severity", "category", "file", "line", "evidence", "recommended_action"] as const) {
        if (obj[k] !== undefined) out[k] = obj[k];
      }
    }
    return out;
  };
  if (Array.isArray(raw)) {
    return raw.flatMap((f) => {
      if (typeof f === "string") return [{ summary: f, message: f }];
      if (f && typeof f === "object") {
        const out = norm(f as Record<string, unknown>);
        return out.summary !== undefined ? [out] : [];
      }
      return [];
    });
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeFindings(parsed);
        if (parsed && typeof parsed === "object") {
          const out = norm(parsed as Record<string, unknown>);
          return out.summary !== undefined ? [out] : [];
        }
      } catch {
        /* fall through */
      }
    }
    return [{ summary: trimmed, message: trimmed }];
  }
  if (raw && typeof raw === "object") {
    const out = norm(raw as Record<string, unknown>);
    return out.summary !== undefined ? [out] : [];
  }
  return [];
}

/** Convert a worker result into a bounded broker outcome. */
function outcomeOf(result: Awaited<ReturnType<WorkerExecutor["run"]>>): ExecutionOutcome {
  const completed = result.result.status === "completed";
  const outcome: ExecutionOutcome = {
    executionId: "worker",
    exitStatus: completed ? "succeeded" : "failed",
    summary: result.result.summary,
    artifactRefs: result.result.evidence_refs ?? [],
    usage: {
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      model: result.usage?.model ?? "unknown",
    },
  };
  // Surface the worker's machine-readable failure marker (e.g.
  // `transient:server_unavailable`) so the scheduler can classify a non-throwing
  // failure and route a transient infrastructure failure into the time-based
  // resilience window instead of immediately failing the task.
  if (!completed) outcome.error = result.result.error ?? result.result.summary;
  return outcome;
}

export function realBackends(opts: RealBackendsOptions) {
  const repository = async (repoId?: string): Promise<{ git: GitRepo | null; cwd: string }> =>
    (await opts.repository?.(repoId)) ?? { git: opts.git, cwd: opts.cwd };
  const runWorker = async (
    req: WorkerRequest,
    input: { signal: AbortSignal; onActivity?: (event: WorkerActivity) => void },
  ): Promise<Awaited<ReturnType<WorkerExecutor["run"]>>> => {
    if (input.signal.aborted) throw new Error("worker execution aborted");
    let aborted = false;
    const markAborted = (): void => {
      aborted = true;
    };
    const publish = (event: WorkerActivity): void => {
      if (aborted) return;
      try {
        input.onActivity?.(event);
      } catch {
        // Activity consumers are observers, never participants.
      }
    };
    req.onActivity = publish;
    req.signal = input.signal;
    input.signal.addEventListener("abort", markAborted, { once: true });
    try {
      const result = await opts.worker.run(req);
      const completed = result.result.status === "completed";
      publish({
        kind: "state",
        phase: completed ? "completed" : "failed",
        summary: completed ? "Worker session completed" : "Worker session failed",
        meaningfulProgress: completed,
      });
      return result;
    } catch (error) {
      publish({ kind: "state", phase: "failed", summary: "Worker session failed", meaningfulProgress: false });
      throw error;
    } finally {
      input.signal.removeEventListener("abort", markAborted);
    }
  };
  return {
    agent: {
      async runAgent(input: {
        role: string;
        repoId?: string;
        objective: string;
        contextRef?: string;
        worktree?: string | null;
        isolatedWorktree?: boolean;
        modelRequirements?: Record<string, unknown>;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: (input.role as WorkerRequest["role"]) ?? "implementer",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "ledger_claim", "artifact_read", "repo_search", "symbol", "tests_for", "bash"],
          cwd: input.worktree ?? bound.cwd,
          // Fresh-context implementation workers need headroom to explore the
          // repo, implement, run verification, and commit. Configurable so an
          // operator can tune per environment without recompiling.
          timeoutMs: workerTimeoutMs(),
          // Only the broker's word makes a directory an isolated worktree; the
          // fallback (no worktree) runs in the user's checkout.
          isolatedWorktree: input.isolatedWorktree === true && !!input.worktree,
        };
        // Place the worker on the model the capability router chose for this
        // role (honours `policy.routing.roles`); fall back to the executor
        // default when routing is unavailable or the role is unknown.
        const modelRoute = await opts.routeModel?.(req.role);
        if (modelRoute) req.modelOverride = { provider: modelRoute.provider, id: modelRoute.id };
        const run = await runWorker(req, input);
        return outcomeOf(run);
      },
    },
    research: {
      async runAgent(input: {
        role?: string;
        repoId?: string;
        objective: string;
        contextRef?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        return runWorker(
          {
            role: "scout",
            task: input.objective,
            context: input.contextRef,
            tools: ["ledger_read", "repo_search", "symbol", "tests_for"],
            cwd: bound.cwd,
          },
          input,
        ).then(outcomeOf);
      },
    },
    validation: {
      async runValidation(input: {
        repoId?: string;
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        input.signal.throwIfAborted();
        const cwd = input.worktree ?? (await repository(input.repoId)).cwd;
        const profile = await opts.verifier.detect(cwd);
        input.signal.throwIfAborted();
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts, { signal: input.signal });
        return {
          executionId: "validation",
          exitStatus: outcome.passed ? "succeeded" : "failed",
          summary: outcome.passed
            ? `validation passed (${outcome.stages.length} stages)`
            : `validation failed at ${outcome.failedStage ?? "unknown"}`,
          artifactRefs: outcome.evidence.flatMap((e) => e.artifacts).filter(Boolean),
          usage: { stages: outcome.stages.length },
        };
      },
    },
    review: {
      async runReview(input: {
        repoId?: string;
        objective: string;
        contextRef?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        // A review must inspect the integrated change, read evidence, and write
        // concrete findings — a long, prose-heavy task. Give it an explicit,
        // generous context budget so the reviewer is never cut off for hitting
        // the (previously unset → default) token cap; the role-adjusted guard
        // lets it write its findings report without a false degeneration abort.
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: "reviewer",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "artifact_read", "repo_search", "symbol"],
          cwd: bound.cwd,
          maxContextTokens: 64_000,
          // Same generous wall-clock budget as implementation workers: a review
          // must inspect the integrated change before writing findings, and the
          // executor's default (5 min) aborted the reviewer mid-analysis.
          timeoutMs: workerTimeoutMs(),
        };
        const routed = await opts.routeModel?.(req.role);
        const modelRoute = routed ?? opts.reviewFallbackModel;
        const fallbackWarning = routed
          ? routed.warning
          : opts.reviewFallbackModel
            ? `Warning: no distinct reviewer model is available; reviewing with ${opts.reviewFallbackModel.provider}/${opts.reviewFallbackModel.id} in a fresh session with reduced independence.`
            : "Warning: no distinct reviewer model is available; reviewing with the current worker model in a fresh session with reduced independence.";
        if (modelRoute) {
          req.modelOverride = { provider: modelRoute.provider, id: modelRoute.id };
        }
        if (fallbackWarning) {
          input.onActivity?.({
            kind: "execution",
            stage: "review",
            phase: "started",
            summary: fallbackWarning,
            meaningfulProgress: false,
          });
        }
        const run = await runWorker(req, input);
        const outcome = outcomeOf(run);
        // If the reviewer emitted structured findings, normalize and surface them
        // so the completion gate can block on blocking findings. Handles three
        // shapes: a list of objects ({severity, message|summary|text}), a list of
        // plain strings (severity defaults to "warning"), and a JSON string.
        const raw = (run.result.details as { findings?: unknown } | undefined)?.findings;
        outcome.findings = normalizeFindings(raw);
        return outcome;
      },
    },
    process: {
      async runProcess(input: {
        repoId?: string;
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        // Deterministic process execution falls back to verification-style
        // commands; a generic subprocess runner can be attached here later.
        input.signal.throwIfAborted();
        const cwd = input.worktree ?? (await repository(input.repoId)).cwd;
        const profile = await opts.verifier.detect(cwd);
        input.signal.throwIfAborted();
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts, { signal: input.signal });
        return {
          executionId: "process",
          exitStatus: outcome.passed ? "succeeded" : "failed",
          summary: outcome.passed ? "process completed" : "process failed",
          artifactRefs: outcome.evidence.flatMap((e) => e.artifacts).filter(Boolean),
          usage: {},
        };
      },
    },
    integration: {
      async runIntegration(input: {
        repoId?: string;
        objective: string;
        handoffs: IntegrationHandoff[];
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        input.signal.throwIfAborted();
        const repo = await repository(input.repoId);
        if (!repo.git)
          return {
            executionId: "integration",
            exitStatus: "failed",
            summary: "no git provider",
            artifactRefs: [],
            usage: {},
          };
        // Integrator (spec 05): merge each worker worktree branch into the
        // current checkout sequentially, then run integration checks.
        // Recovered work (from a timed-out execution) merges its exact worker
        // commit, and a conflict on it is reported but does not fail the
        // integration: the branch stays preserved, and clean work is not held
        // hostage by a half-finished run.
        const merged: string[] = [];
        const recovered: string[] = [];
        const conflicts: string[] = [];
        const skippedRecovered: string[] = [];
        for (const h of input.handoffs) {
          input.signal.throwIfAborted();
          const r = await repo.git.mergeBranch(h.ref ?? h.worktree.branch).catch((e: Error) => ({
            merged: false,
            reason: e.message,
          }));
          input.signal.throwIfAborted();
          const reason = `${h.worktree.branch}: ${(r as { reason?: string }).reason ?? "conflict"}`;
          if (r.merged) (h.recovered ? recovered : merged).push(h.worktree.branch);
          else (h.recovered ? skippedRecovered : conflicts).push(reason);
        }
        const recoveredNote =
          (recovered.length ? `; recovered from timed-out execution(s): ${recovered.join(", ")}` : "") +
          (skippedRecovered.length
            ? `; recovered work NOT merged (kept on its branch): ${skippedRecovered.join("; ")}`
            : "");
        if (conflicts.length > 0) {
          return {
            executionId: "integration",
            exitStatus: "conflict",
            summary: `integration conflicts: ${conflicts.join("; ")}${recoveredNote}`,
            artifactRefs: [],
            usage: { mergedBranches: merged.length + recovered.length, conflicts: conflicts.length },
          };
        }
        input.signal.throwIfAborted();
        const checks = await opts.verifier.detect(repo.cwd);
        input.signal.throwIfAborted();
        const result = await opts.verifier.run(repo.cwd, checks, opts.artifacts, { signal: input.signal });
        return {
          executionId: "integration",
          exitStatus: result.passed ? "succeeded" : "failed",
          summary: `integrated ${merged.join(", ") || "nothing"}${recoveredNote}; checks: ${result.passed ? "pass" : "fail"}`,
          artifactRefs: result.evidence.flatMap((e) => e.artifacts).filter(Boolean),
          usage: { mergedBranches: merged.length + recovered.length, conflicts: conflicts.length },
        };
      },
    },
  };
}
