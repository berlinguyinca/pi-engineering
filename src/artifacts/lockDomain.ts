import { randomUUID } from "node:crypto";
/**
 * The durable lock-domain identity of an artifact store.
 *
 * Identity is the domain TOKEN (`<artifacts>/.artifact-locks/.domain-token`),
 * which lives *inside* the lock directory: a copy of the whole tree carries its
 * own identity, and any store that did not create the tree can never publish a
 * token it does not already hold.
 *
 * `device` in the durable record is NOT identity — it is a mount-generation
 * stamp. `st_dev` names the mount a path was resolved through, not the storage
 * object, and it is documented to change across unmount/remount. macOS regenerates it
 * whenever the APFS volume generation changes (an OS update or restore creates
 * a new snapshot, which is what `/pie update` triggers, and a volume rollback
 * picks a fresh generation): the same directory, on the same disk, keeps its
 * inode, owner, mode and token while `st_dev` moves by a small delta. Treating
 * that as a substitution made every artifact store on such a host unopenable,
 * which surfaced as `Orchestrator not initialized for this directory`.
 *
 * So a device-only drift is judged on continuity instead: the lock directory
 * must still be the same *inode*, still owned by the current user with mode
 * 0700, and still carry the domain token the record names. When all of that
 * holds, the record is re-stamped with the live device (compare-and-swap, so a
 * concurrent opener's stamp is never silently overwritten); when any of it
 * fails, the store fails closed exactly as it did before.
 */
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";

export const LOCK_DOMAIN_RECORD = ".artifact-lock-domain.json";
export const LOCK_DOMAIN_TOKEN = ".domain-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LockDomainRecord {
  version: 1;
  token: string;
  device: bigint;
  inode: bigint;
}

/** Machine-readable reason attached to a lock-domain integrity failure. */
export type LockDomainFailureCode =
  | "LOCK_DOMAIN_RECORD_UNSAFE"
  | "LOCK_DOMAIN_RECORD_CORRUPT"
  | "LOCK_DOMAIN_RECORD_MISSING"
  | "LOCK_DOMAIN_RESTAMP_CONFLICT"
  | "LOCK_DOMAIN_TOKEN_MISMATCH"
  | "LOCK_ROOT_INODE_CHANGED"
  | "LOCK_ROOT_UNSAFE";

/** An integrity failure that diagnostics can classify without string matching. */
export class ArtifactIntegrityError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(`ARTIFACT INTEGRITY: ${message}`);
    this.name = "ArtifactIntegrityError";
    this.code = code;
  }
}

export function lockDomainIntegrityError(message: string, code: LockDomainFailureCode): ArtifactIntegrityError {
  return new ArtifactIntegrityError(message, code);
}

/** Parse a durable lock-domain record; unsafe or corrupt records are refused. */
export function parseLockDomainRecord(contents: string): LockDomainRecord {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw lockDomainIntegrityError("artifact lock domain record is corrupt", "LOCK_DOMAIN_RECORD_CORRUPT");
  }
  const candidate = value as Partial<{ version: number; token: string; device: string; inode: string }>;
  if (
    candidate.version !== 1 ||
    typeof candidate.token !== "string" ||
    !UUID.test(candidate.token) ||
    typeof candidate.device !== "string" ||
    !/^[0-9]+$/.test(candidate.device) ||
    typeof candidate.inode !== "string" ||
    !/^[0-9]+$/.test(candidate.inode)
  ) {
    throw lockDomainIntegrityError("artifact lock domain record is corrupt", "LOCK_DOMAIN_RECORD_CORRUPT");
  }
  return {
    version: 1,
    token: candidate.token,
    device: BigInt(candidate.device),
    inode: BigInt(candidate.inode),
  };
}

export function serializeLockDomainRecord(record: LockDomainRecord): string {
  return `${JSON.stringify({
    version: record.version,
    token: record.token,
    device: record.device.toString(),
    inode: record.inode.toString(),
  })}\n`;
}

export function sameLockDomainRecord(left: LockDomainRecord, right: LockDomainRecord): boolean {
  return (
    left.version === right.version &&
    left.token === right.token &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/** How a live lock root relates to the durable record that names it. */
export type LockDomainDrift =
  /** The live identity is exactly what the durable record asserts. */
  | { kind: "match" }
  /**
   * Device-only drift with continuity proven elsewhere: same inode, same
   * ownership and mode, same domain token. A new mount generation, not a
   * substitution — safe to re-stamp.
   */
  | { kind: "mount_generation"; from: bigint; to: bigint }
  /** Identity cannot be proven: the caller must fail closed. */
  | { kind: "unsafe"; message: string; code: LockDomainFailureCode };

/**
 * Classify the difference between a durable record and a lock root that is
 * provably owned by the current user (`assertTrustedDirectory` already passed)
 * and readable. The token is supplied by the caller because reading it requires
 * the pinned directory descriptor.
 */
export function classifyLockDomainDrift(args: {
  record: LockDomainRecord;
  identity: { dev: bigint; ino: bigint };
  /** Live token inside the lock directory; `undefined` when it cannot be read. */
  token: string | undefined;
}): LockDomainDrift {
  const { record, identity } = args;
  if (args.token === undefined) {
    return {
      kind: "unsafe",
      code: "LOCK_DOMAIN_TOKEN_MISMATCH",
      message:
        "artifact lock root identity changed (the lock directory carries no readable domain token, so this store did not create it)",
    };
  }
  if (identity.ino !== record.inode) {
    return {
      kind: "unsafe",
      code: "LOCK_ROOT_INODE_CHANGED",
      message: `artifact lock root identity changed (inode ${record.inode} is not the lock directory at ${identity.ino}; a substituted directory is not the same store)`,
    };
  }
  if (args.token !== record.token) {
    return {
      kind: "unsafe",
      code: "LOCK_DOMAIN_TOKEN_MISMATCH",
      message: "artifact lock root identity changed (the lock directory's domain token belongs to another store)",
    };
  }
  if (identity.dev !== record.device) {
    return { kind: "mount_generation", from: record.device, to: identity.dev };
  }
  return { kind: "match" };
}

/** What a re-stamp changed, so callers can log it as a durable audit note. */
export interface LockDomainRestampInfo {
  from: bigint;
  to: bigint;
  inode: bigint;
  token: string;
  reason: "mount_generation";
}

/**
 * Read the durable lock-domain record through the store root directory
 * descriptor's projected path (or a plain path on hosts without descriptor
 * projection). A record that is not a plain owner-writable file, or whose
 * contents do not parse, is refused.
 */
export async function readLockDomainRecordFile(dirPath: string): Promise<LockDomainRecord | undefined> {
  const path = `${dirPath}/${LOCK_DOMAIN_RECORD}`;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) {
      throw lockDomainIntegrityError("artifact lock domain record is unsafe", "LOCK_DOMAIN_RECORD_UNSAFE");
    }
    return parseLockDomainRecord(await handle.readFile({ encoding: "utf8" }));
  } finally {
    await handle.close();
  }
}

/** Read the domain token that lives inside the lock root (plain path). */
async function readDomainTokenFile(lockRootDir: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(`${lockRootDir}/${LOCK_DOMAIN_TOKEN}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) return undefined;
    const token = (await handle.readFile({ encoding: "utf8" })).trim();
    return UUID.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Whether a lock root is a plain directory owned by us with mode 0700. */
function isTrustedLockRoot(stat: { isDirectory(): boolean; uid: number; mode: number }): boolean {
  const uid = process.getuid?.();
  return stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o777) === 0o700;
}

/** Health of a store's durable lock domain, as reported by `doctor`. */
export type LockDomainHealth =
  /** Nothing to check: no store, or a bootstrap that has not published a domain yet. */
  | { status: "absent"; detail: string }
  | { status: "ok"; detail: string }
  /**
   * The record stamps a device the lock root no longer lives on while inode,
   * ownership, mode and domain token prove continuity. `doctor --repair` (and
   * opening the store) re-stamps it; nothing is lost.
   */
  | { status: "stale_device"; detail: string; from: bigint; to: bigint; repairable: true }
  /** Identity cannot be proven. The store fails closed, and repair would be unsafe. */
  | { status: "unsafe"; detail: string; code: LockDomainFailureCode | "LOCK_ROOT_MISSING" };

/**
 * Read-only inspection of `<artifacts>/.artifact-lock-domain.json` against the
 * live lock root, using exactly the continuity rules `ArtifactStore` applies
 * when it opens. Paths are plain here: the doctor is a diagnostic, not a writer
 * racing a substitution.
 */
export async function inspectLockDomainStore(artifactsDir: string): Promise<LockDomainHealth> {
  const lockRootDir = `${artifactsDir}/.artifact-locks`;
  let record: LockDomainRecord | undefined;
  try {
    record = await readLockDomainRecordFile(artifactsDir);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      return {
        status: "unsafe",
        code: error.code as LockDomainFailureCode,
        detail: `${artifactsDir}/${LOCK_DOMAIN_RECORD}: ${error.message}`,
      };
    }
    throw error;
  }
  if (!record) {
    return { status: "absent", detail: "no durable lock domain record (store not initialized, or mid-bootstrap)" };
  }
  let identity;
  try {
    identity = await lstat(lockRootDir, { bigint: true });
  } catch {
    return {
      status: "unsafe",
      code: "LOCK_ROOT_MISSING",
      detail: `${lockRootDir} is gone while ${LOCK_DOMAIN_RECORD} still names inode ${record.inode}; restore the lock directory with its .domain-token, or move the whole .pi-eng/artifacts tree aside and let the store rebuild`,
    };
  }
  if (!isTrustedLockRoot(await lstat(lockRootDir))) {
    return {
      status: "unsafe",
      code: "LOCK_ROOT_UNSAFE",
      detail: `${lockRootDir} is not a mode 0700 directory owned by uid ${process.getuid?.() ?? "(unknown)"}`,
    };
  }
  const drift = classifyLockDomainDrift({ record, identity, token: await readDomainTokenFile(lockRootDir) });
  if (drift.kind === "unsafe") return { status: "unsafe", code: drift.code, detail: drift.message };
  if (drift.kind === "mount_generation") {
    return {
      status: "stale_device",
      repairable: true,
      from: drift.from,
      to: drift.to,
      detail: `${LOCK_DOMAIN_RECORD} stamps device ${drift.from} but ${lockRootDir} is on device ${drift.to} (inode ${record.inode} and domain token unchanged) — a new mount generation, not a substituted store`,
    };
  }
  return { status: "ok", detail: `${lockRootDir} device ${record.device} inode ${record.inode}` };
}

/**
 * Re-stamp a stale device stamp. Refuses anything but a proven mount-generation
 * change, uses the same compare-and-swap as the store, and returns nothing when
 * the durable record moved underneath us (the caller reports it as still
 * repairable rather than claiming success).
 */
export async function repairLockDomainStore(artifactsDir: string): Promise<string | undefined> {
  const health = await inspectLockDomainStore(artifactsDir);
  if (health.status !== "stale_device") return undefined;
  const record = await readLockDomainRecordFile(artifactsDir);
  if (!record) return undefined;
  const identity = await lstat(`${artifactsDir}/.artifact-locks`, { bigint: true });
  const restamped = await restampLockDomainRecord({ dirPath: artifactsDir, expected: record, device: identity.dev });
  if (!restamped) return undefined;
  return `re-stamped ${artifactsDir}/${LOCK_DOMAIN_RECORD} device ${record.device} -> ${identity.dev} (inode ${record.inode} and domain token unchanged)`;
}

/**
 * Compare-and-swap the durable record's device stamp to a live device.
 *
 * The record is only ever replaced when it still holds exactly `expected` — the
 * record the caller validated — so a concurrent opener that published a
 * different domain loses nothing and is detected by its own validation. The
 * write is `O_EXCL` temp + atomic rename, then re-read to confirm the bytes we
 * intended are what a later opener will find. Returns `undefined` when the
 * durable record moved under us; the caller must then re-validate against the
 * record it finds, never assume success.
 */
export async function restampLockDomainRecord(args: {
  /** Directory the record lives in, already projected through a pinned descriptor when one exists. */
  dirPath: string;
  expected: LockDomainRecord;
  device: bigint;
  /** Flush the containing directory after the rename, when the caller can. */
  syncDir?: () => Promise<void>;
}): Promise<LockDomainRecord | undefined> {
  const { dirPath, expected, device } = args;
  const finalPath = `${dirPath}/${LOCK_DOMAIN_RECORD}`;
  const temporary = `${dirPath}/.${LOCK_DOMAIN_RECORD}.${process.pid}.${randomUUID()}.restamp.tmp`;
  const restamped: LockDomainRecord = { ...expected, device };
  let handle: FileHandle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    await handle.writeFile(serializeLockDomainRecord(restamped), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // The swap is only honest while the durable bytes are still the ones we
    // checked. Re-read immediately before renaming; anything else is a loss.
    const before = await readLockDomainRecordFile(dirPath);
    if (!before || !sameLockDomainRecord(before, expected)) {
      await rm(temporary, { force: true });
      return undefined;
    }
    await rename(temporary, finalPath);
    const after = await readLockDomainRecordFile(dirPath);
    if (!after || !sameLockDomainRecord(after, restamped)) {
      // Something replaced the record after our rename. The other writer's
      // bytes are the authority now; report the loss instead of claiming the
      // stamp.
      return undefined;
    }
    await args.syncDir?.();
    return after;
  } finally {
    await rm(temporary, { force: true });
  }
}
