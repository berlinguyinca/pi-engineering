import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeGitOrThrow } from "../git/safeGit.ts";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";
import type { VerificationProfile } from "./Verifier.ts";
import { hashProfile } from "./failureBaseline.ts";

const exec = promisify(execFile);

/**
 * Verification result cache: the full suite runs once per candidate commit.
 *
 * Integration verifies the candidate and stores a PASSING result; validation of
 * the same, unchanged candidate reuses it instead of running the suite again.
 * Keyed by (candidate SHA, verification profile hash, base SHA when a failure
 * baseline applies) and stored under `<git-common-dir>/pi-engineering-verify/`
 * with an atomic write and a cross-process lock beside each entry, so two
 * processes asking for the same key compute it once. An entry is reused only
 * when its stage list and environment fingerprint (node version, platform,
 * commands, PATH-resolved toolchain versions, CI/NODE_ENV, lockfile hashes and
 * the presence/mtime of installed dependency directories) also match. The key
 * also binds the diff hash of base..candidate; an unset base is the explicit
 * "no-base". Failed results are never cached. A candidate checkout with any
 * tracked modification or untracked non-ignored file has no stable SHA identity
 * and bypasses the cache. Residual limit: ignored files other than the
 * fingerprinted dependency directories (e.g. a hand-edited ignored config) are
 * not seen. Entries older than 7 days or beyond 200 are pruned on write.
 * This caches the whole-suite verdict only; a finer fingerprinted per-test
 * cache is issue #149.
 */
export interface VerifyCacheInput {
  /** The candidate checkout. */
  cwd: string;
  commonDir: string;
  profile: VerificationProfile;
  /** The commit the candidate was built on, when a failure baseline applies. */
  baseSha?: string | undefined;
}

const NO_BASE = "no-base";
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const ORPHAN_TMP_MS = 60 * 60_000;
const ORPHAN_LOCK_MS = 24 * 60 * 60_000;

interface CacheEntry<T> {
  candidateSha: string;
  profileHash: string;
  baseSha: string;
  diffHash: string;
  stages: string[];
  fingerprint: string;
  runId: string;
  storedAt: string;
  value: T;
}

export interface CacheOutcome<T> {
  value: T;
  /** The id of the run that produced `value` (this run's id unless reused). */
  runId: string;
  reused: boolean;
}

const LOCK_WAIT_MS = 60 * 60_000;

const toolVersions = new Map<string, Promise<string>>();

/** `<tool> --version` as resolved on PATH ("absent" when it is not installed); once per process. */
function toolVersion(tool: string): Promise<string> {
  let known = toolVersions.get(tool);
  if (!known) {
    known = exec(tool, ["--version"], { timeout: 10_000 }).then(
      (r) => r.stdout.trim().split("\n")[0] ?? "",
      () => "absent",
    );
    toolVersions.set(tool, known);
  }
  return known;
}

async function fileHash(path: string): Promise<string> {
  return readFile(path)
    .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
    .catch(() => "absent");
}

async function mtime(path: string): Promise<string> {
  return stat(path)
    .then((s) => String(s.mtimeMs))
    .catch(() => "absent");
}

/** What must match besides the key for a stored result to still describe this run. */
export async function environmentFingerprint(cwd: string, profile: VerificationProfile): Promise<string> {
  const commands = profile.stages.map((stage) => [stage.command, ...stage.args].join(" "));
  const tools = [...new Set(["node", ...profile.stages.map((stage) => stage.command)])].filter((tool) =>
    /^(node|npm|npx|cargo|rustc|python3?|pnpm|yarn)$/.test(tool),
  );
  const versions = Object.fromEntries(await Promise.all(tools.map(async (tool) => [tool, await toolVersion(tool)])));
  const lockfiles = Object.fromEntries(
    await Promise.all(
      ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "node_modules/.package-lock.json"].map(
        async (file) => [file, await fileHash(join(cwd, file))],
      ),
    ),
  );
  const installs = Object.fromEntries(
    await Promise.all(["node_modules", "target"].map(async (dir) => [dir, await mtime(join(cwd, dir))])),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        commands,
        versions,
        env: { CI: process.env.CI ?? null, NODE_ENV: process.env.NODE_ENV ?? null },
        lockfiles,
        installs,
      }),
    )
    .digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await safeGitOrThrow(args, { cwd, trust: "operator", maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return undefined;
  }
}

interface Identity {
  sha: string;
  baseSha: string;
  diffHash: string;
}

/** The candidate's commit and its diff against the base, or undefined when the checkout is not a clean commit. */
async function identityOf(cwd: string, baseSha: string | undefined): Promise<Identity | undefined> {
  const dirty = await git(cwd, ["status", "--porcelain"]);
  if (dirty === undefined || dirty.trim() !== "") return undefined;
  const sha = (await git(cwd, ["rev-parse", "HEAD"]))?.trim();
  if (!sha) return undefined;
  if (!baseSha) return { sha, baseSha: NO_BASE, diffHash: NO_BASE };
  const diff = await git(cwd, ["diff", "--binary", baseSha, sha]);
  if (diff === undefined) return undefined;
  return { sha, baseSha, diffHash: createHash("sha256").update(diff).digest("hex") };
}

function entryPath(input: VerifyCacheInput, id: Identity): string {
  const key = createHash("sha256")
    .update(JSON.stringify([id.sha, hashProfile(input.profile), id.baseSha, id.diffHash]))
    .digest("hex");
  return join(input.commonDir, "pi-engineering-verify", `${key}.json`);
}

async function valid<T>(entry: unknown, input: VerifyCacheInput, id: Identity): Promise<boolean> {
  const e = entry as Partial<CacheEntry<T>> | null;
  return (
    !!e &&
    e.candidateSha === id.sha &&
    e.profileHash === hashProfile(input.profile) &&
    e.baseSha === id.baseSha &&
    e.diffHash === id.diffHash &&
    JSON.stringify(e.stages) === JSON.stringify(input.profile.stages.map((stage) => stage.name)) &&
    typeof e.runId === "string" &&
    e.value !== undefined &&
    e.fingerprint === (await environmentFingerprint(input.cwd, input.profile))
  );
}

async function read<T>(file: string, input: VerifyCacheInput, id: Identity): Promise<CacheEntry<T> | undefined> {
  const parsed = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  return (await valid<T>(parsed, input, id)) ? (parsed as CacheEntry<T>) : undefined;
}

/** Drop expired and surplus entries and stale orphan .tmp/.lock files. Best effort. */
async function prune(dir: string): Promise<void> {
  const now = Date.now();
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (name.endsWith(".tmp")) {
      if (now - info.mtimeMs > ORPHAN_TMP_MS) await rm(path, { force: true }).catch(() => {});
    } else if (name.endsWith(".lock")) {
      if (now - info.mtimeMs > ORPHAN_LOCK_MS) await rm(path, { force: true, recursive: true }).catch(() => {});
    } else if (name.endsWith(".json")) {
      entries.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  entries.sort((x, y) => y.mtimeMs - x.mtimeMs);
  for (const [index, entry] of entries.entries()) {
    if (index >= MAX_ENTRIES || now - entry.mtimeMs > MAX_AGE_MS) await rm(entry.path, { force: true }).catch(() => {});
  }
}

async function acquire(path: string, signal?: AbortSignal): Promise<ExclusiveFileLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(join(path, ".."), { recursive: true });
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await ExclusiveFileLock.acquire(path);
    } catch (error) {
      if (!/is held|is claimed/.test(error instanceof Error ? error.message : "")) throw error;
      if (Date.now() >= deadline) throw new Error("timed out waiting for another process's verification run");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** True when a reusable result for this candidate is already stored. Read-only. */
export async function hasCachedVerification(input: VerifyCacheInput): Promise<boolean> {
  const id = await identityOf(input.cwd, input.baseSha);
  return id !== undefined && (await read(entryPath(input, id), input, id)) !== undefined;
}

/**
 * Return the stored result for this candidate, or compute it once (serialized
 * across processes) and store it when `passed`. `compute` runs outside any
 * cache when the checkout has no stable commit identity.
 */
export async function verifyOnce<T>(
  input: VerifyCacheInput,
  compute: () => Promise<{ value: T; passed: boolean }>,
  signal?: AbortSignal,
): Promise<CacheOutcome<T>> {
  const id = await identityOf(input.cwd, input.baseSha);
  if (id === undefined) return { value: (await compute()).value, runId: randomUUID(), reused: false };
  const file = entryPath(input, id);
  const hit = await read<T>(file, input, id);
  if (hit) return { value: hit.value, runId: hit.runId, reused: true };
  const lock = await acquire(`${file}.lock`, signal);
  try {
    const raced = await read<T>(file, input, id);
    if (raced) return { value: raced.value, runId: raced.runId, reused: true };
    const { value, passed } = await compute();
    const runId = randomUUID();
    if (passed) {
      const entry: CacheEntry<T> = {
        candidateSha: id.sha,
        profileHash: hashProfile(input.profile),
        baseSha: id.baseSha,
        diffHash: id.diffHash,
        stages: input.profile.stages.map((stage) => stage.name),
        fingerprint: await environmentFingerprint(input.cwd, input.profile),
        runId,
        storedAt: new Date().toISOString(),
        value,
      };
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, file);
      await prune(join(file, ".."));
    }
    return { value, runId, reused: false };
  } finally {
    lock.release();
  }
}
