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

/** An OpenAI-shaped error delivered in a 200 SSE body: `{error:{message,type,code}}`. */
function errorFrame(message: string, code: string): string {
  return `data: ${JSON.stringify({ error: { message, type: code, code } })}\n\n`;
}

/** The refusal a hosted gateway puts in a 200 SSE body for a model it does not serve. */
const MODEL_GONE = errorFrame("404 model_not_found: probe-model is not served", "model_not_found");

async function withRefusingGateway<T>(
  run: (executor: PiWorkerExecutor, cwd: string, requests: () => number) => Promise<T>,
  options: { endStream?: boolean; dirPrefix?: string; frame?: string } = {},
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
      res.write(options.frame ?? MODEL_GONE);
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

/**
 * #725 — an in-band provider verdict that classifies into a known category must be
 * reported as the `transient:<category>` marker the thrown path would have produced,
 * not the provider's raw sentence. `run.error` stays a closed set of markers so the
 * ledger, #76's model takeover and rate-limit backpressure can key on it; the wording
 * stays in the summary where an operator reads it.
 *
 * The frame's `code`/`type` is dropped by the provider client for an in-band (200)
 * verdict (formatProviderError returns only the message when there is no HTTP status),
 * so the classifiable signal must be in the message, exactly as the model_not_found
 * frame above carries it. The leak this fixes is the status-less TERMINAL verdict: an
 * auth or quota refusal that advertises no wait and carries no status reaches the prose
 * fallback today. A status- or rate-worded verdict is caught earlier by the gateway /
 * stream branches and already carries a marker (asserted separately below), so the new
 * rule sits after them (#725 trap 3) and only replaces the prose fallback.
 */
const INBAND_VERDICTS: Array<{ code: string; message: string; marker: string; wording: RegExp }> = [
  {
    code: "authentication_error",
    message: "invalid api key",
    marker: "transient:permanent",
    wording: /invalid api key/,
  },
  {
    code: "insufficient_quota",
    message: "insufficient_quota: you exceeded your current quota; check your billing",
    marker: "transient:permanent",
    wording: /quota/,
  },
];

for (const verdict of INBAND_VERDICTS) {
  test(`an in-band ${verdict.code} verdict is reported as ${verdict.marker}, not prose (#725)`, async () => {
    const started = Date.now();
    const { elapsed, error, summary, details, requests } = await withRefusingGateway(
      async (executor, cwd, count) => {
        const run = await executor.run({
          role: "implementer",
          task: "t",
          tools: [],
          cwd,
          modelOverride: { provider: "probe", id: "probe-model" },
          timeoutMs: 5_000,
        });
        return {
          elapsed: Date.now() - started,
          error: run.error,
          summary: run.result.summary,
          details: run.result.details,
          requests: count(),
        };
      },
      { frame: errorFrame(verdict.message, verdict.code) },
    );

    assert.equal(error, verdict.marker, `summary: ${summary}`);
    assert.notEqual(error, verdict.message, "the provider's raw prose must not be the marker");
    assert.match(summary, verdict.wording, "the provider's own wording must still reach the operator");
    // The marker names a category and the model it classified, like the thrown path.
    assert.equal(
      (details as { transient_category?: string }).transient_category,
      verdict.marker.slice("transient:".length),
    );
    assert.deepEqual((details as { model?: unknown }).model, { provider: "probe", id: "probe-model" });
    assert.ok(elapsed < 5_000, `the verdict must end the run, not the budget (${elapsed}ms)`);
    assert.ok(requests <= 3, `a refused run must not keep issuing turns (saw ${requests} requests)`);
  });
}

/**
 * #725 trap 1 — `classifyError`'s fallback is `permanent`, so a blind mapping would turn
 * arbitrary unclassifiable prose into `transient:permanent` and move the wording out of
 * `run.error`, a worse diagnosis than today. Because the frame's `code` is dropped, the
 * `server_error` and `rate_limit_exceeded` frames the issue measured — whose messages
 * were "backend boom" and "slow down" — carry no classifiable signal in the message and
 * must keep their prose, exactly like any text no classifier can place.
 */
for (const [code, message] of [
  ["server_error", "backend boom"],
  ["rate_limit_exceeded", "slow down"],
  ["unknown", "something nobody can classify"],
] as const) {
  test(`an in-band ${code} verdict no classifier can place keeps its prose (#725 trap 1)`, async () => {
    const { error, summary } = await withRefusingGateway(
      async (executor, cwd, count) => {
        const run = await executor.run({
          role: "implementer",
          task: "t",
          tools: [],
          cwd,
          modelOverride: { provider: "probe", id: "probe-model" },
          timeoutMs: 5_000,
        });
        return { error: run.error, summary: run.result.summary, requests: count() };
      },
      { frame: errorFrame(message, code) },
    );

    assert.equal(error, message, `unclassifiable prose must stay prose, not become a marker (${summary})`);
  });
}

/**
 * #725 trap 3 — a status- or rate-worded in-band verdict is caught by the gateway /
 * stream branches before the new rule, so it already carries a marker and never leaked
 * prose. This guards that the new rule did not move in front of those branches.
 */
test("a status-worded in-band verdict keeps its gateway marker, not the new rule (#725 trap 3)", async () => {
  const { error, summary } = await withRefusingGateway(
    async (executor, cwd, count) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
        timeoutMs: 5_000,
      });
      return { error: run.error, summary: run.result.summary, requests: count() };
    },
    { frame: errorFrame("503 service unavailable", "server_error") },
  );

  assert.notEqual(error, "503 service unavailable", `a status-worded verdict must carry a marker (${summary})`);
  assert.match(error ?? "", /^(gateway:|transient:)/, `expected a gateway/transient marker, got ${error}`);
});
