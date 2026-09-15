/**
 * Cached model readiness.
 *
 * `slots` and `x_state` explain a `503 no worker for model` better than any
 * retry counter: a model with no free slots is the one that refuses. The
 * constraint is that this is consulted on every gateway hold, and holds arrive
 * in bursts exactly when the gateway is least able to serve extra requests — so
 * the probe must coalesce, cache, and back off rather than retry.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelHealthProvider } from "../../src/models/health.ts";

const PAYLOAD = {
  data: [
    { id: "deepseek-v4-flash", ctx_per_request: 262144, x_state: "warm", slots: 9 },
    { id: "qwen3.8-27b", ctx_per_request: 262144, x_state: "cold", slots: 0 },
  ],
};

function counting(payload: unknown = PAYLOAD, ok = true) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return { ok, status: ok ? 200 : 503, json: async () => payload };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test("health: readings are parsed per model", async () => {
  const f = counting();
  const p = new ModelHealthProvider({ baseUrl: "https://g/v1", fetchImpl: f.fetchImpl });
  await p.refresh();

  assert.deepEqual(p.get("deepseek-v4-flash"), { state: "warm", slots: 9 });
  assert.deepEqual(p.get("qwen3.8-27b"), { state: "cold", slots: 0 });
});

test("health: an unknown model reads as empty, not as bad news", async () => {
  const f = counting();
  const p = new ModelHealthProvider({ baseUrl: "https://g/v1", fetchImpl: f.fetchImpl });
  await p.refresh();
  assert.deepEqual(p.get("never-heard-of-it"), {});
});

test("health: a reading inside its TTL is not re-fetched", async () => {
  let clock = 1_000;
  const f = counting();
  const p = new ModelHealthProvider({
    baseUrl: "https://g/v1",
    ttlMs: 30_000,
    now: () => clock,
    fetchImpl: f.fetchImpl,
  });

  await p.refresh();
  clock += 29_000;
  await p.refresh();
  assert.equal(f.calls(), 1);

  clock += 2_000;
  await p.refresh();
  assert.equal(f.calls(), 2, "past the TTL it refreshes");
});

test("health: a burst of callers produces one probe, not one each", async () => {
  // Holds arrive in bursts precisely when the gateway is least able to serve
  // extra requests.
  const f = counting();
  const p = new ModelHealthProvider({ baseUrl: "https://g/v1", fetchImpl: f.fetchImpl });

  await Promise.all([p.refresh(), p.refresh(), p.refresh(), p.refresh()]);
  assert.equal(f.calls(), 1);
});

test("health: a failed probe backs off instead of retrying under load", async () => {
  let clock = 1_000;
  const f = counting({}, false);
  const p = new ModelHealthProvider({
    baseUrl: "https://g/v1",
    errorBackoffMs: 60_000,
    now: () => clock,
    fetchImpl: f.fetchImpl,
  });

  await p.refresh();
  assert.equal(f.calls(), 1);

  clock += 30_000;
  await p.refresh();
  assert.equal(f.calls(), 1, "hammering the probe adds load to the problem it describes");

  clock += 31_000;
  await p.refresh();
  assert.equal(f.calls(), 2);
});

test("health: a failure never throws and keeps the previous readings", async () => {
  let clock = 1_000;
  let ok = true;
  const fetchImpl = (async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => PAYLOAD,
  })) as unknown as typeof fetch;
  const p = new ModelHealthProvider({ baseUrl: "https://g/v1", ttlMs: 1, now: () => clock, fetchImpl });

  await p.refresh();
  assert.equal(p.get("deepseek-v4-flash").slots, 9);

  ok = false;
  clock += 10_000;
  await assert.doesNotReject(() => p.refresh());
  assert.equal(p.get("deepseek-v4-flash").slots, 9, "stale readiness beats none");
});

test("health: freshness is reported honestly", async () => {
  let clock = 1_000;
  const f = counting();
  const p = new ModelHealthProvider({
    baseUrl: "https://g/v1",
    ttlMs: 5_000,
    now: () => clock,
    fetchImpl: f.fetchImpl,
  });

  assert.equal(p.isFresh(), false, "nothing has been read yet");
  await p.refresh();
  assert.equal(p.isFresh(), true);
  clock += 6_000;
  assert.equal(p.isFresh(), false);
});
