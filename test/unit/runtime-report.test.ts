import assert from "node:assert/strict";
import { test } from "node:test";
import { reportRuntimeFacts } from "../../src/runtime/herdr/runtimeReport.ts";
import { runtimeFacts } from "../../src/runtime/piRuntime.ts";

test("reportRuntimeFacts sends the runtime on the existing session record, with identity, and keeps sampling", async () => {
  const calls: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
  const ingest = {
    session: async (id: string, type: string, payload: Record<string, unknown>) => {
      calls.push({ id, type, payload });
      return true;
    },
  };
  const env = {
    PI_RUNTIME_KIND: "pi-bolt",
    PI_RUNTIME_SOURCE: "role",
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
  assert.equal((calls[0]?.payload.runtime as { runtime_kind: string }).runtime_kind, "pi-bolt");
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(calls.length, n, "stop() ends the sampling");
});

test("a failing ingest never throws into the agent", async () => {
  const ingest = { session: async () => Promise.reject(new Error("down")) };
  const r = reportRuntimeFacts(ingest as never, "p", {}, 1000);
  await new Promise((res) => setTimeout(res, 20));
  r.stop();
});

test("a launcher fallback is reported with its reason, bounded", () => {
  const f = runtimeFacts({ PI_RUNTIME_FALLBACK_REASON: "x".repeat(500) });
  assert.equal(f.runtime_kind, "standard-pi");
  assert.equal(f.fallback_reason?.length, 200);
});
