import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterRegistry } from "../../src/adapters/Adapters.ts";
import { exportTelemetry, formatTelemetry } from "../../src/telemetry/TelemetryExport.ts";

test("adapters: registry is empty by default (core standalone)", () => {
  const reg = new AdapterRegistry();
  assert.equal(reg.autospecAdapter, null);
  assert.equal(reg.inferweaveAdapter, null);
  assert.equal(reg.hasAdapters, false);
});

test("adapters: optional adapters can be installed without touching core", async () => {
  const reg = new AdapterRegistry({
    autospec: {
      name: "autospec",
      submit: async () => ({ externalId: "run-1", accepted: true }),
      observe: async () => ({ state: "running", sequence: 1 }),
      cancel: async () => ({ cancelled: true, stale: false }),
    },
    inferweave: {
      name: "inferweave",
      retrieve: async () => "knowledge",
      record: async () => {},
    },
  });
  assert.equal(reg.hasAdapters, true);
  const owner = { ownerId: "pi", fencingToken: 1 };
  const handle = await reg.autospecAdapter!.submit({
    missionId: "MSN-1",
    taskId: "T1",
    request: "implement isEven",
    baseSha: "abc123",
    owner,
    idempotencyKey: "k",
  });
  assert.equal(handle.externalId, "run-1");
  assert.equal(await reg.inferweaveAdapter!.retrieve("x"), "knowledge");
});

test("telemetry: exportTelemetry produces a deterministic snapshot", () => {
  const now = () => "2025-01-01T00:00:00Z";
  const snap = exportTelemetry(
    {
      workers: { implementer: 2 },
      toolCalls: 5,
      verifyStages: 3,
      evidence: 7,
      blockedOrFailedWorkers: 0,
      inputTokens: 100,
      outputTokens: 50,
      contextTokens: 150,
      turns: 4,
    },
    { runs: [{ id: "WI-1", outcome: "COMPLETED" }], now },
  );
  assert.equal(snap.generatedAt, "2025-01-01T00:00:00Z");
  assert.equal(snap.runtime.toolCalls, 5);
  assert.equal(snap.runs![0]!.outcome, "COMPLETED");
});

test("telemetry: formatTelemetry renders a compact table", () => {
  const snap = exportTelemetry(
    {
      workers: { implementer: 1 },
      toolCalls: 2,
      verifyStages: 1,
      evidence: 3,
      blockedOrFailedWorkers: 0,
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: 15,
      turns: 2,
    },
    { now: () => "T" },
  );
  const out = formatTelemetry(snap);
  assert.match(out, /telemetry @ T/);
  assert.match(out, /implementer=1/);
});
