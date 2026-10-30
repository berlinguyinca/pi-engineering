/**
 * Trash for housekeeping: sweeps MOVE what they reclaim here and never delete
 * it (owner rule: "we can't lose data due to sweeps"). The only code that ever
 * removes anything from a trash root is `purgeTrash`, reached through the
 * explicit `/gc --purge-trash --older-than <days> --apply` command.
 *
 * Layout: `<trashRoot>/<ISO-ts>/` holds one `.pi-eng-trash.json` marker (proof
 * that pi-engineering created the entry) and the moved item as `<ISO-ts>/<name>`.
 * Purge only touches entries that are regular directories directly under the
 * root, carry a valid marker as a regular file, and are old enough; it never
 * follows symlinks.
 */

import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TRASH_MARKER_FILE = ".pi-eng-trash.json";
export const DEFAULT_PURGE_OLDER_THAN_DAYS = 14;
export const MIN_PURGE_OLDER_THAN_DAYS = 7;

export interface TrashMarker {
  version: 1;
  creator: "pi-engineering";
  kind: "worktree" | "rust-cache";
  movedAt: string;
  items: Array<{ name: string; from: string; branch?: string | null }>;
}

export interface TrashEntry {
  /** `<trashRoot>/<ts>`: holds the marker and the moved item. */
  dir: string;
  /** Where the caller renames the item to. */
  dest: string;
}

/** Create a fresh trash entry for `item` (marker written, destination not yet occupied). */
export async function createTrashEntry(
  trashRoot: string,
  kind: TrashMarker["kind"],
  item: { name: string; from: string; branch?: string | null },
  now: number = Date.now(),
): Promise<TrashEntry> {
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/:/g, "-");
  for (let n = 0; n < 1000; n++) {
    const dir = join(trashRoot, n === 0 ? stamp : `${stamp}-${n}`);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const marker: TrashMarker = {
      version: 1,
      creator: "pi-engineering",
      kind,
      movedAt: new Date(now).toISOString(),
      items: [item],
    };
    await writeFile(join(dir, TRASH_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    return { dir, dest: join(dir, item.name) };
  }
  throw new Error(`could not allocate a trash entry under ${trashRoot}`);
}

/** Undo `createTrashEntry` when the move failed: drops only the marker and the (empty) entry directory. */
export async function abandonTrashEntry(entry: TrashEntry): Promise<void> {
  await unlink(join(entry.dir, TRASH_MARKER_FILE)).catch(() => {});
  await rmdir(entry.dir).catch(() => {});
}

/** Move `from` into a new trash entry by rename. Throws (EXDEV across filesystems) after cleaning up its own entry. */
export async function moveToTrash(
  trashRoot: string,
  kind: TrashMarker["kind"],
  from: string,
  name: string,
  branch?: string | null,
  now?: number,
): Promise<string> {
  const entry = await createTrashEntry(trashRoot, kind, { name, from, branch }, now);
  try {
    await rename(from, entry.dest);
  } catch (error) {
    await abandonTrashEntry(entry);
    throw error;
  }
  return entry.dest;
}

async function readTrashMarker(dir: string): Promise<TrashMarker | null> {
  const file = join(dir, TRASH_MARKER_FILE);
  const l = await lstat(file).catch(() => null);
  if (!l?.isFile()) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TrashMarker>;
    if (parsed.version !== 1 || parsed.creator !== "pi-engineering") return null;
    if (typeof parsed.movedAt !== "string" || !Number.isFinite(Date.parse(parsed.movedAt))) return null;
    return parsed as TrashMarker;
  } catch {
    return null;
  }
}

export interface TrashPurgeReport {
  purged: Array<{ path: string; ageDays: number }>;
  skipped: Array<{ path: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Permanently delete trash entries older than `olderThanDays` (>= 7). Without
 * `apply` it only lists what it would delete. Foreign or unmarked entries,
 * symlinks and anything not a regular directory directly under the root are
 * skipped and reported.
 */
export async function purgeTrash(
  trashRoot: string,
  opts: { olderThanDays: number; apply: boolean; now?: number },
): Promise<TrashPurgeReport> {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays < MIN_PURGE_OLDER_THAN_DAYS) {
    throw new Error(`--older-than must be at least ${MIN_PURGE_OLDER_THAN_DAYS} days`);
  }
  const now = opts.now ?? Date.now();
  const report: TrashPurgeReport = { purged: [], skipped: [], dryRun: !opts.apply };
  const realRoot = await realpath(trashRoot).catch(() => null);
  if (!realRoot) return report;
  for (const name of await readdir(trashRoot).catch(() => [] as string[])) {
    const path = join(trashRoot, name);
    const skip = (reason: string) => report.skipped.push({ path, reason });
    const l = await lstat(path).catch(() => null);
    if (!l?.isDirectory() || l.isSymbolicLink()) {
      skip("not a regular directory");
      continue;
    }
    if ((await realpath(path).catch(() => null)) !== join(realRoot, name)) {
      skip("does not resolve to a directory directly under the trash root");
      continue;
    }
    const marker = await readTrashMarker(path);
    if (!marker) {
      skip("no valid pi-engineering trash marker; not created by housekeeping, left alone");
      continue;
    }
    const ageDays = (now - Date.parse(marker.movedAt)) / 86_400_000;
    if (ageDays < opts.olderThanDays) {
      skip(`trashed ${Math.floor(ageDays)} d ago (< ${opts.olderThanDays} d)`);
      continue;
    }
    if (opts.apply) {
      // Re-check immediately before deleting; rm never follows symlinks.
      const again = await lstat(path).catch(() => null);
      if (!again?.isDirectory() || again.isSymbolicLink() || !(await readTrashMarker(path))) {
        skip("changed while purging; left alone");
        continue;
      }
      await rm(path, { recursive: true, force: false });
    }
    report.purged.push({ path, ageDays: Math.floor(ageDays) });
  }
  return report;
}
