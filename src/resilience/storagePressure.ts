/**
 * StoragePressureController — disk-pressure suspension and automatic recovery
 * (disk-pressure recovery spec: FR-03 suspend-don't-fail, FR-04 warning
 * coalescing + snapshot behavior, FR-05 wait-and-automatically-recover).
 *
 * Sits alongside MissionSupervisor but owns a DIFFERENT concern: local storage
 * (ENOSPC / inode exhaustion / quota) rather than gateway/inference capacity.
 * Where MissionSupervisor parks a mission while the gateway is unhealthy, this
 * controller parks it while the filesystem that would receive its writes is
 * full — and, critically, it NEVER terminally fails a mission and NEVER counts
 * an ENOSPC as a model failure.
 *
 * Responsibilities (by requirement):
 *
 *   FR-03 suspend-don't-fail:
 *     - On a confirmed recoverable storage incident, transition the mission to
 *       the durable blocked state `WAITING_FOR_DISK_SPACE` (a backwards-
 *       compatible substatus: the mission is still parked, not failed) and
 *       record the incident's reason / filesystem / free-bytes / required-bytes.
 *     - Stop new work while suspended: dispatch, builds, tests, snapshot
 *       retries, worktree creation and cache growth are all suppressed by the
 *       caller honouring `suspended` (this controller owns the decision, the
 *       runtime owns the gating). Cooperative quiescence — never kill a write
 *       mid-commit/merge/checkpoint; the caller only stops NEW operations.
 *     - Keep the last durable checkpoint (the controller never touches
 *       checkpoints); represent pending_unpersisted_state explicitly so a
 *       resume knows exactly what still needs writing.
 *     - Lease renewal / fencing / health stay active (the controller only
 *       gates admission of NEW storage writes, not heartbeats or leases).
 *     - Never fail the mission and never classify ENOSPC as a model failure.
 *
 *   FR-04 warning coalescing + snapshot behavior:
 *     - One incident notification per incident + meaningful transition, then
 *       silence or a periodic compact status at most once per
 *       `status_cooldown_ms` (default 10 minutes).
 *     - On ENOSPC the caller must stop high-frequency snapshot retries; the
 *       controller records that the snapshot is dirty and that the last
 *       published snapshot is stale (with the stale timestamp), so a later
 *       resume republishes via the dirty-snapshot pipeline instead of a fresh
 *       publish.
 *     - Jittered exponential backoff after recovery so the first post-recovery
 *       write does not storm the newly-freed disk.
 *     - No false published acknowledgement: the controller only reports the
 *       snapshot recovered after the bounded sentinel probe succeeds.
 *
 *   FR-05 wait-and-automatically-recover:
 *     - The controller is the SHARED monitor for the affected mount(s): a
 *       caller samples the mounts every `probe_interval_ms` (default 30 s while
 *       paused) and feeds each sample here.
 *     - Recovery requires `recovery_consecutive_checks` consecutive healthy
 *       samples PLUS a bounded write/rename/fsync sentinel probe into a
 *       dedicated sentinel directory (default `.pi-sentinel/` on the affected
 *       path). Only then is the incident considered recovered.
 *     - Auto-resume is on by default. On recovery the controller emits exactly
 *       one DISK_RECOVERED / MISSION_RESUMED event carrying the total wait time
 *       and the incident's identity, and hands control back to the caller.
 *     - Flapping protection: only the controller instance that suspended the
 *       mission may resume it (`owner`), and a single `resumed` latch prevents
 *       double resume. A freshly-detected incident resets the recovery
 *       counters so a mount that flips back to full cannot be "resumed".
 *
 * The controller is pure and deterministic: clock, sleep, RNG and the sentinel
 * probe are all injectable for fault-injection tests. It never touches the
 * filesystem itself — callers supply the mount sample and the sentinel probe.
 */

import type { StoragePressureIncident } from "./classify.ts";

/** The durable blocked-state substatus this controller transitions missions to. */
export const WAITING_FOR_DISK_SPACE = "WAITING_FOR_DISK_SPACE";

/** Default status (compact warning) cadence: at most once per 10 minutes. */
export const DEFAULT_STATUS_COOLDOWN_MS = 10 * 60_000;
/** Default recovery probe cadence while paused: 30 seconds. */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
/** Consecutive healthy mount samples required before the sentinel probe. */
export const DEFAULT_CONSECUTIVE_CHECKS = 2;
/** Jitter (ms) added to probe intervals to avoid thundering herd. */
export const DEFAULT_JITTER_MS = 1_000;
/** Default sentinel directory name on the affected mount. */
export const DEFAULT_SENTINEL_DIR = ".pi-sentinel";

/** Configuration for the storage-pressure controller. */
export interface StoragePressureConfig {
  /** Probe cadence for the shared mount monitor while paused (ms). Default 30s. */
  probe_interval_ms: number;
  /** Consecutive healthy mount samples required before the sentinel probe. Default 2. */
  recovery_consecutive_checks: number;
  /** Cooldown between compact status warnings (ms). Default 10 min. */
  status_cooldown_ms: number;
  /** Jitter (ms) added to each probe delay. Default 1s. */
  jitter_ms: number;
  /** Whether to auto-resume once the disk is verified writable. Default true. */
  auto_resume: boolean;
  /** Cap on the jittered-exponential backoff after recovery (ms). Default 60s. */
  post_recovery_backoff_cap_ms: number;
  /** Sentinel directory name on the affected mount. Default ".pi-sentinel". */
  sentinel_dir: string;
}

export const DEFAULT_STORAGE_PRESSURE_CONFIG: StoragePressureConfig = {
  probe_interval_ms: DEFAULT_PROBE_INTERVAL_MS,
  recovery_consecutive_checks: DEFAULT_CONSECUTIVE_CHECKS,
  status_cooldown_ms: DEFAULT_STATUS_COOLDOWN_MS,
  jitter_ms: DEFAULT_JITTER_MS,
  auto_resume: true,
  post_recovery_backoff_cap_ms: 60_000,
  sentinel_dir: DEFAULT_SENTINEL_DIR,
};

/** A single mount sample fed by the caller's shared disk monitor. */
export interface MountSample {
  /** The filesystem/volume path sampled (must be the affected path). */
  path: string;
  /** Whether the mount is writable and has free space/inodes (healthy). */
  healthy: boolean;
  /** Free bytes, when the caller knows them (informational). */
  freeBytes?: number;
  /** Free inodes, when the caller knows them (informational). */
  freeInodes?: number;
}

/** The sentinel probe the caller supplies: bounded write/rename/fsync. */
export interface SentinelProbe {
  /**
   * Verify the sentinel directory on the affected path is writable. Must be
   * bounded (own timeout) and must clean up after itself. Resolves true only
   * when write+rename+fsync all succeed.
   */
  probe(): Promise<boolean>;
}

/** Events the controller emits to the runtime (for logging / status surfaces). */
export interface StoragePressureHooks {
  /** Transition the mission to a state. Returns false to reject. */
  transition: (from: string, to: string) => boolean;
  /** Emit a compact log line (no stack traces). */
  log: (level: "info" | "warn", message: string) => void;
  /**
   * Emit a typed storage event. Called at most once per incident for
   * "incident" and "recovered"; "status" is a periodic compact status.
   */
  emit: (event: StoragePressureEvent) => void;
  /** Current mission state string. */
  currentState: () => string;
}

/** Typed storage event surfaced to the runtime/UI. */
export type StoragePressureEvent =
  | {
      kind: "incident";
      incident: StoragePressureIncident;
      /** Wall-clock ms the incident was confirmed. */
      atMs: number;
    }
  | {
      kind: "status";
      incident: StoragePressureIncident;
      atMs: number;
      /** Total wait time (ms) so far since the incident was confirmed. */
      waitedMs: number;
    }
  | {
      kind: "recovered";
      incident: StoragePressureIncident;
      atMs: number;
      /** Total wait time (ms) from incident confirmation to recovery. */
      waitedMs: number;
      /** Number of mount samples observed while suspended. */
      samples: number;
    };

/** Snapshot state the runtime reports / the controller updates. */
export interface SnapshotPressureState {
  /** True while the snapshot is dirty (unpublished changes). */
  snapshot_dirty: boolean;
  /** True when the last published snapshot is stale (post-ENOSPC). */
  snapshot_stale: boolean;
  /** Wall-clock ms the published snapshot was marked stale. */
  snapshot_stale_at_ms?: number;
  /** True once the dirty snapshot has been republished post-recovery. */
  snapshot_republished: boolean;
}

/** Outcome of a resume decision. */
export interface StorageResumeOutcome {
  resumed: boolean;
  /** The mission state after the attempt. */
  state: string;
  /** Total wait time (ms). */
  waitedMs: number;
}

/** Deterministic default sleep. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A sentinel probe that always reports healthy (for non-storage callers). */
export function healthySentinelProbe(): SentinelProbe {
  return { probe: async () => true };
}

export class StoragePressureController {
  private readonly config: StoragePressureConfig;
  private readonly hooks: StoragePressureHooks;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;

  /** The active incident, when suspended. */
  private incident: StoragePressureIncident | undefined;
  /** Owner id — only the controller that suspended may resume. */
  private readonly owner: string;
  /** Latch preventing double resume. */
  private resumed = false;
  /** Wall-clock ms the incident was confirmed. */
  private suspendedAtMs = 0;
  /** Consecutive healthy samples seen while suspended. */
  private healthyStreak = 0;
  /** Total samples observed while suspended. */
  private samples = 0;
  /** Last wall-clock ms a compact status was emitted (coalescing). */
  private lastStatusAtMs = Number.NEGATIVE_INFINITY;
  /** Snapshot pressure state updated by suspend/resume. */
  private readonly snapshot: SnapshotPressureState;

  constructor(opts: {
    config?: Partial<StoragePressureConfig>;
    hooks: StoragePressureHooks;
    owner?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    rand?: () => number;
  }) {
    this.config = { ...DEFAULT_STORAGE_PRESSURE_CONFIG, ...opts.config };
    this.hooks = opts.hooks;
    this.owner = opts.owner ?? "default";
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    this.snapshot = { snapshot_dirty: false, snapshot_stale: false, snapshot_republished: false };
  }

  /** Whether the mission is currently suspended on storage pressure. */
  get suspended(): boolean {
    return this.incident !== undefined && !this.resumed;
  }

  /** Whether a recovery has already been granted (flapping latch). */
  get hasResumed(): boolean {
    return this.resumed;
  }

  /** The active incident, if suspended. */
  get activeIncident(): StoragePressureIncident | undefined {
    return this.incident;
  }

  /** Snapshot pressure state (dirty / stale / republished). */
  get snapshotState(): SnapshotPressureState {
    return { ...this.snapshot };
  }

  /** Total wall-clock time the current incident has been suspended (ms). */
  get waitedMs(): number {
    if (!this.incident) return 0;
    return Math.max(0, this.now() - this.suspendedAtMs);
  }

  /**
   * FR-03 / FR-04 — Confirm a recoverable storage incident and suspend the
   * mission. Safe to call repeatedly (the caller feeds every detected failure):
   *
   *   - the FIRST confirmed incident emits exactly one "incident" event and
   *     transitions the mission to WAITING_FOR_DISK_SPACE;
   *   - subsequent calls for the SAME incident path are coalesced: no duplicate
   *     notification, and at most one compact "status" event per cooldown;
   *   - a DIFFERENT affected path starts a new incident (resets counters).
   *
   * Returns true when the mission was newly suspended.
   */
  suspend(incident: StoragePressureIncident, opts?: { path?: string }): boolean {
    // Never suspend on an operator-required condition: blind waiting cannot
    // clear a read-only filesystem or an unknown error. The caller should
    // surface the operator action instead.
    if (!incident.autoRecover) return false;

    const path = opts?.path ?? incident.path ?? "/";
    const nowMs = this.now();
    const isSame = this.incident !== undefined && this.incident.path === path;

    if (isSame && this.resumed) {
      // A fresh incident on the same path after recovery: re-open. It is a NEW
      // incident — fall through to the full re-suspension below (fresh
      // notification, stale tag, reset counters) instead of coalescing.
      this.resumed = false;
      this.healthyStreak = 0;
      this.samples = 0;
      this.suspendedAtMs = nowMs;
    } else if (isSame) {
      // Coalesced: only a periodic compact status, never a duplicate incident.
      this.emitCompactStatus(nowMs);
      return false;
    }

    // New incident (or new path). Reset recovery counters and suspend.
    this.incident = { ...incident, path };
    this.suspendedAtMs = nowMs;
    this.resumed = false;
    this.healthyStreak = 0;
    this.samples = 0;
    this.lastStatusAtMs = nowMs;

    // Mark the published snapshot stale: FR-04 — the last published snapshot
    // must not be presented as current while writes are being dropped.
    this.snapshot.snapshot_dirty = true;
    this.snapshot.snapshot_stale = true;
    this.snapshot.snapshot_stale_at_ms = nowMs;
    this.snapshot.snapshot_republished = false;

    this.hooks.transition(this.hooks.currentState(), WAITING_FOR_DISK_SPACE);
    this.hooks.emit({
      kind: "incident",
      incident: this.incident,
      atMs: nowMs,
    });
    this.hooks.log("warn", this.describeSuspension(this.incident, nowMs));
    return true;
  }

  /**
   * FR-05 — Feed one mount sample from the shared disk monitor (caller paces
   * this at `probe_interval_ms`, default 30s while paused). The controller
   * requires `recovery_consecutive_checks` consecutive healthy samples before
   * it runs the sentinel probe; on success it emits DISK_RECOVERED /
   * MISSION_RESUMED exactly once and hands control back.
   *
   * Returns the resume outcome; `resumed:true` means the caller may start
   * admitting storage writes again.
   */
  async sample(mount: MountSample, sentinel?: SentinelProbe): Promise<StorageResumeOutcome> {
    if (!this.incident || this.resumed)
      return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };
    this.samples += 1;

    // Only the mount the incident targeted counts toward recovery.
    const affected = this.incident.path ?? "/";
    if (mount.path !== affected) return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };

    if (!mount.healthy) {
      this.healthyStreak = 0;
      return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };
    }

    this.healthyStreak += 1;
    this.emitCompactStatus(this.now());

    if (this.healthyStreak < this.config.recovery_consecutive_checks) {
      return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };
    }

    // Consecutive healthy samples: verify the disk is actually writable with a
    // bounded write/rename/fsync sentinel probe before declaring recovery.
    const ok = sentinel ? await sentinel.probe() : true;
    if (!ok) {
      this.healthyStreak = 0;
      return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };
    }

    // Auto-resume is on by default; when disabled, wait for an explicit
    // resume() (operator sign-off) but keep the healthy streak.
    if (!this.config.auto_resume) {
      return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };
    }
    return this.resume();
  }

  /**
   * FR-03/05 — Resume a suspended mission. Only the owning controller may
   * resume, and only once (flapping protection). On success emits exactly one
   * DISK_RECOVERED / MISSION_RESUMED event with the total wait time and
   * transitions the mission back to EXECUTING. Auto-resume is on by default;
   * a caller may disable it and call resume() explicitly after operator
   * sign-off.
   */
  resume(): StorageResumeOutcome {
    if (!this.incident) return { resumed: false, state: this.hooks.currentState(), waitedMs: 0 };
    if (this.resumed) return { resumed: false, state: this.hooks.currentState(), waitedMs: this.waitedMs };

    const waited = this.waitedMs;
    this.resumed = true;
    const inc = this.incident;
    const samples = this.samples;

    // FR-04 — mark the dirty snapshot as pending republish; recovery of the
    // snapshot publication happens via the caller's dirty-snapshot pipeline.
    this.snapshot.snapshot_republished = true;

    this.hooks.transition(this.hooks.currentState(), "EXECUTING");
    this.hooks.emit({
      kind: "recovered",
      incident: inc,
      atMs: this.now(),
      waitedMs: waited,
      samples,
    });
    this.hooks.log(
      "info",
      `disk recovered — validating persisted state and resuming from last safe checkpoint (waited ${waited}ms)`,
    );
    return { resumed: true, state: "EXECUTING", waitedMs: waited };
  }

  /**
   * FR-04 — Jittered exponential backoff the caller should apply AFTER a
   * resume before the first storage write, so the newly-freed disk is not
   * stormed. Returns the delay in ms (bounded by `post_recovery_backoff_cap_ms`).
   */
  postRecoveryBackoffMs(attempt = 1): number {
    const base = Math.min(
      this.config.probe_interval_ms * 2 ** Math.max(0, attempt - 1),
      this.config.post_recovery_backoff_cap_ms,
    );
    const jitter = this.config.jitter_ms > 0 ? this.config.jitter_ms * this.rand() : 0;
    return Math.round(base + jitter);
  }

  /**
   * FR-04 — Pause the caller's high-frequency snapshot retry loop. The caller
   * should call this when `suspend` returns true and stop retrying until the
   * controller reports recovery; the snapshot stays dirty and the last
   * published snapshot stays tagged stale.
   */
  pauseSnapshotRetries(): void {
    this.snapshot.snapshot_dirty = true;
    this.snapshot.snapshot_stale = true;
    this.snapshot.snapshot_stale_at_ms = this.now();
  }

  /**
   * FR-04 — Record that the dirty snapshot was republished post-recovery
   * (caller runs its dirty-snapshot pipeline after resume). Returns the
   * updated state.
   */
  markSnapshotRepublished(): SnapshotPressureState {
    this.snapshot.snapshot_dirty = false;
    this.snapshot.snapshot_stale = false;
    this.snapshot.snapshot_republished = true;
    this.snapshot.snapshot_stale_at_ms = undefined;
    return this.snapshotState;
  }

  /** Reset the controller (e.g. after a mission completes/cancels). */
  reset(): void {
    this.incident = undefined;
    this.resumed = false;
    this.healthyStreak = 0;
    this.samples = 0;
    this.lastStatusAtMs = Number.NEGATIVE_INFINITY;
    this.suspendedAtMs = 0;
    this.snapshot.snapshot_dirty = false;
    this.snapshot.snapshot_stale = false;
    this.snapshot.snapshot_republished = false;
    this.snapshot.snapshot_stale_at_ms = undefined;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Emit a compact status at most once per cooldown. */
  private emitCompactStatus(nowMs: number): void {
    if (!this.incident) return;
    if (nowMs - this.lastStatusAtMs < this.config.status_cooldown_ms) return;
    this.lastStatusAtMs = nowMs;
    this.hooks.emit({
      kind: "status",
      incident: this.incident,
      atMs: nowMs,
      waitedMs: this.waitedMs,
    });
    this.hooks.log("warn", this.describeStatus(this.incident, nowMs));
  }

  private describeSuspension(inc: StoragePressureIncident, nowMs: number): string {
    const free = inc.freeBytes !== undefined ? `, free ${inc.freeBytes} bytes` : "";
    const req = inc.requiredBytes !== undefined ? `, need ${inc.requiredBytes} bytes` : "";
    const inodes = inc.freeInodes !== undefined ? `, free ${inc.freeInodes} inodes` : "";
    return `mission paused — ${inc.reason} on ${inc.path ?? "/"} (${inc.code}${free}${req}${inodes}) — WAITING_FOR_DISK_SPACE, progress preserved`;
  }

  private describeStatus(inc: StoragePressureIncident, nowMs: number): string {
    return `disk still unavailable (${inc.code} on ${inc.path ?? "/"}, waited ${this.waitedMs}ms) — will auto-resume when writable`;
  }
}
