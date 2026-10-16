/**
 * Pure GC eligibility (issue #277): a deterministic classifier over a resource
 * snapshot. Every rule (1)-(9) plus the `idle_unreferenced` delete bucket and
 * ordering/immutability invariants are exercised here with flat `test()` calls
 * and object-literal fixtures (no filesystem).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceRecord } from "../../src/resources/ResourceRegistry.ts";
import { type GcEligibilityInput, selectGcCandidates } from "../../src/resources/gcEligibility.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const MIN_IDLE_MS = 15 * 60_000;
const FAILURE_RETENTION_MS = 60 * 60_000;

function record(overrides: Partial<ResourceRecord>): ResourceRecord {
  return {
    schemaVersion: 1,
    id: "r1",
    kind: "build_dir",
    ownerMissionId: "m1",
    ownerExecutionId: "m1-x",
    hostId: "host-a",
    locator: "/tmp/r1",
    createdAt: "2026-10-01T00:00:00Z",
    lease: "lease-1",
    state: "active",
    ...overrides,
  };
}

function input(overrides: Partial<GcEligibilityInput> = {}): GcEligibilityInput {
  return {
    entries: [],
    hostId: "host-a",
    activeMissionIds: new Set(),
    failedMissionIds: new Set(),
    terminalMissionIds: new Set(),
    liveLeases: new Set(),
    nowMs: NOW,
    minIdleMs: MIN_IDLE_MS,
    failureRetentionMs: FAILURE_RETENTION_MS,
    pressure: "soft",
    ...overrides,
  };
}

function retainReasons(result: { retain: { id: string; reason: string }[] }): string[] {
  return result.retain.map((d) => d.reason);
}

function deleteReasons(result: { delete: { id: string; reason: string }[] }): string[] {
  return result.delete.map((d) => d.reason);
}

test("rule 1: a kind outside `kinds` is retained as kind_not_collectable", () => {
  const r = record({ id: "r1", kind: "process" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
      activeMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), ["kind_not_collectable"]);
  assert.equal(result.retain[0]?.id, "r1");
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 2: released/releasing state is retained as not_releasable_state", () => {
  const released = record({ id: "r1", state: "released" });
  const releasing = record({ id: "r2", state: "releasing" });
  const result = selectGcCandidates(
    input({
      entries: [
        { record: released, lastUsedMs: NOW - 10 * 60_000 },
        { record: releasing, lastUsedMs: NOW - 10 * 60_000 },
      ],
    }),
  );
  assert.deepEqual(retainReasons(result), ["not_releasable_state", "not_releasable_state"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 3: a record owned by another host is retained as foreign_host", () => {
  const r = record({ id: "r1", hostId: "host-b" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), ["foreign_host"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 4: an active mission's resource is retained as mission_active at any pressure", () => {
  const r = record({ id: "r1", ownerMissionId: "m-active" });
  for (const pressure of ["none", "soft", "hard"] as const) {
    const result = selectGcCandidates(
      input({
        entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
        activeMissionIds: new Set(["m-active"]),
        terminalMissionIds: new Set(["m-active"]),
        pressure,
      }),
    );
    assert.deepEqual(retainReasons(result), ["mission_active"], `pressure=${pressure}`);
    assert.deepEqual(deleteReasons(result), []);
  }
});

test("rule 5: a live lease is retained as lease_live", () => {
  const r = record({ id: "r1", lease: "lease-held" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
      liveLeases: new Set(["lease-held"]),
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), ["lease_live"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 6: a retained or failed-owner record within failureRetentionMs is diagnostics_retained", () => {
  const retained = record({ id: "r1", state: "retained" });
  const failedOwner = record({ id: "r2", ownerMissionId: "m-failed" });
  const result = selectGcCandidates(
    input({
      entries: [
        { record: retained, lastUsedMs: NOW - 10 * 60_000 },
        { record: failedOwner, lastUsedMs: NOW - 10 * 60_000 },
      ],
      failedMissionIds: new Set(["m-failed"]),
      terminalMissionIds: new Set(["m-failed"]),
    }),
  );
  assert.deepEqual(retainReasons(result), ["diagnostics_retained", "diagnostics_retained"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("a retained record under hard pressure within failureRetentionMs is still retained (hard never overrides diagnostics)", () => {
  const r = record({ id: "r1", state: "retained", bytes: 1_000_000 });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
      terminalMissionIds: new Set(["m1"]),
      pressure: "hard",
    }),
  );
  assert.deepEqual(retainReasons(result), ["diagnostics_retained"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("a retained record past failureRetentionMs is collectable (not protected anymore)", () => {
  const r = record({ id: "r1", state: "retained" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 2 * FAILURE_RETENTION_MS }],
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), []);
  assert.deepEqual(deleteReasons(result), ["idle_unreferenced"]);
});

test("rule 7: an owner in none of the known sets fails closed as owner_unknown", () => {
  const r = record({ id: "r1", ownerMissionId: "m-unknown" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 10 * 60_000 }],
    }),
  );
  assert.deepEqual(retainReasons(result), ["owner_unknown"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 8: a recently used resource is retained as recently_used", () => {
  const r = record({ id: "r1" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 5 * 60_000 }],
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), ["recently_used"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("rule 9: pressure none retains everything as no_pressure", () => {
  const r = record({ id: "r1" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 30 * 60_000 }],
      terminalMissionIds: new Set(["m1"]),
      pressure: "none",
    }),
  );
  assert.deepEqual(retainReasons(result), ["no_pressure"]);
  assert.deepEqual(deleteReasons(result), []);
});

test("an otherwise eligible idle resource is deleted with reason idle_unreferenced", () => {
  const r = record({ id: "r1" });
  const result = selectGcCandidates(
    input({
      entries: [{ record: r, lastUsedMs: NOW - 30 * 60_000 }],
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  assert.deepEqual(retainReasons(result), []);
  assert.deepEqual(deleteReasons(result), ["idle_unreferenced"]);
  assert.equal(result.delete[0]?.id, "r1");
});

test("soft ordering deletes by lastUsedMs ascending then id", () => {
  const entries = [
    { record: record({ id: "b" }), lastUsedMs: NOW - 30 * 60_000 },
    { record: record({ id: "a" }), lastUsedMs: NOW - 20 * 60_000 },
    { record: record({ id: "c" }), lastUsedMs: NOW - 25 * 60_000 },
  ];
  const result = selectGcCandidates(
    input({
      entries,
      terminalMissionIds: new Set(["m1"]),
      pressure: "soft",
    }),
  );
  assert.deepEqual(
    result.delete.map((d) => d.id),
    ["b", "c", "a"],
  );
});

test("hard ordering deletes by bytes descending, missing bytes treated as 0, then lastUsedMs then id", () => {
  const big = record({ id: "big", bytes: 1_000 } as Partial<ResourceRecord>);
  const medium = record({ id: "medium", bytes: 500 } as Partial<ResourceRecord>);
  const none = record({ id: "none", bytes: undefined } as Partial<ResourceRecord>);
  const small = record({ id: "small", bytes: 10 } as Partial<ResourceRecord>);
  const result = selectGcCandidates(
    input({
      entries: [
        { record: big, lastUsedMs: NOW - 40 * 60_000 },
        { record: medium, lastUsedMs: NOW - 30 * 60_000 },
        { record: none, lastUsedMs: NOW - 30 * 60_000 },
        { record: small, lastUsedMs: NOW - 30 * 60_000 },
      ],
      terminalMissionIds: new Set(["m1"]),
      pressure: "hard",
    }),
  );
  assert.deepEqual(
    result.delete.map((d) => d.id),
    ["big", "medium", "small", "none"],
  );
});

test("every id lands in exactly one list", () => {
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  const entries = [
    { record: record({ id: "r1" }), lastUsedMs: NOW - 30 * 60_000 }, // idle -> delete
    { record: record({ id: "r2", kind: "process" }), lastUsedMs: NOW - 10 * 60_000 }, // kind
    { record: record({ id: "r3", state: "retained" }), lastUsedMs: NOW - 10 * 60_000 }, // diagnostics
    { record: record({ id: "r4", ownerMissionId: "m-active" }), lastUsedMs: NOW - 10 * 60_000 }, // active
    { record: record({ id: "r5", hostId: "host-b" }), lastUsedMs: NOW - 10 * 60_000 }, // foreign
  ];
  const result = selectGcCandidates(
    input({
      entries,
      activeMissionIds: new Set(["m-active"]),
      terminalMissionIds: new Set(["m1"]),
    }),
  );
  const deleteIds = result.delete.map((d) => d.id);
  const retainIds = result.retain.map((d) => d.id);
  const union = new Set([...deleteIds, ...retainIds]);
  assert.deepEqual([...union].sort(), [...ids].sort());
  // No overlap.
  for (const id of deleteIds) assert.ok(!retainIds.includes(id), `${id} appears in both lists`);
});

test("empty input yields empty delete and retain lists", () => {
  const result = selectGcCandidates(input());
  assert.deepEqual(result.delete, []);
  assert.deepEqual(result.retain, []);
});

test("input arrays and records are never mutated", () => {
  const r1 = record({ id: "r1" });
  const r2 = record({ id: "r2", state: "retained" });
  const entries = [
    { record: r1, lastUsedMs: NOW - 10 * 60_000 },
    { record: r2, lastUsedMs: NOW - 5 * 60_000 },
  ];
  const beforeEntries = structuredClone(entries);
  const beforeRecords = structuredClone([r1, r2]);
  const snapshot = input({
    entries,
    terminalMissionIds: new Set(["m1"]),
    pressure: "hard",
  });
  const beforeInput = structuredClone(snapshot);

  selectGcCandidates(snapshot);

  assert.deepEqual(entries, beforeEntries, "entries array mutated");
  assert.deepEqual(r1, beforeRecords[0], "record r1 mutated");
  assert.deepEqual(r2, beforeRecords[1], "record r2 mutated");
  assert.deepEqual(snapshot, beforeInput, "input object mutated");
});
