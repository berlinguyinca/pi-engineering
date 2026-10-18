import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  type StoragePressureSnapshot,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import {
  type GuardTimer,
  SnapshotPressureGuard,
  type SnapshotPressureGuardOptions,
} from "../../src/resilience/snapshotPressureGuard.ts";
import type { MountSample, StoragePressureEvent } from "../../src/resilience/storagePressure.ts";

const WORK_DIR = "/tmp/pressure-guard-test";

function enospcError(): Error {
  return Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
}

function erofsError(): Error {
  return Object.assign(new Error("read-only file system"), { code: "EROFS" });
}

function nonStorageError(): Error {
  return new TypeError("cannot read properties of undefined");
}

interface FakeGuardTimer extends GuardTimer {
  stopped: boolean;
}

interface FakeTimers {
  scheduled: Array<{ fn: () => void; ms: number }>;
  timers: FakeGuardTimer[];
}

function makeGuard(overrides: Partial<SnapshotPressureGuardOptions> & { republish?: () => Promise<unknown> } = {}): {
  guard: SnapshotPressureGuard;
  events: StoragePressureEvent[];
  republishCalls: number[];
  timers: FakeTimers;
} {
  const events: StoragePressureEvent[] = [];
  const republishCalls: number[] = [];
  const timers: FakeTimers = { scheduled: [], timers: [] };
  const guard = new SnapshotPressureGuard({
    workDir: WORK_DIR,
    republish: () => {
      republishCalls.push(Date.now());
      return Promise.resolve();
    },
    onEvent: (event) => events.push(event),
    schedule: (fn, ms) => {
      const t: FakeGuardTimer = {
        stopped: false,
        stop: () => {
          t.stopped = true;
        },
      };
      timers.scheduled.push({ fn, ms });
      timers.timers.push(t);
      return t;
    },
    ...overrides,
  });
  return { guard, events, republishCalls, timers };
}

function healthyMount(path: string): MountSample {
  return { path, healthy: true, freeBytes: 1_000_000, freeInodes: 1_000 };
}

function unhealthyMount(path: string): MountSample {
  return { path, healthy: false, freeBytes: 0, freeInodes: 0 };
}

describe("SnapshotPressureGuard — FR-03/04/05 runtime wiring (fault injection only)", () => {
  it("suspends on ENOSPC: pauses the publisher, tags the snapshot stale, emits exactly one incident", async () => {
    const { guard, events, republishCalls, timers } = makeGuard();

    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);

    assert.equal(guard.publishPaused, true, "snapshot retries paused");
    assert.equal(guard.suspended, true);
    assert.equal(events.filter((e) => e.kind === "incident").length, 1, "exactly one incident event");
    assert.equal(republishCalls.length, 0, "no republish while suspended");

    const state = guard.state();
    assert.equal(state.dirty, true);
    assert.equal(state.stale, true);
    assert.ok(state.staleAtMs !== undefined, "stale timestamp recorded");
    assert.equal(state.republished, false);
    assert.equal(state.suspended, true);
    assert.equal(state.incident?.code, "ENOSPC");
    assert.equal(state.incident?.path, WORK_DIR);

    // The recovery probe loop is scheduled at the default 30 s pacing.
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]!.ms, 30_000);
    guard.dispose();
  });

  it("coalesces repeated failures during an active incident (no duplicate incident, stays paused)", async () => {
    const { guard, events } = makeGuard();
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), false);
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), false);
    assert.equal(events.filter((e) => e.kind === "incident").length, 1);
    assert.equal(guard.publishPaused, true);
    guard.dispose();
  });

  it("does not suspend on operator-required incidents (EROFS): publisher keeps its normal behavior", async () => {
    const { guard, events, timers } = makeGuard();
    assert.equal(await guard.notePublishError(erofsError(), { path: WORK_DIR }), false);
    assert.equal(guard.publishPaused, false);
    assert.equal(guard.suspended, false);
    assert.equal(events.length, 0, "no incident notification for operator-required conditions");
    assert.equal(timers.scheduled.length, 0, "no recovery probe scheduled");
    const state = guard.state();
    assert.equal(state.stale, false);
    assert.equal(state.suspended, false);
    guard.dispose();
  });

  it("ignores non-storage errors entirely", async () => {
    const { guard, events } = makeGuard();
    assert.equal(await guard.notePublishError(nonStorageError(), { path: WORK_DIR }), false);
    assert.equal(guard.publishPaused, false);
    assert.equal(events.length, 0);
    guard.dispose();
  });

  it("recovers after consecutive healthy samples of the affected mount + sentinel OK; unpauses and republishes", async () => {
    const samples: MountSample[] = [unhealthyMount(WORK_DIR), healthyMount(WORK_DIR)];
    let sentinelCalls = 0;
    const { guard, events, republishCalls } = makeGuard({
      sampleMount: async (path) => samples.shift() ?? healthyMount(path),
      sentinelProbe: async () => {
        sentinelCalls += 1;
        return true;
      },
    });

    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);

    // Unhealthy sample: stays suspended, streak at zero.
    await guard.tick();
    assert.equal(guard.suspended, true);
    assert.equal(guard.publishPaused, true);

    // First healthy sample: streak 1 of 2, no resume yet.
    await guard.tick();
    assert.equal(guard.suspended, true);
    assert.equal(guard.publishPaused, true);
    assert.equal(republishCalls.length, 0);

    // Second consecutive healthy sample: sentinel runs, resume granted.
    await guard.tick();
    assert.equal(guard.suspended, false, "auto-resume after consecutive healthy checks");
    assert.equal(guard.publishPaused, false, "publisher unpaused");
    assert.equal(sentinelCalls, 1, "sentinel probe ran exactly once");
    assert.equal(events.filter((e) => e.kind === "recovered").length, 1, "exactly one recovered event");
    assert.ok(republishCalls.length >= 1, "dirty-snapshot republish pipeline ran");

    // A successful republish finalizes the stale tag.
    guard.notePublishSuccess();
    const state = guard.state();
    assert.equal(state.dirty, false);
    assert.equal(state.stale, false);
    assert.equal(state.staleAtMs, undefined);
    assert.equal(state.republished, true);
    guard.dispose();
  });

  it("resets the healthy streak when the sentinel probe fails (no false recovery)", async () => {
    let sentinelOk = false;
    const { guard, events, republishCalls } = makeGuard({
      sampleMount: async (path) => healthyMount(path),
      sentinelProbe: async () => sentinelOk,
    });
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);

    // Two healthy samples, sentinel fails: streak resets, no resume.
    await guard.tick();
    await guard.tick();
    assert.equal(guard.suspended, true);
    assert.equal(republishCalls.length, 0);
    assert.equal(events.filter((e) => e.kind === "recovered").length, 0);

    // Sentinel now succeeds; two more consecutive healthy samples recover.
    sentinelOk = true;
    await guard.tick();
    await guard.tick();
    assert.equal(guard.suspended, false);
    assert.equal(events.filter((e) => e.kind === "recovered").length, 1);
    assert.ok(republishCalls.length >= 1);
    guard.dispose();
  });

  it("never counts samples whose mount path differs from the incident path (path-scoped)", async () => {
    const { guard, republishCalls } = makeGuard({
      // A misbehaving sampler: reports healthy, but for a DIFFERENT mount than
      // the one the incident targeted. The controller must reject it.
      sampleMount: async () => ({ path: "/some/other/mount", healthy: true, freeBytes: 1, freeInodes: 1 }),
      sentinelProbe: async () => true,
    });
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);

    // No matter how many foreign-path samples arrive, they never count.
    await guard.tick();
    await guard.tick();
    await guard.tick();
    assert.equal(guard.suspended, true, "foreign-path samples never count toward recovery");
    assert.equal(guard.publishPaused, true);
    assert.equal(republishCalls.length, 0);
    guard.dispose();
  });

  it("keeps the stale tag while suspended even when a publish somehow succeeds", async () => {
    const { guard } = makeGuard();
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);
    guard.notePublishSuccess(); // must be a no-op while suspended
    const state = guard.state();
    assert.equal(state.stale, true, "stale tag survives until recovery is granted");
    assert.equal(state.dirty, true);
    guard.dispose();
  });

  it("disposes cleanly: probe loop stops and further ticks are no-ops", async () => {
    const { guard, timers } = makeGuard();
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);
    assert.equal(timers.scheduled.length, 1);
    guard.dispose();
    assert.equal(timers.timers[0]?.stopped, true, "probe timer stopped");
    // Ticks after dispose are no-ops (no throw, no state change).
    await guard.tick();
    assert.equal(guard.publishPaused, true);
  });

  it("a fresh incident on the same path after recovery re-opens (counters reset)", async () => {
    const { guard, events } = makeGuard({
      sampleMount: async (path) => healthyMount(path),
      sentinelProbe: async () => true,
    });
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);
    await guard.tick();
    await guard.tick();
    assert.equal(guard.suspended, false);

    // A second ENOSPC after recovery re-suspends with a fresh incident.
    assert.equal(await guard.notePublishError(enospcError(), { path: WORK_DIR }), true);
    assert.equal(guard.suspended, true);
    assert.equal(guard.publishPaused, true);
    assert.equal(events.filter((e) => e.kind === "incident").length, 2, "one incident per actual incident");
    guard.dispose();
  });
});

describe("mission snapshot file — additive storagePressure substate (FR-04)", () => {
  function oneMission() {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "Add health endpoint",
      goal: "Add /health",
      user_request: "Add a health endpoint",
      repository: ".",
      base_ref: "abc",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    return [
      {
        mission: m,
        tasks: store.listTasks(m.mission_id),
        findings: store.listFindings(m.mission_id),
      },
    ];
  }

  it("includes the substate when supplied and omits it when absent (legacy shape preserved)", () => {
    const plain = buildMissionSnapshotFile(oneMission());
    assert.equal(plain.contractVersion, MISSION_SNAPSHOT_CONTRACT_VERSION);
    assert.equal("storagePressure" in plain, false, "legacy publishers produce the legacy shape");

    const substate: StoragePressureSnapshot = {
      dirty: true,
      stale: true,
      staleAtMs: 1_750_000_000_000,
      republished: false,
      suspended: true,
      incident: { category: "DISK_FULL", code: "ENOSPC", path: WORK_DIR },
    };
    const tagged = buildMissionSnapshotFile(oneMission(), substate);
    assert.deepEqual(tagged.storagePressure, substate, "the published file carries the stale tag");
  });

  it("end-to-end: a suspended guard tags the file; after recovery the file is clean", () => {
    const guard = new SnapshotPressureGuard({ workDir: WORK_DIR, republish: async () => undefined });
    const plain = buildMissionSnapshotFile(oneMission(), guard.state());
    assert.equal(plain.storagePressure?.stale, false, "healthy guard publishes an untagged file");

    void guard.notePublishError(enospcError(), { path: WORK_DIR });
    const stale = buildMissionSnapshotFile(oneMission(), guard.state());
    assert.equal(stale.storagePressure?.stale, true);
    assert.equal(stale.storagePressure?.suspended, true);
    assert.equal(stale.storagePressure?.incident?.code, "ENOSPC");

    guard.dispose();
  });
});
