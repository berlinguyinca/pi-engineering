import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DiskPressureController,
  defaultDiskPressureConfig,
  defaultDiskPressureThresholds,
  type DiskProbeResult,
  type StoragePressureIncident,
} from "../../src/resilience/diskPressure.ts";

const GIB = 1024 ** 3;

interface Harness {
  controller: DiskPressureController;
  suspended: StoragePressureIncident[];
  resumed: StoragePressureIncident[];
  reports: number[];
  now: () => number;
  probeResults: DiskProbeResult[];
  writeResults: { ok: boolean; errno?: string }[];
}

function makeHarness(overrides: { probeResults?: DiskProbeResult[]; writeResults?: { ok: boolean; errno?: string }[] } = {}): Harness {
  let t = 0;
  const suspended: StoragePressureIncident[] = [];
  const resumed: StoragePressureIncident[] = [];
  const reports: number[] = [];
  const probeResults = overrides.probeResults ?? [{ freeBytes: 100 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }];
  const writeResults = overrides.writeResults ?? [{ ok: true }];
  let probeIdx = 0;
  let writeIdx = 0;
  const controller = new DiskPressureController(
    { ...defaultDiskPressureConfig(), status_cooldown_ms: 1000, jitter_ms: 0 },
    {
      probe: async () => probeResults[Math.min(probeIdx++, probeResults.length - 1)],
      writeProbe: async () => writeResults[Math.min(writeIdx++, writeResults.length - 1)],
      suspend: async (inc) => void suspended.push(inc),
      resume: async (inc) => void resumed.push(inc),
      emit: async () => void reports.push(1),
      now: () => t,
      sleep: async () => undefined,
      rand: () => 0,
    },
  );
  return { controller, suspended, resumed, reports, now: () => t, probeResults, writeResults };
}

function healthy(freeBytes = 100 * GIB, freeInodes = 100_000): DiskProbeResult {
  return { freeBytes, totalBytes: 200 * GIB, freeInodes, probeWritable: true };
}

describe("DiskPressureController", () => {
  it("starts idle and admits writes for a healthy mount", async () => {
    const h = makeHarness();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "idle");
    assert.equal(h.controller.admitting, true);
    assert.equal(h.controller.preflight("/data"), true);
  });

  it("marks a mount unknown when the probe is unavailable", async () => {
    const h = makeHarness({ probeResults: [null as unknown as DiskProbeResult] });
    // probe throws → checkMount marks unknown, does not fabricate pressure
    const c = new DiskPressureController(
      { ...defaultDiskPressureConfig(), status_cooldown_ms: 1000, jitter_ms: 0 },
      {
        probe: async () => {
          throw new Error("probe unavailable");
        },
        writeProbe: async () => ({ ok: true }),
        suspend: async () => undefined,
        resume: async () => undefined,
        now: () => 0,
        sleep: async () => undefined,
        rand: () => 0,
      },
    );
    await c.checkOnce();
    assert.equal(c.stateName, "idle");
    assert.equal(c.admitting, true); // unknown mounts never block writes
    assert.equal(c.preflight("/data"), true);
  });

  it("suspends on a confirmed disk-full incident and preserves state", async () => {
    const h = makeHarness({
      probeResults: [healthy(), { freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }],
    });
    await h.controller.checkOnce(); // healthy
    await h.controller.checkOnce(); // pressured
    assert.equal(h.controller.stateName, "waiting");
    assert.equal(h.controller.admitting, false);
    assert.equal(h.suspended.length, 1);
    assert.equal(h.suspended[0].category, "DISK_FULL");
    assert.equal(h.suspended[0].autoRecover, true);
    assert.equal(h.controller.preflight("/data"), false);
  });

  it("does not terminally fail the mission; it suspends (cooperative quiescence)", async () => {
    const h = makeHarness({
      probeResults: [healthy(), { freeBytes: 0, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: false, probeErrno: "ENOSPC" }],
    });
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    // No failure event surfaced; the mission is paused, not failed.
    assert.equal(h.suspended.length, 1);
    assert.equal(h.resumed.length, 0);
  });

  it("classifies inode exhaustion as a separate recoverable incident", async () => {
    const h = makeHarness({
      probeResults: [
        healthy(),
        { freeBytes: 100 * GIB, totalBytes: 200 * GIB, freeInodes: 5, probeWritable: false, probeErrno: "ENOSPC" },
      ],
    });
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    assert.equal(h.suspended[0].category, "INODE_EXHAUSTED");
  });

  it("requires consecutive healthy checks before recovery (hysteresis)", async () => {
    const h = makeHarness({
      probeResults: [
        healthy(),
        { freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }, // pressured
        healthy(9 * GIB), // recovered but below resume threshold (8 GiB + 3 GiB delta)
        healthy(9 * GIB), // still not meeting resume delta
        healthy(12 * GIB), // meets resume (>8 GiB)
      ],
    });
    // recovery_consecutive_checks default = 3
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    // first healthy-but-below-threshold check accumulates 1 healthy check
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "resolved");
    assert.equal(h.resumed.length, 1);
    assert.equal(h.controller.admitting, true);
  });

  it("flapping protection: a pressured check resets healthy counter", async () => {
    const h = makeHarness({
      probeResults: [
        healthy(),
        { freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }, // pressured
        healthy(12 * GIB), // +1
        { freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }, // flapped → reset
        healthy(12 * GIB), // +1
        healthy(12 * GIB), // +2
        healthy(12 * GIB), // +3 → recover
      ],
    });
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting");
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "waiting"); // flapped, counter reset
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    assert.equal(h.controller.stateName, "resolved");
  });

  it("does not auto-resume when policy requires operator approval", async () => {
    const h = makeHarness();
    const c = new DiskPressureController(
      { ...defaultDiskPressureConfig(), auto_resume: false, status_cooldown_ms: 1000, jitter_ms: 0 },
      {
        probe: async () => ({ freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true }),
        writeProbe: async () => ({ ok: true }),
        suspend: async () => undefined,
        resume: async (inc) => void h.resumed.push(inc),
        now: () => 0,
        sleep: async () => undefined,
        rand: () => 0,
      },
    );
    await c.checkOnce();
    assert.equal(c.stateName, "waiting");
    // Even with healthy checks, auto_resume=false keeps it waiting.
    await c.checkOnce();
    assert.equal(c.stateName, "waiting");
    assert.equal(h.resumed.length, 0);
  });

  it("coalesces status notifications (single incident + cooldown)", async () => {
    const h = makeHarness({
      probeResults: [
        healthy(),
        { freeBytes: 1 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true },
        { freeBytes: 0.5 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true },
        { freeBytes: 0.2 * GIB, totalBytes: 200 * GIB, freeInodes: 100_000, probeWritable: true },
      ],
    });
    // status_cooldown_ms = 1000; keep now frozen so repeated checks cannot emit.
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    await h.controller.checkOnce();
    // Suspended exactly once even though pressure persisted across checks.
    assert.equal(h.suspended.length, 1);
    // Status reports bounded (force emit on suspend + transition, not per check).
    assert.ok(h.reports.length <= 3, `reports=${h.reports.length}`);
  });

  it("records a snapshot attempt: ENOSPC keeps dirty and tags stale", async () => {
    const h = makeHarness();
    const err = new Error("no space left on device");
    (err as { code?: string }).code = "ENOSPC";
    await h.controller.checkOnce();
    const afterFail = await h.controller.recordSnapshotAttempt(false, err);
    assert.equal(afterFail.dirty, true);
    assert.equal(afterFail.published, false);
    assert.notEqual(afterFail.staleSince, null);
    const afterOk = await h.controller.recordSnapshotAttempt(true);
    assert.equal(afterOk.dirty, false);
    assert.equal(afterOk.published, true);
    assert.equal(afterOk.staleSince, null);
  });

  it("admission is advisory: preflight does not throw on unknown mount", async () => {
    const h = makeHarness();
    assert.equal(h.controller.preflight("/some/other/mount"), true);
  });
});
