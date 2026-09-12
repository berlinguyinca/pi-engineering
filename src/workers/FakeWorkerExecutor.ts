import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";

export interface FakeWorkerHandler {
  (req: WorkerRequest): Promise<Partial<WorkerResult>> | Partial<WorkerResult>;
}

/**
 * Deterministic worker executor for tests and for exercising orchestration
 * without a model endpoint. Role handlers are injected by the test.
 *
 * This lets the integration/E2E suite prove the full vertical slice — scout,
 * implement (with real edits), verify, review, fix — without network/model
 * dependence, while the real `PiWorkerExecutor` provides the production path.
 */
export class FakeWorkerExecutor implements WorkerExecutor {
  private readonly handlers: Partial<Record<WorkerRole, FakeWorkerHandler>>;
  private readonly defaultHandler?: FakeWorkerHandler;

  constructor(handlers: Partial<Record<WorkerRole, FakeWorkerHandler>>, defaultHandler?: FakeWorkerHandler) {
    this.handlers = handlers;
    this.defaultHandler = defaultHandler;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const handler = this.handlers[req.role] ?? this.defaultHandler;
    const usage: WorkerUsage = {
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 1500,
      turns: 1,
      model: "fake",
    };
    if (!handler) {
      return {
        result: {
          status: "failed",
          summary: `No fake handler registered for role '${req.role}'.`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
          error: "unhandled-role",
        },
        usage,
        error: "unhandled-role",
        toolCalls: 0,
      };
    }
    const partial = await handler(req);
    const result: WorkerResult = {
      status: "completed",
      summary: "",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
      ...partial,
    };
    return { result, usage, toolCalls: 0 };
  }
}
