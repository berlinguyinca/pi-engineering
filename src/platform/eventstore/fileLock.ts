import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync as removeSync,
  renameSync,
} from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface FileLockOwner {
  pid: number;
  host: string;
  openedAt: string;
  ownerToken: string;
  bootId: string;
  processStartTime: string;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface OwnerRecord extends FileIdentity {
  owner: FileLockOwner;
  descriptor: number;
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;

function isPositiveDigitString(value: unknown): value is string {
  return typeof value === "string" && DIGITS.test(value) && BigInt(value) > 0n;
}

function isFileLockOwner(value: unknown): value is FileLockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<FileLockOwner>;
  return (
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.host === "string" &&
    owner.host.trim().length > 0 &&
    typeof owner.openedAt === "string" &&
    owner.openedAt.trim().length > 0 &&
    typeof owner.ownerToken === "string" &&
    owner.ownerToken.trim().length > 0 &&
    typeof owner.bootId === "string" &&
    BOOT_ID.test(owner.bootId) &&
    isPositiveDigitString(owner.processStartTime)
  );
}

function lockDirectory(file: string): string {
  return `${file}.lock`;
}

async function readOwner(path: string): Promise<FileLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isFileLockOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readOwnerRecord(path: string): Promise<OwnerRecord | undefined> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    const value: unknown = readOwnerFromDescriptor(descriptor);
    if (!isFileLockOwner(value)) {
      closeSync(descriptor);
      return undefined;
    }
    return { owner: value, device: stat.dev, inode: stat.ino, descriptor };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    return undefined;
  }
}

async function closeOwnerRecord(record: OwnerRecord | undefined): Promise<void> {
  if (record) closeSync(record.descriptor);
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
  if (owner.host !== hostname()) return "unknown";
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

function readOwnerFromDescriptor(descriptor: number): Partial<FileLockOwner> {
  const size = fstatSync(descriptor).size;
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== size) throw new Error("JSONL writer lock owner record was truncated while pinned");
  return JSON.parse(bytes.toString("utf8")) as Partial<FileLockOwner>;
}

async function restoreQuarantined(path: string, quarantine: string): Promise<void> {
  try {
    await link(quarantine, path);
  } catch (error) {
    if (!claimCollision(error)) throw error;
  }
  // Recovery only runs after an identity mismatch. Preserve the quarantine
  // even when its inode was restored at the fixed path: deleting a diagnostic
  // through a name that may itself have changed would not be owner-conditional.
}

async function quarantineObserved(
  path: string,
  observed: OwnerRecord,
  quarantine: string,
  identityError = "JSONL writer lock identity changed during quarantine; replacement was restored or preserved",
): Promise<boolean> {
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readOwnerRecord(quarantine);
  try {
    if (!moved || !sameIdentity(moved, observed) || moved.owner.ownerToken !== observed.owner.ownerToken) {
      await restoreQuarantined(path, quarantine);
      throw new Error(identityError);
    }
    const named = await lstat(quarantine, { bigint: true });
    if (named.dev !== observed.device || named.ino !== observed.inode) {
      await restoreQuarantined(path, quarantine);
      throw new Error(identityError);
    }
    await rm(quarantine, { force: true });
    return true;
  } finally {
    await closeOwnerRecord(moved);
  }
}

async function publishRecoveryClaim(path: string, owner: FileLockOwner): Promise<OwnerRecord | undefined> {
  const candidate = `${path}.candidate.${owner.ownerToken}`;
  await writeFile(candidate, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    const candidateRecord = await readOwnerRecord(candidate);
    if (!candidateRecord) throw new Error("JSONL writer recovery claim candidate is unreadable");
    try {
      // A hard link publishes the fully written identity atomically and, unlike
      // POSIX rename, refuses every pre-existing destination type.
      await link(candidate, path);
      return candidateRecord;
    } catch (error) {
      await closeOwnerRecord(candidateRecord);
      if (!claimCollision(error)) throw error;
      return undefined;
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

function reapedClaimPath(path: string, ownerToken: string): string {
  const tokenHash = createHash("sha256").update(ownerToken).digest("hex").slice(0, 24);
  return `${path}.reaped.${tokenHash}`;
}

async function releaseRecoveryClaim(path: string, observed: OwnerRecord): Promise<void> {
  try {
    const current = await readOwnerRecord(path);
    try {
      if (!current || !sameIdentity(current, observed) || current.owner.ownerToken !== observed.owner.ownerToken) {
        throw new Error("JSONL writer recovery claim identity changed during release");
      }
    } finally {
      await closeOwnerRecord(current);
    }
    const released = `${path}.released.${observed.owner.ownerToken}.${randomUUID()}`;
    await quarantineObserved(
      path,
      observed,
      released,
      "JSONL writer recovery claim identity changed during release; replacement was restored or preserved",
    );
  } finally {
    await closeOwnerRecord(observed);
  }
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
  private descriptor: number | undefined;
  private readonly hooks: FileLockRecoveryHooks;
  private released = false;

  private constructor(
    path: string,
    owner: FileLockOwner,
    device: bigint,
    inode: bigint,
    descriptor: number,
    hooks: FileLockRecoveryHooks,
  ) {
    this.path = path;
    this.owner = owner;
    this.device = device;
    this.inode = inode;
    this.descriptor = descriptor;
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
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const identity = fstatSync(descriptor, { bigint: true });
          const persisted = readOwnerFromDescriptor(descriptor);
          if (persisted.ownerToken !== owner.ownerToken) {
            throw new Error(`JSONL writer lock for ${file} changed during acquisition`);
          }
          return new ExclusiveFileLock(path, owner, identity.dev, identity.ino, descriptor, hooks);
        } catch (error) {
          closeSync(descriptor);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const currentRecord = await readOwnerRecord(path);
        if (!currentRecord) {
          throw new Error(`JSONL writer lock for ${file} is held (owner metadata is missing or unreadable)`);
        }
        try {
          const current = currentRecord.owner;
          if (ownerState(current) !== "stale") {
            const diagnostic = `pid=${current.pid} host=${current.host} openedAt=${current.openedAt} ownerToken=${current.ownerToken} incarnation=${ownerState(current)}`;
            throw new Error(`JSONL writer lock for ${file} is held (${diagnostic})`);
          }

          // Serialize recovery by the exact stale token observed. Both the
          // stale owner and every claim remain descriptor-pinned until their
          // owner-conditional deletion completes.
          const claimPath = recoveryClaimPath(path, current.ownerToken);
          const publishedClaim = await publishRecoveryClaim(claimPath, owner);
          if (!publishedClaim) {
            const claimantRecord = await readOwnerRecord(claimPath);
            if (!claimantRecord) {
              throw new Error(
                `JSONL writer lock recovery for ${file} is claimed (claimant metadata is missing or unreadable)`,
              );
            }
            try {
              const claimant = claimantRecord.owner;
              if (ownerState(claimant) !== "stale") {
                const diagnostic = `pid=${claimant.pid} host=${claimant.host} openedAt=${claimant.openedAt} ownerToken=${claimant.ownerToken}`;
                throw new Error(`JSONL writer lock recovery for ${file} is claimed (${diagnostic})`);
              }
              await hooks.beforeRecoveryClaimReap?.(claimPath, { ...claimant });
              const tombstone = reapedClaimPath(claimPath, claimant.ownerToken);
              try {
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
              const reapedRecord = await readOwnerRecord(tombstone);
              try {
                if (
                  !reapedRecord ||
                  !sameIdentity(reapedRecord, claimantRecord) ||
                  reapedRecord.owner.ownerToken !== claimant.ownerToken
                ) {
                  throw new Error(`JSONL writer recovery claim identity changed unexpectedly for ${file}`);
                }
                const quarantined = await quarantineObserved(
                  claimPath,
                  claimantRecord,
                  `${claimPath}.reap.${process.pid}.${randomUUID()}`,
                  `JSONL writer recovery claim identity changed unexpectedly for ${file}; replacement was restored or preserved`,
                );
                if (!quarantined) continue;
              } finally {
                await closeOwnerRecord(reapedRecord);
              }
              continue;
            } finally {
              await closeOwnerRecord(claimantRecord);
            }
          }
          try {
            await hooks.afterRecoveryClaimPublished?.(claimPath, { ...owner });
            const claimed = await readOwnerRecord(path);
            try {
              if (
                !claimed ||
                !sameIdentity(claimed, currentRecord) ||
                claimed.owner.ownerToken !== current.ownerToken ||
                ownerState(claimed.owner) !== "stale"
              ) {
                continue;
              }
            } finally {
              await closeOwnerRecord(claimed);
            }
            await hooks.beforeStaleOwnerQuarantine?.(path, { ...current });
            const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
            if (!(await quarantineObserved(path, currentRecord, stalePath))) continue;
          } finally {
            await releaseRecoveryClaim(claimPath, publishedClaim);
          }
        } finally {
          await closeOwnerRecord(currentRecord);
        }
      }
    }
  }

  /** Release only this owner's lock. Safe to call repeatedly. */
  release(): void {
    if (this.released) return;
    const fd = this.descriptor;
    this.descriptor = undefined;
    this.released = true;
    if (fd === undefined) return;
    try {
      const identity = fstatSync(fd, { bigint: true });
      if (identity.dev !== this.device || identity.ino !== this.inode) return;
      const current = readOwnerFromDescriptor(fd);
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
    } catch {
      return;
    } finally {
      closeSync(fd);
    }
  }
}
