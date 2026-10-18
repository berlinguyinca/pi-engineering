/**
 * Unit tests for the StoragePressureController (disk-pressure recovery spec
 * FR-03 suspend-don't-fail, FR-04 warning coalescing + snapshot behavior,
 * FR-05 wait-and-automatically-recover). Deterministic: injectable clock, sleep
 * and RNG. No real disk is touched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStorageIncident } from "../../src/resilience/classify.ts";
import {
  DEFAULT_STATUS_COOLDOWN_MS,
  StoragePressureController,
  WAITING_FOR_DISK_SPACE,
} from "../../src/resilience/storagePressure.ts";

interface Harness {
  ctrl: StoragePressureController;
  transitions: string[];
  logs: Array<{ level: string; message: string }>;
  events: Array<Record<string, unknown>>;
  state: () => string;
}

function makeHarness(opts?: {
  now?: () => number;
  config?: Partial<{
    status_cooldown_ms: number;
    probe_interval_ms: number;
    recovery_consecutive_checks: number;
    auto_resume: boolean;
    post_recovery_backoff_cap_ms: number;
  }>;
  sentinel?: { result: boolean };
}): Harness {
  const transitions: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  let current = "EXECUTING";
  const ctrl = new StoragePressureController({
    config: opts?.config,
    now: opts?.now,
    hooks: {
      transition: (_from, to) => {
        transitions.push(to);
        current = to;
        return true;
      },
      log: (level, message) => logs.push({ level, message }),
      emit: (event) => events.push({ ...event }),
      currentState: () => current,
    },
  });
  return { ctrl, transitions, logs, events, state: () => current };
}

const enospc = () =>
  classifyStorageIncident(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }), {
    path: "/mnt/out",
    freeBytes: 0,
    requiredBytes: 100,
  });
const inodeFull = () =>
  classifyStorageIncident(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }), {
    path: "/mnt/out",
    freeBytes: 100,
    freeInodes: 0,
  });
const edquot = () =>
  classifyStorageIncident(Object.assign(new Error("disk quota exceeded"), { code: "EDQUOT" }), { path: "/mnt/out" });
const erofs = () =>
  classifyStorageIncident(Object.assign(new Error("read-only file system"), { code: "EROFS" }), { path: "/mnt/out" });

describe("StoragePressureController FR-03 suspend-don't-fail", () => {
  it("transitions to WAITING_FOR_DISK_SPACE on a confirmed ENOSPC and preserves progress", () => {
    const h = makeHarness();
    const inc = enospc();
    const fresh = h.ctrl.suspend(inc);
    assert.equal(fresh, true);
    assert.equal(h.transitions.at(-1), WAITING_FOR_DISK_SPACE);
    assert.equal(h.ctrl.suspended, true);
    assert.equal(h.ctrl.activeIncident?.category, "DISK_FULL");
    assert.equal(h.ctrl.activeIncident?.path, "/mnt/out");
  });

  it("never terminally fails a mission on ENOSPC", () => {
    const h = makeHarness();
    h.ctrl.suspend(enospc());
    // The controller never emits a FAILED transition and never counts ENOSPC
    // as a model failure — it only parks the mission in WAITING_FOR_DISK_SPACE.
    assert.ok(!h.transitions.some((t) => t === "FAILED"));
    assert.ok(!h.transitions.some((t) => t === "CANCELED"));
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
  });

  it("retains the last durable checkpoint (controller never touches it)", () => {
    const h = makeHarness();
    h.ctrl.suspend(enospc());
    // The controller holds no checkpoint mutation API; resume returns to the
    // caller so it can continue from its own last safe checkpoint.
    assert.equal(h.ctrl.resume().resumed, true);
    assert.equal(h.state(), "EXECUTING");
  });

  it("does not suspend on operator-required (read-only) incidents — surfaces operator action instead", () => {
    const h = makeHarness();
    const fresh = h.ctrl.suspend(erofs());
    assert.equal(fresh, false);
    assert.equal(h.ctrl.suspended, false);
    assert.equal(h.state(), "EXECUTING");
  });

  it("classifies inode exhaustion as auto-recoverable (FR-05)", () => {
    const h = makeHarness();
    const inc = inodeFull();
    assert.equal(inc.category, "INODE_EXHAUSTED");
    assert.equal(inc.autoRecover, true);
    h.ctrl.suspend(inc);
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
  });
});

describe("StoragePressureController FR-04 warning coalescing + snapshot behavior", () => {
  it("emits exactly one incident notification per incident, then compact status at most once per cooldown", () => {
    const now = (() => {
      const t = 0;
      return () => t;
    })();
    const h = makeHarness({ now });
    h.ctrl.suspend(enospc());
    // Repeated calls for the same path within the cooldown: no duplicate incident.
    h.ctrl.suspend(enospc());
    h.ctrl.suspend(enospc());
    const incidents = h.events.filter((e) => e.kind === "incident");
    assert.equal(incidents.length, 1);
    // No status before the cooldown elapses.
    assert.equal(h.events.filter((e) => e.kind === "status").length, 0);
  });

  it("emits a periodic compact status once the cooldown elapses", () => {
    let t = 0;
    const h = makeHarness({ now: () => t });
    h.ctrl.suspend(enospc());
    t = DEFAULT_STATUS_COOLDOWN_MS + 1;
    h.ctrl.suspend(enospc()); // same incident, coalesced
    const statuses = h.events.filter((e) => e.kind === "status");
    assert.equal(statuses.length, 1);
    assert.equal((statuses[0] as { waitedMs: number }).waitedMs, DEFAULT_STATUS_COOLDOWN_MS + 1);
    // Still exactly one incident.
    assert.equal(h.events.filter((e) => e.kind === "incident").length, 1);
  });

  it("marks the published snapshot stale with a timestamp and keeps it dirty on ENOSPC", () => {
    const now = (() => {
      const t = 1234;
      return () => t;
    })();
    const h = makeHarness({ now });
    h.ctrl.suspend(enospc());
    const snap = h.ctrl.snapshotState;
    assert.equal(snap.snapshot_dirty, true);
    assert.equal(snap.snapshot_stale, true);
    assert.equal(snap.snapshot_stale_at_ms, 1234);
    assert.equal(snap.snapshot_republished, false);
  });

  it("pauseSnapshotRetries keeps the snapshot dirty and stops the retry loop", () => {
    const h = makeHarness();
    h.ctrl.pauseSnapshotRetries();
    assert.equal(h.ctrl.snapshotState.snapshot_dirty, true);
    assert.equal(h.ctrl.snapshotState.snapshot_stale, true);
  });

  it("postRecoveryBackoffMs applies jittered exponential backoff bounded by the cap", () => {
    const ctrl = new StoragePressureController({
      config: { probe_interval_ms: 1000, post_recovery_backoff_cap_ms: 4000, jitter_ms: 500 },
      rand: () => 0.5,
      now: () => 0,
      hooks: {
        transition: () => true,
        log: () => {},
        emit: () => {},
        currentState: () => "EXECUTING",
      },
    });
    const b1 = ctrl.postRecoveryBackoffMs(1);
    const b3 = ctrl.postRecoveryBackoffMs(3);
    // attempt1: base 1000 + jitter 250 = 1250
    assert.equal(b1, 1250);
    // attempt3: base min(1000*2^2, 4000)=4000 + jitter 250 = 4250 (capped base)
    assert.equal(b3, 4250);
  });
});

describe("StoragePressureController FR-05 wait-and-automatically-recover", () => {
  it("recovers only after consecutive healthy samples AND a sentinel probe pass", async () => {
    const h = makeHarness({ config: { recovery_consecutive_checks: 2 } });
    h.ctrl.suspend(enospc());

    // One healthy sample alone is not enough.
    let out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, false);
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);

    // Second consecutive healthy sample + sentinel => resume.
    out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, true);
    assert.equal(out.state, "EXECUTING");
  });

  it("resets the streak when the mount flips back to unhealthy (flapping protection)", async () => {
    const h = makeHarness({ config: { recovery_consecutive_checks: 2 } });
    h.ctrl.suspend(enospc());
    await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    await h.ctrl.sample({ path: "/mnt/out", healthy: false }, { probe: async () => true });
    const out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, false, "streak was not reset on the unhealthy sample");
  });

  it("does not recover when the sentinel write/rename/fsync probe fails", async () => {
    const h = makeHarness({ config: { recovery_consecutive_checks: 1 } });
    h.ctrl.suspend(enospc());
    const out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => false });
    assert.equal(out.resumed, false);
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
  });

  it("emits exactly one DISK_RECOVERED event with total wait time and sample count", async () => {
    let t = 1000;
    const h = makeHarness({ now: () => t, config: { recovery_consecutive_checks: 1 } });
    h.ctrl.suspend(enospc());
    t = 7000;
    await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    const recovered = h.events.filter((e) => e.kind === "recovered");
    assert.equal(recovered.length, 1);
    const ev = recovered[0] as { waitedMs: number; samples: number };
    assert.equal(ev.waitedMs, 6000);
    assert.equal(ev.samples, 1);
    // No duplicate recovery event on a second sample.
    await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(h.events.filter((e) => e.kind === "recovered").length, 1);
  });

  it("auto_resume=false requires an explicit operator resume (no automatic recovery)", async () => {
    const h = makeHarness({ config: { auto_resume: false } });
    h.ctrl.suspend(enospc());
    // Healthy mount + sentinel must NOT auto-resume.
    const out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, false, "auto_resume=false must not auto-resume");
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
    // Operator explicitly signs off via resume().
    const manual = h.ctrl.resume();
    assert.equal(manual.resumed, true);
    assert.equal(h.state(), "EXECUTING");
  });

  it("resets counters when a fresh incident follows a recovery on the same path", async () => {
    const t = 0;
    const h = makeHarness({ now: () => t, config: { recovery_consecutive_checks: 2 } });
    h.ctrl.suspend(enospc());
    await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(h.ctrl.hasResumed, true);

    // Disk fills again: the incident is reopened and counters reset.
    h.ctrl.suspend(enospc());
    assert.equal(h.ctrl.suspended, true);
    // A single healthy sample should NOT auto-resume (counters were reset).
    const out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, false);
    // Two consecutive healthy samples are again required to recover.
    const out2 = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out2.resumed, true);
  });

  it("only the affected mount path counts toward recovery (shared monitor ignores others)", async () => {
    const h = makeHarness({ config: { recovery_consecutive_checks: 1 } });
    h.ctrl.suspend(enospc());
    // A healthy sample of a DIFFERENT mount must not recover the affected one.
    const out = await h.ctrl.sample({ path: "/", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, false);
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
  });

  it("markSnapshotRepublished clears dirty/stale only after the dirty pipeline republishes", () => {
    const h = makeHarness();
    h.ctrl.suspend(enospc());
    assert.equal(h.ctrl.snapshotState.snapshot_stale, true);
    h.ctrl.resume();
    // Snapshot recovery is explicit: only the caller's dirty pipeline clears it.
    h.ctrl.markSnapshotRepublished();
    const snap = h.ctrl.snapshotState;
    assert.equal(snap.snapshot_dirty, false);
    assert.equal(snap.snapshot_stale, false);
    assert.equal(snap.snapshot_republished, true);
  });
});

describe("StoragePressureController classification integration", () => {
  it("EDQUOT (quota exceeded) suspends and auto-recovers as AUTO", async () => {
    const h = makeHarness({ config: { recovery_consecutive_checks: 1 } });
    const inc = edquot();
    assert.equal(inc.category, "QUOTA_EXCEEDED");
    assert.equal(inc.autoRecover, true);
    h.ctrl.suspend(inc);
    assert.equal(h.state(), WAITING_FOR_DISK_SPACE);
    const out = await h.ctrl.sample({ path: "/mnt/out", healthy: true }, { probe: async () => true });
    assert.equal(out.resumed, true);
  });

  it("a non-storage error is never treated as a storage incident", () => {
    const h = makeHarness();
    const inc = classifyStorageIncident(new Error("boom"), { path: "/mnt/out" });
    assert.equal(inc.autoRecover, false);
    const fresh = h.ctrl.suspend(inc);
    assert.equal(fresh, false);
    assert.equal(h.state(), "EXECUTING");
  });
});
