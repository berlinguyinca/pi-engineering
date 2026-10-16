import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { VerificationProfile, VerificationProvider, VerifyOutcome, VerifyRunOptions } from "./Verifier.ts";

const execFileAsync = promisify(execFile);

/**
 * The verification failures that already exist at a base commit (spec §5
 * R-DELIVER, §7 item 7), so a change is judged by the failures it INTRODUCES
 * instead of by a suite that was red before it started.
 *
 * Matching rule: a failure is identified per test name (`test:<stage> » <name>`)
 * when the stage output yields node:test TAP/spec names, otherwise per stage
 * (`stage:<name>`). Limits: a bare test name is not qualified by its file, so two
 * files reporting the same name collide (a new failure under an already-failing
 * name is forgiven); a stage that fails with a different exit code, or hangs,
 * is never forgiven.
 *
 * A baseline names its inputs (§8): the exact base SHA and the profile it ran.
 * It is only ever compared against a candidate bound to that same SHA.
 */
export interface FailureBaseline {
  /** Full commit SHA of the checkout the profile ran on. */
  baseSha: string;
  /** Hash of the profile (stage names, commands, args, required) that produced the failures. */
  profileHash: string;
  /** Failure ids that failed in every confirming run. */
  failures: string[];
  /** Ids that failed in some but not all confirming runs. Never forgiven. */
  flaky: string[];
  capturedAt: string;
  /** Stages the baseline profile ran (it runs every stage, even after a failure). */
  stagesRun?: string[];
  /** Exit code of each failing stage, when it was the same in every confirming run. */
  exitCodes?: Record<string, number>;
}

export interface BaselineVerdict {
  /** Failures absent from the baseline. They block. */
  introduced: string[];
  /** Failures the baseline already recorded. They do not block. */
  preExisting: string[];
  /** Baseline failures that no longer fail (in a stage that ran this time). */
  fixed: string[];
  /** The baseline does not describe this candidate (moved base, other profile, unbound). It blocks. */
  stale: boolean;
  blocking: boolean;
  reason: string;
}

export interface CaptureBaselineOptions {
  signal?: AbortSignal;
  /**
   * Mission build options for the base runs: a baseline build is still a build,
   * so it gets the requesting mission's target dir and disk admission rather
   * than bypassing them (issue #259).
   */
  runOptions?: Pick<VerifyRunOptions, "missionId" | "build">;
  /**
   * Confirming runs of the profile at the base. A failure counts as
   * pre-existing only if it fails in every run; one that fails in only some is
   * flaky and is recorded separately so it can never mask a later regression.
   */
  runs?: number;
}

const SEPARATOR = " » ";

/** Hash of the parts of a profile that decide what is verified. */
export function hashProfile(profile: VerificationProfile): string {
  const canonical = profile.stages.map((stage) => ({
    name: stage.name,
    command: stage.command,
    args: stage.args,
    required: stage.required,
    cwd: stage.cwd ?? null,
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/**
 * Failing test names from node:test output. Handles the TAP reporter
 * (`not ok N - name`) and the spec reporter (`✖ name (1.2ms)`); SKIP and TODO
 * results are not failures. The checkout path is stripped so a file-level
 * failure (`not ok 1 - /abs/repo/test/x.test.js`) has the same id in two
 * checkouts of the same tree.
 */
export function parseFailingTests(output: string, cwd?: string): string[] {
  const names = new Set<string>();
  const prefix = cwd ? `${cwd.replace(/\/+$/, "")}/` : undefined;
  const add = (raw: string): void => {
    let name = raw.trim();
    if (prefix) name = name.split(prefix).join("");
    if (name) names.add(name);
  };
  for (const line of output.split(/\r?\n/)) {
    const tap = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (tap) {
      const body = tap[1] ?? "";
      if (/\s#\s*(SKIP|TODO)\b/i.test(body)) continue;
      add(body.replace(/\s#\s.*$/, ""));
      continue;
    }
    const spec = /^\s*✖\s+(.*?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/.exec(line);
    if (spec) {
      const body = spec[1] ?? "";
      if (/^(failing tests|\d+ failing tests?):?$/i.test(body.trim())) continue;
      add(body);
    }
  }
  return [...names];
}

/**
 * Stable ids for what failed in an outcome. A failing stage with parsed test
 * failures is named by those tests (so a new failing test in an already-red
 * stage is visible); any other failing stage is named by the stage.
 */
export function failureIds(outcome: VerifyOutcome): string[] {
  const ids: string[] = [];
  for (const run of outcome.stages) {
    if (run.passed) continue;
    const tests = run.failingTests ?? [];
    if (tests.length === 0) ids.push(`stage:${run.stage.name}`);
    else for (const test of tests) ids.push(`test:${run.stage.name}${SEPARATOR}${test}`);
  }
  return ids;
}

function stageOf(id: string): string {
  if (id.startsWith("stage:")) return id.slice("stage:".length);
  const rest = id.slice("test:".length);
  const cut = rest.indexOf(SEPARATOR);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Run `profile` in `cwd`, which must be a clean checkout of `baseSha`, and
 * record what fails there. The baseline is bound to the commit actually
 * checked out; a mismatch or uncommitted change is rejected rather than
 * recorded as a baseline of something else.
 */
export async function captureBaseline(
  cwd: string,
  baseSha: string,
  provider: VerificationProvider,
  profile: VerificationProfile,
  store: ArtifactStore,
  options: CaptureBaselineOptions = {},
): Promise<FailureBaseline> {
  const runs = options.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1) throw new Error("captureBaseline runs must be a positive integer");
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const wanted = await git(cwd, ["rev-parse", "--verify", `${baseSha}^{commit}`]).catch(() => "");
  if (!wanted || wanted !== head) {
    throw new Error(`captureBaseline: ${cwd} is not at base ${baseSha} (HEAD is ${head})`);
  }
  if ((await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).length > 0) {
    throw new Error(`captureBaseline: ${cwd} has uncommitted changes; a baseline must describe ${head} exactly`);
  }
  const perRun: Array<Set<string>> = [];
  const outcomes: VerifyOutcome[] = [];
  for (let attempt = 0; attempt < runs; attempt++) {
    // Exhaustive: a stage after the first failure must not stay unknown.
    const outcome = await provider.run(cwd, profile, store, {
      exhaustive: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runOptions ?? {}),
    });
    // A run that died of the environment describes the machine, not the commit.
    if (outcome.stages.some((run) => run.summary.infrastructureFailure === true)) {
      throw new Error("captureBaseline: a stage failed for an infrastructure reason (hang or spawn failure)");
    }
    perRun.push(new Set(failureIds(outcome)));
    outcomes.push(outcome);
  }
  const everFailed = new Set(perRun.flatMap((ids) => [...ids]));
  const failures = [...everFailed].filter((id) => perRun.every((ids) => ids.has(id))).sort();
  const flaky = [...everFailed].filter((id) => !perRun.every((ids) => ids.has(id))).sort();
  const stagesRun = [...new Set(outcomes.flatMap((o) => o.stages.map((run) => run.stage.name)))];
  const exitCodes: Record<string, number> = {};
  for (const run of outcomes[0]?.stages ?? []) {
    if (run.passed) continue;
    const codes = outcomes.map((o) => o.stages.find((r) => r.stage.name === run.stage.name)?.exitCode);
    if (codes.every((code) => code === run.exitCode)) exitCodes[run.stage.name] = run.exitCode;
  }
  return {
    baseSha: head,
    profileHash: hashProfile(profile),
    failures,
    flaky,
    capturedAt: new Date().toISOString(),
    stagesRun,
    exitCodes,
  };
}

/**
 * Judge `outcome` against `baseline` for a candidate bound to `boundBaseSha`.
 * A baseline whose base SHA (or profile) is not the candidate's is stale: it is
 * never reused, forgives nothing, and blocks.
 */
export function compareToBaseline(
  baseline: FailureBaseline,
  outcome: VerifyOutcome,
  boundBaseSha: string | undefined,
): BaselineVerdict {
  const current = failureIds(outcome);
  // A blocked outcome depends on a quarantined test: no baseline can forgive it,
  // and it blocks even when no failing id is listed (stages may all have passed).
  if (outcome.status === "blocked") {
    return {
      introduced: current,
      preExisting: [],
      fixed: [],
      stale: false,
      blocking: true,
      reason: `blocked by quarantined test(s): ${(outcome.quarantined ?? []).join(", ") || "unknown"}`,
    };
  }
  const stale = (reason: string): BaselineVerdict => ({
    introduced: current,
    preExisting: [],
    fixed: [],
    stale: true,
    blocking: true,
    reason: `stale baseline: ${reason}`,
  });
  if (!boundBaseSha) return stale("the candidate has no bound base SHA");
  if (baseline.baseSha.toLowerCase() !== boundBaseSha.toLowerCase()) {
    return stale(`captured at ${baseline.baseSha} but the candidate is bound to ${boundBaseSha}`);
  }
  if (outcome.profileHash !== undefined && outcome.profileHash !== baseline.profileHash) {
    return stale("captured for a different verification profile");
  }
  // A failing stage that died differently than it did on the base (other exit
  // code, hang, forced exit) is a new failure even when its names match.
  const changedStages = new Set(
    outcome.stages
      .filter((run) => {
        if (run.passed) return false;
        const baseCode = baseline.exitCodes?.[run.stage.name];
        return run.summary.infrastructureFailure === true || (baseCode !== undefined && baseCode !== run.exitCode);
      })
      .map((run) => run.stage.name),
  );
  const known = new Set(baseline.failures);
  const inherits = (id: string): boolean => known.has(id) && !changedStages.has(stageOf(id));
  const preExisting = current.filter(inherits);
  const introduced = current.filter((id) => !inherits(id));
  const ranStages = new Set(outcome.stages.map((run) => run.stage.name));
  const now = new Set(current);
  const fixed = baseline.failures.filter((id) => ranStages.has(stageOf(id)) && !now.has(id));
  return {
    introduced,
    preExisting,
    fixed,
    stale: false,
    blocking: introduced.length > 0,
    reason:
      introduced.length > 0
        ? `${introduced.length} failure(s) introduced since ${baseline.baseSha}`
        : `no failures beyond the ${preExisting.length} present at ${baseline.baseSha}`,
  };
}
