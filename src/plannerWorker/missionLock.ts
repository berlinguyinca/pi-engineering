/**
 * One live owner per planner-worker mission.
 *
 * Running and resuming a mission rebuild its integration worktree and discard
 * the worktrees of unfinished contracts, so two processes driving the same
 * mission would delete worktrees under each other's live workers. The owner
 * records itself in `<stateDir>/mission.lock` by pid AND process incarnation
 * (boot id + `/proc/<pid>/stat` start time), so a reused pid is not mistaken
 * for the owner. A live (or undeterminable) owner refuses the lock; a dead
 * owner's lock — a crash, a SIGKILL — is taken over.
 *
 * Race-freedom: the lock file is never deleted while anyone but its owner
 * could act on it. A fresh lock is created exclusively (hard link of a fully
 * written draft, or an O_EXCL create where hard links are unsupported). A
 * dead owner's lock is replaced in place (atomic rename) only by the single
 * claimant that exclusively created `<lock>.takeover-<dead token>`; it
 * re-checks under that claim that the lock still names the dead owner. A
 * claim abandoned by a crashed claimant is itself taken over the same way.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ProcessIdentity, assessProcess, currentProcessIdentity } from "../runtime/isolation/processIdentity.ts";

const LOCK_FILE = "mission.lock";

interface LockRecord extends ProcessIdentity {
  token: string;
  acquired_at: string;
}

export class MissionLockedError extends Error {
  constructor(stateDir: string, holder: LockRecord | null) {
    super(
      holder
        ? `mission in ${stateDir} is being run by pid ${holder.pid} on ${holder.host} (since ${holder.acquired_at}); not resuming it concurrently`
        : `mission in ${stateDir} is locked by another process`,
    );
    this.name = "MissionLockedError";
  }
}

/** Test seams; production callers omit them. */
export interface MissionLockHooks {
  /** Hard-link primitive (default fs.promises.link); failing like EPERM reproduces a filesystem without hard links. */
  linkFile?: (existingPath: string, newPath: string) => Promise<void>;
  /** Runs between an O_EXCL create of `path` and writing its record: a slow writer. */
  beforeRecordWrite?: (path: string) => Promise<void>;
}

export interface MissionLock {
  /** Remove the lock if it is still ours (a no-op once taken over by another owner). */
  release(): Promise<void>;
}

type Read =
  | { kind: "record"; record: LockRecord }
  | { kind: "missing" }
  | { kind: "corrupt"; token: string; ageMs: number };

/**
 * An unreadable (empty or partial) lock younger than this may still be being
 * written by an O_EXCL creator on a filesystem without hard links: it is held,
 * not abandoned. Only an older one is taken over.
 */
const FRESH_MS = 5_000;

async function readRecord(path: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const r = JSON.parse(text) as Partial<LockRecord>;
    if (typeof r.pid === "number" && typeof r.token === "string" && typeof r.host === "string") {
      return { kind: "record", record: r as LockRecord };
    }
  } catch {
    // fall through
  }
  const mtime = await stat(path).then(
    (st) => st.mtimeMs,
    () => Date.now(),
  );
  return {
    kind: "corrupt",
    token: `corrupt-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    ageMs: Date.now() - mtime,
  };
}

/**
 * Read a lock or claim, giving an O_EXCL creator (no hard links) a moment to
 * finish writing it; a still-unreadable one is judged by its age (`FRESH_MS`).
 */
async function settledRecord(path: string): Promise<Read> {
  let r = await readRecord(path);
  for (let i = 0; i < 20 && r.kind === "corrupt"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    r = await readRecord(path);
  }
  return r;
}

const dead = (r: Read): boolean =>
  r.kind === "corrupt" ? r.ageMs > FRESH_MS : r.kind === "record" && assessProcess(r.record).state === "dead";
const tokenOf = (r: Read): string | null =>
  r.kind === "record" ? r.record.token : r.kind === "corrupt" ? r.token : null;

/**
 * Create `path` exclusively with `content`: a hard link of the written draft
 * (never visible half-written), or an O_EXCL create on filesystems without
 * hard links. False when it already exists.
 */
async function createExclusive(
  path: string,
  draft: string,
  content: string,
  hooks: MissionLockHooks,
): Promise<boolean> {
  try {
    await (hooks.linkFile ?? link)(draft, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code ?? "")) throw error;
  }
  // No hard links: the O_EXCL create publishes the file before it is filled.
  // Readers treat a fresh unreadable file as being written (see `dead`).
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await hooks.beforeRecordWrite?.(path);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Become the single claimant allowed to replace `target`, whose holder (token
 * `deadToken`) is dead. Returns the claim files created, outermost first, or
 * null when a live claimant got there first.
 */
async function claim(
  target: string,
  deadToken: string,
  draft: string,
  content: string,
  hooks: MissionLockHooks,
): Promise<string[] | null> {
  const marker = `${target}.takeover-${deadToken}`;
  for (let tries = 0; tries < 5; tries++) {
    if (await createExclusive(marker, draft, content, hooks)) return [marker];
    const holder = await settledRecord(marker);
    if (holder.kind === "missing") continue;
    if (!dead(holder)) return null;
    // A claimant crashed mid-takeover: take over its claim, which leaves the
    // abandoned marker in place so nobody else can create it afresh.
    const inner = await claim(marker, tokenOf(holder)!, draft, content, hooks);
    return inner ? [...inner, marker] : null;
  }
  return null;
}

/** Take the mission's lock, taking it over from a dead owner; throws `MissionLockedError` when held. */
export async function acquireMissionLock(stateDir: string, hooks: MissionLockHooks = {}): Promise<MissionLock> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, LOCK_FILE);
  const record: LockRecord = {
    ...currentProcessIdentity(),
    token: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
  const content = `${JSON.stringify(record)}\n`;
  const ours = { release: () => releaseIfOwned(path, record.token) };
  const draft = `${path}.${record.token}.tmp`;
  await writeFile(draft, content);
  try {
    for (let tries = 0; tries < 5; tries++) {
      if (await createExclusive(path, draft, content, hooks)) return ours;
      const holder = await settledRecord(path);
      if (holder.kind === "missing") continue;
      if (!dead(holder)) throw new MissionLockedError(stateDir, holder.kind === "record" ? holder.record : null);
      const stale = tokenOf(holder)!;
      const claims = await claim(path, stale, draft, content, hooks);
      if (!claims) throw new MissionLockedError(stateDir, null);
      try {
        // Exclusive claimant now: replace the lock only if it still names the dead owner.
        if (tokenOf(await settledRecord(path)) !== stale) continue;
        const replacement = `${draft}.replace`;
        await writeFile(replacement, content);
        await rename(replacement, path);
        return ours;
      } finally {
        // Only after the lock is replaced (or found changed): a later claimant
        // re-checks the lock and finds it no longer names the dead owner.
        for (const file of claims) await rm(file, { force: true });
      }
    }
    throw new MissionLockedError(stateDir, null);
  } finally {
    await rm(draft, { force: true });
  }
}

async function releaseIfOwned(path: string, token: string): Promise<void> {
  const holder = await readRecord(path).catch(() => ({ kind: "missing" }) as const);
  if (holder.kind === "record" && holder.record.token === token) await rm(path, { force: true });
}
