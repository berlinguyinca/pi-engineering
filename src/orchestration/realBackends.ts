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
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";
import type { ExecutionOutcome } from "./broker.ts";

/**
 * Fresh-context worker wall-clock budget in ms. The default (30 min) gives an
 * implementation worker enough time to explore the repo, implement, run
 * verification, and commit within a single bounded run — the historical 10-min
 * default repeatedly killed workers at the boundary before they could commit
 * real implementation work. Overridable via PI_ENGINEERING_WORKER_TIMEOUT_MS.
 */
export function workerTimeoutMs(): number {
  const env = Number.parseInt(process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return 30 * 60_000;
}

export interface RealBackendsOptions {
  worker: WorkerExecutor;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  git: GitRepo | null;
  cwd: string;
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
  return {
    executionId: "worker",
    exitStatus: result.result.status === "completed" ? "succeeded" : "failed",
    summary: result.result.summary,
    artifactRefs: result.result.evidence_refs ?? [],
    usage: {
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      model: result.usage?.model ?? "unknown",
    },
  };
}

export function realBackends(opts: RealBackendsOptions) {
  return {
    agent: {
      async runAgent(input: {
        role: string;
        objective: string;
        contextRef?: string;
        worktree?: string | null;
        modelRequirements?: Record<string, unknown>;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        const req: WorkerRequest = {
          role: (input.role as WorkerRequest["role"]) ?? "implementer",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "ledger_claim", "artifact_read", "repo_search", "symbol", "tests_for", "bash"],
          cwd: input.worktree ?? opts.cwd,
          // Fresh-context implementation workers need headroom to explore the
          // repo, implement, run verification, and commit. Configurable so an
          // operator can tune per environment without recompiling.
          timeoutMs: workerTimeoutMs(),
        };
        const run = await opts.worker.run(req);
        return outcomeOf(run);
      },
    },
    research: {
      async runAgent(input: {
        role?: string;
        objective: string;
        contextRef?: string;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        return opts.worker
          .run({
            role: "scout",
            task: input.objective,
            context: input.contextRef,
            tools: ["ledger_read", "repo_search", "symbol", "tests_for"],
            cwd: opts.cwd,
          })
          .then(outcomeOf);
      },
    },
    validation: {
      async runValidation(input: {
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        const cwd = input.worktree ?? opts.cwd;
        const profile = await opts.verifier.detect(cwd);
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts);
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
        objective: string;
        contextRef?: string;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        const run = await opts.worker.run({
          role: "reviewer",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "artifact_read", "repo_search", "symbol"],
          cwd: opts.cwd,
        });
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
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        // Deterministic process execution falls back to verification-style
        // commands; a generic subprocess runner can be attached here later.
        const cwd = input.worktree ?? opts.cwd;
        const profile = await opts.verifier.detect(cwd);
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts);
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
        objective: string;
        handoffs: Array<{ worktree: { path: string; branch: string }; summary: string; artifacts: string[] }>;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        if (!opts.git)
          return {
            executionId: "integration",
            exitStatus: "failed",
            summary: "no git provider",
            artifactRefs: [],
            usage: {},
          };
        // Integrator (spec 05): merge each worker worktree branch into the
        // current checkout sequentially, then run integration checks.
        const merged: string[] = [];
        const conflicts: string[] = [];
        for (const h of input.handoffs) {
          const r = await opts.git.mergeBranch(h.worktree.branch).catch((e: Error) => ({
            merged: false,
            reason: e.message,
          }));
          if (r.merged) merged.push(h.worktree.branch);
          else conflicts.push(`${h.worktree.branch}: ${(r as { reason?: string }).reason ?? "conflict"}`);
        }
        if (conflicts.length > 0) {
          return {
            executionId: "integration",
            exitStatus: "conflict",
            summary: `integration conflicts: ${conflicts.join("; ")}`,
            artifactRefs: [],
            usage: { mergedBranches: merged.length, conflicts: conflicts.length },
          };
        }
        const checks = await opts.verifier.detect(opts.cwd);
        const result = await opts.verifier.run(opts.cwd, checks, opts.artifacts);
        return {
          executionId: "integration",
          exitStatus: result.passed ? "succeeded" : "failed",
          summary: `integrated ${merged.join(", ") || "nothing"}; checks: ${result.passed ? "pass" : "fail"}`,
          artifactRefs: result.evidence.flatMap((e) => e.artifacts).filter(Boolean),
          usage: { mergedBranches: merged.length, conflicts: conflicts.length },
        };
      },
    },
  };
}
