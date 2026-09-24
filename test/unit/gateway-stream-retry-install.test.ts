/**
 * Binding the retry pump to a live Pi session.
 *
 * The pump itself is pure and tested in `gateway-stream-retry.test.ts`. What
 * this file pins is the wiring, where the two ways to get it wrong are both
 * silent:
 *
 *   * capturing the composed provider AFTER registering makes the wrapper call
 *     itself — an infinite loop that no type checks;
 *   * `registerProvider` REPLACES a provider's extension config, so an operator
 *     who had registered a proxy base URL or custom models would lose it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ProviderHost,
  captureGatewayAttemptResponse,
  installGatewayStreamRetry,
  isGatewayStreamRetryInstalled,
  resetGatewayStreamRetry,
} from "../../src/gateway/installStreamRetry.ts";
import type { RetryableEvent, RetryableResult } from "../../src/gateway/streamRetry.ts";

type Ev = RetryableEvent & { text?: string; error?: RetryableResult; message?: RetryableResult };

const SATURATED = "503 no worker for model";

/** A stand-in for `createAssistantMessageEventStream`. */
function fakeStream() {
  const pushed: Ev[] = [];
  let settle: (r: RetryableResult) => void = () => {};
  const settled = new Promise<RetryableResult>((r) => {
    settle = r;
  });
  return {
    pushed,
    settled,
    push: (e: Ev) => pushed.push(e),
    end: (r?: RetryableResult) => settle(r ?? {}),
    async *[Symbol.asyncIterator]() {
      for (const e of pushed) yield e;
    },
    result: () => settled,
  };
}

/** A scripted provider attempt. */
function attempt(events: Ev[]) {
  const terminal = events.find((e) => e.type === "done" || e.type === "error");
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    result: async (): Promise<RetryableResult> => terminal?.message ?? terminal?.error ?? {},
  };
}

interface HostState {
  host: ProviderHost<unknown, unknown, unknown>;
  registered: Array<{ id: string; config: Record<string, unknown> }>;
  baseCalls: number;
}

/**
 * A host that behaves like pi's registry: `getProvider` returns the composed
 * provider, and after `registerProvider` that composition INCLUDES the
 * extension's own handler — the recursion trap.
 */
function makeHost(script: Ev[][], opts: { throwOnRegister?: boolean } = {}): HostState {
  const registered: Array<{ id: string; config: Record<string, unknown> }> = [];
  let baseCalls = 0;
  const configs = new Map<string, Record<string, unknown>>();

  const realBase = {
    streamSimple: () => attempt(script[Math.min(baseCalls++, script.length - 1)] ?? []),
  };

  const state: HostState = {
    registered,
    get baseCalls() {
      return baseCalls;
    },
    host: {
      getProvider: (id: string) => {
        const matches = registered.filter((r) => r.id === id);
        const latest = matches[matches.length - 1];
        if (latest?.config.streamSimple) {
          return { streamSimple: latest.config.streamSimple as never };
        }
        return realBase;
      },
      getRegisteredProviderConfig: (id: string) => configs.get(id),
      registerProvider: (id: string, config: Record<string, unknown>) => {
        if (opts.throwOnRegister) throw new Error('Provider x: "api" is required when registering streamSimple.');
        registered.push({ id, config });
        configs.set(id, config);
      },
    },
  };
  return state;
}

function deps(stream: ReturnType<typeof fakeStream>, extra: Record<string, unknown> = {}) {
  return {
    createStream: () => stream,
    hold: async () => {},
    errorMessage: (_m: unknown, error: unknown) => ({
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    }),
    ...extra,
  };
}

test("install: threads finite attempt and elapsed budgets into the interactive pump", async () => {
  resetGatewayStreamRetry();
  const fail = { type: "error", error: { stopReason: "error", errorMessage: SATURATED } } as Ev;
  const h = makeHost(Array.from({ length: 10 }, () => [fail]));
  const stream = fakeStream();
  installGatewayStreamRetry(
    h.host,
    { provider: "acme", api: "a" },
    deps(stream, { maxAttempts: 2, maxElapsedMs: 60_000, now: () => 0 }),
  );
  const handler = h.registered[0]?.config.streamSimple as (m: unknown, c: unknown) => unknown;
  handler({}, {});
  const settled = await stream.settled;
  assert.equal(h.baseCalls, 2);
  assert.equal(settled.stopReason, "error");
  assert.equal(settled.errorMessage, SATURATED);
});

test("install: registers the api and a streamSimple handler", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done", message: { stopReason: "stop" } }]]);
  const result = installGatewayStreamRetry(h.host, { provider: "acme", api: "anthropic-messages" }, deps(fakeStream()));

  assert.equal(result, "installed");
  assert.equal(h.registered.length, 1);
  assert.equal(h.registered[0]?.config.api, "anthropic-messages", "compose only dispatches when the api matches");
  assert.equal(typeof h.registered[0]?.config.streamSimple, "function");
  assert.equal(isGatewayStreamRetryInstalled("acme", "anthropic-messages"), true);
});

test("install: an operator's existing provider config survives", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]]);
  h.host.registerProvider("acme", { baseUrl: "https://proxy.internal", apiKey: "$KEY" });
  installGatewayStreamRetry(h.host, { provider: "acme", api: "openai-completions" }, deps(fakeStream()));

  const final = h.registered.at(-1)?.config;
  assert.equal(
    final?.baseUrl,
    "https://proxy.internal",
    "registering replaces the config — it must be carried forward",
  );
  assert.equal(final?.apiKey, "$KEY");
  assert.equal(typeof final?.streamSimple, "function");
});

test("install: is idempotent per provider+api, which is what prevents self-recursion", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]]);
  const first = installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(fakeStream()));
  const second = installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(fakeStream()));

  assert.equal(first, "installed");
  assert.equal(second, "already-installed");
  assert.equal(h.registered.length, 1, "a second capture would wrap our own wrapper");
});

test("install: a different api on the same provider is wrapped separately", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]]);
  installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(fakeStream()));
  const second = installGatewayStreamRetry(h.host, { provider: "acme", api: "b" }, deps(fakeStream()));

  assert.equal(second, "installed", "compose dispatches per api, so each api needs its own wrapper");
  assert.equal(h.registered.length, 2);
});

test("install: response metadata is attempt-local, error-only, and consumed once", async () => {
  const first = captureGatewayAttemptResponse({
    onResponse: async (_response: { status: number; headers?: Record<string, string> }, _model: unknown) => {},
  });
  const second = captureGatewayAttemptResponse({
    onResponse: async (_response: { status: number; headers?: Record<string, string> }, _model: unknown) => {},
  });

  await first.options.onResponse?.({ status: 503, headers: { "retry-after": "8" } }, {});
  await second.options.onResponse?.({ status: 429, headers: { "retry-after": "3" } }, {});
  assert.deepEqual(second.take(), { status: 429, headers: { "retry-after": "3" } });
  assert.deepEqual(first.take(), { status: 503, headers: { "retry-after": "8" } });
  assert.equal(first.take(), undefined, "metadata belongs to one parse decision only");

  const success = captureGatewayAttemptResponse({
    onResponse: async (_response: { status: number; headers?: Record<string, string> }, _model: unknown) => {},
  });
  await success.options.onResponse?.({ status: 200, headers: { "retry-after": "99" } }, {});
  assert.equal(success.take(), undefined, "a successful response cannot poison a later failure");
});

test("install: hold receives the actual model for each call on one provider api", async () => {
  resetGatewayStreamRetry();
  const fail = { type: "error", error: { stopReason: "error", errorMessage: SATURATED } } as Ev;
  const ok = { type: "done", message: { stopReason: "stop" } } as Ev;
  const h = makeHost([[fail], [ok], [fail], [ok]]);
  const streams: Array<ReturnType<typeof fakeStream>> = [];
  const heldModels: string[] = [];
  installGatewayStreamRetry(
    h.host,
    { provider: "acme", api: "a" },
    {
      createStream: () => {
        const stream = fakeStream();
        streams.push(stream);
        return stream;
      },
      hold: async (_signal, _attempt, _abort, model: { id: string }) => {
        heldModels.push(model.id);
      },
      errorMessage: (_m: unknown, error: unknown) => ({ stopReason: "error", errorMessage: String(error) }),
    },
  );
  const handler = h.registered[0]?.config.streamSimple as (model: { id: string }, context: unknown) => unknown;

  handler({ id: "model-a" }, {});
  await streams[0]!.settled;
  handler({ id: "model-b" }, {});
  await streams[1]!.settled;

  assert.deepEqual(heldModels, ["model-a", "model-b"]);
});

test("install: each same-provider model call uses its own response headers", async () => {
  resetGatewayStreamRetry();
  type TestModel = { id: string };
  type TestOptions = {
    onResponse?: (
      response: { status: number; headers?: Record<string, string> },
      model: TestModel,
    ) => void | Promise<void>;
  };
  const calls = new Map<string, number>();
  const base = {
    streamSimple(model: TestModel, _context: unknown, options?: TestOptions) {
      const call = calls.get(model.id) ?? 0;
      calls.set(model.id, call + 1);
      const retryAfter = model.id === "model-a" ? "7" : "9";
      return {
        async *[Symbol.asyncIterator]() {
          await options?.onResponse?.(
            { status: call === 0 ? 503 : 200, headers: { "retry-after": retryAfter } },
            model,
          );
          yield call === 0
            ? ({ type: "error", error: { stopReason: "error", errorMessage: SATURATED } } as Ev)
            : ({ type: "done", message: { stopReason: "stop" } } as Ev);
        },
        result: async () => (call === 0 ? { stopReason: "error", errorMessage: SATURATED } : { stopReason: "stop" }),
      };
    },
  };
  const registered: Array<Record<string, unknown>> = [];
  const host: ProviderHost<TestModel, unknown, TestOptions> = {
    getProvider: () => base,
    registerProvider: (_id, config) => registered.push(config ?? {}),
  };
  const streams: Array<ReturnType<typeof fakeStream>> = [];
  const holdsSeen: Array<{ model: string; ms: number }> = [];
  installGatewayStreamRetry(
    host,
    { provider: "acme", api: "a" },
    {
      createStream: () => {
        const stream = fakeStream();
        streams.push(stream);
        return stream;
      },
      hold: async (signal, _attempt, _abort, model) => {
        holdsSeen.push({ model: model.id, ms: signal.retryAfterMs });
      },
      errorMessage: (_model, error) => ({ stopReason: "error", errorMessage: String(error) }),
    },
  );
  const handler = registered[0]?.streamSimple as (model: TestModel, context: unknown) => unknown;

  handler({ id: "model-a" }, {});
  handler({ id: "model-b" }, {});
  await Promise.all(streams.map((stream) => stream.settled));

  assert.deepEqual(holdsSeen, [
    { model: "model-a", ms: 7_000 },
    { model: "model-b", ms: 9_000 },
  ]);
});

test("install: reports an unknown provider instead of registering a broken wrapper", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]]);
  h.host.getProvider = () => undefined;
  assert.equal(installGatewayStreamRetry(h.host, { provider: "ghost", api: "a" }, deps(fakeStream())), "no-provider");
});

test("install: reports a provider with nothing to delegate to", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]]);
  h.host.getProvider = () => ({});
  assert.equal(installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(fakeStream())), "no-base-stream");
});

test("install: a rejected config leaves the session usable and uninstalled", () => {
  resetGatewayStreamRetry();
  const h = makeHost([[{ type: "done" }]], { throwOnRegister: true });
  assert.equal(installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(fakeStream())), "failed");
  assert.equal(isGatewayStreamRetryInstalled("acme", "a"), false, "a failed install must be retryable");
});

test("install: the wrapper delegates to the pre-registration base and waits out a 503", async () => {
  resetGatewayStreamRetry();
  const h = makeHost([
    [{ type: "error", error: { stopReason: "error", errorMessage: SATURATED } }],
    [
      { type: "text_delta", text: "recovered" },
      { type: "done", message: { stopReason: "stop" } },
    ],
  ]);
  const stream = fakeStream();
  installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(stream));

  const handler = h.registered[0]?.config.streamSimple as (m: unknown, c: unknown) => unknown;
  handler({}, {});
  const settled = await stream.settled;

  assert.equal(h.baseCalls, 2, "the real transport is reached twice — no recursion, and the 503 was retried");
  assert.equal(settled.stopReason, "stop");
  assert.equal(
    stream.pushed.some((e) => e.type === "error"),
    false,
    "the operator never sees the 503",
  );
});

test("install: a thrown transport failure becomes a terminal error, not an unhandled rejection", async () => {
  resetGatewayStreamRetry();
  const h = makeHost([[]]);
  h.host.getProvider = () => ({
    streamSimple: () => {
      throw new Error("TypeError: undefined is not a function");
    },
  });
  const stream = fakeStream();
  installGatewayStreamRetry(h.host, { provider: "acme", api: "a" }, deps(stream));

  const handler = h.registered[0]?.config.streamSimple as (m: unknown, c: unknown) => unknown;
  handler({}, {});
  const settled = await stream.settled;

  assert.match(settled.errorMessage ?? "", /undefined is not a function/);
  assert.equal(stream.pushed.at(-1)?.type, "error", "pi expects a terminal event, never a rejected promise");
});

test("install: escalation climbs within a call and resets once one succeeds", async () => {
  resetGatewayStreamRetry();
  const waits: number[] = [];
  const streams: Array<ReturnType<typeof fakeStream>> = [];
  const fail = { type: "error", error: { stopReason: "error", errorMessage: SATURATED } } as Ev;
  const ok = { type: "done", message: { stopReason: "stop" } } as Ev;
  // Call 1 rides out two 503s; call 2 hits one more.
  const h = makeHost([[fail], [fail], [ok], [fail], [ok]]);

  installGatewayStreamRetry(
    h.host,
    { provider: "acme", api: "a" },
    {
      createStream: () => {
        const s = fakeStream();
        streams.push(s);
        return s;
      },
      hold: async (sig: { retryAfterMs: number }) => {
        waits.push(sig.retryAfterMs);
      },
      errorMessage: (_m: unknown, e: unknown) => ({ stopReason: "error", errorMessage: String(e) }),
    },
  );
  const handler = h.registered[0]?.config.streamSimple as (m: unknown, c: unknown) => unknown;

  handler({}, {});
  assert.equal((await streams[0]!.settled).stopReason, "stop");
  assert.deepEqual(waits, [5_000, 10_000], "a second failure in the same call waits longer");

  handler({}, {});
  assert.equal((await streams[1]!.settled).stopReason, "stop");
  assert.equal(waits[2], 5_000, "a stream that completed means capacity is back — the ladder resets");
});
