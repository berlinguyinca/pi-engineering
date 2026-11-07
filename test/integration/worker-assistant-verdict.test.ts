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
) {
  let requests = 0;
  const server = createServer((req, res: ServerResponse) => {
    req.resume(); // consume the body, as a real gateway does
    req.on("end", () => {
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(MODEL_GONE);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-assistant-verdict-"));
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
