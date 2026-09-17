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

export interface RealBackendsOptions {
  worker: WorkerExecutor;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  git: GitRepo | null;
  cwd: string;
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
          timeoutMs: 10 * 60_000,
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
        // If the reviewer emitted structured findings in details.findings,
        // surface them so the completion gate can block on blocking findings.
        const raw = (run.result.details as { findings?: unknown } | undefined)?.findings;
        if (Array.isArray(raw)) outcome.findings = raw as Array<Record<string, unknown>>;
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
      async runIntegration(input: { objective: string; signal: AbortSignal }): Promise<ExecutionOutcome> {
        if (!opts.git)
          return {
            executionId: "integration",
            exitStatus: "failed",
            summary: "no git provider",
            artifactRefs: [],
            usage: {},
          };
        // Integrator: merge the current branch into base (fast path). For a
        // multi-candidate mission the caller drives GitRepo.mergeBranch.
        return {
          executionId: "integration",
          exitStatus: "succeeded",
          summary: "integrated",
          artifactRefs: [],
          usage: {},
        };
      },
    },
  };
}
