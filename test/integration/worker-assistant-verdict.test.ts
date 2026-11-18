/**
 * A gateway verdict delivered as an assistant message must end the worker run (#457).
 *
 * An OpenAI-compatible proxy that answers 200 and puts the refusal in the SSE body —
 * what it does for a model it does not serve — produces a terminal assistant message,
 * never a throw, so the transient layer never sees an error. Before #457 the run kept
 * re-issuing turns until the inactivity window fired: `error = "timeout"`, and the
 * `transient:model_unavailable` marker the mission's model takeover keys on (#76) never
 * appeared. Under a whole-family outage (#433) that was per worker, per attempt.
 *
 * Its own file on purpose: this scenario is order-sensitive inside the shared probe
 * harness of worker-stream-truncation.test.ts, where a preceding run changes how many
 * turns the agent takes. Each test file is a fresh process, so the assertion below
 * measures the executor and not its neighbours.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

/** The refusal a hosted gateway puts in a 200 SSE body for a model it does not serve. */
const MODEL_GONE = `data: ${JSON.stringify({
  error: {
    message: "404 model_not_found: probe-model is not served",
    type: "invalid_request_error",
    code: "model_not_found",
  },
})}\n\n`;

async function withRefusingGateway<T>(
  run: (executor: PiWorkerExecutor, cwd: string, requests: () => number) => Promise<T>,
  options: { endStream?: boolean; dirPrefix?: string } = {},
) {
  // A gateway that refuses and then hangs up, and one that refuses and never
  // closes the socket, are different failures for a worker: only the frame can
  // end the second one (#718).
  const endStream = options.endStream !== false;
  let requests = 0;
  const server = createServer((req, res: ServerResponse) => {
    req.resume(); // consume the body, as a real gateway does
    req.on("end", () => {
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(MODEL_GONE);
      if (endStream) res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), options.dirPrefix ?? "pi-assistant-verdict-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "probe-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    return await run(executor, dir, () => requests);
  } finally {
    // A wedged reply leaves the connection open; close() would wait for it.
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an assistant-message model_not_found ends the run with the takeover marker (#457)", async () => {
  // The window is set so the silence wrap-up (75% in) queues a turn while the refusal is
  // still in flight — the provider client retries a status-less stream error before
  // surfacing it, ~10s here — which is how a run ends up talking to a model that already
  // refused it. The assertion is that the verdict, not the window, ends the run: without
  // the fix this settles as `timeout` after further turns, as measured in #457.
  const started = Date.now();
  const { elapsed, error, details, requests } = await withRefusingGateway(async (executor, cwd, count) => {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "probe", id: "probe-model" },
      timeoutMs: 12_000,
    });
    return { elapsed: Date.now() - started, error: run.error, details: run.result.details, requests: count() };
  });

  assert.equal(error, "transient:model_unavailable");
  // The takeover marks the model that was refused, so it has to be named.
  assert.deepEqual(details.model, { provider: "probe", id: "probe-model" });
  assert.ok(elapsed < 60_000, `the verdict must end the run, not the 300s window (${elapsed}ms)`);
  assert.ok(requests <= 8, `the verdict must end the run, not keep re-issuing turns (${requests} requests)`);
});

/**
 * #718 — the acceptance test #457 left pinned as `todo`, with its assertion
 * corrected to what the fix actually promises. The pinned form demanded the run
 * classify as a *stall*; that was the expectation of the rejected remedy (clamping
 * the first-token window, measured 5.5x slower). The contract that matters is
 * time to failure and the provider's own reason: a refusal the gateway already
 * sent must end the run inside the run's own budget, with its wording, and
 * without further turns.
 *
 * Time is asserted, not only classification — that is what killed the clamp.
 */
test("a refusal that never yields a token ends the run inside its own budget (#718)", async () => {
  const started = Date.now();
  const { elapsed, error, summary, requests } = await withRefusingGateway(async (executor, cwd, count) => {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "probe", id: "probe-model" },
      timeoutMs: 5_000,
    });
    return { elapsed: Date.now() - started, error: run.error, summary: run.result.summary, requests: count() };
  });

  assert.notEqual(error, "timeout", `the clock ended the run, not the refusal: ${summary}`);
  assert.equal(error, "transient:model_unavailable", `summary: ${summary}`);
  assert.match(summary, /model_not_found/, "the provider's own wording must reach the operator");
  assert.ok(elapsed < 5_000, `the refusal must end the run, not the budget (${elapsed}ms)`);
  assert.ok(requests <= 3, `a refused run must not keep issuing turns (saw ${requests} requests)`);
});

/**
 * The hang #718 describes, in its truest shape: the frame arrives and the socket
 * is never closed, so no stream end, no finish_reason and no token ever follow.
 * Without a terminal verdict on the frame the run can only die on the clock.
 */
test("a refusal on a socket that never closes still ends the run (#718)", async () => {
  const started = Date.now();
  const { elapsed, error, summary, requests } = await withRefusingGateway(
    async (executor, cwd, count) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
        timeoutMs: 5_000,
      });
      return { elapsed: Date.now() - started, error: run.error, summary: run.result.summary, requests: count() };
    },
    { endStream: false },
  );

  assert.notEqual(error, "timeout", `the clock ended the run, not the refusal: ${summary}`);
  assert.equal(error, "transient:model_unavailable", `summary: ${summary}`);
  assert.ok(elapsed < 5_000, `an unclosed socket must not hold the run (${elapsed}ms)`);
  assert.ok(requests <= 3, `a refused run must not keep issuing turns (saw ${requests} requests)`);
});
