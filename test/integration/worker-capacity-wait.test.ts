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

/** A gateway that accepts every request and never answers (a hung model server). */
async function withSilentGateway(
  admission: AdmissionController,
  body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req: IncomingMessage) => {
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-silent-gateway-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        silent: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "silent-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 2, jitterMs: 0 }),
    admission,
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("another worker queued for capacity does not hide this worker hanging", async () => {
  const admission = new AdmissionController({ maxConcurrency: 4, jitterMs: 0 });
  // Some other caller in the process is parked behind the gateway for a minute.
  const other = new AbortController();
  const parked = admission.noteCallerWaitAndSleep(
    { retryAfterMs: 60_000, source: "body", retryable: true, reason: "queue_timeout" },
    { signal: other.signal },
  );
  try {
    await withSilentGateway(admission, async (executor, cwd) => {
      assert.ok(admission.status().waiting > 0, "the process has a caller waiting for inference");
      const started = Date.now();
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "silent", id: "silent-model" },
        timeoutMs: 600,
      });
      const took = Date.now() - started;
      assert.equal(run.result.status, "failed");
      assert.ok(took >= 550, `not before the window (${took}ms)`);
      assert.ok(took < 30_000, `the hung worker is caught although another caller waits (${took}ms)`);
    });
  } finally {
    other.abort();
    await parked;
  }
});

test("a worker queued for an admission slot reports that it is waiting for inference capacity", async () => {
  const admission = new AdmissionController({ maxConcurrency: 1, jitterMs: 0 });
  const held = await admission.acquire();
  const activity: WorkerActivity[] = [];
  const owner = new AbortController();
  await withSilentGateway(admission, async (executor, cwd) => {
    const pending = executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "silent", id: "silent-model" },
      signal: owner.signal,
      unboundedInferenceWait: true,
      onActivity: (event) => activity.push(event),
    });
    for (let i = 0; i < 50 && activity.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(activity[0]?.summary, WAITING_FOR_INFERENCE_SUMMARY, "the slot wait is liveness for the owner");
    held.release();
    for (let i = 0; i < 100 && activity.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      activity.slice(1).some((event) => event.summary !== WAITING_FOR_INFERENCE_SUMMARY),
      "once admitted, the worker's own activity ends the wait",
    );
    owner.abort();
    await pending;
  });
});

test("two workers racing for the last slot: the one left queued reports that it is waiting", async () => {
  const admission = new AdmissionController({ maxConcurrency: 1, jitterMs: 0 });
  await withSilentGateway(admission, async (executor, cwd) => {
    const owners = [new AbortController(), new AbortController()];
    const activity: WorkerActivity[][] = [[], []];
    // Both start in the same tick, so both see a free slot before either takes it.
    const runs = owners.map((owner, i) =>
      executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "silent", id: "silent-model" },
        signal: owner.signal,
        unboundedInferenceWait: true,
        onActivity: (event) => activity[i]?.push(event),
      }),
    );
    const started = (i: number) => activity[i]?.some((e) => e.summary === "Worker session started") ?? false;
    for (let i = 0; i < 200 && !(started(0) || started(1)); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    const queued = started(0) ? 1 : 0;
    assert.equal(started(queued), false, "only one worker holds the slot");
    assert.ok(
      activity[queued]?.some((e) => e.summary === WAITING_FOR_INFERENCE_SUMMARY),
      `the queued worker reports its wait: ${JSON.stringify(activity[queued])}`,
    );
    for (const owner of owners) owner.abort();
    // Both settle: the one canceled while queued never starts its session.
    const settled = await Promise.all(runs);
    for (const run of settled) assert.equal(run.result.status, "failed");
  });
});
