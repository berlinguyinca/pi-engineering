/**
 * One transient fault (5xx, connection reset), one retry owner. The worker's
 * transient retry owns same-model replays; the in-call resilient ladder settles
 * and records a `defer`, so the request count equals the owner's budget
 * (maxAttempts + 1), not that budget times the ladder's 4 attempts.
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
import type { RetryTrace } from "../../src/inference/retryTrace.ts";
import { InferenceTelemetry } from "../../src/inference/telemetry.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const OWNER_ATTEMPTS = 3; // transientConfig.maxAttempts = 2 retries + the first request

async function runAgainst(
  fault: (req: IncomingMessage, res: ServerResponse) => void,
  gateway: boolean,
): Promise<{ requests: number; status: string }> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      fault(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-single-retry-owner-transient-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        flaky: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "flaky-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: gateway, maxRetries: 1, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientConfig: { baseMs: 1, maxMs: 1, factor: 1, jitter: 0, maxAttempts: OWNER_ATTEMPTS - 1 },
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd: dir,
      modelOverride: { provider: "flaky", id: "flaky-model" },
    });
    return { requests, status: run.result.status };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const serverError = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(503, { "content-type": "text/plain" });
  res.end("upstream overloaded");
};
const reset = (req: IncomingMessage): void => {
  req.socket.destroy();
};

for (const gateway of [true, false]) {
  const label = gateway ? "gateway holds on" : "gateway holds off";
  // Over real HTTP the worker reads a 5xx text as a gateway refusal, so its gateway
  // hold (maxRetries = 1) is the owner: 1 + 1 requests, or 1 when holds are off.
  test(`one injected 503 costs the owner's budget (${label})`, async () => {
    const { requests, status } = await runAgainst(serverError, gateway);
    assert.equal(status, "failed");
    assert.equal(requests, gateway ? 2 : 1);
  });
  test(`one injected connection reset costs the worker's transient budget (${label})`, async () => {
    const { requests, status } = await runAgainst(reset, gateway);
    assert.equal(status, "failed");
    assert.equal(requests, OWNER_ATTEMPTS);
  });
}

function flowFor(owner: boolean, telemetry: InferenceTelemetry): ResilientAttemptFlow {
  return new ResilientAttemptFlow(
    {
      role: "worker",
      refOf: (m) => m as { provider: string; id: string },
      env: {},
      telemetry,
      context: () => (owner ? { transientRetryOwner: "worker-transient-retry" as const } : {}),
    },
    { provider: "p", id: "m" },
  );
}
const fault = (text: string, status?: number) => ({
  attempt: 1,
  text,
  ...(status ? { status } : {}),
  streamState: { finished: false, outputCommitted: false },
});

test("the ladder replays a 5xx / network fault only when no worker owns the retry", async () => {
  for (const [text, status] of [
    ["503 service unavailable", 503],
    ["fetch failed: ECONNRESET", undefined],
  ] as const) {
    const telemetry = new InferenceTelemetry();
    const control = await flowFor(false, telemetry).decide(fault(text, status));
    assert.equal(control?.retryable, true, `control: ${text} is replayed by the ladder when nobody else owns it`);

    const owned = await flowFor(true, telemetry).decide(fault(text, status));
    assert.equal(owned?.retryable, false, `${text}: the worker owns it, so the ladder settles`);
    const traces = telemetry.eventsNamed("inference.retry.trace").map((e) => e.data.trace as RetryTrace);
    assert.equal(traces.length, 1);
    assert.deepEqual(
      { layer: traces[0]?.layer, next: traces[0]?.next, owner: traces[0]?.owner },
      { layer: "resilient-stream", next: "defer", owner: "worker-transient-retry" },
    );
  }
});

test("a fault the worker would NOT retry keeps the ladder's own retry (still exactly one retrier)", async () => {
  const telemetry = new InferenceTelemetry();
  const owned = await flowFor(true, telemetry).decide(fault("500 internal server error", 500));
  assert.equal(owned?.retryable, true, "the worker classifies a bare 500 as permanent, so it is not the owner");
  assert.equal(telemetry.eventsNamed("inference.retry.trace").length, 0);
});

test("a permanent fault is untouched by the hand-off", async () => {
  const telemetry = new InferenceTelemetry();
  const owned = await flowFor(true, telemetry).decide(fault("401 unauthorized", 401));
  assert.equal(owned?.retryable, false);
  assert.equal(telemetry.eventsNamed("inference.retry.trace").length, 0, "settled by the ladder itself, not deferred");
});
