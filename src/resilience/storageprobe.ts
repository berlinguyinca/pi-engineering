/**
 * Filesystem-aware storage probes (disk-pressure spec FR-01, Phase 1).
 *
 * A healthy `/` proves nothing about a separate output mount, and a
 * `statfs`-style "free bytes" number proves nothing about whether a write can
 * actually complete: inode exhaustion, per-directory quotas, read-only
 * remounts, container-layer barriers and reserved root blocks all produce
 * failures that utilisation alone cannot see. This module answers the only
 * question the suspension machinery cares about, per mount:
 *
 *   1. what are the real free bytes / free inodes (`fs.statfs`), and
 *   2. can this process actually create, rename and fsync a file there?
 *
 * The probe is deliberately bounded (fixed payload size, hard timeout, its own
 * sentinel subdirectory) and NEVER deletes anything it did not create:
 * cleanup is a separate, explicitly-owned operation (spec: a probe must not
 * become a janitor). When measurement is impossible the mount is reported
 * `unknown`, never optimistically `ok` — an unknown mount suppresses new
 * dispatch but never fails a mission, and never blocks read-only status or
 * cleanup work (FR-02).
 *
 * Reuses `classifyStorageIncident` from ./classify.ts for the typed incident;
 * this module adds measurement, not a second classification scheme.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { StorageHints, StoragePressureIncident } from "./classify.ts";
import { classifyStorageIncident } from "./classify.ts";

/** Default probe payload: one small file, bounded on purpose. */
export const DEFAULT_PROBE_BYTES = 4096;
/** Default per-probe timeout. A wedged filesystem must not hang a caller. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** Sentinel directory name inside each probed mount. */
export const PROBE_SENTINEL_DIR = ".pi-engineering-pressure-probe";

/** Measurement states for a mount. `unknown` is never treated as healthy. */
export type StorageMountStatus = "ok" | "pressured" | "unknown";

/** How a mount's free-space picture was obtained. */
export type StorageProbeMethod =
  | "statfs+write" // bytes, inodes and a real write/rename/fsync all confirmed
  | "statfs-only" // statfs answered, the write probe did not run
  | "write-only" // the write probe ran, statfs was unavailable
  | "unavailable"; // nothing could be measured

/** One filesystem/mount under observation. */
export interface StorageProbeTarget {
  /** Identifier used in pressure state, events and log lines. */
  id: string;
  /** A path on the mount to probe (need not be the mount root). */
  path: string;
  /**
   * Role of the mount. Only advisory: admission control uses the mount's own
   * state, the role exists so operators can read the status surface.
   */
  role?: "state" | "output" | "worktree" | "cache" | "scratch" | string;
}

/** Result of probing one mount once. */
export interface StorageProbeResult {
  id: string;
  path: string;
  role?: string;
  status: StorageMountStatus;
  method: StorageProbeMethod;
  /** Free bytes available to this process, when statfs answered. */
  freeBytes?: number;
  /** Total bytes of the mount, when statfs answered. */
  totalBytes?: number;
  /** Free inodes, when statfs answered. */
  freeInodes?: number;
  /** Total inodes, when statfs answered. */
  totalInodes?: number;
  /** Free bytes as a fraction of total bytes (0..1), when both known. */
  freePercent?: number;
  /** True when the bounded write/rename/fsync probe succeeded. */
  writable?: boolean;
  /** Which probe step failed, when one did. */
  failedStep?: "sentinel" | "write" | "rename" | "fsync" | "statfs";
  /** Typed incident when the probe failed; absent on a healthy mount. */
  incident?: StoragePressureIncident;
  /** Probe duration in ms. */
  durationMs: number;
  /** Wall-clock time the probe finished. */
  observedAt: number;
}

/** A whole observation cycle across every configured mount. */
export interface StorageProbeSnapshot {
  /** Monotonic sample counter (per monitor instance). */
  seq: number;
  observedAt: number;
  durationMs: number;
  results: StorageProbeResult[];
}

/** Threshold configuration for one monitor (FR-02 owns the hysteresis use). */
export interface StorageProbeThresholds {
  /** Refuse new work below this many free bytes. */
  minimumFreeBytes?: number;
  /** Refuse new work below this fraction of total bytes (0..1). */
  minimumFreePercent?: number;
  /** Refuse new work below this many free inodes. */
  minimumFreeInodes?: number;
}

/** Raw statfs-shaped measurement (the OS surface the probe reads). */
export interface StorageStatfsLike {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
}

/** Everything a probe needs from the filesystem; injectable for tests. */
export interface StorageProbeIo {
  mkdir(path: string, opts: { recursive: true }): void;
  writeFileSync(path: string, data: Uint8Array): void;
  rename(from: string, to: string): void;
  open(path: string, flags: string): { sync(): void; close(): void };
  unlink(path: string): void;
  statfs(path: string): Promise<StorageStatfsLike>;
  now(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

const realIo: StorageProbeIo = {
  mkdir: (p, o) => fs.mkdirSync(p, o),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  rename: (from, to) => fs.renameSync(from, to),
  open: (p, flags) => {
    const fd = fs.openSync(p, flags);
    return {
      sync: () => fs.fsyncSync(fd),
      close: () => fs.closeSync(fd),
    };
  },
  unlink: (p) => fs.rmSync(p, { force: true }),
  statfs: (p) => fs.promises.statfs(p),
  now: () => Date.now(),
};

/** Options for a storage probe. */
export interface StorageProbeOptions {
  /** The mounts to probe. Empty list ⇒ every probe reports an empty snapshot. */
  targets: StorageProbeTarget[];
  thresholds?: StorageProbeThresholds;
  /** Probe payload size in bytes (default 4 KiB). */
  probeBytes?: number;
  /** Hard per-probe timeout (default 5 s). */
  timeoutMs?: number;
  io?: Partial<StorageProbeIo>;
  /**
   * Sentinel subdir override for tests. The probe only ever creates files
   * inside `<target.path>/<sentinelDir>/`, and only files it named.
   */
  sentinelDir?: string;
}

function resolveIo(overrides?: Partial<StorageProbeIo>): StorageProbeIo {
  return { ...realIo, ...overrides };
}

/**
 * The probe identity prefix. Kept short and prefixed so a leftover sentinel
 * file is recognisable as ours (and, per spec, is never auto-deleted).
 */
const PROBE_FILE_PREFIX = "probe-";

/**
 * Bounded write/rename/fsync probe plus free-bytes/inode measurement for a set
 * of mounts. Stateless apart from a sample counter: the caller (the pressure
 * monitor) owns the history, this class answers "what is true right now?".
 */
export class StorageProbe {
  private readonly targets: StorageProbeTarget[];
  private thresholds_: StorageProbeThresholds;
  private readonly probeBytes: number;
  private readonly timeoutMs: number;
  private readonly io: StorageProbeIo;
  private readonly sentinelDir: string;
  private seq = 0;

  constructor(opts: StorageProbeOptions) {
    this.targets = opts.targets.map((t) => ({ ...t }));
    this.thresholds_ = { ...(opts.thresholds ?? {}) };
    this.probeBytes = Math.max(0, opts.probeBytes ?? DEFAULT_PROBE_BYTES);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.io = resolveIo(opts.io);
    this.sentinelDir = opts.sentinelDir ?? PROBE_SENTINEL_DIR;
  }

  /** The configured mounts (copies). */
  listTargets(): StorageProbeTarget[] {
    return this.targets.map((t) => ({ ...t }));
  }

  /** Current threshold configuration (copies). */
  getThresholds(): StorageProbeThresholds {
    return { ...this.thresholds_ };
  }

  /** Replace the threshold configuration (used by config reload). */
  setThresholds(next: StorageProbeThresholds): void {
    this.thresholds_ = { ...next };
  }

  /** Probe every configured mount. Never throws; a failed mount is data. */
  async probeAll(): Promise<StorageProbeSnapshot> {
    const started = this.io.now();
    const results: StorageProbeResult[] = [];
    for (const target of this.targets) {
      results.push(await this.probeOne(target));
    }
    const finished = this.io.now();
    this.seq += 1;
    return {
      seq: this.seq,
      observedAt: finished,
      durationMs: finished - started,
      results,
    };
  }

  /** Probe a single mount. Never throws. */
  async probeOne(target: StorageProbeTarget): Promise<StorageProbeResult> {
    const started = this.io.now();
    const base = { id: target.id, path: target.path, ...(target.role ? { role: target.role } : {}) };
    const finish = (r: Omit<StorageProbeResult, "durationMs" | "observedAt" | "id" | "path" | "role">): StorageProbeResult => ({
      ...base,
      ...r,
      durationMs: this.io.now() - started,
      observedAt: this.io.now(),
    });

    // 1. Measurement. A statfs failure is not fatal: the write probe still
    //    answers the question that matters ("can we write?").
    let freeBytes: number | undefined;
    let totalBytes: number | undefined;
    let freeInodes: number | undefined;
    let totalInodes: number | undefined;
    let freePercent: number | undefined;
    let statfsError: unknown;
    try {
      const s = await this.withTimeout(this.io.statfs(target.path), `statfs ${target.path}`);
      freeBytes = s.bavail * s.bsize;
      totalBytes = s.blocks * s.bsize;
      freeInodes = s.ffree;
      totalInodes = s.files;
      freePercent = totalBytes > 0 ? freeBytes / totalBytes : undefined;
    } catch (err) {
      statfsError = err;
    }

    // 2. The bounded write/rename/fsync probe. This is authoritative: a mount
    //    that reports free bytes but refuses a write is pressured.
    const writable = await this.writeProbe(target);

    if (writable.ok === false) {
      const hints: StorageHints = {
        path: target.path,
        ...(freeBytes !== undefined ? { freeBytes } : {}),
        ...(freeInodes !== undefined ? { freeInodes } : {}),
        requiredBytes: this.probeBytes,
      };
      const incident = classifyStorageIncident(writable.error, hints);
      return finish({
        status: "pressured",
        method: statfsError ? "write-only" : "statfs+write",
        ...(freeBytes !== undefined ? { freeBytes } : {}),
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(freeInodes !== undefined ? { freeInodes } : {}),
        ...(totalInodes !== undefined ? { totalInodes } : {}),
        ...(freePercent !== undefined ? { freePercent } : {}),
        writable: false,
        failedStep: writable.step ?? "write",
        incident,
      });
    }

    if (statfsError) {
      // The write succeeded but nothing could be measured: still not "ok",
      // because admission needs a number to compare against. Unknown.
      return finish({
        status: "unknown",
        method: "write-only",
        writable: true,
        failedStep: "statfs",
        incident: classifyStorageIncident(statfsError, { path: target.path }),
      });
    }

    // 3. Thresholds. A writable mount below any configured floor is
    //    "pressured": admission control (FR-02) suppresses new work on it,
    //    while writes that are already in flight are allowed to finish.
    const breach = this.firstBreach({ freeBytes, freePercent, freeInodes });
    if (breach) {
      return finish({
        status: "pressured",
        method: "statfs+write",
        freeBytes,
        totalBytes,
        freeInodes,
        totalInodes,
        freePercent,
        writable: true,
        failedStep: breach,
        incident: pressureIncident(breach, {
          path: target.path,
          freeBytes,
          freeInodes,
        }),
      });
    }

    return finish({
      status: "ok",
      method: "statfs+write",
      freeBytes,
      totalBytes,
      freeInodes,
      totalInodes,
      freePercent,
      writable: true,
    });
  }

  /** Which configured floor the measurement violates first, if any. */
  private firstBreach(m: {
    freeBytes?: number;
    freePercent?: number;
    freeInodes?: number;
  }): "minimum_free_bytes" | "minimum_free_percent" | "minimum_free_inodes" | undefined {
    const t = this.thresholds_;
    if (typeof t.minimumFreeBytes === "number" && typeof m.freeBytes === "number" && m.freeBytes < t.minimumFreeBytes) {
      return "minimum_free_bytes";
    }
    if (typeof t.minimumFreePercent === "number" && typeof m.freePercent === "number" && m.freePercent < t.minimumFreePercent) {
      return "minimum_free_percent";
    }
    if (typeof t.minimumFreeInodes === "number" && typeof m.freeInodes === "number" && m.freeInodes < t.minimumFreeInodes) {
      return "minimum_free_inodes";
    }
    return undefined;
  }

  /**
   * create → rename → fsync inside the mount's own sentinel directory.
   * Returns `{ ok: true }` or the failing step + error. Removes only the files
   * it created; a leftover is left for the operator to see.
   */
  private async writeProbe(
    target: StorageProbeTarget,
  ): Promise<{ ok: true } | { ok: false; step?: "sentinel" | "write" | "rename" | "fsync"; error: unknown }> {
    const dir = path.join(target.path, this.sentinelDir);
    const token = `${PROBE_FILE_PREFIX}${process.pid}-${this.seq + 1}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(dir, `${token}.tmp`);
    const final = path.join(dir, `${token}.ok`);
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(this.probeBytes);
      this.io.mkdir(dir, { recursive: true });
    } catch (error) {
      return { ok: false, step: "sentinel", error };
    }
    try {
      await this.withTimeout(Promise.resolve().then(() => this.io.writeFileSync(tmp, payload)), `write ${tmp}`);
    } catch (error) {
      this.cleanup(tmp);
      return { ok: false, step: "write", error };
    }
    try {
      await this.withTimeout(Promise.resolve().then(() => this.io.rename(tmp, final)), `rename ${tmp}`);
    } catch (error) {
      this.cleanup(tmp);
      this.cleanup(final);
      return { ok: false, step: "rename", error };
    }
    try {
      await this.withTimeout(
        Promise.resolve().then(() => {
          const handle = this.io.open(final, "r+");
          try {
            handle.sync();
          } finally {
            handle.close();
          }
        }),
        `fsync ${final}`,
      );
    } catch (error) {
      this.cleanup(final);
      return { ok: false, step: "fsync", error };
    }
    this.cleanup(final);
    return { ok: true };
  }

  private cleanup(p: string): void {
    try {
      this.io.unlink(p);
    } catch {
      /* a probe must never fail the caller, and never escalates to deleting
         anything else: the leftover stays visible for the operator. */
    }
  }

  private withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
    if (this.timeoutMs <= 0) return promise;
    const setTimeoutFn = this.io.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimeoutFn = this.io.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`storage probe timed out after ${this.timeoutMs}ms: ${what}`));
      }, this.timeoutMs);
      promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(handle);
          resolve(v);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(handle);
          reject(err);
        },
      );
    });
  }
}

/** A threshold breach is not an errno failure; give it a coherent incident. */
function pressureIncident(
  breach: "minimum_free_bytes" | "minimum_free_percent" | "minimum_free_inodes",
  hints: StorageHints,
): StoragePressureIncident {
  if (breach === "minimum_free_inodes") {
    return {
      category: "INODE_EXHAUSTED",
      recovery: "AUTO",
      code: "PRESSURE_INODES",
      reason: `free inodes below the configured floor (${hints.freeInodes})`,
      autoRecover: true,
      needsOperator: false,
      path: hints.path,
      freeBytes: hints.freeBytes,
      freeInodes: hints.freeInodes,
    };
  }
  return {
    category: "DISK_FULL",
    recovery: "AUTO",
    code: breach === "minimum_free_bytes" ? "PRESSURE_BYTES" : "PRESSURE_PERCENT",
    reason:
      breach === "minimum_free_bytes"
        ? `free bytes below the configured floor (${hints.freeBytes})`
        : "free space below the configured percentage floor",
    autoRecover: true,
    needsOperator: false,
    path: hints.path,
    freeBytes: hints.freeBytes,
    freeInodes: hints.freeInodes,
  };
}

/**
 * Default mounts to watch: the durable state root and the working directory.
 * A separate output/worktree mount is added by the caller once it knows where
 * its candidates live (spec: never assume `/` stands in for an output mount).
 */
export function defaultStorageTargets(opts: { stateDir: string; workdirs?: string[] }): StorageProbeTarget[] {
  const targets: StorageProbeTarget[] = [{ id: "state", path: opts.stateDir, role: "state" }];
  const seen = new Set<string>([opts.stateDir]);
  for (const wd of opts.workdirs ?? []) {
    if (!wd || seen.has(wd)) continue;
    seen.add(wd);
    targets.push({ id: `work-${targets.length}`, path: wd, role: "worktree" });
  }
  return targets;
}
