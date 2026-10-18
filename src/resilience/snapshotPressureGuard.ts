/**
 * SnapshotPressureGuard — runtime wiring for FR-03 / FR-04 / FR-05.
 *
 * Connects the runtime's snapshot publisher to the StoragePressureController
 * so disk pressure is handled by the controller instead of by blind retries:
 *
 *   - A recoverable storage failure (ENOSPC, inode exhaustion, quota,
 *     EIO/EFBIG) from a snapshot write SUSPENDS the controller: snapshot
 *     retries are paused and the published snapshot is tagged stale. No
 *     retry storm against a full disk; exactly one incident notification.
 *   - While suspended, a recovery probe runs at `probe_interval_ms` pacing
 *     against the AFFECTED mount only: a mount sample plus a bounded
 *     write/sync/rename sentinel probe, with consecutive-check streaking
 *     (flapping protection) inside the controller.
 *   - On resume the publisher is unpaused and the dirty-snapshot republish
 *     pipeline runs once; the stale tag clears once a republish actually
 *     lands (via notePublishSuccess).
 *
 * Every dependency is injectable (classify, mount sample, sentinel probe,
 * republish pipeline, timer scheduling) so the test suite works by fault
 * injection only — it never fills a real disk.
 */

import { randomUUID } from "node:crypto";
import { open, rename, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type StorageHints, type StoragePressureIncident, classifyStorageIncident } from "./classify.ts";
import {
  DEFAULT_STORAGE_PRESSURE_CONFIG,
  type MountSample,
  StoragePressureController,
  type StoragePressureEvent,
  WAITING_FOR_DISK_SPACE,
} from "./storagePressure.ts";

export const EXECUTING_STATE = "EXECUTING";

/**
 * The storage-pressure substate the runtime embeds in the published
 * snapshot file (additive field — older plugins feature-detect and ignore
 * it). Lets a plugin show the last published snapshot as stale instead of
 * presenting it as current while writes are being dropped.
 */
export interface StoragePressureSnapshot {
  /** True while the snapshot is dirty (unpublished changes). */
  dirty: boolean;
  /** True when the last published snapshot is stale (post-incident). */
  stale: boolean;
  /** Wall-clock ms the published snapshot was marked stale. */
  staleAtMs?: number;
  /** True once the dirty snapshot has been republished post-recovery. */
  republished: boolean;
  /** True while the mission is suspended on storage pressure. */
  suspended: boolean;
  /** The active incident, when suspended. */
  incident?: { category: string; code: string; path?: string };
}

/** One-shot timer handle the guard uses for probe pacing. */
export interface GuardTimer {
  stop(): void;
}

export interface SnapshotPressureGuardOptions {
  /**
   * The dirty-snapshot republish pipeline, run once after resume. Must bypass
   * the publisher's pause gate — it IS the recovery write.
   */
  republish: () => Promise<unknown>;
  /** Working directory; used when the incident carries no path. */
  workDir?: string;
  /** Probe pacing while suspended. Default `probe_interval_ms` (30 s). */
  probeIntervalMs?: number;
  /** Error classifier. Default {@link classifyStorageIncident}. */
  classify?: (error: unknown, hints: StorageHints) => StoragePressureIncident;
  /** Mount sampler. Default `fs.statfs`-based. */
  sampleMount?: (path: string) => Promise<MountSample>;
  /** Sentinel probe. Default bounded write/sync/rename in `dir`. */
  sentinelProbe?: (dir: string) => Promise<boolean>;
  /** Timer scheduling (injectable for tests). Default `setInterval` (unref'd). */
  schedule?: (fn: () => void, ms: number) => GuardTimer;
  /** Diagnostic log hook (coalesced by the controller — never floods). */
  log?: (level: "info" | "warn", message: string) => void;
  /** Typed storage-pressure event hook (incident / status / recovered). */
  onEvent?: (event: StoragePressureEvent) => void;
  /** Controller owner id. Default `workDir ?? "runtime"`. */
  owner?: string;
}

/** Default mount sampler: a mount is healthy when it has free blocks AND inodes. */
export async function statfsMountSample(path: string): Promise<MountSample> {
  const st = await statfs(path);
  return {
    path,
    healthy: st.bavail > 0 && st.ffree > 0,
    freeBytes: st.bavail * st.bsize,
    freeInodes: st.ffree,
  };
}

/**
 * Default sentinel probe: bounded write/sync/rename in `dir`. Resolves true
 * only when all three succeed; always cleans up after itself.
 */
export async function sentinelProbeInDir(dir: string): Promise<boolean> {
  const base = join(dir, `.storage-sentinel.${process.pid}.${randomUUID()}`);
  const renamed = `${base}.done`;
  try {
    await writeFile(base, "ok\n", "utf8");
    const fh = await open(base, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(base, renamed);
    return true;
  } catch {
    return false;
  } finally {
    await Promise.all([unlink(base), unlink(renamed)].map((p) => p.catch(() => undefined)));
  }
}

/** Default probe pacing: an unref'd interval that never holds the process open. */
function defaultSchedule(fn: () => void, ms: number): GuardTimer {
  const t: GuardTimer = { stop: () => clearInterval(handle) };
  const handle = setInterval(() => {
    try {
      fn();
    } catch {
      // Probe failures are non-fatal; the next tick retries.
    }
  }, ms);
  handle.unref?.();
  return t;
}

function describeEvent(event: StoragePressureEvent): string {
  switch (event.kind) {
    case "incident":
      return `storage pressure incident: ${event.incident.code} on ${event.incident.path ?? "/"} — snapshot retries paused, waiting for disk space`;
    case "status":
      return `storage pressure: still waiting (${event.incident.code} on ${event.incident.path ?? "/"}, waited ${event.waitedMs}ms)`;
    case "recovered":
      return `storage pressure recovered (${event.incident.code} on ${event.incident.path ?? "/"}, waited ${event.waitedMs}ms) — republishing snapshot`;
  }
}

/**
 * Owns one StoragePressureController for a runtime and wires the snapshot
 * publisher into it. Cheap to construct; the runtime creates it lazily on
 * the first publish error (or first state query) so healthy runs are
 * behaviorally unchanged.
 */
export class SnapshotPressureGuard {
  private readonly controller: StoragePressureController;
  private readonly opts: SnapshotPressureGuardOptions;
  private paused = false;
  private probeTimer: GuardTimer | null = null;
  private ticking = false;
  private disposed = false;

  constructor(opts: SnapshotPressureGuardOptions) {
    this.opts = opts;
    this.controller = new StoragePressureController({
      owner: opts.owner ?? opts.workDir ?? "runtime",
      hooks: {
        transition: (_from, to) => {
          this.log("info", `storage-pressure state → ${to}`);
          return true;
        },
        log: (level, message) => this.log(level, message),
        emit: (event) => {
          this.log(event.kind === "incident" ? "warn" : "info", describeEvent(event));
          opts.onEvent?.(event);
        },
        currentState: () => (this.controller.suspended ? WAITING_FOR_DISK_SPACE : EXECUTING_STATE),
      },
    });
  }

  /** True while the snapshot publisher must skip disk writes entirely. */
  get publishPaused(): boolean {
    return this.paused;
  }

  /** True while the controller is suspended on storage pressure. */
  get suspended(): boolean {
    return this.controller.suspended;
  }

  /** The substate to embed in the published snapshot file. */
  state(): StoragePressureSnapshot {
    const s = this.controller.snapshotState;
    const incident = this.controller.activeIncident;
    return {
      dirty: s.snapshot_dirty,
      stale: s.snapshot_stale,
      ...(s.snapshot_stale_at_ms !== undefined ? { staleAtMs: s.snapshot_stale_at_ms } : {}),
      republished: s.snapshot_republished,
      suspended: this.controller.suspended,
      ...(incident
        ? {
            incident: {
              category: incident.category,
              code: incident.code,
              ...(incident.path ? { path: incident.path } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Notify the guard of a snapshot publish failure. Classifies the error; on a
   * recoverable storage incident that is not already active, suspends the
   * controller (pauses snapshot retries, tags the published snapshot stale)
   * and starts the recovery probe. Coalesced: repeated failures during an
   * active incident are no-ops (the controller emits at most one compact
   * status per cooldown).
   *
   * @returns true when a NEW suspension occurred (the publisher must stop
   * retrying this write and yield to the recovery probe).
   */
  async notePublishError(error: unknown, hints: StorageHints = {}): Promise<boolean> {
    if (this.disposed) return false;
    const incident = (this.opts.classify ?? classifyStorageIncident)(error, hints);
    if (!incident.autoRecover) return false;
    const suspended = this.controller.suspend(incident, incident.path ? { path: incident.path } : undefined);
    if (!suspended) return false;
    // FR-04 — pause the publisher's high-frequency retry loop; the snapshot
    // stays dirty and the last published snapshot stays tagged stale.
    this.controller.pauseSnapshotRetries();
    this.paused = true;
    this.startProbeLoop();
    return true;
  }

  /**
   * A snapshot publish SUCCEEDED. After recovery has been granted, this
   * finalizes the stale tag (the republish landed). No-op while suspended —
   * the stale tag must survive until the disk is writable again.
   */
  notePublishSuccess(): void {
    if (this.disposed) return;
    const s = this.controller.snapshotState;
    if (this.controller.hasResumed && (s.snapshot_dirty || s.snapshot_stale)) {
      this.controller.markSnapshotRepublished();
    }
  }

  /**
   * One recovery-probe iteration: sample the affected mount, feed the
   * controller (streak + sentinel), and on resume unpause the publisher and
   * run the dirty-snapshot republish pipeline. Driven by the probe timer;
   * also invoked directly by tests (fault injection only).
   */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      if (!this.controller.suspended) {
        this.stopProbeLoop();
        return;
      }
      const path = this.controller.activeIncident?.path ?? this.opts.workDir ?? "/";
      const sample = await (this.opts.sampleMount ?? statfsMountSample)(path);
      const outcome = await this.controller.sample(sample, {
        probe: () => (this.opts.sentinelProbe ?? sentinelProbeInDir)(path),
      });
      if (outcome.resumed) {
        // FR-05 — auto-resume granted: unpause the publisher and run the
        // dirty-snapshot pipeline once. notePublishSuccess clears the stale
        // tag when the republish actually lands.
        this.paused = false;
        this.stopProbeLoop();
        void this.opts.republish().catch(() => {
          // A failed republish leaves the snapshot dirty/stale; the next
          // mission change republishes through the normal (unpaused) path.
        });
      }
    } catch {
      // A failed probe keeps the mission suspended; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  /** Stop the probe loop and release timers (runtime close). */
  dispose(): void {
    this.disposed = true;
    this.stopProbeLoop();
  }

  private startProbeLoop(): void {
    if (this.probeTimer) return;
    const ms = this.opts.probeIntervalMs ?? DEFAULT_STORAGE_PRESSURE_CONFIG.probe_interval_ms;
    const schedule = this.opts.schedule ?? defaultSchedule;
    this.probeTimer = schedule(() => {
      void this.tick();
    }, ms);
  }

  private stopProbeLoop(): void {
    this.probeTimer?.stop();
    this.probeTimer = null;
  }

  private log(level: "info" | "warn", message: string): void {
    this.opts.log?.(level, message);
  }
}
