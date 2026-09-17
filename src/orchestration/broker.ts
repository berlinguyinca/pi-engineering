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

import { id } from "../core/ids.ts";
import type { MissionStore } from "./missionStore.ts";
import type { ExecutionBackend } from "./types.ts";

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

export interface IntegrationRunner {
  runIntegration(input: { objective: string; signal: AbortSignal }): Promise<ExecutionOutcome>;
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

export interface BrokerOptions {
  store: MissionStore;
  backends: BrokerBackends;
  /** Default timeout per execution. */
  defaultTimeoutMs?: number;
}

export class ExecutionBroker {
  private readonly store: MissionStore;
  private readonly backends: BrokerBackends;
  private readonly defaultTimeoutMs: number;
  /** In-flight execution state for cancellation. */
  private readonly active = new Map<string, { abort: AbortController; status: string }>();

  constructor(opts: BrokerOptions) {
    this.store = opts.store;
    this.backends = opts.backends;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
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
        this.active.get(execution.execution_id)?.abort.abort();
        this.store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
        this.active.delete(execution.execution_id);
      },
      steer: async (request) => {
        this.store.steerTask(input.taskId, request);
        const runner = this.backends[backend as keyof BrokerBackends] as { onSteer?: (s: string) => void } | undefined;
        runner?.onSteer?.(request);
      },
      result: async () => {
        const timeoutMs = input.timeoutPolicy?.timeoutMs ?? this.defaultTimeoutMs;
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        try {
          const outcome = await this.dispatch(input, backend, execution.execution_id, abort.signal);
          this.store.setExecutionStatus(execution.execution_id, "SUCCEEDED", {
            exit_status: outcome.exitStatus,
            artifact_refs: outcome.artifactRefs,
            usage: outcome.usage,
          });
          this.active.delete(execution.execution_id);
          return outcome;
        } catch (err) {
          if (abort.signal.aborted) {
            this.store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
          } else {
            this.store.setExecutionStatus(execution.execution_id, "FAILED", {
              exit_status: err instanceof Error ? err.message : String(err),
            });
          }
          this.active.delete(execution.execution_id);
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    };

    this.active.set(execution.execution_id, { abort, status: "PENDING" });
    this.store.setExecutionStatus(execution.execution_id, "RUNNING", {});
    this.active.get(execution.execution_id)!.status = "RUNNING";
    return handle;
  }

  private dispatch(
    input: ExecutionRequestInput,
    backend: ExecutionBackend,
    executionId: string,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const base = {
      objective: input.objective,
      contextRef: input.contextRef,
      worktree: null as string | null,
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
        return runner.runIntegration({ objective: input.objective, signal });
      }
      case "validation": {
        const runner = this.backends.validation;
        if (!runner) throw new Error("no validation backend registered");
        return runner.runValidation({ objective: input.objective, worktree: base.worktree, signal });
      }
    }
  }
}

/** Build a logical task id from a request (for deterministic tests). */
export function logicalExecutionId(): string {
  return id("EXC");
}
