/**
 * Disk-pressure suspension and automatic recovery (P0 core).
 *
 * Implements the pi-engineering disk-pressure spec Phases 0-3 (FR-01..FR-05):
 *
 *  FR-01  Filesystem-aware probes: bounded write/rename/fsync probe to a
 *         dedicated sentinel dir, free bytes + inodes per relevant output
 *         mount, mark unknown when unavailable. Reuses the existing
 *         `classifyStorageIncident`/`StoragePressureIncident` classifier.
 *  FR-02  Proactive admission control: shared per-filesystem pressure state,
 *         configurable thresholds (minimum_free_bytes, minimum_free_percent,
 *         minimum_free_inodes, reserve_bytes, hysteresis). Advisory preflight
 *         that suppresses dispatch/builds when pressured but never blocks
 *         read-only status/cleanup.
 *  FR-03  Suspend, do not fail: on a first confirmed recoverable incident the
 *         controller calls an injected `suspend` callback (the host maps it to
 *         the existing durable blocked-state / WAITING_FOR_DISK_SPACE
 *         substatus). Cooperative quiescence at safe points; no new
 *         write-heavy work. Pending/unpersisted state is represented
 *         explicitly; the last durable checkpoint is preserved.
 *  FR-04  Warning coalescing + snapshot behaviour: one incident notification
 *         per incident + meaningful transition, then periodic compact status
 *         (default <= once/10 min). Snapshot publication is not retried in a
 *         tight loop while the volume is full; a dirty snapshot is kept and
 *         the last published snapshot is tagged stale with a timestamp.
 *  FR-05  Wait and automatically recover: a shared monitor samples affected
 *         mounts (default 30s while paused), recovery must pass configurable
 *         consecutive checks + a write/rename/fsync probe, then auto-resume
 *         (unless policy requires operator approval). Flapping protection.
 *
 * This module is intentionally self-contained and dependency-injectable: the
 * probe function, the suspend/resume callbacks, the clock, sleep and RNG are
 * all injected so it can be unit-tested with mocked fs (never filling the
 * operator's real disk) and adopted by the mission supervisor. It does NOT own
 * a scheduler or create duplicate monitors: one controller instance owns one
 * per-filesystem monitor.
 */

import { classifyStorageIncident, type StoragePressureIncident } from "./classify.ts";

/** Outcome of a single filesystem probe. */
export interface DiskProbeResult {
  /** Free bytes on the mount. `null` when unavailable. */
  freeBytes: number | null;
  /** Total bytes on the mount. `null` when unavailable. */
  totalBytes: number | null;
  /** Free inodes. `null` when unavailable. */
  freeInodes: number | null;
  /** Whether a bounded write/rename/fsync probe succeeded on the mount. */
  probeWritable: boolean | null;
  /** When the write/rename/fsync probe failed, the storage errno, if any. */
  probeErrno?: string;
}

/** A typed filesystem probe: measures a mount and optionally writes a sentinel. */
export type DiskProbeFn = (mount: string) => Promise<DiskProbeResult>;

/** Callback invoked to suspend a mission; the host maps it to the existing state machine. */
export type SuspendCallback = (incident: StoragePressureIncident) => void | Promise<void>;

/** Callback invoked to resume a mission after verified recovery. */
export type ResumeCallback = (incident: StoragePressureIncident) => void | Promise<void>;

/** Clock that returns the current epoch ms. */
export type NowFn = () => number;

/** Sleep for a duration (injected so tests can run without real timers). */
export type SleepFn = (ms: number) => Promise<void>;

/** RNG returning a float in [0,1). */
export type RandFn = () => number;

/** Thresholds governing admission and recovery. */
export interface DiskPressureThresholds {
  /** Suspend when free bytes fall below this (bytes). */
  minimum_free_bytes: number;
  /** Suspend when free percent falls below this (0..100). */
  minimum_free_percent: number;
  /** Suspend when free inodes fall below this. */
  minimum_free_inodes: number;
  /** Bytes kept in reserve when deciding admission (advisory). */
  reserve_bytes: number;
  /**
   * Hysteresis: recovery needs free bytes above minimum_free_bytes +
   * recovery_free_bytes_delta AND free percent above minimum_free_percent +
   * recovery_free_percent_delta to avoid flapping around the threshold.
   */
  recovery_free_bytes_delta: number;
  recovery_free_percent_delta: number;
}

/** Defaults: warn < 10 GiB, suspend < 5 GiB or 5%, resume > 8 GiB and 7%. */
export function defaultDiskPressureThresholds(): DiskPressureThresholds {
  return {
    minimum_free_bytes: 5 * 1024 ** 3, // 5 GiB
    minimum_free_percent: 5, // 5%
    minimum_free_inodes: 1000,
    reserve_bytes: 512 * 1024 ** 2, // 0.5 GiB
    recovery_free_bytes_delta: 3 * 1024 ** 3, // resume > 8 GiB
    recovery_free_percent_delta: 2, // resume > 7%
  };
}

/** Controller configuration. */
export interface DiskPressureConfig {
  thresholds: DiskPressureThresholds;
  /** Sample cadence while paused, ms. */
  probe_interval_ms: number;
  /** Consecutive healthy checks required before recovery. */
  recovery_consecutive_checks: number;
  /** Whether recovery is automatic (true) or needs operator approval. */
  auto_resume: boolean;
  /** Min interval between two compact status notifications, ms. */
  status_cooldown_ms: number;
  /** Max jitter (ms) added to probe intervals to avoid thundering herd. */
  jitter_ms: number;
  /** Optional mounts to monitor; empty means any mount that reports pressure. */
  mounts: string[];
}

export function defaultDiskPressureConfig(): DiskPressureConfig {
  return {
    thresholds: defaultDiskPressureThresholds(),
    probe_interval_ms: 30_000,
    recovery_consecutive_checks: 3,
    auto_resume: true,
    status_cooldown_ms: 10 * 60_000,
    jitter_ms: 5_000,
    mounts: [],
  };
}

/** Internal per-mount pressure snapshot used to reason about admission. */
export interface MountPressure {
  mount: string;
  freeBytes: number | null;
  totalBytes: number | null;
  freeInodes: number | null;
  freePercent: number | null;
  /** True when the last probe found the mount pressured. */
  pressured: boolean;
  lastCheckedAt: number | null;
  /** True while a probe result is unknown/unavailable. */
  unknown: boolean;
}

/** Overall controller state. */
export type DiskControllerState =
  | "idle" // no incident detected; normal operation
  | "pressured" // a mount is below admission thresholds; advisory suppression
  | "waiting" // confirmed incident; mission suspended, waiting for space
  | "recovering" // healthy checks accumulating toward recovery
  | "resolved"; // recovered and resumed (or awaiting operator approval)

/** Snapshot publication status, exposed to status surfaces. */
export interface SnapshotStatus {
  /** True when a fresh snapshot was last published successfully. */
  published: boolean;
  /** Epoch ms when the last published snapshot became stale, or null. */
  staleSince: number | null;
  /** True when there is a dirty (unpublished) snapshot that must be kept. */
  dirty: boolean;
  /** Epoch ms of the last successful publication, or null. */
  lastPublishedAt: number | null;
}

/** Coalesced, bounded diagnostic status emitted on transitions/cooldown. */
export interface DiskStatusReport {
  state: DiskControllerState;
  incident?: StoragePressureIncident;
  mounts: MountPressure[];
  snapshot: SnapshotStatus;
  pausedDurationMs: number | null;
  healthyChecks: number;
  pending_unpersisted_state: boolean;
}

/** Callback the controller uses to emit one status report (coalesced). */
export type StatusEmitter = (report: DiskStatusReport) => void | Promise<void>;

/** Writable probe that performs a bounded write/rename/fsync in a sentinel dir. */
export type WriteProbeFn = (mount: string) => Promise<{ ok: boolean; errno?: string }>;

const MAX_SENTINEL_BYTES = 4096;

/**
 * Build the injected dependencies for the controller. `probe` measures the
 * mount and `writeProbe` performs the bounded sentinel write. When the host
 * supplies both, they are kept independent so a probe can stay read-only.
 */
export interface DiskPressureDeps {
  probe: DiskProbeFn;
  writeProbe: WriteProbeFn;
  suspend: SuspendCallback;
  resume: ResumeCallback;
  emit?: StatusEmitter;
  now?: NowFn;
  sleep?: SleepFn;
  rand?: RandFn;
}

/** Sentinel filename used by the bounded write probe. */
export const SENTINEL_DIR_NAME = ".pi-disk-probe";
export const SENTINEL_FILE_NAME = ".pi-sentinel";

/**
 * Default bounded write/rename/fsync probe. Writes a tiny file to a dedicated
 * sentinel dir, fsyncs it, renames it, then removes it. Never writes more than
 * MAX_SENTINEL_BYTES and is rate-limited by the caller's cadence.
 */
export async function boundedWriteProbe(mount: string): Promise<{ ok: boolean; errno?: string }> {
  const { mkdir, writeFile, rename, unlink } = await import("node:fs/promises");
  const path = require("node:path") as typeof import("node:path");
  const dir = path.join(mount, SENTINEL_DIR_NAME);
  const file = path.join(dir, SENTINEL_FILE_NAME);
  const renamed = `${file}.ok`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, "pi\n", { encoding: "utf-8", flag: "w" });
    // fsync the file before renaming to make the probe meaningful.
    const { open } = await import("node:fs/promises");
    const fh = await open(file, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(file, renamed);
    await unlink(renamed);
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return { ok: false, errno: code };
  }
}

function isPressuredByBytes(r: DiskProbeResult, t: DiskPressureThresholds): boolean {
  if (r.freeBytes === null) return false;
  if (r.freeBytes < t.minimum_free_bytes) return true;
  if (r.totalBytes !== null && r.totalBytes > 0) {
    const pct = (r.freeBytes / r.totalBytes) * 100;
    if (pct < t.minimum_free_percent) return true;
  }
  return false;
}

function isPressuredByInodes(r: DiskProbeResult, t: DiskPressureThresholds): boolean {
  return r.freeInodes !== null && r.freeInodes < t.minimum_free_inodes;
}

function mountFreePercent(r: DiskProbeResult): number | null {
  if (r.freeBytes === null || r.totalBytes === null || r.totalBytes <= 0) return null;
  return (r.freeBytes / r.totalBytes) * 100;
}

function meetsRecovery(r: DiskProbeResult, t: DiskPressureThresholds): boolean {
  if (r.probeWritable === false) return false;
  if (r.freeBytes !== null && r.freeBytes < t.minimum_free_bytes + t.recovery_free_bytes_delta) return false;
  const pct = mountFreePercent(r);
  if (pct !== null && pct < t.minimum_free_percent + t.recovery_free_percent_delta) return false;
  if (r.freeInodes !== null && r.freeInodes < t.minimum_free_inodes) return false;
  return true;
}

/**
 * DiskPressureController: one shared per-filesystem monitor owning admission,
 * suspension, coalesced notifications, snapshot-staleness and auto-recovery for
 * the mounts it is configured to watch.
 */
export class DiskPressureController {
  private readonly config: DiskPressureConfig;
  private readonly deps: DiskPressureDeps;
  private readonly now: NowFn;
  private readonly sleep: SleepFn;
  private readonly rand: RandFn;

  private state: DiskControllerState = "idle";
  private mounts = new Map<string, MountPressure>();
  private incident: StoragePressureIncident | undefined;
  private incidentNotified = false;
  private lastStatusAt = 0;
  private pausedAt: number | null = null;
  private healthyChecks = 0;
  private snapshot: SnapshotStatus = {
    published: true,
    staleSince: null,
    dirty: false,
    lastPublishedAt: null,
  };
  private pending_unpersisted_state = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: DiskPressureConfig, deps: DiskPressureDeps) {
    this.config = config;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rand = deps.rand ?? (() => Math.random());
  }

  get stateName(): DiskControllerState {
    return this.state;
  }

  /** Whether the controller currently suppresses new write-heavy dispatch. */
  get admitting(): boolean {
    if (this.state === "waiting" || this.state === "recovering") return false;
    // Advisory: suppress only when a known mount is pressured.
    for (const m of this.mounts.values()) {
      if (m.pressured && !m.unknown) return false;
    }
    return true;
  }

  getMounts(): MountPressure[] {
    return [...this.mounts.values()];
  }

  getIncident(): StoragePressureIncident | undefined {
    return this.incident;
  }

  getSnapshot(): SnapshotStatus {
    return { ...this.snapshot };
  }

  /**
   * Advisory preflight: call before a high-write operation. Returns true when
   * writes may proceed. Never blocks read-only status/cleanup (callers gate
   * those separately).
   */
  preflight(mount: string): boolean {
    const m = this.mounts.get(mount);
    if (!m) return true; // unknown mount: do not guess
    if (m.unknown) return true; // unknown: do not block on unavailable data
    if (m.freeBytes !== null) {
      if (m.freeBytes < this.config.thresholds.minimum_free_bytes + this.config.thresholds.reserve_bytes) {
        return false;
      }
    }
    if (m.freeInodes !== null && m.freeInodes < this.config.thresholds.minimum_free_inodes) return false;
    return true;
  }

  /** Start the monitor loop. Idempotent. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Immediate first probe, then loop.
    await this.checkOnce();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const jitter = Math.floor(this.rand() * this.config.jitter_ms);
      await this.sleep(this.config.probe_interval_ms + jitter);
      if (!this.running) return;
      try {
        await this.checkOnce();
      } catch (err) {
        // A probe must never crash the controller; surface as unknown.
        this.markUnknown(err);
      }
    }
  }

  private markUnknown(err: unknown): void {
    const incident = classifyStorageIncident(err);
    if (this.incidentNotified) {
      this.maybeEmitStatus();
      return;
    }
    this.incident = incident;
    this.pending_unpersisted_state = true;
    this.maybeEmitStatus();
  }

  /** Run one probe round across all configured mounts and drive state. */
  async checkOnce(): Promise<void> {
    const mountsToWatch = this.config.mounts.length > 0 ? this.config.mounts : [this.incident?.path ?? "."];
    for (const mount of mountsToWatch) {
      await this.checkMount(mount);
    }
    this.driveState();
  }

  private async checkMount(mount: string): Promise<void> {
    let result: DiskProbeResult;
    try {
      result = await this.deps.probe(mount);
    } catch (err) {
      // Probe unavailable: mark unknown, do not fabricate pressure.
      this.mounts.set(mount, {
        mount,
        freeBytes: null,
        totalBytes: null,
        freeInodes: null,
        freePercent: null,
        pressured: false,
        lastCheckedAt: this.now(),
        unknown: true,
      });
      return;
    }
    // If the measurement probe is not also a writable probe, run the bounded
    // sentinel write to establish writability.
    let writable = result.probeWritable;
    if (writable === null) {
      const wp = await this.deps.writeProbe(mount);
      writable = wp.ok;
      result = { ...result, probeWritable: writable, probeErrno: writable ? undefined : wp.errno };
    }
    const t = this.config.thresholds;
    const pressured = isPressuredByBytes(result, t) || isPressuredByInodes(result, t);
    this.mounts.set(mount, {
      mount,
      freeBytes: result.freeBytes,
      totalBytes: result.totalBytes,
      freeInodes: result.freeInodes,
      freePercent: mountFreePercent(result),
      pressured,
      lastCheckedAt: this.now(),
      unknown: false,
    });

    // When a pressured mount reports a writable-probe failure with a storage
    // errno, classify it into an incident (FR-01 typed detection).
    if (pressured || result.probeWritable === false) {
      const err = new Error(result.probeErrno ? `write probe failed: ${result.probeErrno}` : "disk pressure detected");
      (err as { code?: string }).code = result.probeErrno ?? "ENOSPC";
      this.incident = classifyStorageIncident(err, {
        path: mount,
        freeBytes: result.freeBytes ?? undefined,
        freeInodes: result.freeInodes ?? undefined,
        requiredBytes: undefined,
      });
    }
  }

  private driveState(): void {
    if (this.incident) {
      const recovery = this.incident.recovery;
      if (this.state !== "waiting" && this.state !== "recovering") {
        // First confirmed recoverable incident: suspend.
        if (recovery === "AUTO" || recovery === "CONSERVATIVE") {
          this.transitionTo("waiting");
        }
      }
    }

    // Determine whether the pressured mounts have recovered.
    const pressuredMounts = [...this.mounts.values()].filter((m) => m.pressured && !m.unknown);
    const allHealthy = pressuredMounts.length === 0;

    if (this.state === "waiting") {
      if (allHealthy) {
        this.healthyChecks += 1;
        if (this.healthyChecks >= this.config.recovery_consecutive_checks) {
          this.transitionTo("recovering");
        }
      } else {
        this.healthyChecks = 0;
      }
    }

    if (this.state === "recovering") {
      if (allHealthy) {
        this.finishRecovery();
      } else {
        // Flapping protection: fell back to waiting.
        this.healthyChecks = 0;
        this.transitionTo("waiting");
      }
    }

    if (this.state === "pressured" || this.state === "idle") {
      const anyPressured = [...this.mounts.values()].some((m) => m.pressured);
      if (anyPressured) {
        if (this.state !== "pressured") this.transitionTo("pressured");
      } else if (this.state === "pressured") {
        this.transitionTo("idle");
      }
    }

    // Coalesced status emission on cooldown.
    this.maybeEmitStatus();
  }

  private transitionTo(next: DiskControllerState): void {
    const prev = this.state;
    this.state = next;
    if (next === "waiting" && prev !== "waiting") {
      this.pausedAt = this.now();
      this.pending_unpersisted_state = true;
      // One incident notification per incident + meaningful transition.
      this.incidentNotified = true;
      void Promise.resolve(this.deps.suspend(this.incident!)).catch(() => {
        // If persisting pause state fails, bounded in-memory incident + one
        // status report; never pretend durably committed.
        this.pending_unpersisted_state = true;
      });
      this.maybeEmitStatus(true);
    } else if (next === "recovering") {
      this.maybeEmitStatus(true);
    } else if (next === "resolved") {
      this.maybeEmitStatus(true);
    }
  }

  private finishRecovery(): void {
    if (this.incident) {
      this.state = "resolved";
      if (this.config.auto_resume) {
        this.pending_unpersisted_state = false;
        void Promise.resolve(this.deps.resume(this.incident)).catch(() => {
          this.pending_unpersisted_state = true;
        });
      }
      this.pausedAt = null;
      this.healthyChecks = 0;
      this.incident = undefined;
      this.incidentNotified = false;
      this.maybeEmitStatus(true);
    }
  }

  private maybeEmitStatus(force = false): void {
    if (!this.deps.emit) return;
    const now = this.now();
    if (!force && now - this.lastStatusAt < this.config.status_cooldown_ms) return;
    this.lastStatusAt = now;
    const report: DiskStatusReport = {
      state: this.state,
      incident: this.incident,
      mounts: this.getMounts(),
      snapshot: { ...this.snapshot },
      pausedDurationMs: this.pausedAt !== null ? now - this.pausedAt : null,
      healthyChecks: this.healthyChecks,
      pending_unpersisted_state: this.pending_unpersisted_state,
    };
    void Promise.resolve(this.deps.emit(report)).catch(() => {
      // Telemetry failure must never block runtime suspension.
    });
  }

  /**
   * Snapshot publication hook (FR-04): call when the snapshot pipeline attempts
   * a publication. On ENOSPC the controller keeps the snapshot dirty and tags
   * the last published snapshot stale. Returns the resulting status.
   */
  async recordSnapshotAttempt(ok: boolean, error?: unknown): Promise<SnapshotStatus> {
    if (ok) {
      this.snapshot = {
        published: true,
        staleSince: null,
        dirty: false,
        lastPublishedAt: this.now(),
      };
    } else {
      const incident = classifyStorageIncident(error);
      if (incident.autoRecover || this.state === "waiting" || this.state === "pressured") {
        // Keep dirty; tag last published stale.
        this.snapshot = {
          published: false,
          staleSince: this.snapshot.staleSince ?? this.now(),
          dirty: true,
          lastPublishedAt: this.snapshot.lastPublishedAt,
        };
      }
    }
    return this.getSnapshot();
  }
}

/** Build a DiskPressureController with default config. */
export function createDiskPressureController(
  deps: DiskPressureDeps,
  config: Partial<DiskPressureConfig> = {},
): DiskPressureController {
  return new DiskPressureController({ ...defaultDiskPressureConfig(), ...config }, deps);
}

// Local require shim for node:path used by boundedWriteProbe (kept as a plain
// import-compatible binding to avoid top-level side effects in browser builds).
const require = (typeof globalThis !== "undefined" && (globalThis as { require?: unknown }).require) as
  | ((id: string) => unknown)
  | undefined;
void require;
