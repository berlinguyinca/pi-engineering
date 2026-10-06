/**
 * Waiting for inference capacity does not fail a mission worker.
 *
 * A real local OpenAI-compatible HTTP server answers with gateway queue
 * timeouts (429 inference_admission / queue_timeout) more times than the
 * worker's interactive hold budget allows, then serves the request. The REAL
 * PiWorkerExecutor must wait it out for a mission worker, while a standalone
 * (non-mission) run keeps its finite hold budget.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerActivity } from "../../src/workers/WorkerExecutor.ts";
import { WAITING_FOR_INFERENCE_SUMMARY } from "../../src/workers/activity.ts";

const QUEUE_TIMEOUTS = 6;

const WORKER_RESULT = {
  status: "completed",
  summary: "served after the queue",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

function queueTimeout(res: ServerResponse): void {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        type: "inference_admission",
        reason: "queue_timeout",
        retry_after_ms: 20,
        scope: "agent",
        message: "queue_timeout",
      },
    }),
  );
}

function workerResult(res: ServerResponse): void {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-queue",
      object: "chat.completion.chunk",
      created: 0,
      model: "queue-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_0",
          type: "function",
          function: { name: "worker_result", arguments: JSON.stringify(WORKER_RESULT) },
        },
      ],
    }),
  );
  res.write(frame({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

async function withQueueingGateway(body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>): Promise<number> {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      requests++;
      if (requests <= QUEUE_TIMEOUTS) queueTimeout(res);
      else workerResult(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-capacity-wait-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        queue: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "queue-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    // The interactive hold budget is two waits; the gateway queues six times.
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 2, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return requests;
}

test("a mission worker waits out gateway queueing past the hold budget and completes", async () => {
  const activity: WorkerActivity[] = [];
  const requests = await withQueueingGateway(async (executor, cwd) => {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "queue", id: "queue-model" },
      signal: new AbortController().signal,
      unboundedInferenceWait: true,
      onActivity: (event) => activity.push(event),
    });
    assert.equal(run.result.status, "completed", run.result.summary);
    assert.equal(run.result.summary, WORKER_RESULT.summary);
  });
  assert.equal(requests, QUEUE_TIMEOUTS + 1);
  assert.ok(
    activity.some((event) => event.summary === WAITING_FOR_INFERENCE_SUMMARY),
    "every hold is reported as liveness, so the owner never mistakes it for a hang",
  );
});

test("a standalone worker keeps its finite gateway hold budget", async () => {
  const requests = await withQueueingGateway(async (executor, cwd) => {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "queue", id: "queue-model" },
    });
    assert.equal(run.result.status, "failed");
  });
  assert.equal(requests, 3, "one attempt plus two honoured waits");
});
