/**
 * Rust build cache for isolated worktrees.
 *
 * Cargo keys its build cache (`target/`) on the checkout directory, so every
 * candidate worktree the runtime creates (INV-004) rebuilds the full dependency
 * graph from scratch and leaves a multi-gigabyte `target/` behind when the
 * worktree is abandoned. Twelve concurrent candidates on one Rust project
 * meant twelve copies of the same compiled dependencies and a full disk.
 *
 * This module points every Rust build the runtime spawns (verification stages,
 * CAV runs, and worker `bash` tool calls, which inherit the process env) at ONE
 * machine-wide cache root, `~/.rust/cache` by default:
 *
 *   ~/.rust/cache/target/<repo>-<hash>/<worktree-hash>  CARGO_TARGET_DIR
 *   ~/.rust/cache/sccache                                SCCACHE_DIR
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
 * Moving target dirs out of the worktrees keeps them in one place the
 * housekeeping sweep (`sweepRustCache`) expires by age, and the worktree
 * janitor removes a worktree's target dir together with the worktree.
 *
 * Operator intent always wins: an explicit `CARGO_TARGET_DIR`, `RUSTC_WRAPPER`
 * or `SCCACHE_DIR` in the environment is left untouched, `PI_RUST_CACHE_DIR`
 * relocates the root, and `PI_RUST_CACHE=0` switches the whole thing off.
 */

import { execFile } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

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
  let commonDir: string;
  let toplevel: string;
  try {
    const r = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { timeout: 10_000 },
    );
    [commonDir = "", toplevel = ""] = r.stdout.trim().split(/\r?\n/);
  } catch {
    return UNSCOPED_TARGET_KEY;
  }
  if (!commonDir || !toplevel) return UNSCOPED_TARGET_KEY;
  // `<repo>/.git` for a normal repository; a bare repository is its own common dir.
  const repoDir = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  return join(`${sanitizeName(basename(repoDir))}-${shortHash(commonDir)}`, shortHash(toplevel));
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
 * Merge the shared-cache variables into `env` in place and return it. Nothing
 * is created on disk: cargo and sccache make their own directories on first
 * use, so a dry run (or the test suite) leaves no trace under the cache root.
 */
export async function withRustBuildEnv<T extends Env>(env: T, cwd: string): Promise<T> {
  applyAdditions(env, await rustBuildEnv(cwd, env));
  return env;
}

/**
 * Apply the shared cache to this process's own environment so every child the
 * runtime (or Pi's `bash` tool, which copies `process.env`) spawns inherits it.
 * Idempotent; safe to call on every session start. Returns what was added.
 */
export async function applyRustBuildEnvToProcess(cwd: string): Promise<RustBuildEnv> {
  const additions = await rustBuildEnv(cwd, process.env);
  // CARGO_TARGET_DIR is per worktree. Exporting the session checkout's value
  // here would read as an operator override in every candidate worktree and
  // make them all share one target dir, so only the dependency cache is global.
  delete additions.CARGO_TARGET_DIR;
  applyAdditions(process.env, additions);
  return additions;
}

function applyAdditions(env: Env, additions: RustBuildEnv): void {
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value;
  }
}

/** Days a per-repository target dir may go unused before the sweep removes it. */
export const RUST_CACHE_MAX_AGE_DAYS_ENV = "PI_RUST_CACHE_MAX_AGE_DAYS";
export const DEFAULT_RUST_CACHE_MAX_AGE_DAYS = 30;

export interface RustCacheSweepReport {
  removed: Array<{ path: string; idleDays: number }>;
  kept: Array<{ path: string; idleDays: number }>;
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
 * Remove per-worktree target dirs under the cache root that no build has
 * touched for `maxAgeMs`, and repository dirs left empty by that. Everything
 * there is derived output, so a wrong guess costs one cold build, never data.
 * Worktrees removed outside the janitor, and repositories that were deleted
 * or moved, leave target dirs behind; this is what collects them.
 */
export async function sweepRustCache(
  opts: { env?: Env; maxAgeMs?: number; dryRun?: boolean; now?: () => number } = {},
): Promise<RustCacheSweepReport> {
  const env = opts.env ?? process.env;
  const report: RustCacheSweepReport = { removed: [], kept: [], dryRun: Boolean(opts.dryRun) };
  if (!rustCacheEnabled(env)) return report;
  const targets = join(rustCacheRoot(env), "target");
  const now = opts.now?.() ?? Date.now();
  const maxAge = opts.maxAgeMs ?? rustCacheMaxAgeMs(env);
  for (const repoName of await readdir(targets).catch(() => [] as string[])) {
    const repoDir = join(targets, repoName);
    if (!(await stat(repoDir).catch(() => null))?.isDirectory()) continue;
    const children = await readdir(repoDir).catch(() => [] as string[]);
    let remaining = children.length;
    for (const name of children) {
      const dir = join(repoDir, name);
      if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
      const idleMs = now - (await targetLastActivity(dir));
      const idleDays = Math.round(idleMs / 86_400_000);
      if (idleMs < maxAge) {
        report.kept.push({ path: dir, idleDays });
        continue;
      }
      if (!opts.dryRun) await rm(dir, { recursive: true, force: true });
      report.removed.push({ path: dir, idleDays });
      remaining--;
    }
    if (remaining === 0 && !opts.dryRun) await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
  return report;
}
