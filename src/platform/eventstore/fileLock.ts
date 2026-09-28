import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, rmSync as removeSync } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface FileLockOwner {
  pid: number;
  host: string;
  openedAt: string;
  ownerToken: string;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function verifiedStale(owner: FileLockOwner): boolean {
  return owner.host === hostname() && !processIsAlive(owner.pid);
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
  private released = false;

  private constructor(path: string, owner: FileLockOwner, device: bigint, inode: bigint) {
    this.path = path;
    this.owner = owner;
    this.device = device;
    this.inode = inode;
  }

  static async acquire(file: string, hooks: FileLockRecoveryHooks = {}): Promise<ExclusiveFileLock> {
    const path = lockDirectory(file);
    const owner: FileLockOwner = {
      pid: process.pid,
      host: hostname(),
      openedAt: new Date().toISOString(),
      ownerToken: randomUUID(),
    };
    await mkdir(dirname(file), { recursive: true });

    for (;;) {
      try {
        await writeFile(path, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
        const identity = await lstat(path, { bigint: true });
        return new ExclusiveFileLock(path, owner, identity.dev, identity.ino);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await readOwner(path);
        if (!current || !verifiedStale(current)) {
          const diagnostic = current
            ? `pid=${current.pid} host=${current.host} openedAt=${current.openedAt} ownerToken=${current.ownerToken}`
            : "owner metadata is missing or unreadable";
          throw new Error(`JSONL writer lock for ${file} is held (${diagnostic})`);
        }

        // Serialize recovery by the exact stale token observed. Claim identity
        // is complete before its directory is atomically published.
        const claimPath = recoveryClaimPath(path, current.ownerToken);
        const published = await publishRecoveryClaim(claimPath, owner);
        if (!published) {
          const claimant = await readRecoveryClaim(claimPath);
          if (!claimant || !verifiedStale(claimant)) {
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
          const claimed = await readOwner(path);
          if (!claimed || claimed.ownerToken !== current.ownerToken || !verifiedStale(claimed)) continue;
          const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
          try {
            await rename(path, stalePath);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw renameError;
          }
          const quarantined = await readOwner(stalePath);
          if (quarantined?.ownerToken !== current.ownerToken) {
            throw new Error(`JSONL writer lock recovery token changed unexpectedly for ${file}`);
          }
          await rm(stalePath, { force: true });
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
      // Revalidate the fixed name immediately before removal. A replacement
      // may copy the token, but it cannot copy the acquired inode identity.
      const named = lstatSync(this.path, { bigint: true });
      if (named.dev !== this.device || named.ino !== this.inode) return;
      removeSync(this.path, { recursive: true, force: true });
      this.released = true;
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
