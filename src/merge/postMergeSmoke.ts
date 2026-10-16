/**
 * Post-merge smoke decision (issue #308).
 *
 * A pure module that decides, after a merge into `main`, whether the merge is
 * confirmed, needs a CI re-run (the failing checks look flaky) or must be
 * reverted (a deterministic regression was introduced by the merge). It reuses
 * {@link classifyCheckFailures} from the pre-merge gate so the two agree on how
 * a failing check is classified as base, flaky or deterministic.
 *
 * The module performs no I/O, never mutates its input and never throws: every
 * array is copied before it is returned.
 */
import { type CheckFailureBaseline, classifyCheckFailures } from "./checkRunIngest.ts";
import type { CheckRun, FailureClass } from "./mergeGate.ts";

export type SmokeDecision = "confirmed" | "rerun" | "revert" | "pending";

export interface PostMergeSmokeInput {
  mergeSha: string;
  prNumber: number;
  parentSha: string;
  mainChecks: readonly CheckRun[];
  requiredChecks: readonly string[];
  preMergeMainChecks?: readonly CheckRun[];
  baseline?: CheckFailureBaseline;
  rerunCount: number;
  maxReruns: number;
}

export interface PostMergeSmokeResult {
  decision: SmokeDecision;
  reasons: string[];
  failureClasses: Record<string, FailureClass>;
  preExisting: string[];
  introduced: string[];
  revertTarget?: { sha: string; prNumber: number };
}

/**
 * Decide the post-merge smoke outcome for `mergeSha`.
 *
 * Rules, in this exact order (reasons are emitted in this order):
 *
 * 1. Only runs whose `sha` equals `input.mergeSha` and whose name is in
 *    `requiredChecks` are considered; runs on other SHAs count as absent.
 * 2. For each required name in `requiredChecks` order: absent → `required check
 *    <n> missing`; status `pending` → `required check <n> pending`; status
 *    `skipped` → `required check <n> skipped`. If any such reason was pushed the
 *    decision is `pending` with empty `failureClasses`, `preExisting` and
 *    `introduced`.
 * 3. If every required check passes → `confirmed` with empty reasons.
 * 4. Classify the required runs on `mergeSha` with `classifyCheckFailures`.
 * 5. A failing name is PRE-EXISTING when its class is `base`, or
 *    `preMergeMainChecks` contains a run with the same name whose `sha` equals
 *    `parentSha` and status `fail` → push `check <n> failed before merge
 *    (preexisting)` and list it in `preExisting`.
 * 6. Every other failing name is INTRODUCED → push `check <n> failed (<class>)`
 *    and list it in `introduced`.
 * 7. Decision: any introduced `deterministic` → `revert` with revertTarget
 *    `{ sha: mergeSha, prNumber }`; else any introduced `flaky` → `rerun` if
 *    `rerunCount < maxReruns`, otherwise push `rerun budget exhausted
 *    (<rerunCount>/<maxReruns>)` and `revert` with revertTarget; else (only
 *    pre-existing failures) → `confirmed` keeping the preexisting reasons.
 *
 * Non-finite `rerunCount`/`maxReruns` are treated as `maxReruns` 0. The input is
 * never mutated.
 */
export function decidePostMergeSmoke(input: PostMergeSmokeInput): PostMergeSmokeResult {
  const reasons: string[] = [];
  const failureClasses: Record<string, FailureClass> = {};
  const preExisting: string[] = [];
  const introduced: string[] = [];

  const required = new Set(input.requiredChecks);
  const mergeRuns = input.mainChecks.filter((run) => run.sha === input.mergeSha && required.has(run.name));

  // Rule 2: missing / pending / skipped required checks.
  for (const name of input.requiredChecks) {
    const run = mergeRuns.find((r) => r.name === name);
    if (!run) {
      reasons.push(`required check ${name} missing`);
    } else if (run.status === "pending") {
      reasons.push(`required check ${name} pending`);
    } else if (run.status === "skipped") {
      reasons.push(`required check ${name} skipped`);
    }
  }
  if (reasons.length > 0) {
    return { decision: "pending", reasons, failureClasses, preExisting, introduced };
  }

  // Rule 3: every required check passes.
  if (mergeRuns.every((run) => run.status === "pass")) {
    return { decision: "confirmed", reasons: [], failureClasses, preExisting, introduced };
  }

  // Rule 4: classify the failing required runs on the merge SHA.
  const classes = classifyCheckFailures(mergeRuns, input.parentSha, input.baseline);
  for (const name of Object.keys(classes)) {
    const cls = classes[name];
    if (cls !== undefined) failureClasses[name] = cls;
  }

  const preMergeFailing = new Set(
    (input.preMergeMainChecks ?? [])
      .filter((run) => run.sha === input.parentSha && run.status === "fail")
      .map((run) => run.name),
  );

  // Rules 5 & 6: split failing names into pre-existing and introduced.
  for (const name of input.requiredChecks) {
    const run = mergeRuns.find((r) => r.name === name);
    if (!run || run.status !== "fail") continue;
    const cls = classes[name] ?? "deterministic";
    if (cls === "base" || preMergeFailing.has(name)) {
      preExisting.push(name);
      reasons.push(`check ${name} failed before merge (preexisting)`);
    } else {
      introduced.push(name);
      reasons.push(`check ${name} failed (${cls})`);
    }
  }

  // Rule 7: decision.
  const deterministicIntroduced = introduced.some((name) => failureClasses[name] === "deterministic");
  if (deterministicIntroduced) {
    return {
      decision: "revert",
      reasons,
      failureClasses,
      preExisting,
      introduced,
      revertTarget: { sha: input.mergeSha, prNumber: input.prNumber },
    };
  }

  const flakyIntroduced = introduced.some((name) => failureClasses[name] === "flaky");
  if (flakyIntroduced) {
    const rerunBudget = Number.isFinite(input.rerunCount) && Number.isFinite(input.maxReruns) ? input.maxReruns : 0;
    if (input.rerunCount < rerunBudget) {
      return { decision: "rerun", reasons, failureClasses, preExisting, introduced };
    }
    reasons.push(`rerun budget exhausted (${input.rerunCount}/${input.maxReruns})`);
    return {
      decision: "revert",
      reasons,
      failureClasses,
      preExisting,
      introduced,
      revertTarget: { sha: input.mergeSha, prNumber: input.prNumber },
    };
  }

  // Only pre-existing failures remain.
  return { decision: "confirmed", reasons, failureClasses, preExisting, introduced };
}
