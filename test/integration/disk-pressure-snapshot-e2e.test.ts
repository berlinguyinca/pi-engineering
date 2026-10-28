/**
 * Disk-pressure recovery — END-TO-END acceptance (spec §6), through the REAL
 * EngineeringRuntime publish path, the REAL SnapshotPressureGuard +
 * StoragePressureController, and REAL files in an isolated temp directory.
 *
 * Fault injection only (house rule: never fill a real disk): the write fault
 * seam throws an ENOSPC-class error at the exact point `writeFile` would fail,
 * and the mount sampler/sentinel/probe scheduler are injected.
 *
 * Covered acceptance behaviors:
 *  1. ENOSPC SUSPENDS — the mission never fails; publish returns the last good
 *     snapshot; exactly ONE incident event.
 *  2. The published file carries the STALE tag (storagePressure substate with
 *     the ENOSPC incident) via the one best-effort final attempt.
 *  3. While suspended the publisher does NOT touch the disk (no retry storm).
 *  4. Recovery requires consecutive healthy samples + the sentinel probe;
 *     sentinel failure never recovers.
 *  5. Recovery → exactly ONE recovered event → forced republish lands a CLEAN
 *     file (stale tag cleared only when the republish succeeds).
 *  6. A fresh ENOSPC after recovery re-suspends as a NEW incident.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MISSION_SNAPSHOT_FILENAME } from "../../src/orchestration/missionSnapshot.ts";
import type { StoragePressureEvent } from "../../src/resilience/storagePressure.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const enospc = () => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

interface Tick {
  fn: () => void;
}

test("E2E: ENOSPC suspends, tags the snapshot stale, probes, recovers, and republishes clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-diskpressure-e2e-"));
  const workDir = join(root, ".pi-eng");
  const events: StoragePressureEvent[] = [];
  const ticks: Tick[] = [];
  // Write fault: fires once (the first publish after arming), then clears —
  // the one-time ENOSPC that suspends, and the stale-tagged final attempt
  // that succeeds.
  let faultArmed = false;
  let faultFireCount = 0;
  // Mount state: full until recovery begins, then healthy.
  let diskHealthy = false;

  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
      snapshotWriteFault: () => {
        faultFireCount++;
        if (!faultArmed) return null;
        faultArmed = false;
        return enospc();
      },
      snapshotPressureOverrides: {
        sampleMount: async (path) => ({
          path,
          healthy: diskHealthy,
          freeBytes: diskHealthy ? 1024 * 1024 * 1024 : 0,
          freeInodes: diskHealthy ? 100_000 : 0,
        }),
        sentinelProbe: async () => true,
        // Deterministic pacing: collect ticks, drive them manually.
        schedule: (fn) => {
          const tick: Tick = { fn };
          ticks.push(tick);
          return { stop: () => void ticks.splice(ticks.indexOf(tick), 1) };
        },
        probeIntervalMs: 5,
        config: { probe_interval_ms: 5, recovery_consecutive_checks: 2, jitter_ms: 0 },
        onEvent: (event) => events.push(event),
      },
    });
    runtime.missionStore!.createMission({
      title: "disk pressure e2e",
      goal: "g",
      user_request: "g",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });

    const snapshotPath = join(workDir, MISSION_SNAPSHOT_FILENAME);
    const readSnapshot = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;

    // ── Baseline: a clean publish writes a clean file.
    const first = await runtime.publishMissionSnapshot();
    assert.ok(first, "baseline publish succeeds");
    const baseline = await readSnapshot();
    assert.ok(!baseline.storagePressure, "no storage-pressure substate on a healthy file");

    // ── 1+2: ENOSPC suspends; exactly one incident; file carries the stale tag.
    faultArmed = true;
    const duringIncident = await runtime.publishMissionSnapshot();
    assert.ok(duringIncident, "publish still returns a snapshot (the stale-tagged final attempt)");
    assert.equal(
      events.filter((e) => e.kind === "incident").length,
      1,
      `exactly one incident event, got ${JSON.stringify(events.map((e) => e.kind))}`,
    );
    const tagged = await readSnapshot();
    const pressure = tagged.storagePressure as Record<string, unknown>;
    assert.equal(pressure.stale, true, "the published file is tagged stale");
    assert.equal((pressure.incident as Record<string, unknown>).code, "ENOSPC");

    // ── 3: while suspended the publisher does not touch the disk at all.
    const writesBefore = faultFireCount;
    for (let i = 0; i < 5; i++) {
      const paused = await runtime.publishMissionSnapshot();
      // Structural, not identity: a publish returns the merged view of the snapshot
      // file (#427), so it is no longer the same object reference the caller passed.
      // The contract is "the last good content, unchanged", which is what is asserted.
      assert.deepEqual(paused, duringIncident, "paused publish returns the last good snapshot");
    }
    assert.equal(faultFireCount, writesBefore, "no write attempts while suspended (no retry storm)");

    // ── 4+5: recovery needs consecutive healthy samples + sentinel, then
    // exactly one recovered event and a CLEAN republished file.
    diskHealthy = true;
    // Drive probe ticks: unhealthy streak is impossible now; need 2 healthy
    // samples + sentinel, then the guard's republish pipeline runs.
    for (let i = 0; i < 6 && !events.some((e) => e.kind === "recovered"); i++) {
      for (const tick of [...ticks]) tick.fn();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const recoveredEvents = events.filter((e) => e.kind === "recovered");
    assert.equal(
      recoveredEvents.length,
      1,
      `exactly one recovered event, got ${JSON.stringify(events.map((e) => e.kind))}`,
    );
    const afterRecovery = await readSnapshot();
    const finalPressure = afterRecovery.storagePressure as Record<string, unknown>;
    assert.equal(finalPressure.stale, false, "the stale tag cleared only after the republish landed");
    assert.equal(finalPressure.suspended, false);

    // ── 6: a fresh ENOSPC after recovery re-suspends as a NEW incident.
    faultArmed = true;
    await runtime.publishMissionSnapshot();
    assert.equal(
      events.filter((e) => e.kind === "incident").length,
      2,
      "a fresh incident follows recovery (the publisher re-pauses on a second disk-full)",
    );

    runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("E2E: recovery never fires while the sentinel probe fails (no false all-clear)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-diskpressure-e2e-sentinel-"));
  const workDir = join(root, ".pi-eng");
  const events: StoragePressureEvent[] = [];
  const ticks: Tick[] = [];
  let faultArmed = false;
  let diskHealthy = false;
  let sentinelOk = false;

  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
      snapshotWriteFault: () => {
        if (!faultArmed) return null;
        faultArmed = false;
        return enospc();
      },
      snapshotPressureOverrides: {
        sampleMount: async (path) => ({ path, healthy: diskHealthy, freeBytes: 1024, freeInodes: 100 }),
        sentinelProbe: async () => sentinelOk,
        schedule: (fn) => {
          const tick: Tick = { fn };
          ticks.push(tick);
          return { stop: () => void ticks.splice(ticks.indexOf(tick), 1) };
        },
        probeIntervalMs: 5,
        config: { probe_interval_ms: 5, recovery_consecutive_checks: 1, jitter_ms: 0 },
        onEvent: (event) => events.push(event),
      },
    });
    runtime.missionStore!.createMission({
      title: "sentinel gate",
      goal: "g",
      user_request: "g",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    await runtime.publishMissionSnapshot();

    faultArmed = true;
    await runtime.publishMissionSnapshot();
    assert.equal(events.filter((e) => e.kind === "incident").length, 1);

    // The mount reports healthy but writes STILL fail (quota-class condition):
    // many healthy ticks must not recover while the sentinel fails.
    diskHealthy = true;
    for (let i = 0; i < 10; i++) {
      for (const tick of [...ticks]) tick.fn();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.filter((e) => e.kind === "recovered").length, 0, "no false all-clear on sentinel failure");

    // The sentinel starts succeeding -> the next tick recovers.
    sentinelOk = true;
    for (let i = 0; i < 4 && !events.some((e) => e.kind === "recovered"); i++) {
      for (const tick of [...ticks]) tick.fn();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(events.filter((e) => e.kind === "recovered").length, 1);
    runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
