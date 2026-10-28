/**
 * #425 — worker-shaped preflight: probe outcomes map through the gateway
 * signal vocabulary (#428/#435) before any worker startup is paid; nothing
 * outside that vocabulary can park a mission.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  type PreflightRuntime,
  preflightEnabled,
  preflightWorkerShape,
  resetPreflightCache,
} from "../../src/gateway/preflight.ts";

const UPSTREAM_400 =
  '400: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"upstream_error","message":"Correct the request syntax, parameters, endpoint, or model identity.","reason":"upstream_error","replay_safe":false,"request_state":"unknown","retryable":false,"scope":"request","type":"inferweave_backpressure"}';

const runtime = (
  behavior: (
    context: unknown,
    options: Record<string, unknown> | undefined,
  ) => Promise<{ stopReason?: string; errorMessage?: string }>,
): { rt: PreflightRuntime; calls: { context: unknown; options?: Record<string, unknown> }[] } => {
  const calls: { context: unknown; options?: Record<string, unknown> }[] = [];
  return {
    calls,
    rt: {
      completeSimple: async (model, context, options) => {
        calls.push({ context, options: options as Record<string, unknown> | undefined });
        return behavior(context, options as Record<string, unknown> | undefined);
      },
    },
  };
};

const MODEL = { provider: "metabolomics", id: "probe-model" };

afterEach(() => resetPreflightCache());

describe("#425 worker-shaped preflight", () => {
  it("probes the worker shape: tools present, tiny budget, abort signal", async () => {
    const { rt, calls } = runtime(async () => ({ stopReason: "stop" }));
    const outcome = await preflightWorkerShape({ runtime: rt, model: { ...MODEL, id: "shape-ok" } });
    assert.deepEqual(outcome, { ok: true, probed: true });
    const context = calls[0]!.context as { systemPrompt?: string; messages: unknown[]; tools?: unknown[] };
    assert.ok(
      context.systemPrompt && context.tools?.length === 1,
      "system prompt and a tool schema are part of the shape",
    );
    assert.equal((calls[0]!.options as { maxTokens?: number }).maxTokens, 16);
    assert.ok((calls[0]!.options as { signal?: unknown }).signal, "the probe is abortable");
  });

  it("caches success briefly and failure even shorter", async () => {
    const { rt, calls } = runtime(async () => ({ stopReason: "stop" }));
    let now = 1_000;
    const opts = () => ({ runtime: rt, model: { ...MODEL, id: "cache-me" }, now: () => now });
    assert.deepEqual(await preflightWorkerShape(opts()), { ok: true, probed: true });
    assert.deepEqual(await preflightWorkerShape(opts()), { ok: true, probed: false });
    now += 61_000;
    assert.deepEqual(await preflightWorkerShape(opts()), { ok: true, probed: true }, "success TTL expired");
    const failing = runtime(async () => ({ stopReason: "error", errorMessage: UPSTREAM_400 }));
    const fopts = () => ({ runtime: failing.rt, model: { ...MODEL, id: "cache-fail" }, now: () => now });
    const first = await preflightWorkerShape(fopts());
    assert.equal(first.ok, false);
    now += 6_000;
    const again = await preflightWorkerShape(fopts());
    assert.equal(again.ok, false);
    assert.equal(failing.calls.length, 2, "failure TTL expired — re-probed");
  });

  it("maps the field-observed upstream_error envelope to the capacity-wait marker", async () => {
    const { rt } = runtime(async () => ({ stopReason: "error", errorMessage: UPSTREAM_400 }));
    const outcome = await preflightWorkerShape({ runtime: rt, model: { ...MODEL, id: "env-1" } });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { marker: string }).marker, "transient:server_unavailable");
  });

  it("keeps quota refusals failing and reports auth as auth", async () => {
    const quota = runtime(async () => ({
      stopReason: "error",
      errorMessage:
        '402: {"action":"fix_request","code":"quota_exceeded","reason":"quota_exceeded","retryable":false,"type":"inferweave_backpressure"}',
    }));
    const q = await preflightWorkerShape({ runtime: quota.rt, model: { ...MODEL, id: "quota" } });
    assert.equal((q as { marker: string }).marker, "gateway:quota_exceeded");

    const auth = runtime(async () => ({ stopReason: "error", errorMessage: "401: unauthorized — invalid api key" }));
    const a = await preflightWorkerShape({ runtime: auth.rt, model: { ...MODEL, id: "auth" } });
    assert.equal((a as { marker: string }).marker, "preflight:auth");
  });

  it("never parks on errors outside the gateway vocabulary", async () => {
    const { rt } = runtime(async () => ({
      stopReason: "error",
      errorMessage: "provider rejected invalid parameter combination",
    }));
    const outcome = await preflightWorkerShape({ runtime: rt, model: { ...MODEL, id: "odd" } });
    assert.equal(
      (outcome as { marker: string }).marker,
      "preflight:error",
      "fails the task with its own text, no capacity wait",
    );
  });

  it("treats a hung upstream as a transient timeout", async () => {
    const { rt } = runtime(
      (_context, options) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (options as { signal?: AbortSignal })?.signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const outcome = await preflightWorkerShape({ runtime: rt, model: { ...MODEL, id: "hang" }, timeoutMs: 60 });
    assert.equal((outcome as { marker: string }).marker, "transient:timeout");
  });

  it("is on by default and off with PI_ENG_PREFLIGHT=0", () => {
    assert.equal(preflightEnabled({}), true);
    assert.equal(preflightEnabled({ PI_ENG_PREFLIGHT: "0" }), false);
    assert.equal(preflightEnabled({ PI_ENG_PREFLIGHT: "off" }), false);
    assert.equal(preflightEnabled({ PI_ENG_PREFLIGHT: "1" }), true);
  });
});
