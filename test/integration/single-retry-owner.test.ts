/**
 * One failure, one retry owner (missionless-fabric O2 / T4).
 *
 * A gateway 429 (`inference_admission`) used to be eligible for two retry
 * layers at once: the in-call resilient ladder (up to 4 attempts) AND the
 * worker's gateway hold (up to maxRetries holds, each re-entering the ladder).
 * Now the worker owns the wait, the ladder settles and records a `defer`, and
 * the total request count equals the owner's budget, not a product.
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
import { ResilientAttemptFlow } from "../../src/inference/resilientStream.ts";
import { actingLayers } from "../../src/inference/retryTrace.ts";
import type { RetryTrace } from "../../src/inference/retryTrace.ts";
import { InferenceTelemetry } from "../../src/inference/telemetry.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const ADMISSION_429 =
  '429: {"type":"inference_admission","reason":"queue_timeout","retry_after_ms":20,"scope":"agent","message":"queue_timeout"}';

function flowFor(owner: "worker-gateway-hold" | undefined, telemetry: InferenceTelemetry): ResilientAttemptFlow {
  return new ResilientAttemptFlow(
    {
      role: "worker",
      refOf: (m) => m as { provider: string; id: string },
      env: {},
      telemetry,
      context: () => (owner ? { gatewayWaitOwner: owner } : {}),
    },
    { provider: "p", id: "m" },
  );
}

const observed = (attempt: number) => ({
  attempt,
  text: ADMISSION_429,
  status: 429,
  headers: { "retry-after": "1" } as Record<string, string>,
  streamState: { finished: false, outputCommitted: false },
});

test("the resilient ladder replays an admission 429 only when nobody else owns the wait", async () => {
  const telemetry = new InferenceTelemetry();
  const control = await flowFor(undefined, telemetry).decide(observed(1));
  assert.equal(control?.retryable, true, "control: with no other owner the ladder replays (the multiplication source)");

  const owned = await flowFor("worker-gateway-hold", telemetry).decide(observed(1));
  assert.equal(owned?.retryable, false, "the worker owns this wait, so the ladder settles");
  const traces = telemetry.eventsNamed("inference.retry.trace").map((e) => e.data.trace as RetryTrace);
  assert.equal(traces.length, 1);
  assert.deepEqual(
    { layer: traces[0]?.layer, next: traces[0]?.next, owner: traces[0]?.owner },
    { layer: "resilient-stream", next: "defer", owner: "worker-gateway-hold" },
  );
  assert.deepEqual(actingLayers(traces), [], "a defer is not an action");
});

test("one injected 429 is retried by exactly one owner; attempts equal its budget, not a product", async () => {
  const MAX_HOLDS = 2;
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      requests++;
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
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-single-retry-owner-"));
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
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: MAX_HOLDS, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd: dir,
      modelOverride: { provider: "queue", id: "queue-model" },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(requests, 1 + MAX_HOLDS, "one attempt plus the owner's holds; no inner ladder replays");
    const trace = (run.result.details?.retry_trace ?? []) as RetryTrace[];
    assert.deepEqual(actingLayers(trace), ["worker-gateway-hold"], "exactly one layer acted");
    assert.ok(trace.every((entry) => entry.owner === "worker-gateway-hold"));
    assert.deepEqual(
      trace.map((entry) => `${entry.next}#${entry.attempt}`),
      ["hold#1", "hold#2", "give-up#3"],
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
