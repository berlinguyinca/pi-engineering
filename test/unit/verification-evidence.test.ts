import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun } from "../../src/merge/mergeGate.ts";
import type { LocalRun, VerificationEvidenceInput } from "../../src/merge/verificationEvidence.ts";
import { buildVerificationEvidence } from "../../src/merge/verificationEvidence.ts";
import type { ReleaseGateResult } from "../../src/roadmap/types.ts";

/** Builder for a CI check run. */
function ci(name: string, status: CheckRun["status"], sha: string): CheckRun {
  return { name, status, sha };
}

/** Builder for a local run. */
function loc(name: string, status: LocalRun["status"], sha: string): LocalRun {
  return { name, status, sha };
}

/** Builder for a release gate result. */
function gate(pass: boolean, blockers: string[]): ReleaseGateResult {
  return { pass, blockers, gates: {} };
}

const S = "abc123";
const O = "old999";

function input(over: Partial<VerificationEvidenceInput> = {}): VerificationEvidenceInput {
  return {
    sha: S,
    requiredChecks: ["verify"],
    local: [loc("verify", "pass", S)],
    ci: [ci("verify", "pass", S)],
    ...over,
  };
}

test("verification evidence: base is consistent with no divergences", () => {
  const evidence = buildVerificationEvidence(input());
  assert.equal(evidence.status, "consistent");
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual(evidence.divergences, []);
  assert.deepEqual(evidence.summary, { required: 1, localPassed: 1, ciPassed: 1, ciMissing: 0, releaseGate: "absent" });
});

test("verification evidence: gate pass with matching evidence commit is consistent", () => {
  const evidence = buildVerificationEvidence(input({ releaseGate: gate(true, []), evidenceCommit: S }));
  assert.equal(evidence.status, "consistent");
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.summary.releaseGate, "pass");
});

test("verification evidence: local pass with CI fail is divergent", () => {
  const evidence = buildVerificationEvidence(input({ ci: [ci("verify", "fail", S)] }));
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, ["local verify passed but CI verify failed"]);
  assert.equal(evidence.divergences.length, 1);
  assert.equal(evidence.divergences[0]!.kind, "local-pass-ci-fail");
  assert.equal(evidence.divergences[0]!.name, "verify");
});

test("verification evidence: local fail with CI pass is divergent", () => {
  const evidence = buildVerificationEvidence(input({ local: [loc("verify", "fail", S)] }));
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, ["local verify failed but CI verify passed"]);
  assert.equal(evidence.divergences[0]!.kind, "local-fail-ci-pass");
});

test("verification evidence: both fail agrees and is consistent", () => {
  const evidence = buildVerificationEvidence(
    input({ local: [loc("verify", "fail", S)], ci: [ci("verify", "fail", S)] }),
  );
  assert.equal(evidence.status, "consistent");
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.summary.localPassed, 0);
  assert.equal(evidence.summary.ciPassed, 0);
});

test("verification evidence: missing CI is incomplete", () => {
  const evidence = buildVerificationEvidence(input({ ci: [] }));
  assert.equal(evidence.status, "incomplete");
  assert.deepEqual(evidence.reasons, ["CI verify missing"]);
  assert.deepEqual(evidence.divergences, []);
  assert.equal(evidence.summary.ciMissing, 1);
});

test("verification evidence: CI for a different sha is incomplete", () => {
  const evidence = buildVerificationEvidence(input({ ci: [ci("verify", "pass", O)] }));
  assert.equal(evidence.status, "incomplete");
  assert.deepEqual(evidence.reasons, ["CI verify is for old999, not abc123"]);
});

test("verification evidence: pending CI and missing local are incomplete in order", () => {
  const evidence = buildVerificationEvidence(input({ ci: [ci("verify", "pending", S)], local: [] }));
  assert.equal(evidence.status, "incomplete");
  assert.deepEqual(evidence.reasons, ["CI verify pending", "local verify missing"]);
});

test("verification evidence: stale evidence commit is divergent", () => {
  const evidence = buildVerificationEvidence(input({ releaseGate: gate(true, []), evidenceCommit: O }));
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, ["release gate evidence commit old999 is stale for abc123"]);
  assert.equal(evidence.divergences[0]!.kind, "stale-evidence");
  assert.equal(evidence.divergences[0]!.name, "release-gate");
});

test("verification evidence: blocked gate with green CI is divergent", () => {
  const evidence = buildVerificationEvidence(
    input({
      releaseGate: gate(false, [
        "fresh-review gate failed: 1 critical, 0 high",
        "dogfood gate failed: no fresh recorded dogfood evidence",
      ]),
    }),
  );
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, [
    "release gate blocked: fresh-review gate failed: 1 critical, 0 high",
    "release gate blocked: dogfood gate failed: no fresh recorded dogfood evidence",
  ]);
  assert.equal(evidence.divergences.length, 1);
  assert.equal(evidence.divergences[0]!.kind, "gate-blocked");
  assert.equal(evidence.summary.releaseGate, "blocked");
});

test("verification evidence: blocked gate agreeing with red CI is consistent", () => {
  const evidence = buildVerificationEvidence(
    input({
      local: [loc("verify", "fail", S)],
      ci: [ci("verify", "fail", S)],
      releaseGate: gate(false, ["tests.unit gate failed"]),
    }),
  );
  assert.equal(evidence.status, "consistent");
  assert.deepEqual(evidence.reasons, ["release gate blocked: tests.unit gate failed"]);
  assert.deepEqual(evidence.divergences, []);
});

test("verification evidence: multiple divergences accumulate in order", () => {
  const evidence = buildVerificationEvidence(
    input({
      requiredChecks: ["verify", "lint"],
      local: [loc("verify", "pass", S)],
      ci: [ci("verify", "fail", S)],
      evidenceCommit: O,
    }),
  );
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, [
    "local verify passed but CI verify failed",
    "CI lint missing",
    "local lint missing",
    "release gate evidence commit old999 is stale for abc123",
  ]);
  assert.deepEqual(
    evidence.divergences.map((d) => d.kind),
    ["local-pass-ci-fail", "stale-evidence"],
  );
});

test("verification evidence: gate passed with red CI is divergent", () => {
  const evidence = buildVerificationEvidence(
    input({ local: [loc("verify", "fail", S)], ci: [ci("verify", "fail", S)], releaseGate: gate(true, []) }),
  );
  assert.equal(evidence.status, "divergent");
  assert.deepEqual(evidence.reasons, ["release gate passed but CI verify failed"]);
  assert.equal(evidence.divergences[0]!.kind, "gate-pass-ci-fail");
});

test("verification evidence: frozen input is not mutated", () => {
  const before = input({
    requiredChecks: ["verify", "lint"],
    releaseGate: gate(false, ["x gate failed"]),
    evidenceCommit: O,
  });
  const snapshot = structuredClone(before);
  Object.freeze(before);
  Object.freeze(before.local);
  Object.freeze(before.ci);
  Object.freeze(before.requiredChecks);
  assert.ok(before.releaseGate);
  Object.freeze(before.releaseGate);
  Object.freeze(before.releaseGate.blockers);
  buildVerificationEvidence(before);
  assert.deepEqual(before, snapshot);
});
