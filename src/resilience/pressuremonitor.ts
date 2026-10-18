/**
 * Shared storage-pressure monitor (disk-pressure spec FR-03/FR-05, Phases 0-3).
 *
 * One monitor per filesystem set, shared by every controller in the process:
 * the spec's central data-preservation requirement is that a mission is
 * SUSPENDED, not failed, the first time a recoverable storage incident is
 * confirmed — and that nobody restarts work the instant a number looks better.
 *
 * Responsibilities (and nothing else):
 *  - sample the configured mounts on an interval (default 30 s while paused);
 *  - confirm an incident before declaring pressure, and require a configurable
 *    number of CONSECUTIVE clean samples plus a write/rename/fsync probe pass
 *    before declaring recovery;
 *  - hold a durable ownership record so two processes cannot both resume the
 *    same mission (spec §3.3 "one controller per mission", §3.4 flapping);
 *  - hand the resulting state transitions to the caller through `onChange`;
 *    the caller owns the mission state machine, this module does not dispatch,
 *    suspend, or resume anything itself.
 *
 * The durable pieces (blocked state, `WAITING_FOR_DISK_SPACE` substatus,
 * snapshot staleness, worktree creation gate) live in their own owners; this
 * module is the shared sensor + decision function they all read.
 */

import type { StorageProbe, StorageProbeResult, StorageProbeSnapshot } from "./storageprobe.ts";
import type { StoragePressureIncident } from "./classify.ts";

/** Default sampling cadence while paused (spec FR-05: 30s). */
export const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
/** Clean samples required before declaring recovery (spec FR-05: 3). */
export const DEFAULT_RECOVERY_CONSECUTIVE_CHECKS = 3;
/** Flap window / limits (spec §3.4). */
export const DEFAULT_FLAP_WINDOW_MS = 10 * 60_000;
export const DEFAULT_FLAP_MAX_SUSPENSIONS = 3;
/** Backoff applied to sampling after a flapping trip. */
export const DEFAULT_FLAP_BACKOFF_MS = 5 * 60_000;

/** Why a mission-scoped controller stopped watching. */
export type MonitorStopReason = "operator" | "resolved" | "flap_backoff" | "already_owned";

/** Lifecycle of a pressure incident on a monitored mount set. */
export type MonitorPhase = "idle" | "degraded" | "suspended" | "recovering" | "flap_backoff";

export interface PressureMonitorOptions {
  probe: StorageProbe;
  /** Sampling cadence while suspended (default 30 s). */
  sampleIntervalMs?: number;
  /** Consecutive clean samples (with a passed write probe) to declare recovery. */
  recoveryConsecutiveChecks?: number;
  /** Sliding window for flapping detection. */
  flapWindowMs?: number;
  /** Suspensions inside the window before the monitor backs off. */
  flapMaxSuspensions?: number;
  /** Sampling pause after a flapping trip. */
  flapBackoffMs?: number;
  /** Durable ownership store (single-controller guard). */
  ownership?: MonitorOwnership;
  /** Identity used to claim ownership. */
  ownerId?: string;
  /** Transition sink. Must not throw; errors are swallowed by design. */
  onChange?: (change: PressureChange) => void;
  /** Injectable clock (tests). */
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** A state transition produced by the monitor. */
export interface PressureChange {
  phase: MonitorPhase;
  /** True when new dispatch/builds/growth must be suppressed. */
  pressured: boolean;
  /** Mounts currently pressured or unknown. */
  blocked: StorageProbeResult[];
  /** The incident that opened (or most recently characterised) the episode. */
  incident?: StoragePressureIncident;
  /** Monotonic per-monitor episode id; changes when a new episode opens. */
  episode: number;
  consecutiveCleanSamples: number;
  reason: string;
  at: number;
}

/** Durable single-controller ownership record (see FileMonitorOwnership). */
export interface MonitorOwnershipRecord {
  scope: string;
  owner: string;
  acquiredAt: number;
  /** Epoch-ms; a held record past this is considered abandoned. */
  expiresAt: number;
  /** Bumped on every re-acquire by the same owner. */
  fence: number;
}

/**
 * Durable ownership contract. Implementations must be atomic at the storage
 * layer (compare-and-set on the record) — an in-memory-only guard is not
 * enough across processes.
 */
export interface MonitorOwnership {
  /** Claim the scope; resolves true when this owner holds it. */
  claim(scope: string, owner: string, ttlMs: number, now: number): Promise<MonitorOwnershipRecord | undefined>;
  /** Release only if `owner` currently holds it. */
  release(scope: string, owner: string): Promise<void>;
  /** Current holder, if any. */
  peek(scope: string): Promise<MonitorOwnershipRecord | undefined>;
}

/** In-memory ownership (default; single process). */
export class MemoryMonitorOwnership implements MonitorOwnership {
  private readonly records = new Map<string, MonitorOwnershipRecord>();

  async claim(scope: string, owner: string, ttlMs: number, now: number): Promise<MonitorOwnershipRecord | undefined> {
    const current = this.records.get(scope);
    if (current && current.owner !== owner && current.expiresAt > now) return undefined;
    const record: MonitorOwnershipRecord = {
      scope,
      owner,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      fence: (current?.fence ?? 0) + 1,
    };
    this.records.set(scope, record);
    return record;
  }

  async release(scope: string, owner: string): Promise<void> {
    const current = this.records.get(scope);
    if (current && current.owner === owner) this.records.delete(scope);
  }

  async peek(scope: string): Promise<MonitorOwnershipRecord | undefined> {
    const current = this.records.get(scope);
    return current && current.expiresAt > Date.now() ? current : undefined;
  }
}

/** Aggregate a snapshot into a pressure verdict. */
export function verdictOf(snapshot: StorageProbeSnapshot): {
  pressured: boolean;
  blocked: StorageProbeResult[];
  incident?: StoragePressureIncident;
} {
  const blocked = snapshot.results.filter((r) => r.status !== "ok");
  if (blocked.length === 0) return { pressured: false, blocked: [] };
  // Prefer an operator-class incident (read-only mount) over an auto-recoverable
  // one so the surfaced reason is the one that actually needs a human.
  const incident =
    blocked.find((r) => r.incident?.needsOperator)?.incident ?? blocked.find((r) => r.incident)?.incident;
  return { pressured: true, blocked, ...(incident ? { incident } : {}) };
}

/**
 * The shared pressure monitor. `start()` samples once immediately and then on
 * an interval; `sampleNow()` lets a caller force a sample (e.g. right before
 * an admission decision, or on shutdown).
 */
export class StoragePressureMonitor {
  private readonly probe: StorageProbe;
  private readonly sampleIntervalMs: number;
  private readonly recoveryChecks: number;
  private readonly flapWindowMs: number;
  private readonly flapMax: number;
  private readonly flapBackoffMs: number;
  private readonly ownership?: MonitorOwnership;
  private readonly ownerId: string;
  private readonly onChange?: (c: PressureChange) => void;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private phase: MonitorPhase = "idle";
  private episode = 0;
  private clean = 0;
  private suspensions: number[] = [];
  private lastIncident?: StoragePressureIncident;
  private lastBlocked: StorageProbeResult[] = [];
  private lastSnapshot?: StorageProbeSnapshot;
  private timer?: unknown;
  private running = false;
  private sampling = false;
  private backoffUntil = 0;
  private ownershipHeld = false;
  /** Total samples taken (diagnostics/tests). */
  samples = 0;

  constructor(opts: PressureMonitorOptions) {
    this.probe = opts.probe;
    this.sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.recoveryChecks = Math.max(1, opts.recoveryConsecutiveChecks ?? DEFAULT_RECOVERY_CONSECUTIVE_CHECKS);
    this.flapWindowMs = opts.flapWindowMs ?? DEFAULT_FLAP_WINDOW_MS;
    this.flapMax = opts.flapMaxSuspensions ?? DEFAULT_FLAP_MAX_SUSPENSIONS;
    this.flapBackoffMs = opts.flapBackoffMs ?? DEFAULT_FLAP_BACKOFF_MS;
    this.ownership = opts.ownership;
    this.ownerId = opts.ownerId ?? `monitor-${process.pid}`;
    this.onChange = opts.onChange;
    this.now = opts.now ?? (() => Date.now());
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  getPhase(): MonitorPhase {
    return this.phase;
  }

  getEpisode(): number {
    return this.episode;
  }

  /** True when new dispatch/builds/growth must be suppressed. */
  isPressured(): boolean {
    return this.phase === "suspended" || this.phase === "recovering" || this.phase === "degraded";
  }

  /** Mounts blocked at the last sample (pressured or unknown). */
  blockedMounts(): StorageProbeResult[] {
    return [...this.lastBlocked];
  }

  lastSnapshotInfo(): StorageProbeSnapshot | undefined {
    return this.lastSnapshot;
  }

  /** Current durable change object (for status surfaces). */
  currentChange(): PressureChange {
    return this.change("no change");
  }

  /** Begin watching. No-op when another process holds ownership. */
  async start(): Promise<{ started: boolean; reason?: MonitorStopReason }> {
    if (this.running) return { started: true };
    if (this.ownership) {
      const rec = await this.ownership.claim("storage-pressure", this.ownerId, this.sampleIntervalMs * 4, this.now());
      if (!rec) {
        this.phase = "idle";
        return { started: false, reason: "already_owned" };
      }
      this.ownershipHeld = true;
    }
    this.running = true;
    await this.sample("start");
    this.armTimer();
    return { started: true };
  }

  /** Stop sampling and release ownership. Does not touch mission state. */
  async stop(reason: MonitorStopReason = "operator"): Promise<void> {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    if (this.ownership && this.ownershipHeld) {
      await this.ownership.release("storage-pressure", this.ownerId);
      this.ownershipHeld = false;
    }
    void reason;
  }

  /**
   * Take one sample and advance the incident state machine. Concurrent calls
   * are serialised: a slow filesystem must not interleave two verdicts.
   */
  async sample(trigger: "start" | "interval" | "manual" = "manual"): Promise<PressureChange> {
    if (this.sampling) return this.currentChange();
    this.sampling = true;
    try {
      return this.sampleInner(trigger);
    } finally {
      this.sampling = false;
    }
  }

  private async sampleInner(trigger: "start" | "interval" | "manual"): Promise<PressureChange> {
    const now = this.now();
    if (this.phase === "flap_backoff") {
      if (now < this.backoffUntil) {
        // Still cooling down; do not sample, do not transition.
        return this.change(`flap backoff for ${this.backoffUntil - now}ms more`);
      }
      this.phase = "idle";
      this.clean = 0;
    }

    // Refresh the ownership lease while we hold it (spec §3.3).
    if (this.ownership && this.ownershipHeld) {
      const rec = await this.ownership.claim("storage-pressure", this.ownerId, this.sampleIntervalMs * 4, now);
      this.ownershipHeld = rec !== undefined;
    }

    const snapshot = await this.probe.probeAll();
    this.lastSnapshot = snapshot;
    this.samples += 1;
    const verdict = verdictOf(snapshot);
    const at = this.now();

    if (verdict.pressured) {
      this.lastBlocked = verdict.blocked;
      if (verdict.incident) this.lastIncident = verdict.incident;
      this.clean = 0;
      if (this.phase === "idle" || this.phase === "degraded") {
        // First confirmed incident: open an episode. The caller suspends; we do
        // not decide mission policy, only "new work must stop".
        this.episode += 1;
        this.suspensions.push(at);
        this.suspensions = this.suspensions.filter((t) => at - t <= this.flapWindowMs);
        if (this.suspensions.length > this.flapMax) {
          this.phase = "flap_backoff";
          this.backoffUntil = at + this.flapBackoffMs;
          this.suspensions = [];
          return this.emit("flapping detected: storage pressure keeps returning — backing off sampling", at, trigger);
        }
        this.phase = "suspended";
        return this.emit("storage pressure confirmed", at, trigger);
      }
      if (this.phase === "recovering") {
        // Recovery attempt failed: straight back to suspended, clean counter
        // reset, so the caller never resumes on a single lucky sample.
        this.phase = "suspended";
        return this.emit("recovery probe failed — still suspended", at, trigger);
      }
      return this.emit("still pressured", at, trigger);
    }

    // Clean sample.
    this.lastBlocked = [];
    if (this.phase === "suspended") {
      this.clean = 1;
      if (this.recoveryChecks <= 1) {
        this.phase = "idle";
        return this.emit("storage pressure cleared", at, trigger);
      }
      this.phase = "recovering";
      return this.emit(`recovery check 1/${this.recoveryChecks}`, at, trigger);
    }
    if (this.phase === "recovering") {
      this.clean += 1;
      if (this.clean >= this.recoveryChecks) {
        this.phase = "idle";
        const c = this.emit(`recovery confirmed after ${this.clean} consecutive clean samples`, at, trigger);
        this.clean = 0;
        return c;
      }
      return this.emit(`recovery check ${this.clean}/${this.recoveryChecks}`, at, trigger);
    }
    // Already idle (or degraded-and-now-clean): nothing to announce, but keep
    // the phase honest.
    this.phase = "idle";
    this.lastIncident = undefined;
    void trigger;
    return this.currentChange();
  }

  private emit(reason: string, at: number, trigger: string): PressureChange {
    const c = this.change(`${reason} (${trigger})`, at);
    try {
      this.onChange?.(c);
    } catch {
      /* a status sink must never break the sensor */
    }
    return c;
  }

  private change(reason: string, at = this.now()): PressureChange {
    return {
      phase: this.phase,
      pressured: this.isPressured(),
      blocked: [...this.lastBlocked],
      ...(this.lastIncident ? { incident: this.lastIncident } : {}),
      episode: this.episode,
      consecutiveCleanSamples: this.clean,
      reason,
      at,
    };
  }

  private armTimer(): void {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    if (!this.running) return;
    const ms = this.phase === "suspended" || this.phase === "recovering" ? this.sampleIntervalMs : this.sampleIntervalMs;
    this.timer = this.setIntervalFn(() => {
      void this.sample("interval");
    }, ms);
  }
}
