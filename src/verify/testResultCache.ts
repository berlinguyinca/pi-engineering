import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { safeGitOrThrow } from "../git/safeGit.ts";
import type { StageRun } from "./Verifier.ts";

const run = promisify(execFile);

/**
 * Fingerprinted test result cache (autospec R-WATCH, issue #149).
 *
 * A passing stage result is reused only when EVERYTHING that could change it
 * matches exactly: the source tree, the lockfiles, the toolchain, the stage
 * command, an explicit allowlist of environment variables and the base SHA the
 * work is bound to. Binding the base SHA means a result is never carried across
 * a moved base without a fresh run, which is the integration proof the merge
 * queue needs (spec gates 1-3). Only passes are stored; a failure is always
 * re-run, and a failed `put` also never replaces an earlier pass.
 *
 * This is the per-STAGE cache. `resultCache.ts` (#223) caches the whole-suite
 * verdict per candidate commit and stays as it is; the two are different keys
 * over different units.
 *
 * Residual limits, deliberately stated: ignored files are not part of the tree
 * hash (like `resultCache.ts`), and a stored `StageRun.artifactUri` points at the
 * artifact of the run that produced it, which the consumer must still resolve.
 */

/** Environment variables that change how code compiles or behaves; extend per call. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "CI",
  "NODE_ENV",
  "NODE_OPTIONS",
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_BUILD_TARGET",
  "CARGO_PROFILE_DEV_DEBUG",
  "RUST_BACKTRACE",
  "GOFLAGS",
  "CGO_ENABLED",
  "GOOS",
  "GOARCH",
  "PYTHONHASHSEED",
  "TZ",
];

const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
]);

export interface FingerprintInput {
  /** Git tree hash of the source as it is on disk (see {@link treeHash}). */
  treeHash: string;
  /** Lockfile path (repo-relative) to content hash. */
  lockHashes: Record<string, string>;
  /** Toolchain version string (see {@link toolchainString}). */
  toolchain: string;
  /** The stage command with its arguments. */
  command: string;
  /** The allowlisted environment (see {@link collectFingerprintInput}). */
  env: Record<string, string>;
  /** The target tip the work is bound to. */
  baseSha: string;
}

const sortedEntries = (record: Record<string, string>): Array<[string, string]> =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * sha256 over a canonical, unambiguous encoding of every input (nested JSON
 * arrays with sorted keys), so no two different inputs share an encoding.
 */
export function fingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    "pi-engineering/test-result-cache/v1",
    input.treeHash,
    sortedEntries(input.lockHashes),
    input.toolchain,
    input.command,
    sortedEntries(input.env),
    input.baseSha,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await safeGitOrThrow(args, {
    cwd,
    trust: "operator",
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout;
}

/**
 * Git tree hash of the working directory's content: tracked, modified and
 * untracked-but-not-ignored files. Built in a THROWAWAY index (a copy of the
 * real one) so the repository's own index and status are never touched; it
 * depends on content only, not on mtimes or on whether the change is committed.
 */
export async function treeHash(cwd: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "pi-treehash-"));
  try {
    const index = join(scratch, "index");
    const realIndex = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    await copyFile(realIndex, index).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const env = { GIT_INDEX_FILE: index };
    await git(cwd, ["add", "-A"], env);
    return (await git(cwd, ["write-tree"], env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Content hash of every lockfile in the tree (tracked or new, not ignored), keyed by relative path. */
export async function lockfileHashes(cwd: string): Promise<Record<string, string>> {
  const listed = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const out: Record<string, string> = {};
  for (const path of listed.split("\0")) {
    if (!path || !LOCKFILE_NAMES.has(basename(path))) continue;
    const bytes = await readFile(join(cwd, path)).catch(() => undefined);
    if (bytes) out[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return out;
}

/** `tool: <first line of tool --version>`, or `tool: absent`, one line per tool. */
export async function toolchainString(tools: readonly string[]): Promise<string> {
  const lines: string[] = [];
  for (const tool of tools) {
    const version = await run(tool, ["--version"], { timeout: 10_000 }).then(
      (r) => r.stdout.trim().split("\n")[0] ?? "",
      () => "absent",
    );
    lines.push(`${tool}: ${version}`);
  }
  return lines.join("\n");
}

/** The command line of a stage, as it is fingerprinted. */
export function stageCommand(stage: { command: string; args: readonly string[] }): string {
  return [stage.command, ...stage.args].join(" ");
}

export interface CollectOptions {
  cwd: string;
  /** See {@link stageCommand}. */
  command: string;
  /** The target tip the work is bound to; required, a cache without it proves nothing. */
  baseSha: string;
  /** See {@link toolchainString}. */
  toolchain: string;
  /** The environment to filter; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Variable names that take part; defaults to {@link DEFAULT_ENV_ALLOWLIST}. */
  envAllowlist?: readonly string[];
}

/** Gather every fingerprint input from the checkout at `cwd`. */
export async function collectFingerprintInput(opts: CollectOptions): Promise<FingerprintInput> {
  if (opts.baseSha.trim().length === 0) throw new Error("baseSha is required to fingerprint a test result");
  const source = opts.env ?? process.env;
  const env: Record<string, string> = {};
  for (const name of opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    treeHash: await treeHash(opts.cwd),
    lockHashes: await lockfileHashes(opts.cwd),
    toolchain: opts.toolchain,
    command: opts.command,
    env,
    baseSha: opts.baseSha,
  };
}

// --- storage -----------------------------------------------------------------

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 500;
const DIGEST = /^[0-9a-f]{64}$/;

interface StoredEntry {
  schemaVersion: number;
  fingerprint: string;
  storedAt: string;
  run: StageRun;
}

function isPassingRun(run: unknown): run is StageRun {
  if (typeof run !== "object" || run === null) return false;
  const r = run as Record<string, unknown>;
  return r.passed === true && r.exitCode === 0 && typeof r.stage === "object" && r.stage !== null;
}

function requireDigest(fp: string): void {
  if (!DIGEST.test(fp)) throw new Error("fingerprint must be a 64 character lowercase hex digest");
}

export interface TestResultCacheOptions {
  /** Entries kept; the least recently used beyond it are dropped on `put`. */
  maxEntries?: number;
}

/**
 * Local store of passing stage results under `<stateDir>/test-results/`, one
 * file per fingerprint, written with temp-file plus `rename` so a crash leaves
 * the old entry or the new one. An unreadable, foreign or non-passing file is a
 * miss, never an error and never a hit.
 */
export class TestResultCache {
  private readonly dir: string;
  private readonly maxEntries: number;

  constructor(stateDir: string, opts: TestResultCacheOptions = {}) {
    this.dir = join(stateDir, "test-results");
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async get(fp: string): Promise<StageRun | null> {
    requireDigest(fp);
    const file = join(this.dir, `${fp}.json`);
    let entry: StoredEntry;
    try {
      entry = JSON.parse(await readFile(file, "utf8")) as StoredEntry;
    } catch {
      return null;
    }
    if (entry.schemaVersion !== SCHEMA_VERSION || entry.fingerprint !== fp || !isPassingRun(entry.run)) return null;
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    return entry.run;
  }

  /** Stores a PASSING run; a failed one is ignored (and never replaces an earlier pass). */
  async put(fp: string, run: StageRun): Promise<void> {
    requireDigest(fp);
    if (!isPassingRun(run)) return;
    await mkdir(this.dir, { recursive: true });
    const entry: StoredEntry = {
      schemaVersion: SCHEMA_VERSION,
      fingerprint: fp,
      storedAt: new Date().toISOString(),
      run,
    };
    const tmp = join(this.dir, `.${fp}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(tmp, join(this.dir, `${fp}.json`));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    await this.prune();
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => DIGEST.test(n.replace(/\.json$/, "")) && n.endsWith(".json"));
    if (names.length <= this.maxEntries) return;
    const aged = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await stat(join(this.dir, name)).catch(() => undefined))?.mtimeMs ?? 0,
      })),
    );
    aged.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const { name } of aged.slice(0, names.length - this.maxEntries))
      await rm(join(this.dir, name), { force: true });
  }
}
