// D04: pure recovery-outcome classifier. No I/O, no clock, no env: the caller supplies durable evidence
// records (D01 reader events, E05 failure records, E07 retry traces). HTTP status is never recovery proof,
// and `retryTraced` alone proves only that attempts were acted on.

export type RecoveryOutcome = "recovered" | "unresolved" | "suppressed" | "unknown";

export interface RecoveryEvidence {
  failureRecorded: boolean;
  failureAt?: string;
  completion?: { kind: string; at: string; eventId: string } | null;
  retryTraced?: boolean;
  httpStatus?: number | null;
  suppression?: { at: string; eventId: string } | null;
  claimedOutcome?: RecoveryOutcome | null;
}

export interface RecoveryVerdict {
  outcome: RecoveryOutcome;
  reason: string;
  missing: string[];
}

// Durable record kinds that prove completion; an unrecognised kind proves nothing and is never guessed at.
export const COMPLETION_KINDS: readonly string[] = [
  "verification.passed",
  "unit.passed",
  "typecheck.passed",
  "task.completed",
];

const NEED_COMPLETION = "completion:allowlisted-kind-after-failureAt";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const verdict = (outcome: RecoveryOutcome, reason: string, missing: string[] = []): RecoveryVerdict => ({
  outcome,
  reason,
  missing,
});

// Rules in order: suppressed (complete record) > recovered (allowlisted completion strictly after failureAt)
// > unresolved (recorded failure, no completion/suppression) > unknown (inconsistent / unsubstantiated claim).
export function classifyRecoveryOutcome(evidence: RecoveryEvidence): RecoveryVerdict {
  if (!isObj(evidence)) return verdict("unknown", "evidence.malformed", ["failureRecorded"]);
  const sup = isObj(evidence.suppression) ? evidence.suppression : undefined;
  if (sup !== undefined) {
    if (isStr(sup.at) && isStr(sup.eventId)) return verdict("suppressed", "suppression.recorded");
    return verdict("unknown", "suppression.incomplete", ["suppression:eventId"]);
  }
  if (evidence.failureRecorded !== true) return verdict("unknown", "failure.not.recorded", ["failureRecorded"]);
  const c = isObj(evidence.completion) ? evidence.completion : undefined;
  if (c === undefined) {
    // Nothing durable says this ever finished; a claimed "recovered" is rejected for lack of proof.
    return verdict(
      "unresolved",
      "failure.unresolved",
      evidence.claimedOutcome === "recovered" ? [NEED_COMPLETION] : [],
    );
  }
  const failureAt = isStr(evidence.failureAt) ? evidence.failureAt : undefined;
  const allowlisted = isStr(c.kind) && COMPLETION_KINDS.includes(c.kind);
  const strictlyAfter = failureAt !== undefined && isStr(c.at) && c.at > failureAt;
  if (allowlisted && strictlyAfter) return verdict("recovered", "completion.strictly.after.failure");
  const missing = [NEED_COMPLETION];
  if (failureAt === undefined) missing.push("failureAt");
  return verdict("unknown", "completion.not.substantiated", missing);
}
