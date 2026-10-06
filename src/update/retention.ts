/**
 * Retention cleanup (spec §37).
 *
 * Kept, always: current, previous, the version running in this process, and
 * every version, staging tree or checkpoint an incomplete journal names
 * (crash recovery needs them). Beyond that the newest `keepVersions` installed
 * versions and `keepCheckpoints` checkpoints are kept, and staging trees of
 * finished transactions are removed.
 *
 * A kept version whose node_modules is a link into another version's
 * directory (installs made before every version owned its dependency tree)
 * keeps that other version as well, so no kept version is left dangling.
 *
 * Other Pi processes never import code from versions/ directly: each one
 * materializes its generations under its own generations/<pid>-… directory.
 * Those snapshots link node_modules into the version they came from, so a
 * version a live process's snapshot links to is kept as well.
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type InstallLayout, isInside } from "./installLayout.ts";
import type { UpdateJournal } from "./journal.ts";

export interface RetentionOptions {
  keepVersions?: number;
  keepCheckpoints?: number;
  /** Version directory the calling process runs (never removed). */
  running?: string | null;
}

export interface RetentionResult {
  versions: string[];
  staging: string[];
  checkpoints: string[];
}

export async function applyRetention(
  layout: InstallLayout,
  journal: UpdateJournal,
  opts: RetentionOptions = {},
): Promise<RetentionResult> {
  const keepVersions = Math.max(2, opts.keepVersions ?? 3);
  const keepCheckpoints = Math.max(1, opts.keepCheckpoints ?? 3);
  const protectedPaths = new Set<string>();
  const protect = (p: string | null | undefined) => {
    if (p) protectedPaths.add(resolve(p));
  };
  protect(layout.readPointer("current"));
  protect(layout.readPointer("previous"));
  protect(opts.running);
  const incomplete = journal.incomplete();
  if (incomplete) {
    protect(incomplete.candidateRuntime);
    protect(incomplete.previousRuntime);
    protect(incomplete.pointers.current);
    protect(incomplete.pointers.previous);
    protect(incomplete.migration?.checkpoint);
    protect(join(layout.checkpointsDir, incomplete.transaction));
  }

  const removed: RetentionResult = { versions: [], staging: [], checkpoints: [] };

  // Versions: newest `keepVersions` stay, protected ones always.
  const versions = layout.listVersions();
  const newest = new Set(versions.slice(-keepVersions).map((v) => resolve(v.dir)));
  // Installs made before each version owned its dependency tree link
  // node_modules into another version's directory. A kept version must never
  // be left with a dangling link: the version that owns the tree stays too.
  for (const v of versions) {
    const dir = resolve(v.dir);
    if (!newest.has(dir) && !protectedPaths.has(dir)) continue;
    const owner = linkedModulesOwner(versions, dir);
    if (owner) protect(owner);
  }
  // Generation snapshots of live Pi processes (generations/<pid>-…/<snapshot>)
  // link node_modules into the version they were taken from; that process may
  // still import lazily from it.
  for (const name of safeList(join(layout.root, "generations"))) {
    const pid = Number(name.split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) continue;
    const processDir = join(layout.root, "generations", name);
    for (const snapshot of safeList(processDir)) {
      const owner = linkedModulesOwner(versions, join(processDir, snapshot));
      if (owner) protect(owner);
    }
  }
  for (const v of versions) {
    const dir = resolve(v.dir);
    if (newest.has(dir) || protectedPaths.has(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    removed.versions.push(dir);
  }

  // Staging: nothing in it is needed once its transaction finished. While one
  // is still open, staging belongs to it (crash recovery decides).
  for (const name of incomplete ? [] : safeList(layout.stagingDir)) {
    const dir = resolve(layout.stagingDir, name);
    if (protectedPaths.has(dir) || !isInside(layout.stagingDir, dir)) continue;
    await rm(dir, { recursive: true, force: true });
    removed.staging.push(dir);
  }

  // Checkpoints: the newest few stay (manual rollback restores from them).
  const checkpoints = safeList(layout.checkpointsDir)
    .map((name) => resolve(layout.checkpointsDir, name))
    .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    .sort((a, b) => (statSync(a).mtimeMs ?? 0) - (statSync(b).mtimeMs ?? 0));
  const keptCheckpoints = new Set(checkpoints.slice(-keepCheckpoints));
  for (const dir of checkpoints) {
    if (keptCheckpoints.has(dir) || protectedPaths.has(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    removed.checkpoints.push(dir);
  }
  return removed;
}

/** The installed version whose directory `dir`/node_modules links into, if any. */
function linkedModulesOwner(versions: readonly { dir: string }[], dir: string): string | null {
  const modules = join(dir, "node_modules");
  try {
    if (!lstatSync(modules).isSymbolicLink()) return null;
    const target = realpathSync(modules);
    for (const v of versions) {
      const real = realpathSync(v.dir);
      if (real !== realpathSync(dir) && isInside(real, target)) return resolve(v.dir);
    }
    return null;
  } catch {
    return null;
  }
}

/** Conservative: a PID that might be alive (EPERM included) keeps its versions. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeList(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
