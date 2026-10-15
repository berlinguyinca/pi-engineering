import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { GitRepo } from "../git/GitRepo.ts";
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
 * same id fails on the base commit under the same verification profile; flaky
 * base failures and anything absent from the base are new and still block.
 *
 * The base is verified once per (base SHA, profile hash): in a temporary
 * worktree of the base commit (never the shared checkout), cached on disk under
 * the repository's git common dir, and shared in-process while running.
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
}

export interface SubtractionInput {
  git: GitRepo;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  /** The commit the candidate was built on; without it no baseline can apply. */
  baseSha: string | undefined;
  /** The profile the candidate's outcome ran. */
  profile: VerificationProfile;
  outcome: VerifyOutcome;
  signal?: AbortSignal;
}

const inFlight = new Map<string, Promise<FailureBaseline>>();

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
): Promise<FailureBaseline> {
  const wt = await input.git.createWorktree(
    baseSha,
    `pi-eng-baseline-${baseSha.slice(0, 7)}-${Date.now().toString(36)}`,
  );
  try {
    // Detect on the base itself: the profile that describes the base, bound by hash.
    const baseProfile = await input.verifier.detect(wt.path);
    if (hashProfile(baseProfile) !== hashProfile(profile)) {
      throw new Error("the verification profile at the base differs from the candidate's");
    }
    const baseline = await captureBaseline(wt.path, baseSha, input.verifier, baseProfile, input.artifacts, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(baseline));
    await rename(tmp, file);
    return baseline;
  } finally {
    await input.git.removeWorktree(wt).catch(() => {});
  }
}

async function baselineFor(
  input: SubtractionInput,
  baseSha: string,
  profile: VerificationProfile,
): Promise<FailureBaseline> {
  const profileHash = hashProfile(profile);
  const dir = join(await input.git.commonDir(), "pi-engineering-baselines");
  const file = join(dir, `${baseSha}.${profileHash.replace(/[^a-z0-9]/gi, "_")}.json`);
  const cached = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (isBaseline(cached, baseSha, profileHash)) return cached;
  let pending = inFlight.get(file);
  if (!pending) {
    pending = computeBaseline(input, baseSha, profile, file).finally(() => inFlight.delete(file));
    inFlight.set(file, pending);
  }
  return pending;
}

export async function subtractBaselineFailures(input: SubtractionInput): Promise<SubtractionResult> {
  const { outcome } = input;
  const unchanged = (warnings: string[]): SubtractionResult => ({
    passed: outcome.passed,
    inheritedFailures: [],
    introducedFailures: failureIds(outcome),
    warnings,
  });
  if (outcome.passed)
    return {
      passed: true,
      inheritedFailures: [],
      introducedFailures: [],
      warnings: [],
    };
  if (!input.baseSha)
    return unchanged(["failure baseline unavailable: no base commit is known; judged without a baseline"]);
  try {
    const sha = await input.git.resolveCommit(input.baseSha);
    if (!sha) throw new Error(`base commit ${input.baseSha} is not available`);
    const baseline = await baselineFor(input, sha, input.profile);
    const verdict = compareToBaseline(baseline, outcome, sha);
    if (verdict.stale) return unchanged([`failure baseline unavailable: ${verdict.reason}; judged without a baseline`]);
    const inherited = verdict.preExisting;
    if (verdict.blocking || inherited.length === 0) {
      return {
        passed: false,
        inheritedFailures: inherited,
        introducedFailures: verdict.introduced,
        warnings: inherited.length
          ? [`${inherited.length} failure(s) inherited from base ${sha.slice(0, 7)}: ${inherited.join("; ")}`]
          : [],
      };
    }
    return {
      passed: true,
      inheritedFailures: inherited,
      introducedFailures: [],
      warnings: [
        `${inherited.length} failure(s) inherited from base ${sha.slice(0, 7)}, not introduced by this change: ${inherited.join("; ")}`,
      ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unchanged([`failure baseline unavailable: ${reason}; judged without a baseline`]);
  }
}
