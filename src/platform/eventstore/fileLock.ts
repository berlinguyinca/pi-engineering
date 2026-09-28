import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync as removeSync,
  renameSync,
} from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface FileLockOwner {
  pid: number;
  host: string;
  openedAt: string;
  ownerToken: string;
  bootId?: string;
  processStartTime?: string;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface OwnerRecord extends FileIdentity {
  owner: FileLockOwner;
}

function lockDirectory(file: string): string {
  return `${file}.lock`;
}

async function readOwner(path: string): Promise<FileLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockOwner>;
    if (
      typeof value.pid !== "number" ||
      typeof value.host !== "string" ||
      typeof value.openedAt !== "string" ||
      typeof value.ownerToken !== "string"
    ) {
      return undefined;
    }
    return value as FileLockOwner;
  } catch {
    return undefined;
  }
}

async function readOwnerRecord(path: string): Promise<OwnerRecord | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const value = JSON.parse(await handle.readFile({ encoding: "utf8" })) as Partial<FileLockOwner>;
    if (
      typeof value.pid !== "number" ||
      typeof value.host !== "string" ||
      typeof value.openedAt !== "string" ||
      typeof value.ownerToken !== "string"
    ) {
      return undefined;
    }
    return { owner: value as FileLockOwner, device: stat.dev, inode: stat.ino };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function readBootId(): string | undefined {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readProcessStartTime(
  pid: number,
): { state: "present"; value: string } | { state: "missing" } | { state: "unknown" } {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = line.lastIndexOf(")");
    const value =
      close >= 0
        ? line
            .slice(close + 2)
            .trim()
            .split(/\s+/)[19]
        : undefined;
    return value ? { state: "present", value } : { state: "unknown" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unknown" };
  }
}

function ownerState(owner: FileLockOwner): "live" | "stale" | "unknown" {
  if (owner.host !== hostname() || !owner.bootId || !owner.processStartTime) return "unknown";
  const bootId = readBootId();
  if (!bootId) return "unknown";
  if (owner.bootId !== bootId) return "stale";
  const start = readProcessStartTime(owner.pid);
  if (start.state === "missing") return "stale";
  if (start.state === "unknown") return "unknown";
  return start.value === owner.processStartTime ? "live" : "stale";
}

function recoveryClaimPath(path: string, ownerToken: string): string {
  const tokenHash = createHash("sha256").update(ownerToken).digest("hex").slice(0, 24);
  return `${path}.recover.${tokenHash}`;
}

async function readRecoveryClaim(path: string): Promise<FileLockOwner | undefined> {
  return readOwner(path);
}

function claimCollision(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function restoreQuarantined(path: string, quarantine: string): Promise<void> {
  try {
    await link(quarantine, path);
    await rm(quarantine, { force: true });
  } catch (error) {
    if (!claimCollision(error)) throw error;
    // A new fixed-path owner won. Preserve both it and the quarantine for
    // diagnosis rather than overwriting or deleting an unproven identity.
  }
}

async function quarantineObserved(path: string, observed: OwnerRecord, quarantine: string): Promise<boolean> {
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readOwnerRecord(quarantine);
  if (!moved || !sameIdentity(moved, observed) || moved.owner.ownerToken !== observed.owner.ownerToken) {
    await restoreQuarantined(path, quarantine);
    throw new Error("JSONL writer lock identity changed during quarantine; replacement was restored or preserved");
  }
  await rm(quarantine, { force: true });
  return true;
}

async function publishRecoveryClaim(path: string, owner: FileLockOwner): Promise<boolean> {
  const candidate = `${path}.candidate.${owner.ownerToken}`;
  await writeFile(candidate, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    try {
      // A hard link publishes the fully written identity atomically and, unlike
      // POSIX rename, refuses every pre-existing destination type.
      await link(candidate, path);
      return true;
    } catch (error) {
      if (!claimCollision(error)) throw error;
      return false;
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

function reapedClaimPath(path: string, ownerToken: string): string {
  const tokenHash = createHash("sha256").update(ownerToken).digest("hex").slice(0, 24);
  return `${path}.reaped.${tokenHash}`;
}

async function releaseRecoveryClaim(path: string, owner: FileLockOwner): Promise<void> {
  const current = await readRecoveryClaim(path);
  if (current?.ownerToken !== owner.ownerToken) return;
  const released = `${path}.released.${owner.ownerToken}`;
  try {
    await rename(path, released);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await readRecoveryClaim(released);
  if (moved?.ownerToken !== owner.ownerToken) {
    throw new Error("JSONL writer recovery claim identity changed during release");
  }
  await rm(released, { recursive: true, force: true });
}

export interface FileLockRecoveryHooks {
  /** Deterministic crash/race injection points; production callers omit these. */
  afterRecoveryClaimPublished?: (claimPath: string, owner: FileLockOwner) => Promise<void> | void;
  beforeRecoveryClaimReap?: (claimPath: string, claimant: FileLockOwner) => Promise<void> | void;
  afterRecoveryClaimTombstonePublished?: (
    claimPath: string,
    tombstonePath: string,
    claimant: FileLockOwner,
  ) => Promise<void> | void;
  beforeStaleOwnerQuarantine?: (path: string, owner: FileLockOwner) => Promise<void> | void;
  beforeReleaseQuarantine?: (path: string, owner: FileLockOwner) => void;
}

/**
 * Local-filesystem process lock.
 *
 * Stale-owner proof assumes every contender sees the same filesystem, hostname,
 * and PID namespace. Shared/network filesystems or containers with different PID
 * namespaces require a distributed/advisory lock and are deliberately unsupported.
 */
export class ExclusiveFileLock {
  readonly owner: FileLockOwner;
  readonly path: string;
  private readonly device: bigint;
  private readonly inode: bigint;
  private readonly hooks: FileLockRecoveryHooks;
  private released = false;

  private constructor(path: string, owner: FileLockOwner, device: bigint, inode: bigint, hooks: FileLockRecoveryHooks) {
    this.path = path;
    this.owner = owner;
    this.device = device;
    this.inode = inode;
    this.hooks = hooks;
  }

  static async acquire(file: string, hooks: FileLockRecoveryHooks = {}): Promise<ExclusiveFileLock> {
    const path = lockDirectory(file);
    const bootId = readBootId();
    const processStart = readProcessStartTime(process.pid);
    if (!bootId || processStart.state !== "present") {
      throw new Error(`JSONL writer lock for ${file} cannot establish a trustworthy process incarnation`);
    }
    const owner: FileLockOwner = {
      pid: process.pid,
      host: hostname(),
      openedAt: new Date().toISOString(),
      ownerToken: randomUUID(),
      bootId,
      processStartTime: processStart.value,
    };
    await mkdir(dirname(file), { recursive: true });

    for (;;) {
      try {
        await writeFile(path, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
        const identity = await lstat(path, { bigint: true });
        return new ExclusiveFileLock(path, owner, identity.dev, identity.ino, hooks);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const currentRecord = await readOwnerRecord(path);
        if (!currentRecord) {
          throw new Error(`JSONL writer lock for ${file} is held (owner metadata is missing or unreadable)`);
        }
        const current = currentRecord.owner;
        if (ownerState(current) !== "stale") {
          const diagnostic = `pid=${current.pid} host=${current.host} openedAt=${current.openedAt} ownerToken=${current.ownerToken} incarnation=${ownerState(current)}`;
          throw new Error(`JSONL writer lock for ${file} is held (${diagnostic})`);
        }

        // Serialize recovery by the exact stale token observed. Claim identity
        // is complete before its directory is atomically published.
        const claimPath = recoveryClaimPath(path, current.ownerToken);
        const published = await publishRecoveryClaim(claimPath, owner);
        if (!published) {
          const claimant = await readRecoveryClaim(claimPath);
          if (!claimant || ownerState(claimant) !== "stale") {
            const diagnostic = claimant
              ? `pid=${claimant.pid} host=${claimant.host} openedAt=${claimant.openedAt} ownerToken=${claimant.ownerToken}`
              : "claimant metadata is missing or unreadable";
            throw new Error(`JSONL writer lock recovery for ${file} is claimed (${diagnostic})`);
          }
          await hooks.beforeRecoveryClaimReap?.(claimPath, { ...claimant });
          const tombstone = reapedClaimPath(claimPath, claimant.ownerToken);
          try {
            // Only the reaper that atomically creates this identity-specific
            // hard-link tombstone may unlink the fixed path. A delayed loser
            // cannot remove a replacement claim published afterward.
            await link(claimPath, tombstone);
          } catch (reapError) {
            if ((reapError as NodeJS.ErrnoException).code === "ENOENT") continue;
            if (claimCollision(reapError)) {
              const fixed = await readRecoveryClaim(claimPath);
              const existingTombstone = await readRecoveryClaim(tombstone);
              const fixedToken = fixed?.ownerToken ?? "missing-or-unreadable";
              const tombstoneToken = existingTombstone?.ownerToken ?? "missing-or-unreadable";
              throw new Error(
                `JSONL writer lock recovery for ${file} is blocked by existing tombstone ${tombstone} (fixedClaimToken=${fixedToken} tombstoneToken=${tombstoneToken}); the fixed recovery claim and tombstone were preserved`,
              );
            }
            throw reapError;
          }
          await hooks.afterRecoveryClaimTombstonePublished?.(claimPath, tombstone, { ...claimant });
          const reaped = await readRecoveryClaim(tombstone);
          if (reaped?.ownerToken !== claimant.ownerToken) {
            throw new Error(`JSONL writer recovery claim identity changed unexpectedly for ${file}`);
          }
          await rm(claimPath, { force: true });
          continue;
        }
        try {
          await hooks.afterRecoveryClaimPublished?.(claimPath, { ...owner });
          const claimed = await readOwnerRecord(path);
          if (
            !claimed ||
            !sameIdentity(claimed, currentRecord) ||
            claimed.owner.ownerToken !== current.ownerToken ||
            ownerState(claimed.owner) !== "stale"
          ) {
            continue;
          }
          await hooks.beforeStaleOwnerQuarantine?.(path, { ...claimed.owner });
          const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
          if (!(await quarantineObserved(path, claimed, stalePath))) continue;
        } finally {
          await releaseRecoveryClaim(claimPath, owner);
        }
      }
    }
  }

  /** Release only this owner's lock. Safe to call repeatedly. */
  release(): void {
    if (this.released) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const identity = fstatSync(fd, { bigint: true });
      if (identity.dev !== this.device || identity.ino !== this.inode) return;
      const current = JSON.parse(readFileSync(fd, "utf8")) as Partial<FileLockOwner>;
      if (current.ownerToken !== this.owner.ownerToken) return;
      this.hooks.beforeReleaseQuarantine?.(this.path, { ...this.owner });
      const named = lstatSync(this.path, { bigint: true });
      if (named.dev !== this.device || named.ino !== this.inode) return;
      const quarantine = `${this.path}.release.${this.owner.ownerToken}.${randomUUID()}`;
      renameSync(this.path, quarantine);
      const moved = lstatSync(quarantine, { bigint: true });
      if (moved.dev !== this.device || moved.ino !== this.inode) {
        try {
          linkSync(quarantine, this.path);
          removeSync(quarantine, { force: true });
        } catch (error) {
          if (!claimCollision(error)) throw error;
        }
        return;
      }
      removeSync(quarantine, { force: true });
      this.released = true;
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
