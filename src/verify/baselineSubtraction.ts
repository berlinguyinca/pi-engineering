import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { GitRepo } from "../git/GitRepo.ts";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";
import type { VerificationProfile, VerificationProvider, VerifyOutcome } from "./Verifier.ts";
import {
  type FailureBaseline,
  captureBaseline,
  compareToBaseline,
  failureIds,
  hashProfile,
} from "./failureBaseline.ts";

/**
 * Judge a candidate's failed verification by the failures it INTRODUCES.
 *
 * Matching rule (finest level the verifier exposes): a failure is identified
 * per test name (`test:<stage> » <name>`) when the stage's output yields
 * TAP/spec test names, otherwise per stage (`stage:<name>`, i.e. that
 * stage/command exited non-zero). A candidate failure is inherited when the
 * same id fails on the base commit under the same verification profile AND its
 * stage ended the way it did on the base (same exit code, not hung). Flaky
 * base failures (failing in only some of the confirming base runs) and
 * anything absent from the base are new and still block. A run that failed
 * with no identifiable failure blocks. Limit: a bare test name is not
 * qualified by its file, so the same name failing in two files collides.
 *
 * Early stop: the verifier stops at the first failing required stage. The base
 * is therefore verified exhaustively, and a candidate stopped at a stage whose
 * failure is inherited is re-run through that stage so later stages are judged
 * too; the candidate passes only if it ran every stage the base ran.
 *
 * The base is verified once per (base SHA, profile hash): in a temporary
 * worktree of the base commit (never the shared checkout), cached on disk under
 * the repository's git common dir, and serialized by a lock file next to the cache entry (a second caller, in this
 * process or another, waits and reads the cached result). The run
 * is bounded (PI_ENGINEERING_BASELINE_TIMEOUT_MS, default 20 min) and repeated
 * PI_ENGINEERING_BASELINE_RUNS times (default 2) to expose flaky failures; a
 * run that timed out or died of the environment is never cached.
 */
export interface SubtractionResult {
  /** True when the candidate passes after forgiving inherited failures. */
  passed: boolean;
  /** Failure ids that also fail on the base commit. */
  inheritedFailures: string[];
  /** Failure ids the candidate introduced (they block). */
  introducedFailures: string[];
  /** Non-blocking notes: the inherited failures, or why no baseline was used. */
  warnings: string[];
  /** The outcome that was judged: the candidate's re-run when it had stopped at an inherited failure. */
  outcome: VerifyOutcome;
}

export interface SubtractionInput {
  git: GitRepo;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  /** The commit the candidate was built on; without it no baseline can apply. */
  baseSha: string | undefined;
  /** The candidate checkout the outcome was produced in. */
  cwd: string;
  /** The profile the candidate's outcome ran. */
  profile: VerificationProfile;
  outcome: VerifyOutcome;
  signal?: AbortSignal;
}

const DEFAULT_BASELINE_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_BASELINE_RUNS = 2;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function isBaseline(value: unknown, baseSha: string, profileHash: string): value is FailureBaseline {
  const v = value as Partial<FailureBaseline> | null;
  return (
    !!v && v.baseSha === baseSha && v.profileHash === profileHash && Array.isArray(v.failures) && Array.isArray(v.flaky)
  );
}

async function computeBaseline(
  input: SubtractionInput,
  baseSha: string,
  profile: VerificationProfile,
  file: string,
  notes: string[],
): Promise<FailureBaseline> {
  const timeoutMs = positiveInt(process.env.PI_ENGINEERING_BASELINE_TIMEOUT_MS, DEFAULT_BASELINE_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  // A stable name per base SHA lets createWorktree's crash recovery clear a
  // worktree an earlier, killed run left behind.
  const wt = await input.git.createWorktree(baseSha, `pi-eng-baseline-${baseSha.slice(0, 12)}`);
  try {
    // Detect on the base itself: the profile that describes the base, bound by hash.
    const baseProfile = await input.verifier.detect(wt.path);
    if (hashProfile(baseProfile) !== hashProfile(profile)) {
      throw new Error("the verification profile at the base differs from the candidate's");
    }
    // Hook: when the shared Rust target/sccache environment (#186) exists, the
    // base run should reuse it here instead of building from cold.
    const baseline = await captureBaseline(wt.path, baseSha, input.verifier, baseProfile, input.artifacts, {
      signal,
      runs: positiveInt(process.env.PI_ENGINEERING_BASELINE_RUNS, DEFAULT_BASELINE_RUNS),
    }).catch((error: unknown) => {
      if (timeout.aborted && !input.signal?.aborted) {
        throw new Error(`the base verification run timed out after ${timeoutMs}ms`);
      }
      throw error;
    });
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(baseline));
    await rename(tmp, file);
    return baseline;
  } finally {
    await input.git.removeWorktree(wt).catch((error: unknown) => {
      notes.push(`baseline worktree ${wt.path} was not removed: ${error instanceof Error ? error.message : error}`);
    });
  }
}

async function baselineFor(
  input: SubtractionInput,
  baseSha: string,
  profile: VerificationProfile,
  notes: string[],
): Promise<FailureBaseline> {
  const profileHash = hashProfile(profile);
  const dir = join(await input.git.commonDir(), "pi-engineering-baselines");
  const file = join(dir, `${baseSha}.${profileHash.replace(/[^a-z0-9]/gi, "_")}.json`);
  const cached = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (isBaseline(cached, baseSha, profileHash)) return cached;
  // The lock file serializes every contender, in this process or another one on
  // the same repository: the stable base worktree name must have one user, and
  // a second contender reads the first one's cached result instead.
  const lock = await acquireBaselineLock(`${file}.lock`);
  try {
    const raced = await readFile(file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined);
    if (isBaseline(raced, baseSha, profileHash)) return raced;
    return await computeBaseline(input, baseSha, profile, file, notes);
  } finally {
    lock.release();
  }
}

/**
 * Wait for the baseline lock. A dead owner is taken over by the lock itself; a
 * live owner is waited for up to the baseline timeout plus a margin, after
 * which the caller falls back to judging without a baseline.
 */
async function acquireBaselineLock(path: string): Promise<ExclusiveFileLock> {
  const timeoutMs = positiveInt(process.env.PI_ENGINEERING_BASELINE_TIMEOUT_MS, DEFAULT_BASELINE_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs + 30_000;
  await mkdir(join(path, ".."), { recursive: true });
  for (;;) {
    try {
      return await ExclusiveFileLock.acquire(path);
    } catch (error) {
      if (!/is held|is claimed/.test(error instanceof Error ? error.message : "")) throw error;
      if (Date.now() >= deadline) throw new Error("timed out waiting for another process's baseline run");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function stageName(id: string): string {
  const rest = id.startsWith("stage:") ? id.slice("stage:".length) : id.slice("test:".length);
  const cut = rest.indexOf(" » ");
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

export async function subtractBaselineFailures(input: SubtractionInput): Promise<SubtractionResult> {
  let outcome = input.outcome;
  const unchanged = (warnings: string[]): SubtractionResult => ({
    passed: outcome.passed,
    inheritedFailures: [],
    introducedFailures: failureIds(outcome),
    warnings,
    outcome,
  });
  if (outcome.passed) {
    return { passed: true, inheritedFailures: [], introducedFailures: [], warnings: [], outcome };
  }
  const unavailable = (reason: string): SubtractionResult =>
    unchanged([`failure baseline unavailable: ${reason}; judged without a baseline`]);
  if (!input.baseSha) return unavailable("no base commit is known");
  // A stage pinned to the candidate checkout (the scriptless node-syntax check)
  // hashes differently in every checkout: no baseline could ever match it.
  if (input.profile.stages.some((stage) => stage.cwd !== undefined)) {
    return unavailable("the verification profile is bound to the candidate checkout");
  }
  const notes: string[] = [];
  try {
    const sha = await input.git.resolveCommit(input.baseSha);
    if (!sha) throw new Error(`base commit ${input.baseSha} is not available`);
    const baseline = await baselineFor(input, sha, input.profile, notes);
    let verdict = compareToBaseline(baseline, outcome, sha);
    if (verdict.stale) return unavailable(verdict.reason);
    const inheritedStages = new Set(baseline.failures.map(stageName));
    if (
      !verdict.blocking &&
      outcome.failedStage !== null &&
      inheritedStages.has(outcome.failedStage) &&
      outcome.stages.length < input.profile.stages.length
    ) {
      // The candidate stopped at a stage whose failure is inherited: its later
      // stages never ran, so run them before judging.
      outcome = await input.verifier.run(input.cwd, input.profile, input.artifacts, {
        ...(input.signal ? { signal: input.signal } : {}),
        continueThrough: inheritedStages,
      });
      verdict = compareToBaseline(baseline, outcome, sha);
      if (verdict.stale) return unavailable(verdict.reason);
    }
    const ran = new Set(outcome.stages.map((run) => run.stage.name));
    const missing = (baseline.stagesRun ?? []).filter((name) => !ran.has(name));
    if (!verdict.blocking && missing.length > 0) {
      return unavailable(`the candidate did not run stage(s) the base ran: ${missing.join(", ")}`);
    }
    const inherited = verdict.preExisting;
    const note = inherited.length
      ? [`${inherited.length} failure(s) inherited from base ${sha.slice(0, 7)}: ${inherited.join("; ")}`]
      : [];
    // Failed with nothing inherited (or nothing identifiable): never forgiven.
    const passed = !verdict.blocking && inherited.length > 0;
    return {
      passed,
      inheritedFailures: inherited,
      introducedFailures: verdict.introduced,
      warnings: [...note, ...notes],
      outcome,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result = unavailable(reason);
    result.warnings.push(...notes);
    return result;
  }
}
