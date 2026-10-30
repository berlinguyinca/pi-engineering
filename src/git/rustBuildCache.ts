/**
 * Rust build cache for isolated worktrees.
 *
 * Cargo keys its build cache (`target/`) on the checkout directory, so every
 * candidate worktree the runtime creates (INV-004) rebuilds the full dependency
 * graph from scratch and leaves a multi-gigabyte `target/` behind when the
 * worktree is abandoned. Twelve concurrent candidates on one Rust project
 * meant twelve copies of the same compiled dependencies and a full disk.
 *
 * This module points the Rust builds the runtime SPAWNS ITSELF (verification
 * stages, CAV runs and lifecycle commands) at ONE machine-wide cache root,
 * `~/.rust/cache` by default (mode 0700):
 *
 *   ~/.rust/cache/target/<repo>-<hash>/<worktree-hash>  CARGO_TARGET_DIR
 *   ~/.rust/cache/sccache                                SCCACHE_DIR
 *
 * It applies only to projects with a Cargo.toml at the checkout root. The
 * variables are computed per spawned command and never exported to
 * `process.env`: a worker's own `bash` tool calls therefore get neither the
 * per-worktree target dir nor sccache, and build inside the worktree (the
 * janitor removes that with the worktree). Idle generations are moved to the trash after
 * `PI_RUST_CACHE_MAX_AGE_DAYS` (default 30); there is no byte cap.
 *
 * Each worktree gets its OWN target directory. Sharing one target directory
 * between worktrees is not safe: cargo identifies a workspace crate by its
 * path relative to the workspace root and decides freshness by mtime, so a
 * worktree whose sources are older than another worktree's last build reuses
 * that build and one worker's tests run against another worker's code
 * (measured upstream; see docs/usage.md). What IS shared safely is compiled
 * dependencies, through `sccache`: when it is on PATH it becomes
 * `RUSTC_WRAPPER` and every rustc invocation is cached by the hash of its
 * inputs, so a second worktree's dependency build is a cache hit, not a
 * recompile. Nothing is installed by this module.
 *
 * Moving target dirs out of the worktrees keeps them in one place. The
 * housekeeping sweep (`sweepRustCache`) never deletes: it moves a generation
 * dir to `<cache>/.trash/<ts>/` only when the runtime's ownership marker
 * (`.pi-eng-rust-cache.json`) is present, it is idle and its worktree is gone;
 * `/gc --purge-trash` is the only thing that removes trash. The cache root must
 * carry `.pi-eng-rust-cache-root` (written on first use of an empty or older
 * cache); any other directory named by `PI_RUST_CACHE_DIR` is refused.
 *
 * Operator intent always wins: an explicit `CARGO_TARGET_DIR`, `RUSTC_WRAPPER`
 * or `SCCACHE_DIR` in the environment is left untouched, `PI_RUST_CACHE_DIR`
 * relocates the root, and `PI_RUST_CACHE=0` switches the whole thing off.
 */

import { execFile } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { abandonTrashEntry, createTrashEntry } from "./trashStore.ts";

const exec = promisify(execFile);

/** Relocates the cache root. Default: `~/.rust/cache`. */
export const RUST_CACHE_DIR_ENV = "PI_RUST_CACHE_DIR";
/** `0`/`false`/`off` disables the shared cache entirely. */
export const RUST_CACHE_ENABLED_ENV = "PI_RUST_CACHE";
/** Key used for a cwd that is not inside a git repository. */
export const UNSCOPED_TARGET_KEY = "_shared";

export interface RustBuildEnv {
  CARGO_TARGET_DIR?: string;
  RUSTC_WRAPPER?: string;
  SCCACHE_DIR?: string;
}

type Env = Record<string, string | undefined>;

/** Short, stable, filesystem-safe hash (same scheme as GitRepo's worktree dirs). */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function expandHome(path: string, env: Env): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = env.HOME?.trim() || homedir();
    return join(home, path.slice(1));
  }
  return path;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "repo";
}

/** True unless the operator switched the shared cache off. */
export function rustCacheEnabled(env: Env = process.env): boolean {
  const raw = env[RUST_CACHE_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** The machine-wide cache root: `PI_RUST_CACHE_DIR` or `~/.rust/cache`. */
export function rustCacheRoot(env: Env = process.env): string {
  const explicit = env[RUST_CACHE_DIR_ENV]?.trim();
  if (explicit) {
    const expanded = expandHome(explicit, env);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  const home = env.HOME?.trim() || homedir();
  return join(home, ".rust", "cache");
}

/**
 * Target-dir key for `cwd`: `<repo>-<hash(common dir)>/<hash(worktree root)>`.
 * The first segment groups every checkout of one repository (the common dir is
 * identical across linked worktrees); the second keeps each worktree's build
 * separate, which cargo's path+mtime freshness requires. A cwd outside any
 * repository maps to one unscoped key.
 */
export async function rustTargetKey(cwd: string): Promise<string> {
  const identity = await repoIdentity(cwd);
  if (!identity) return UNSCOPED_TARGET_KEY;
  const { commonDir, toplevel } = identity;
  // `<repo>/.git` for a normal repository; a bare repository is its own common dir.
  const repoDir = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  return join(`${sanitizeName(basename(repoDir))}-${shortHash(commonDir)}`, shortHash(toplevel));
}

async function repoIdentity(cwd: string): Promise<{ commonDir: string; toplevel: string } | null> {
  try {
    const r = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { timeout: 10_000 },
    );
    const [commonDir = "", toplevel = ""] = r.stdout.trim().split(/\r?\n/);
    return commonDir && toplevel ? { commonDir, toplevel } : null;
  } catch {
    return null;
  }
}

/**
 * The target directory the runtime assigns to builds from `cwd`, or null when
 * the cache is disabled or the operator set CARGO_TARGET_DIR themselves (that
 * directory is theirs; the runtime never removes it).
 */
export async function rustTargetDir(cwd: string, env: Env = process.env): Promise<string | null> {
  if (!rustCacheEnabled(env) || env.CARGO_TARGET_DIR?.trim()) return null;
  return join(rustCacheRoot(env), "target", await rustTargetKey(cwd));
}

let sccacheLookup: { path: string; found: string | null } | null = null;

/** Locate `sccache` on PATH without spawning anything; memoised per PATH value. */
export function findSccache(env: Env = process.env): string | null {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const path = env[pathKey] ?? "";
  if (sccacheLookup && sccacheLookup.path === path) return sccacheLookup.found;
  let found: string | null = null;
  const exe = process.platform === "win32" ? "sccache.exe" : "sccache";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      found = candidate;
      break;
    } catch {
      /* keep looking */
    }
  }
  sccacheLookup = { path, found };
  return found;
}

/** Test seam: forget the memoised sccache lookup. */
export function resetSccacheLookup(): void {
  sccacheLookup = null;
}

/**
 * True when `cwd` (or the root of the git checkout containing it) has a
 * `Cargo.toml`. Node, Python and other repositories get no Rust variables.
 */
export async function isRustProject(cwd: string): Promise<boolean> {
  if (existsSync(join(cwd, "Cargo.toml"))) return true;
  try {
    const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    const top = r.stdout.trim();
    return top !== "" && existsSync(join(top, "Cargo.toml"));
  } catch {
    return false;
  }
}

const keyCache = new Map<string, Promise<string>>();

/** Test seam: forget memoised per-cwd target keys. */
export function resetRustTargetKeys(): void {
  keyCache.clear();
}

/**
 * The variables a Rust build run from `cwd` should see on top of `env`.
 * Returns an empty object when the cache is disabled; never overrides a
 * variable the operator already set.
 */
export async function rustBuildEnv(cwd: string, env: Env = process.env): Promise<RustBuildEnv> {
  if (!rustCacheEnabled(env) || !(await isRustProject(cwd))) return {};
  const root = rustCacheRoot(env);
  const out: RustBuildEnv = {};
  if (!env.CARGO_TARGET_DIR?.trim()) {
    let keyPromise = keyCache.get(cwd);
    if (!keyPromise) {
      keyPromise = rustTargetKey(cwd);
      keyCache.set(cwd, keyPromise);
    }
    out.CARGO_TARGET_DIR = join(root, "target", await keyPromise);
  }
  if (!env.RUSTC_WRAPPER?.trim()) {
    const sccache = findSccache(env);
    if (sccache) {
      out.RUSTC_WRAPPER = sccache;
      if (!env.SCCACHE_DIR?.trim()) out.SCCACHE_DIR = join(root, "sccache");
    }
  }
  return out;
}

/**
 * Merge the shared-cache variables into `env` in place and return it. Only the
 * cache root is guaranteed to exist (mode 0700, so other local users cannot
 * plant build output in it); cargo and sccache make their own directories
 * below it on first use. Computed per command, never exported process-wide, so
 * an sccache removed after startup just drops out of the next command's env.
 */
export async function withRustBuildEnv<T extends Env>(env: T, cwd: string): Promise<T> {
  const additions = await rustBuildEnv(cwd, env);
  if (Object.keys(additions).length > 0) {
    const root = rustCacheRoot(env);
    // A root that is not ours (e.g. PI_RUST_CACHE_DIR pointing at a home or work dir) is never used:
    // the build proceeds without the shared cache rather than scattering target dirs into it.
    const check = await prepareRustCacheRoot(root);
    if (!check.ok) {
      warnRefusedRoot(root, check.reason);
      return env;
    }
    if (additions.CARGO_TARGET_DIR) await markGeneration(additions.CARGO_TARGET_DIR, cwd);
  }
  applyAdditions(env, additions);
  return env;
}

const warnedRoots = new Set<string>();

/** One visible warning per root and process: without it a refused root silently disables the shared cache. */
function warnRefusedRoot(root: string, reason: string): void {
  if (warnedRoots.has(root)) return;
  warnedRoots.add(root);
  process.emitWarning(`the shared Rust cache is disabled: ${reason}`, { type: "PiRustCacheWarning" });
}

/** Marks the cache root as pi-engineering's. A root without it is refused (see `prepareRustCacheRoot`). */
export const RUST_CACHE_ROOT_MARKER = ".pi-eng-rust-cache-root";
/** Marks one generation dir (`target/<repo>/<worktree>`) as created by the runtime; only marked ones are swept. */
export const RUST_CACHE_GENERATION_MARKER = ".pi-eng-rust-cache.json";
/** Entries a root may hold and still be adopted (a cache created before the root marker existed). */
const ADOPTABLE_ROOT_ENTRIES = new Set(["target", "sccache", ".trash", RUST_CACHE_ROOT_MARKER]);

export type RustCacheRootCheck = { ok: true } | { ok: false; reason: string };

export async function hasRootMarker(root: string): Promise<boolean> {
  const file = join(root, RUST_CACHE_ROOT_MARKER);
  if (!(await lstat(file).catch(() => null))?.isFile()) return false;
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { creator?: unknown }).creator === "pi-engineering";
  } catch {
    return false;
  }
}

/**
 * Make `root` usable as the cache root, or say why not. A missing or empty root
 * (or an older cache holding only `target/` and `sccache/`) gets the root marker
 * written on first use; any other directory without the marker is refused, so a
 * misconfigured `PI_RUST_CACHE_DIR` can never turn a user directory into a cache.
 */
export async function prepareRustCacheRoot(root: string): Promise<RustCacheRootCheck> {
  try {
    if (!(await hasRootMarker(root))) {
      const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
      if (!entries.every((e) => ADOPTABLE_ROOT_ENTRIES.has(e))) {
        return {
          ok: false,
          reason: `${root} is not a pi-engineering Rust cache (no ${RUST_CACHE_ROOT_MARKER} marker and it holds other files); refusing to use or sweep it`,
        };
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, RUST_CACHE_ROOT_MARKER),
        `${JSON.stringify({ version: 1, creator: "pi-engineering" })}\n`,
        { flag: "wx" },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    await chmod(root, 0o700);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `${root} is unusable as a Rust cache: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GenerationMarker {
  version: 1;
  creator: "pi-engineering";
  worktreePath: string;
  createdAt: string;
}

async function markGeneration(dir: string, cwd: string): Promise<void> {
  try {
    const identity = await repoIdentity(cwd);
    if (!identity) return; // the shared `_shared` fallback dir belongs to no one checkout: never marked, never swept
    await mkdir(dir, { recursive: true });
    const marker: GenerationMarker = {
      version: 1,
      creator: "pi-engineering",
      worktreePath: identity.toplevel,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, RUST_CACHE_GENERATION_MARKER), `${JSON.stringify(marker)}\n`, { flag: "wx" });
  } catch {
    /* EEXIST is the normal case; a failed mark only leaves the dir unswept, which is the safe side */
  }
}

async function readGenerationMarker(dir: string): Promise<GenerationMarker | null> {
  const file = join(dir, RUST_CACHE_GENERATION_MARKER);
  if (!(await lstat(file).catch(() => null))?.isFile()) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<GenerationMarker>;
    return parsed.version === 1 && parsed.creator === "pi-engineering" ? (parsed as GenerationMarker) : null;
  } catch {
    return null;
  }
}

function applyAdditions(env: Env, additions: RustBuildEnv): void {
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value;
  }
}

/** Days a per-worktree target dir may go unused before the sweep moves it to the trash. */
export const RUST_CACHE_MAX_AGE_DAYS_ENV = "PI_RUST_CACHE_MAX_AGE_DAYS";
export const DEFAULT_RUST_CACHE_MAX_AGE_DAYS = 30;

export interface RustCacheSweepReport {
  /** Generation dirs moved (or, in a dry run, that would be moved) to `<cache>/.trash`. Never deleted. */
  trashed: Array<{ path: string; idleDays: number; trashedTo?: string }>;
  kept: Array<{ path: string; idleDays: number; reason: string }>;
  /** Why the whole sweep did nothing (cache root not ours). */
  refused?: string;
  dryRun: boolean;
}

export function rustCacheMaxAgeMs(env: Env = process.env): number {
  const raw = Number(env[RUST_CACHE_MAX_AGE_DAYS_ENV]);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUST_CACHE_MAX_AGE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Newest build activity in a cargo target dir. Cargo touches
 * `<target>/<profile>/.cargo-lock` on every build, so that beats the
 * directory's own mtime, which only changes when a profile dir is added.
 */
async function targetLastActivity(dir: string): Promise<number> {
  let newest = (await stat(dir).catch(() => null))?.mtimeMs ?? 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    for (const probe of [join(dir, name), join(dir, name, ".cargo-lock")]) {
      const s = await stat(probe).catch(() => null);
      if (s) newest = Math.max(newest, s.mtimeMs);
    }
  }
  return newest;
}

/**
 * Move idle per-worktree target dirs out of the cache into `<cache>/.trash/<ts>/`.
 * Nothing is deleted here (only `/gc --purge-trash` deletes). A generation is
 * moved only when it carries the runtime's ownership marker, has been idle for
 * `maxAgeMs`, and its worktree is gone (the marker's recorded checkout no longer
 * exists and it is not in `liveTargetDirs`). Unmarked dirs (created before the
 * marker existed, or by anyone else) are kept and reported. A cache root without
 * the root marker is refused outright.
 */
export async function sweepRustCache(
  opts: {
    env?: Env;
    maxAgeMs?: number;
    dryRun?: boolean;
    now?: () => number;
    /** Target dirs of worktrees known to be live; never moved. */
    liveTargetDirs?: ReadonlySet<string>;
  } = {},
): Promise<RustCacheSweepReport> {
  const env = opts.env ?? process.env;
  const report: RustCacheSweepReport = { trashed: [], kept: [], dryRun: Boolean(opts.dryRun) };
  if (!rustCacheEnabled(env)) return report;
  const root = rustCacheRoot(env);
  if (!(await stat(root).catch(() => null))) return report;
  if (!(await hasRootMarker(root))) {
    // An older cache is adopted (marker only, nothing moved); anything else is refused.
    const check = opts.dryRun ? await classifyRoot(root) : await prepareRustCacheRoot(root);
    if (!check.ok) return { ...report, refused: check.reason };
  }
  const targets = join(root, "target");
  const now = opts.now?.() ?? Date.now();
  const maxAge = opts.maxAgeMs ?? rustCacheMaxAgeMs(env);
  for (const repoName of await readdir(targets).catch(() => [] as string[])) {
    const repoDir = join(targets, repoName);
    const repoStat = await lstat(repoDir).catch(() => null);
    if (!repoStat?.isDirectory()) continue;
    let leftBehind = 0;
    for (const name of await readdir(repoDir).catch(() => [] as string[])) {
      const dir = join(repoDir, name);
      if (!(await lstat(dir).catch(() => null))?.isDirectory()) {
        leftBehind++;
        continue;
      }
      const idleMs = now - (await targetLastActivity(dir));
      const idleDays = Math.round(idleMs / 86_400_000);
      const keep = async (reason: string) => {
        leftBehind++;
        report.kept.push({ path: dir, idleDays, reason });
      };
      const marker = await readGenerationMarker(dir);
      if (!marker) {
        await keep(`no ${RUST_CACHE_GENERATION_MARKER} ownership marker (not provably created by pi-engineering)`);
        continue;
      }
      if (idleMs < maxAge) {
        await keep(`active ${idleDays} d ago`);
        continue;
      }
      if (opts.liveTargetDirs?.has(dir)) {
        await keep("referenced by a live worktree");
        continue;
      }
      if (!marker.worktreePath) {
        await keep("its marker records no worktree path, so whether its worktree still exists is unknown");
        continue;
      }
      if (await stat(marker.worktreePath).catch(() => null)) {
        await keep(`its worktree ${marker.worktreePath} still exists`);
        continue;
      }
      if (opts.dryRun) {
        report.trashed.push({ path: dir, idleDays });
        continue;
      }
      const entry = await createTrashEntry(
        join(root, ".trash"),
        "rust-cache",
        { name: `${repoName}--${name}`, from: dir },
        now,
      ).catch(() => null);
      if (!entry) {
        await keep("could not create a trash entry");
        continue;
      }
      try {
        await rename(dir, entry.dest);
        report.trashed.push({ path: dir, idleDays, trashedTo: entry.dest });
      } catch (error) {
        await abandonTrashEntry(entry);
        await keep(`could not move it to the trash: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // An emptied repository dir is removed with rmdir: it fails, and does nothing, if anything is left in it.
    if (leftBehind === 0 && !opts.dryRun) await rmdir(repoDir).catch(() => {});
  }
  return report;
}

/** Dry-run twin of `prepareRustCacheRoot`: same verdict, writes nothing. */
async function classifyRoot(root: string): Promise<RustCacheRootCheck> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.every((e) => ADOPTABLE_ROOT_ENTRIES.has(e))
    ? { ok: true }
    : {
        ok: false,
        reason: `${root} is not a pi-engineering Rust cache (no ${RUST_CACHE_ROOT_MARKER} marker and it holds other files); refusing to use or sweep it`,
      };
}
