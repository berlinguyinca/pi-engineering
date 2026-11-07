// D04: recovery comes from durable evidence — a claimed "recovered" backed only by HTTP 200 is rejected, and completion must be allowlisted AND strictly after the failure.
import assert from "node:assert/strict"; import { test } from "node:test";
import { classifyRecoveryOutcome, COMPLETION_KINDS, type RecoveryEvidence } from "../../src/incidents/recoveryOutcome.ts";
const NEED = "completion:allowlisted-kind-after-failureAt"; const F = "2026-11-01T00:00:00Z";
const ev = (over: Partial<RecoveryEvidence> = {}): RecoveryEvidence => ({ failureRecorded: true, failureAt: F, ...over });
const done = (at: string, kind = "verification.passed"): RecoveryEvidence["completion"] => ({ kind, at, eventId: "evt-c1" });
const sup = (v: unknown) => ({ suppression: v as RecoveryEvidence["suppression"] });
const bad = (v: unknown) => classifyRecoveryOutcome(v as RecoveryEvidence);
const OUTCOMES = ["recovered", "unresolved", "suppressed", "unknown"];
const CODES = ["suppression.recorded", "completion.strictly.after.failure", "failure.unresolved", "failure.not.recorded", "suppression.incomplete", "completion.not.substantiated", "evidence.malformed"];
test("evidence criterion: claimed recovered with httpStatus 200 and no completion is rejected, missing names the absent proof (criterion 1)", () => {
  const r = classifyRecoveryOutcome(ev({ httpStatus: 200, claimedOutcome: "recovered" }));
  assert.notEqual(r.outcome, "recovered"); assert.equal(r.outcome, "unresolved"); assert.deepEqual(r.missing, [NEED], "the caller is told exactly which durable record is absent");
  const k = classifyRecoveryOutcome(ev({ httpStatus: 204, claimedOutcome: "recovered", completion: done("2026-11-02T00:00:00Z", "http.200.ok") }));
  assert.equal(k.outcome, "unknown", `a completion kind outside ${COMPLETION_KINDS.join(", ")} proves nothing`); assert.ok(k.missing.includes(NEED));
});
test("recovered needs an allowlisted completion strictly after failureAt; equal and earlier rejected; retryTraced alone is nothing (criterion 3)", () => {
  assert.equal(classifyRecoveryOutcome(ev({ completion: done("2026-11-01T00:00:01Z") })).outcome, "recovered");
  assert.equal(classifyRecoveryOutcome(ev({ completion: done("2026-11-01T00:00:01Z"), retryTraced: true, httpStatus: 500 })).outcome, "recovered", "once durable completion lands, trace and status are irrelevant");
  const eq = classifyRecoveryOutcome(ev({ completion: done(F), claimedOutcome: "recovered" })); const early = classifyRecoveryOutcome(ev({ completion: done("2026-10-31T23:59:59Z"), claimedOutcome: "recovered" }));
  for (const r of [eq, early]) { assert.notEqual(r.outcome, "recovered"); assert.equal(r.outcome, "unknown"); assert.ok(r.missing.includes(NEED), "equal or earlier completion cannot settle a later failure"); }
  const t = classifyRecoveryOutcome(ev({ retryTraced: true, claimedOutcome: "recovered" })); assert.equal(t.outcome, "unresolved"); assert.ok(t.missing.includes(NEED), "an attempted retry is not a recovery");
});
test("suppressed only with a complete suppression record; a half-filled one is unknown naming what is missing (criterion 4)", () => {
  assert.deepEqual(classifyRecoveryOutcome(ev({ suppression: { at: F, eventId: "evt-s1" } })), { outcome: "suppressed", reason: "suppression.recorded", missing: [] });
  for (const s of [{ at: F }, { eventId: "evt-s1" }, { at: "", eventId: "evt-s1" }]) { const r = classifyRecoveryOutcome(ev(sup(s))); assert.equal(r.outcome, "unknown", JSON.stringify(s)); assert.deepEqual(r.missing, ["suppression:eventId"]); }
});
test("unresolved is the default for a recorded failure alone, and no 2xx changes the outcome or leaks into reason (criteria 2+4)", () => {
  for (const s of [200, 201, 204, 226, 299]) { const r = classifyRecoveryOutcome(ev({ httpStatus: s, claimedOutcome: "recovered", retryTraced: true })); assert.equal(r.outcome, "unresolved", `http ${s} is not recovery`); assert.deepEqual(r.missing, [NEED]); }
  assert.deepEqual(classifyRecoveryOutcome(ev()).missing, [], "unresolved without a claim is a fact, not a complaint"); assert.equal(classifyRecoveryOutcome(ev({ failureRecorded: true })).outcome, "unresolved");
});
test("totality: null, {}, non-date failureAt and completion { kind: 5 } never throw and always answer with evidence (criterion 4)", () => {
  const corpus: unknown[] = [null, undefined, 7, "x", {}, { failureRecorded: "yes" }, ev({ failureAt: "not-a-date", completion: done("2026-12-01T00:00:00Z") }), ev({ completion: { kind: 5 } as unknown as RecoveryEvidence["completion"] }), ev({ completion: null }), ev({ failureAt: undefined, completion: done("2026-11-09T00:00:00Z") })];
  for (const v of corpus) { const r = bad(v); assert.ok(OUTCOMES.includes(r.outcome), JSON.stringify(v)); assert.ok(Array.isArray(r.missing) && r.missing.every((m) => typeof m === "string")); }
  assert.equal(bad(null).outcome, "unknown"); assert.deepEqual(bad({}).missing, ["failureRecorded"], "no failure record means nothing can be claimed");
  const r = classifyRecoveryOutcome(ev({ failureAt: undefined, completion: done("2026-11-09T00:00:00Z"), claimedOutcome: "recovered" }));
  assert.equal(r.outcome, "unknown"); assert.deepEqual(r.missing, [NEED, "failureAt"], "an undated failure cannot be ordered against a completion");
});
test("every reason is a stable code and no reason ever cites an HTTP status (criterion 2)", () => {
  const corpus: unknown[] = [ev(), ev({ httpStatus: 200, claimedOutcome: "recovered" }), ev({ httpStatus: 500, completion: done("2026-11-02T00:00:00Z"), retryTraced: true }), ev(sup({ at: F, eventId: "e" })), ev(sup({ at: F })), {}, null];
  for (const e of corpus) { const r = bad(e); assert.ok(CODES.includes(r.reason), `unstable reason: ${r.reason}`); assert.doesNotMatch(r.reason, /https?|status|\b\d{3}\b/i, "status codes never appear as the reason"); }
});
