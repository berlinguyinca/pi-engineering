/**
 * Shared Rust build cache for isolated worktrees.
 *
 * Cargo keys its build cache (`target/`) on the checkout directory, so every
 * candidate worktree the runtime creates (INV-004) rebuilds the full dependency
 * graph from scratch and leaves a multi-gigabyte `target/` behind when the
 * worktree is abandoned. Twelve concurrent candidates on one Rust project
 * meant twelve copies of the same compiled dependencies.
 *
 * This module points every Rust build the runtime spawns (verification stages,
 * CAV runs, and worker `bash` tool calls, which inherit the process env) at ONE
 * machine-wide cache root, `~/.rust/cache` by default:
 *
 *   ~/.rust/cache/target/<repo>-<hash>   CARGO_TARGET_DIR, one per repository
 *   ~/.rust/cache/sccache                 SCCACHE_DIR, when `sccache` is installed
 *
 * The target directory is keyed on the git COMMON directory, which linked
 * worktrees share with their main checkout, so every candidate of a repository
 * builds into the same cache and compiled dependencies are reused across
 * candidates. Cargo serialises concurrent builds of one target directory with
 * its own file lock, so sharing is safe; it never corrupts. Unrelated
 * repositories get distinct target directories so they do not queue on each
 * other's lock.
 *
 * When `sccache` is on PATH it is installed as `RUSTC_WRAPPER` so that even
 * candidates whose dependency sets diverge share compiled crates through its
 * content-addressed store. Nothing is installed by this module.
 *
 * Operator intent always wins: an explicit `CARGO_TARGET_DIR`, `RUSTC_WRAPPER`
 * or `SCCACHE_DIR` in the environment is left untouched, `PI_RUST_CACHE_DIR`
 * relocates the root, and `PI_RUST_CACHE=0` switches the whole thing off.
 */

import { execFile } from "node:child_process";
import { constants, accessSync } from "node:fs";
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
 * Stable per-repository key derived from the git common directory, which is
 * identical for a main checkout and all of its linked worktrees. A cwd outside
 * any repository maps to one unscoped key so stray builds still share a cache.
 */
export async function rustTargetKey(cwd: string): Promise<string> {
  let commonDir: string;
  try {
    const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeout: 10_000,
    });
    commonDir = r.stdout.trim();
  } catch {
    return UNSCOPED_TARGET_KEY;
  }
  if (!commonDir) return UNSCOPED_TARGET_KEY;
  // `<repo>/.git` for a normal repository; a bare repository is its own common dir.
  const repoDir = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  return `${sanitizeName(basename(repoDir))}-${shortHash(commonDir)}`;
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
  if (!rustCacheEnabled(env)) return {};
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
  applyAdditions(process.env, additions);
  return additions;
}

function applyAdditions(env: Env, additions: RustBuildEnv): void {
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value;
  }
}
