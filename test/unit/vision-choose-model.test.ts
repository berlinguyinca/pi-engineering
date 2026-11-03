import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProbeResult } from "../../src/resilience/probe.ts";
import { chooseVisionModel } from "../../src/visionDelegation/chooseModel.ts";

const IMG = ["text", "image"];
const ok: ProbeResult = { healthy: true, authoritative: true };
const down = (reason: string): ProbeResult => ({ healthy: false, authoritative: true, reason });

function probes(map: Record<string, ProbeResult | Error>) {
  const calls: string[] = [];
  const probeFor = async (m: { provider: string; id: string }) => {
    calls.push(`${m.provider}/${m.id}`);
    const r = map[m.id];
    if (r instanceof Error) throw r;
    return r ?? down("unknown");
  };
  return { probeFor, calls };
}

test("prefers the first alias in the preference list that takes images and is healthy", async () => {
  const { probeFor } = probes({ a: ok, b: ok });
  const r = await chooseVisionModel({
    models: [
      { provider: "p", id: "a", input: IMG },
      { provider: "p", id: "b", input: IMG },
    ],
    preference: ["b", "a"],
    probeFor,
  });
  assert.deepEqual(r, { provider: "p", id: "b" });
});

test("skips an unhealthy alias and takes the next", async () => {
  const { probeFor } = probes({ a: down("relocating"), b: ok });
  const r = await chooseVisionModel({
    models: [
      { provider: "p", id: "a", input: IMG },
      { provider: "p", id: "b", input: IMG },
    ],
    preference: ["a", "b"],
    probeFor,
  });
  assert.deepEqual(r, { provider: "p", id: "b" });
});

test("falls through to a non-preferred eligible model in models order", async () => {
  const { probeFor } = probes({ a: down("x"), c: ok, d: ok });
  const r = await chooseVisionModel({
    models: [
      { provider: "p", id: "d", input: IMG },
      { provider: "p", id: "a", input: IMG },
      { provider: "p", id: "c", input: IMG },
    ],
    preference: ["a", "  ", ""],
    probeFor,
  });
  assert.deepEqual(r, { provider: "p", id: "d" });
});

test("ignores models whose input lacks image", async () => {
  const { probeFor, calls } = probes({ t: ok, v: ok });
  const r = await chooseVisionModel({
    models: [
      { provider: "p", id: "t", input: ["text"] },
      { provider: "p", id: "n" },
      { provider: "p", id: "v", input: IMG },
    ],
    preference: ["t"],
    probeFor,
  });
  assert.deepEqual(r, { provider: "p", id: "v" });
  assert.deepEqual(calls, ["p/v"]);
});

test("same id on two providers: first in models order is tried first", async () => {
  const { probeFor } = probes({ a: ok });
  const r = await chooseVisionModel({
    models: [
      { provider: "one", id: "a", input: IMG },
      { provider: "two", id: "a", input: IMG },
    ],
    preference: ["a"],
    probeFor,
  });
  assert.deepEqual(r, { provider: "one", id: "a" });
});

test("a non-authoritative probe result counts as not healthy", async () => {
  const { probeFor } = probes({ a: { healthy: true, authoritative: false } });
  const r = await chooseVisionModel({
    models: [{ provider: "p", id: "a", input: IMG }],
    preference: ["a"],
    probeFor,
  });
  assert.ok("none" in r);
  assert.match(r.reason, /p\/a/);
  assert.match(r.reason, /authoritative/);
});

test("a probe that throws or rejects is unhealthy, with the message in the reason", async () => {
  const { probeFor } = probes({ a: new Error("boom"), b: ok });
  const r = await chooseVisionModel({
    models: [{ provider: "p", id: "a", input: IMG }],
    preference: ["a"],
    probeFor,
  });
  assert.ok("none" in r);
  assert.match(r.reason, /boom/);
  const r2 = await chooseVisionModel({
    models: [{ provider: "p", id: "a", input: IMG }],
    preference: ["a"],
    probeFor: () => {
      throw new Error("sync-boom");
    },
  });
  assert.ok("none" in r2);
  assert.match(r2.reason, /sync-boom/);
});

test("returns none with a reason naming each skipped model when nothing is healthy", async () => {
  const { probeFor } = probes({ a: down("relocating"), b: down("loading") });
  const r = await chooseVisionModel({
    models: [
      { provider: "p", id: "a", input: IMG },
      { provider: "q", id: "b", input: IMG },
      { provider: "p", id: "t", input: ["text"] },
    ],
    preference: ["a", "b"],
    probeFor,
  });
  assert.ok("none" in r);
  assert.match(r.reason, /p\/a.*relocating/);
  assert.match(r.reason, /q\/b.*loading/);
  assert.match(r.reason, /p\/t.*image/);
});

test("none says explicitly when no model accepts images", async () => {
  const { probeFor } = probes({});
  const r = await chooseVisionModel({
    models: [{ provider: "p", id: "t", input: ["text"] }],
    preference: [],
    probeFor,
  });
  assert.ok("none" in r);
  assert.match(r.reason, /no model accepts images/i);
  assert.match(r.reason, /p\/t/);
});
