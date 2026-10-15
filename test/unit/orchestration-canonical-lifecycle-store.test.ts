import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LIFECYCLE_SCHEMA_VERSION } from "../../src/orchestration/canonicalLifecycle.ts";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

let dir: string;
let journal: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-canonical-lifecycle-"));
  journal = join(dir, "events.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MISSION = {
  title: "Add health endpoint",
  goal: "Add /health",
  user_request: "Add a health endpoint",
  repository: ".",
  base_ref: "abc",
  risk_profile: "medium" as const,
  workflow_class: "engineering_review" as const,
};

function readEvents(): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function writeJournal(): Promise<string> {
  const backend = await JsonlEventStore.open(journal);
  const store = MissionStore.open(backend);
  const m = store.createMission(MISSION);
  store.transitionMission(m.mission_id, "CLASSIFYING");
  store.transitionMission(m.mission_id, "READY");
  store.transitionMission(m.mission_id, "EXECUTING");
  await store.flush();
  backend.close();
  return m.mission_id;
}

describe("canonical lifecycle persisted on transitions (R-LIFE)", () => {
  it("a transition to EXECUTING persists canonicalState RUNNING and the schema version", async () => {
    await writeJournal();
    const updates = readEvents().filter((e) => e.type === "mission.updated");
    const executing = updates.find((e) => (e.payload.patch as { status?: string }).status === "EXECUTING");
    assert.ok(executing, "no EXECUTING transition event was journaled");
    assert.equal(executing.payload.canonicalState, "RUNNING");
    assert.equal(executing.payload.lifecycleSchemaVersion, LIFECYCLE_SCHEMA_VERSION);
    // The existing fields beside it are unchanged.
    assert.equal(executing.payload.actor, "system");
  });

  it("every journaled transition carries the canonical image of its target status", async () => {
    await writeJournal();
    const images = readEvents()
      .filter((e) => e.type === "mission.updated")
      .map((e) => [(e.payload.patch as { status?: string }).status, e.payload.canonicalState]);
    assert.deepEqual(images, [
      ["CLASSIFYING", "CREATED"],
      ["READY", "READY"],
      ["EXECUTING", "RUNNING"],
    ]);
  });

  it("reads the persisted state back after a reopen", async () => {
    const id = await writeJournal();
    const backend = await JsonlEventStore.open(journal);
    const store = MissionStore.open(backend);
    assert.deepEqual(store.getCanonicalLifecycle(id), {
      canonicalState: "RUNNING",
      lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
    });
    backend.close();
  });

  it("a mission with no transition yet projects CREATED", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission(MISSION);
    assert.equal(store.getCanonicalLifecycle(m.mission_id)?.canonicalState, "CREATED");
    assert.equal(store.getCanonicalLifecycle("MSN-unknown"), undefined);
  });
});

describe("a journal written before this change (R-LIFE)", () => {
  /** Strip the new fields from every line, as a pre-change build would have written it. */
  async function legacyJournal(upTo: "created" | "executing"): Promise<{ id: string; bytes: string }> {
    const id = await writeJournal();
    const lines = readFileSync(journal, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
      .filter((e) => upTo === "executing" || e.type === "mission.created");
    for (const e of lines) {
      e.payload.canonicalState = undefined;
      e.payload.lifecycleSchemaVersion = undefined;
    }
    const bytes = `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`;
    writeFileSync(journal, bytes);
    return { id, bytes };
  }

  it("loads and projects CREATED for a NEW mission, without writing it back", async () => {
    const { id, bytes } = await legacyJournal("created");
    const backend = await JsonlEventStore.open(journal);
    const store = MissionStore.open(backend);
    assert.equal(store.getMission(id)?.status, "NEW");
    assert.deepEqual(store.getCanonicalLifecycle(id), {
      canonicalState: "CREATED",
      lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
    });
    await store.flush();
    backend.close();
    assert.equal(readFileSync(journal, "utf8"), bytes, "replay must not append or rewrite the journal");
  });

  it("derives the state from the status when transitions carry no canonicalState", async () => {
    const { id } = await legacyJournal("executing");
    const backend = await JsonlEventStore.open(journal);
    const store = MissionStore.open(backend);
    assert.equal(store.getMission(id)?.status, "EXECUTING");
    assert.equal(store.getCanonicalLifecycle(id)?.canonicalState, "RUNNING");
    backend.close();
  });
});

describe("snapshot canonicalState (R-LIFE)", () => {
  it("adds canonicalState to mission entries and keeps contractVersion at 3", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission(MISSION);
    const file = buildMissionSnapshotFile([{ mission: m, tasks: [], findings: [] }]);
    assert.equal(file.contractVersion, 3);
    assert.equal(MISSION_SNAPSHOT_CONTRACT_VERSION, 3);
    assert.equal(file.missions[0]?.canonicalState, "CREATED");
  });

  it("prefers the recorded lifecycle when the caller supplies it", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission(MISSION);
    store.transitionMission(m.mission_id, "CLASSIFYING");
    const current = store.getMission(m.mission_id);
    assert.ok(current);
    const file = buildMissionSnapshotFile([
      { mission: current, tasks: [], findings: [], lifecycle: store.getCanonicalLifecycle(m.mission_id) },
    ]);
    assert.equal(file.missions[0]?.canonicalState, "CREATED");
    assert.equal(file.missions[0]?.lifecycleSchemaVersion, LIFECYCLE_SCHEMA_VERSION);
  });
});
