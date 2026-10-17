import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HandoffRecordError, MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function makeStore(): MissionStore {
  return MissionStore.open(JsonlEventStore.inMemory());
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hf-1",
    kind: "phase_transition",
    state: "prepared",
    missionId: "m-1",
    predecessor: { sessionId: "s-1", generation: 1 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("MissionStore handoff records", () => {
  it("stores a valid HandoffRecord and reads it back", () => {
    const store = makeStore();
    const stored = store.addHandoffRecord(validRecord());
    assert.equal(stored.id, "hf-1");
    assert.equal(stored.kind, "phase_transition");

    const fetched = store.getHandoffRecord("hf-1");
    assert.ok(fetched);
    assert.equal(fetched.missionId, "m-1");
    assert.equal(store.getHandoffRecord("does-not-exist"), undefined);

    assert.equal(store.listHandoffRecords("m-1").length, 1);
    assert.equal(store.listHandoffRecords("m-other").length, 0);
    assert.equal(store.listHandoffRecords().length, 1);
  });

  it("returns defensive copies so external mutation cannot corrupt the store", () => {
    const store = makeStore();
    store.addHandoffRecord(validRecord());
    const fetched = store.getHandoffRecord("hf-1");
    assert.ok(fetched);
    fetched.missionId = "mutated";
    const again = store.getHandoffRecord("hf-1");
    assert.equal(again?.missionId, "m-1");
  });

  it("rejects invalid records with a typed HandoffRecordError", () => {
    const store = makeStore();
    assert.throws(() => store.addHandoffRecord(validRecord({ missionId: "" })), HandoffRecordError);
    assert.throws(() => store.addHandoffRecord(validRecord({ kind: "not-a-kind" })), HandoffRecordError);
    assert.throws(() => store.addHandoffRecord(validRecord({ state: "bogus" })), HandoffRecordError);
    assert.throws(() => store.addHandoffRecord({ id: "hf-x" }), HandoffRecordError);
  });

  it("requires successor and ackAt once a record is acknowledged", () => {
    const store = makeStore();
    assert.throws(() => store.addHandoffRecord(validRecord({ state: "acknowledged" })), HandoffRecordError);
    const ok = store.addHandoffRecord(
      validRecord({
        state: "acknowledged",
        successor: { sessionId: "s-2", generation: 2 },
        ackAt: new Date().toISOString(),
      }),
    );
    assert.equal(ok.state, "acknowledged");
    assert.equal(ok.successor?.sessionId, "s-2");
  });
});
