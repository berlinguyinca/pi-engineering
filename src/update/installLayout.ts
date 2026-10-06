/**
 * Versioned Pi Engineering installations (spec §10, §31, §37).
 *
 *   <root>/
 *     versions/<id>/            immutable, validated runtime trees
 *     current  -> versions/<id> the runtime Pi Engineering starts from
 *     previous -> versions/<id> last known-good, the rollback target
 *     staging/update-<id>/      candidates being fetched/validated
 *     checkpoints/<tx>/         pre-migration state copies
 *     update-journal.json       crash-safe transaction record
 *     runtime-update.lock       cross-process mutation lock
 *
 * A pointer switch is ONE rename(2) of a freshly made symlink over the old
 * one, which POSIX makes atomic: a crash leaves either the old target or the
 * new one, never a missing or half-written pointer. Running code is never
 * overwritten; a version directory is never modified after install.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type PointerName = "current" | "previous";

export const INSTALL_META = ".pi-engineering-install.json";

/** Recorded with every installed version. */
export interface InstalledVersionMeta {
  id: string;
  version: string;
  commit: string | null;
  channel: string;
  source: string;
  installedAt: string;
  runtimeApi: number;
  stateSchema?: { minReadable: number; maxReadable: number; writes: number };
}

export interface InstalledVersion extends InstalledVersionMeta {
  dir: string;
}

const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function versionId(version: string, commit: string | null): string {
  const v = version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return commit ? `${v}-${commit.slice(0, 12)}` : v;
}

export class InstallLayout {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get versionsDir(): string {
    return join(this.root, "versions");
  }
  get stagingDir(): string {
    return join(this.root, "staging");
  }
  get checkpointsDir(): string {
    return join(this.root, "checkpoints");
  }
  get journalFile(): string {
    return join(this.root, "update-journal.json");
  }
  get lockFile(): string {
    return join(this.root, "runtime-update.lock");
  }
  get preferencesFile(): string {
    return join(this.root, "update-preferences.json");
  }
  get cacheRepo(): string {
    return join(this.root, "cache", "source.git");
  }

  pointerPath(name: PointerName): string {
    return join(this.root, name);
  }

  versionDir(id: string): string {
    if (!VERSION_ID.test(id)) throw new Error(`invalid version id: ${JSON.stringify(id)}`);
    return join(this.versionsDir, id);
  }

  /** Is `dir` a direct child of versions/ (no traversal, no symlink escape)? */
  isVersionDir(dir: string): boolean {
    const abs = resolve(dir);
    if (dirname(abs) !== this.versionsDir) return false;
    return VERSION_ID.test(basename(abs));
  }

  /** The version directory a pointer names, or null when absent/invalid. */
  readPointer(name: PointerName): string | null {
    const link = this.pointerPath(name);
    try {
      if (!lstatSync(link).isSymbolicLink()) return null;
      const target = resolve(dirname(link), readlinkSync(link));
      if (!this.isVersionDir(target) || !existsSync(target)) return null;
      return target;
    } catch {
      return null;
    }
  }

  /** Point `name` at a version directory, atomically. */
  async setPointer(name: PointerName, dir: string): Promise<void> {
    if (!this.isVersionDir(dir)) throw new Error(`refusing to point ${name} outside ${this.versionsDir}: ${dir}`);
    await mkdir(this.root, { recursive: true });
    const tmp = join(this.root, `.${name}.${process.pid}.${Date.now()}.tmp`);
    await rm(tmp, { force: true });
    // Relative target: the install root may be moved as a whole.
    await symlink(relative(this.root, resolve(dir)), tmp, "dir");
    await rename(tmp, this.pointerPath(name));
  }

  async clearPointer(name: PointerName): Promise<void> {
    await rm(this.pointerPath(name), { force: true });
  }

  /**
   * Make `dir` current; the old current becomes previous. Each step is one
   * atomic rename. Between them the state is still consistent: previous has
   * moved and current has not yet.
   */
  async activate(dir: string): Promise<{ current: string | null; previous: string | null }> {
    const before = { current: this.readPointer("current"), previous: this.readPointer("previous") };
    if (before.current && resolve(before.current) !== resolve(dir)) await this.setPointer("previous", before.current);
    await this.setPointer("current", dir);
    return before;
  }

  /** Put both pointers back exactly as they were. */
  async restorePointers(state: { current: string | null; previous: string | null }): Promise<void> {
    if (state.current) await this.setPointer("current", state.current);
    else await this.clearPointer("current");
    if (state.previous) await this.setPointer("previous", state.previous);
    else await this.clearPointer("previous");
  }

  readMeta(dir: string): InstalledVersionMeta | null {
    try {
      const meta = JSON.parse(readFileSync(join(dir, INSTALL_META), "utf8")) as InstalledVersionMeta;
      return typeof meta.id === "string" && typeof meta.version === "string" ? meta : null;
    } catch {
      return null;
    }
  }

  async writeMeta(dir: string, meta: InstalledVersionMeta): Promise<void> {
    await writeFile(join(dir, INSTALL_META), `${JSON.stringify(meta, null, 2)}\n`);
  }

  listVersions(): InstalledVersion[] {
    let names: string[];
    try {
      names = readdirSync(this.versionsDir);
    } catch {
      return [];
    }
    const out: InstalledVersion[] = [];
    for (const name of names) {
      if (!VERSION_ID.test(name)) continue;
      const dir = join(this.versionsDir, name);
      const meta = this.readMeta(dir);
      if (meta) out.push({ ...meta, dir });
    }
    return out.sort((a, b) => a.installedAt.localeCompare(b.installedAt));
  }

  /** Move a validated staging tree into versions/ (a rename: same filesystem). */
  async install(stagedDir: string, id: string): Promise<string> {
    const target = this.versionDir(id);
    await mkdir(this.versionsDir, { recursive: true });
    if (existsSync(target)) {
      // Same id means same version + commit: the content is identical. Keep the
      // installed tree (it may be the one running) and drop the new copy.
      await rm(stagedDir, { recursive: true, force: true });
      return target;
    }
    await rename(stagedDir, target);
    return target;
  }

  /** Directories under versions/ other than `keep`, oldest first. */
  async removableVersions(keep: Iterable<string>): Promise<string[]> {
    const kept = new Set([...keep].map((d) => safeReal(d)));
    let names: string[];
    try {
      names = await readdir(this.versionsDir);
    } catch {
      return [];
    }
    return this.listVersions()
      .filter((v) => names.includes(basename(v.dir)) && !kept.has(safeReal(v.dir)))
      .map((v) => v.dir);
  }
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Is `child` inside `parent` (after resolving)? */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}
