import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { StoredEvent } from "../../src/platform/eventstore/backend.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts";
import { migrateLegacyStore } from "../../src/runtime/isolation/legacyMigration.ts";

function event(id: string, timestamp: string, type = "probe"): StoredEvent {
  return { event_id: id, timestamp, type, project_id: null, run_id: null, worker_id: null, payload: { id } };
}

async function namespace(): Promise<{ eventsDir: string; recoveryDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ses-"));
  return { root, eventsDir: join(root, "events"), recoveryDir: join(root, "recovery") };
}

describe("SessionEventStore (per-session streams, merged read)", () => {
  it("merges sessions by timestamp while preserving each stream's order and enveloping lines", async () => {
    const ns = await namespace();
    const a = SessionEventStore.open({ ...ns, sessionId: "aaaa", worktreeId: "wt" });
    const b = SessionEventStore.open({ ...ns, sessionId: "bbbb", worktreeId: "wt" });
    await a.append(event("a1", "2026-01-01T00:00:01.000Z"));
    await b.append(event("b1", "2026-01-01T00:00:02.000Z"));
    await a.append(event("a2", "2026-01-01T00:00:03.000Z"));
    a.close();
    b.close();
    const line = JSON.parse(readFileSync(join(ns.eventsDir, "aaaa.jsonl"), "utf8").split("\n")[0]!);
    assert.equal(line.session_id, "aaaa");
    assert.equal(line.worktree_id, "wt");
    assert.equal(line.sequence, 1);
    const reader = SessionEventStore.open({ ...ns, sessionId: "cccc", worktreeId: "wt" });
    assert.deepEqual(
      reader.all().map((e) => e.event_id),
      ["a1", "b1", "a2"],
    );
    assert.equal("session_id" in reader.all()[0]!, false, "envelope is stripped back to StoredEvent");
    reader.close();
  });

  it("refresh() orders all() exactly as a fresh load() does (merged by timestamp, not appended after own events)", async () => {
    const ns = await namespace();
    const mine = SessionEventStore.open({ ...ns, sessionId: "aaaa", worktreeId: "wt" });
    const other = SessionEventStore.open({ ...ns, sessionId: "bbbb", worktreeId: "wt" });
    await mine.append(event("a1", "2026-01-01T00:00:01.000Z"));
    await mine.append(event("a3", "2026-01-01T00:00:03.000Z"));
    // Another session's event is older than this session's latest one.
    await other.append(event("b2", "2026-01-01T00:00:02.000Z"));
    await other.append(event("b4", "2026-01-01T00:00:04.000Z"));
    assert.deepEqual(
      mine.refresh().map((e) => e.event_id),
      ["b2", "b4"],
    );
    const fresh = SessionEventStore.open({ ...ns, sessionId: "cccc", worktreeId: "wt" });
    assert.deepEqual(
      fresh.all().map((e) => e.event_id),
      ["a1", "b2", "a3", "b4"],
    );
    assert.deepEqual(
      mine.all().map((e) => e.event_id),
      fresh.all().map((e) => e.event_id),
      "refresh() and load() agree",
    );
    mine.close();
    other.close();
    fresh.close();
  });

  it("refresh() delivers other sessions' later appends exactly once and waits for incomplete records", async () => {
    const ns = await namespace();
    const reader = SessionEventStore.open({ ...ns, sessionId: "reader", worktreeId: "wt" });
    const writer = SessionEventStore.open({ ...ns, sessionId: "writer", worktreeId: "wt" });
    await writer.append(event("w1", "2026-01-01T00:00:01.000Z"));
    assert.deepEqual(
      reader.refresh().map((e) => e.event_id),
      ["w1"],
    );
    assert.deepEqual(reader.refresh(), [], "no duplicates");
    // A writer mid-append: half a record is visible.
    appendFileSync(join(ns.eventsDir, "writer.jsonl"), '{"event_id":"w2","timestamp":"2026-01-01T00:00:02.000Z"');
    assert.deepEqual(reader.refresh(), [], "an incomplete record is not consumed");
    appendFileSync(join(ns.eventsDir, "writer.jsonl"), ',"type":"probe","payload":{}}\n');
    assert.deepEqual(
      reader.refresh().map((e) => e.event_id),
      ["w2"],
    );
    reader.close();
    writer.close();
  });

  it("quarantines and truncates only the torn tail of its own stream, keeping every valid record", async () => {
    const ns = await namespace();
    const first = SessionEventStore.open({ ...ns, sessionId: "torn", worktreeId: "wt" });
    await first.append(event("t1", "2026-01-01T00:00:01.000Z"));
    first.close();
    const file = join(ns.eventsDir, "torn.jsonl");
    appendFileSync(file, '{"event":"foo","value":');
    const reopened = SessionEventStore.open({ ...ns, sessionId: "torn", worktreeId: "wt" });
    assert.deepEqual(
      reopened.all().map((e) => e.event_id),
      ["t1"],
    );
    assert.ok(readFileSync(file, "utf8").endsWith("\n"), "stream ends on a complete record");
    const quarantined = readdirSync(ns.recoveryDir);
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(join(ns.recoveryDir, quarantined[0]!), "utf8"), '{"event":"foo","value":');
    await reopened.append(event("t2", "2026-01-01T00:00:02.000Z"));
    reopened.close();
    const again = SessionEventStore.open({ ...ns, sessionId: "torn", worktreeId: "wt" });
    assert.deepEqual(
      again.all().map((e) => e.event_id),
      ["t1", "t2"],
      "the next append was not fused onto a fragment",
    );
    again.close();
  });

  it("skips malformed complete lines without discarding the rest of the history", async () => {
    const ns = await namespace();
    const file = join(ns.eventsDir, "dead-session.jsonl");
    const seed = SessionEventStore.open({ ...ns, sessionId: "seed", worktreeId: "wt" });
    seed.close();
    writeFileSync(
      file,
      `${JSON.stringify(event("d1", "2026-01-01T00:00:01.000Z"))}\nnot json\n${JSON.stringify(event("d2", "2026-01-01T00:00:02.000Z"))}\n`,
    );
    const reader = SessionEventStore.open({ ...ns, sessionId: "reader2", worktreeId: "wt" });
    assert.deepEqual(
      reader.all().map((e) => e.event_id),
      ["d1", "d2"],
    );
    assert.equal(reader.diagnostics().corruptLines, 1);
    reader.close();
  });

  it("shares one writer instance per stream within a process (reload-safe) and de-duplicates legacy imports", async () => {
    const ns = await namespace();
    const one = SessionEventStore.open({ ...ns, sessionId: "same", worktreeId: "wt" });
    const two = SessionEventStore.open({ ...ns, sessionId: "same", worktreeId: "wt" });
    assert.equal(one, two, "a second open joins the live writer");
    two.close();
    assert.equal(one.isClosed(), false, "the first reference still holds the writer");
    await one.append(event("dup", "2026-01-01T00:00:01.000Z"));
    one.close();
    const legacy = join(ns.root, "orchestration.jsonl");
    writeFileSync(legacy, `${JSON.stringify(event("dup", "2026-01-01T00:00:01.000Z"))}\n`);
    const migrated = migrateLegacyStore({ legacyFile: legacy, runtimeDir: ns.root, eventsDir: ns.eventsDir });
    assert.equal(migrated.status, "migrated");
    assert.equal(
      migrateLegacyStore({ legacyFile: legacy, runtimeDir: ns.root, eventsDir: ns.eventsDir }).status,
      "current",
      "a second migration of an unchanged source is a no-op",
    );
    const reader = SessionEventStore.open({ ...ns, sessionId: "reader3", worktreeId: "wt" });
    assert.equal(reader.all().filter((e) => e.event_id === "dup").length, 1);
    reader.close();
  });

  it("MissionStore.syncExternal applies missions another session created after this one opened", async () => {
    const ns = await namespace();
    const mine = MissionStore.open(SessionEventStore.open({ ...ns, sessionId: "mine", worktreeId: "wt" }));
    const theirsBackend = SessionEventStore.open({ ...ns, sessionId: "theirs", worktreeId: "wt" });
    const theirs = MissionStore.open(theirsBackend);
    const mission = theirs.createMission({
      title: "t",
      goal: "g",
      user_request: "u",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    await theirs.flush();
    assert.equal(mine.getMission(mission.mission_id), undefined);
    assert.equal(mine.syncExternal() > 0, true);
    assert.equal(mine.getMission(mission.mission_id)?.title, "t");
    theirsBackend.close();
  });

  it("refuses to write once its writer authority is superseded", async () => {
    const ns = await namespace();
    let authoritative = true;
    const store = SessionEventStore.open({
      ...ns,
      sessionId: "fenced",
      worktreeId: "wt",
      writerAuthority: () => authoritative,
    });
    await store.append(event("f1", "2026-01-01T00:00:01.000Z"));
    authoritative = false;
    await assert.rejects(store.append(event("f2", "2026-01-01T00:00:02.000Z")), /superseded/);
    assert.equal(store.ownsWriterLock(), false);
    store.close();
  });
});
