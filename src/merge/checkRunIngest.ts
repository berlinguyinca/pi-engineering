import type { FailureBaseline } from "../verify/failureBaseline.ts";
/**
 * Check-run ingestion (merge gate spec §31, issue #306).
 *
 * A pure module that converts raw GitHub check data — the PR "check" bucket
 * summary and the REST check-run list — into normalized {@link CheckRun}s that
 * {@link decideMerge} understands, and that classifies the failing checks as
 * base, flaky or deterministic against a {@link FailureBaseline}. The mapping
 * deliberately mirrors the merge-gate's private rule so the two agree.
 *
 * The module performs no I/O and never mutates its inputs. Entries are
 * de-duplicated by name (latest wins, ties keep the later input with REST after
 * gh) and the result is sorted by name via `localeCompare`.
 */
import type { CheckRun, FailureClass } from "./mergeGate.ts";

/**
 * A GitHub PR check summary entry as surfaced by the PR checks bucket. The
 * `bucket` field carries a coarse status: `"pass"`, `"fail"`, `"cancel"`,
 * `"pending"`, `"skipping"` or anything else.
 */
export interface GhPrCheck {
  name: string;
  /** PR head SHA the check ran against, when known. */
  head_sha?: string;
  /** Coarse status bucket. Lower-cased before mapping. */
  bucket?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * A single check run from the GitHub REST API
 * (`/repos/{owner}/{repo}/commits/{ref}/check-runs`). `status` is one of
 * `"queued"`, `"in_progress"` or `"completed"`; `conclusion` is only meaningful
 * once `status === "completed"` and may be `null`.
 */
export interface RestCheckRun {
  name: string;
  /** Commit SHA the check run targeted, when known. */
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
}

/** Baseline slice used for classification (same shape mergeGate accepts). */
export type CheckFailureBaseline = Pick<FailureBaseline, "baseSha" | "failures" | "flaky">;

export interface NormalizeCheckRunsInput {
  headSha: string;
  ghChecks?: readonly GhPrCheck[];
  restCheckRuns?: readonly RestCheckRun[];
}

/** Map a gh check bucket (lower-cased) to a CheckRun status. */
function ghStatus(bucket: string | undefined): CheckRun["status"] {
  switch (bucket?.toLowerCase()) {
    case "pass":
      return "pass";
    case "fail":
    case "cancel":
      return "fail";
    case "pending":
      return "pending";
    case "skipping":
      return "skipped";
    default:
      // Anything else, or a missing bucket, is treated as a failure.
      return "fail";
  }
}

/** Map a REST check run's status/conclusion to a CheckRun status. */
function restStatus(status: string | undefined, conclusion: string | null | undefined): CheckRun["status"] {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "pass";
    case "failure":
    case "timed_out":
    case "action_required":
    case "cancelled":
      return "fail";
    case "skipped":
    case "neutral":
      return "skipped";
    case "stale":
      return "pending";
    default:
      // Completed with any other conclusion, including a null conclusion.
      return "fail";
  }
}

/** Treat empty and the zero-time `0001-…` dates as "no date" (empty string). */
function normalizeDate(value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("0001-")) return "";
  return value;
}

/** Latest-wins date key for a candidate (completedAt ?? startedAt). */
function dateKey(completedAt: string | undefined, startedAt: string | undefined): string {
  return normalizeDate(completedAt) || normalizeDate(startedAt) || "";
}

/**
 * Convert raw GitHub check data into normalized {@link CheckRun}s.
 *
 * gh entries always use the input `headSha` (their own `head_sha` is not
 * authoritative), while REST entries use their `head_sha` when it is a
 * non-empty string and fall back to `input.headSha` otherwise. Entries with a
 * missing or non-string name are dropped. Entries are de-duplicated by name
 * keeping the entry with the latest `(completedAt ?? startedAt)` date, treating
 * empty or `0001-`-prefixed dates as absent; ties keep the later input, with
 * REST entries considered after gh entries. The result is sorted by name via
 * `localeCompare` and the input is never mutated.
 */
export function normalizeCheckRuns(input: NormalizeCheckRunsInput): CheckRun[] {
  const byName = new Map<string, CheckRun>();
  const byDate = new Map<string, string>();

  const upsert = (name: string, run: CheckRun, date: string): void => {
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, run);
      byDate.set(name, date);
      return;
    }
    const existingDate = byDate.get(name) ?? "";
    if (date >= existingDate) {
      byName.set(name, run);
      byDate.set(name, date);
    }
  };

  for (const gh of input.ghChecks ?? []) {
    if (typeof gh.name !== "string" || gh.name === "") continue;
    upsert(
      gh.name,
      { name: gh.name, status: ghStatus(gh.bucket), sha: input.headSha },
      dateKey(gh.completedAt, gh.startedAt),
    );
  }

  for (const rest of input.restCheckRuns ?? []) {
    if (typeof rest.name !== "string" || rest.name === "") continue;
    const sha = typeof rest.head_sha === "string" && rest.head_sha !== "" ? rest.head_sha : input.headSha;
    upsert(
      rest.name,
      { name: rest.name, status: restStatus(rest.status, rest.conclusion), sha },
      dateKey(rest.completed_at, rest.started_at),
    );
  }

  const result = [...byName.values()];
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * Classify failing checks (status `"fail"`) as base, flaky or deterministic,
 * mirroring mergeGate's private `classifyFailure` exactly: `"base"` when the
 * baseline names the check and its `baseSha` equals `baseSha` exactly
 * (case-sensitive), else `"flaky"` when the baseline lists it as flaky, else
 * `"deterministic"`. The returned object maps each failing check name to its
 * class. Inputs are never mutated.
 */
export function classifyCheckFailures(
  checks: readonly CheckRun[],
  baseSha: string,
  baseline?: CheckFailureBaseline,
): Record<string, FailureClass> {
  const failureClasses: Record<string, FailureClass> = {};
  for (const check of checks) {
    if (check.status !== "fail") continue;
    if (baseline && baseline.baseSha === baseSha && baseline.failures.includes(check.name)) {
      failureClasses[check.name] = "base";
    } else if (baseline?.flaky.includes(check.name)) {
      failureClasses[check.name] = "flaky";
    } else {
      failureClasses[check.name] = "deterministic";
    }
  }
  return failureClasses;
}
