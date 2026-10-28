import assert from "node:assert/strict";
import { test } from "node:test";
import { reportRuntimeFacts } from "../../src/runtime/herdr/runtimeReport.ts";
import { runtimeFacts } from "../../src/runtime/runtimeFacts.ts";

test("reportRuntimeFacts sends the runtime on the existing session record, with identity, and keeps sampling", async () => {
  const calls: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
  const ingest = {
    session: async (id: string, type: string, payload: Record<string, unknown>) => {
      calls.push({ id, type, payload });
      return true;
    },
  };
  const env = {
    PI_ENGINEERING_ROLE: "reviewer",
    PI_ENGINEERING_MISSION_ID: "m-1",
  };
  const r = reportRuntimeFacts(ingest as never, "w1:p2", env, 15);
  await new Promise((res) => setTimeout(res, 70));
  r.stop();
  const n = calls.length;
  assert.ok(n >= 2, `expected an immediate and a periodic report, got ${n}`);
  assert.equal(calls[0]?.id, "w1:p2");
  assert.equal(calls[0]?.type, "session.updated");
  assert.equal(calls[0]?.payload.missionId, "m-1");
  assert.equal(calls[0]?.payload.agentRole, "reviewer");
  assert.equal((calls[0]?.payload.runtime as { runtime_kind: string }).runtime_kind, "standard-pi");
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(calls.length, n, "stop() ends the sampling");
});

test("a failing ingest never throws into the agent", async () => {
  const ingest = { session: async () => Promise.reject(new Error("down")) };
  const r = reportRuntimeFacts(ingest as never, "p", {}, 1000);
  await new Promise((res) => setTimeout(res, 20));
  r.stop();
});

test("runtimeFacts reports engine, CPU and RSS and is always standard Pi", () => {
  const f = runtimeFacts({
    versions: { node: "22.1.0" },
    cpuUsage: () => ({ user: 1_500_000, system: 500_000 }),
    memoryUsage: () => ({ rss: 52_428_800 }),
  });
  assert.deepEqual(f, {
    runtime_kind: "standard-pi",
    runtime_source: "default",
    js_engine: "node",
    js_engine_version: "22.1.0",
    cpu_s: 2,
    rss_mib: 50,
  });
});
