/**
 * RuntimeLoader: give every generation a unique module identity (spec §7, §32).
 *
 * A `?generation=N` query re-evaluates only the ENTRY module; its relative
 * imports stay cached under both Node ESM and Pi's jiti loader (measured, see
 * the notes doc). So a generation is imported from its own immutable
 * directory: a snapshot of the runtime source. Every module URL in that
 * directory is new, so every module is fresh.
 */

import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type EngineeringRuntimeModule, HOST_SUPPORTED_RUNTIME_APIS, isEngineeringRuntimeModule } from "./contract.ts";

/** Top-level entries never copied into a generation snapshot. */
const SNAPSHOT_EXCLUDE = new Set([".git", "node_modules", ".pi-eng", ".omc", "test", "docs", "coverage", "dist"]);

export interface RuntimeSource {
  /** Directory holding the runtime code (a checkout, an installed version, a snapshot). */
  root: string;
  /** Entry module, relative to root. */
  entry: string;
  version: string;
  commit: string | null;
  /** "package" | "installed:<id>" | "baseline" ... for diagnostics. */
  label: string;
  /** Import straight from `root` (no snapshot). Only safe for the first load of a directory. */
  direct?: boolean;
  /**
   * For a `direct` source: an immutable copy of `root` taken before it was
   * imported. A mutable checkout may be edited after loading, so rolling back
   * to "the code that ran" must use this copy, not `root`.
   */
  rollbackRoot?: string;
}

export class RuntimeLoadError extends Error {
  readonly stage: "snapshot" | "import" | "contract" | "api";
  constructor(stage: RuntimeLoadError["stage"], message: string) {
    super(message);
    this.name = "RuntimeLoadError";
    this.stage = stage;
  }
}

/**
 * Copy `sourceRoot` into a fresh directory under `generationsDir` and link its
 * dependencies. Returns the snapshot directory.
 */
export async function snapshotRuntimeSource(
  sourceRoot: string,
  generationsDir: string,
  label: string,
): Promise<string> {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const dir = join(generationsDir, `${safeLabel}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
  await mkdir(generationsDir, { recursive: true });
  const root = resolve(sourceRoot);
  try {
    await cp(root, dir, {
      recursive: true,
      // Symlinks are copied as links; a link escaping the source is rejected below.
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = relative(root, src);
        if (rel === "") return true;
        const top = rel.split(sep)[0] as string;
        if (SNAPSHOT_EXCLUDE.has(top)) return false;
        return !rel.endsWith(".zip");
      },
    });
    await linkDependencies(root, dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new RuntimeLoadError("snapshot", `could not snapshot ${root}: ${message(error)}`);
  }
  return dir;
}

/** Point the snapshot's node_modules at the real dependency tree of the source. */
async function linkDependencies(sourceRoot: string, snapshotDir: string): Promise<void> {
  const nm = join(sourceRoot, "node_modules");
  if (!existsSync(nm)) return;
  await symlink(realpathSync(nm), join(snapshotDir, "node_modules"), "dir");
}

/** Import a runtime entry with a unique identity and verify its contract. */
export async function importRuntimeModule(
  dir: string,
  entry: string,
  generation: number,
  supported: readonly number[] = HOST_SUPPORTED_RUNTIME_APIS,
): Promise<EngineeringRuntimeModule> {
  const entryPath = resolve(dir, entry);
  if (!entryPath.startsWith(resolve(dir) + sep)) {
    throw new RuntimeLoadError("import", `runtime entry ${entry} escapes ${dir}`);
  }
  const url = pathToFileURL(entryPath);
  url.searchParams.set("generation", String(generation));
  let mod: unknown;
  try {
    mod = await import(url.href);
  } catch (error) {
    throw new RuntimeLoadError("import", `could not import ${entryPath}: ${message(error)}`);
  }
  const candidate = (mod as { default?: unknown }).default;
  const resolved = isEngineeringRuntimeModule(mod)
    ? mod
    : isEngineeringRuntimeModule(candidate)
      ? candidate
      : undefined;
  if (!resolved) {
    throw new RuntimeLoadError("contract", `${entryPath} does not export runtimeApi + createRuntime`);
  }
  if (!supported.includes(resolved.runtimeApi)) {
    throw new RuntimeLoadError(
      "api",
      `runtime API ${resolved.runtimeApi} is not supported by this host (supports ${supported.join(", ")})`,
    );
  }
  return resolved;
}

/** Load a source: snapshot unless `direct`, then import. */
export async function loadRuntimeSource(
  source: RuntimeSource,
  generationsDir: string,
  generation: number,
  supported?: readonly number[],
): Promise<{ module: EngineeringRuntimeModule; dir: string }> {
  const dir = source.direct
    ? resolve(source.root)
    : await snapshotRuntimeSource(source.root, generationsDir, `g${generation}`);
  try {
    const module = await importRuntimeModule(dir, source.entry, generation, supported);
    return { module, dir };
  } catch (error) {
    if (!source.direct) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Remove generation snapshots except `keep` (absolute paths). Code a loaded
 * generation may still import lazily must stay on disk, so callers keep the
 * active and previous generation directories.
 */
export async function pruneGenerationSnapshots(generationsDir: string, keep: Iterable<string>): Promise<string[]> {
  if (!existsSync(generationsDir)) return [];
  const kept = new Set([...keep].map((p) => resolve(p)));
  const removed: string[] = [];
  for (const name of await readdir(generationsDir)) {
    const full = resolve(generationsDir, name);
    if (kept.has(full)) continue;
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    await rm(full, { recursive: true, force: true });
    removed.push(full);
  }
  return removed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
