import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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
 * commands) also match. Failed results are never cached. A candidate checkout
 * with tracked modifications has no stable SHA identity and bypasses the cache.
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

interface CacheEntry<T> {
  candidateSha: string;
  profileHash: string;
  baseSha: string | null;
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

/** What must match besides the key for a stored result to still describe this run. */
export function environmentFingerprint(profile: VerificationProfile): string {
  const commands = profile.stages.map((stage) => [stage.command, ...stage.args].join(" "));
  return createHash("sha256")
    .update(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, commands }))
    .digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return undefined;
  }
}

/** The candidate's commit, or undefined when the checkout is not a clean commit. */
async function candidateSha(cwd: string): Promise<string | undefined> {
  const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty === undefined || dirty.trim() !== "") return undefined;
  const sha = (await git(cwd, ["rev-parse", "HEAD"]))?.trim();
  return sha || undefined;
}

function entryPath(input: VerifyCacheInput, sha: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify([sha, hashProfile(input.profile), input.baseSha ?? null]))
    .digest("hex");
  return join(input.commonDir, "pi-engineering-verify", `${key}.json`);
}

function valid<T>(entry: unknown, input: VerifyCacheInput, sha: string): entry is CacheEntry<T> {
  const e = entry as Partial<CacheEntry<T>> | null;
  return (
    !!e &&
    e.candidateSha === sha &&
    e.profileHash === hashProfile(input.profile) &&
    e.baseSha === (input.baseSha ?? null) &&
    e.fingerprint === environmentFingerprint(input.profile) &&
    JSON.stringify(e.stages) === JSON.stringify(input.profile.stages.map((stage) => stage.name)) &&
    typeof e.runId === "string" &&
    e.value !== undefined
  );
}

async function read<T>(file: string, input: VerifyCacheInput, sha: string): Promise<CacheEntry<T> | undefined> {
  const parsed = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  return valid<T>(parsed, input, sha) ? parsed : undefined;
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
  const sha = await candidateSha(input.cwd);
  return sha !== undefined && (await read(entryPath(input, sha), input, sha)) !== undefined;
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
  const sha = await candidateSha(input.cwd);
  if (sha === undefined) return { value: (await compute()).value, runId: randomUUID(), reused: false };
  const file = entryPath(input, sha);
  const hit = await read<T>(file, input, sha);
  if (hit) return { value: hit.value, runId: hit.runId, reused: true };
  const lock = await acquire(`${file}.lock`, signal);
  try {
    const raced = await read<T>(file, input, sha);
    if (raced) return { value: raced.value, runId: raced.runId, reused: true };
    const { value, passed } = await compute();
    const runId = randomUUID();
    if (passed) {
      const entry: CacheEntry<T> = {
        candidateSha: sha,
        profileHash: hashProfile(input.profile),
        baseSha: input.baseSha ?? null,
        stages: input.profile.stages.map((stage) => stage.name),
        fingerprint: environmentFingerprint(input.profile),
        runId,
        storedAt: new Date().toISOString(),
        value,
      };
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, file);
    }
    return { value, runId, reused: false };
  } finally {
    lock.release();
  }
}
