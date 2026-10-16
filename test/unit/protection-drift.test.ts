import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchProtectionSnapshot, ProtectionDriftInput } from "../../src/merge/protectionDrift.ts";
import { evaluateProtectionDrift } from "../../src/merge/protectionDrift.ts";

/** Small builder for a protection snapshot. */
function snap(overrides: Partial<BranchProtectionSnapshot> = {}): BranchProtectionSnapshot {
  return {
    requiredStatusChecks: ["ci"],
    strict: true,
    requiredApprovingReviews: 1,
    enforceAdmins: true,
    allowForcePushes: false,
    allowDeletions: false,
    ...overrides,
  };
}

function input(over: Partial<ProtectionDriftInput> = {}): ProtectionDriftInput {
  return {
    desired: snap(),
    actual: snap(),
    requiredChecks: ["ci"],
    ...over,
  };
}

test("protection drift: actual identical to desired is enforced", () => {
  const result = evaluateProtectionDrift(input());
  assert.equal(result.status, "enforced");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, []);
});

test("protection drift: actual null is unknown", () => {
  const result = evaluateProtectionDrift(input({ actual: null }));
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.reasons, ["branch protection unavailable"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, []);
});

test("protection drift: required check missing from actual is weakened", () => {
  const result = evaluateProtectionDrift(input({ requiredChecks: ["ci", "lint"], actual: snap() }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.missingChecks, ["lint"]);
  assert.deepEqual(result.reasons, ["required check lint not enforced"]);
  assert.deepEqual(result.weakenedFields, ["requiredStatusChecks"]);
});

test("protection drift: check named only in desired is still reported", () => {
  const desired = snap({ requiredStatusChecks: ["ci", "audit"] });
  const result = evaluateProtectionDrift(input({ desired, actual: snap() }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.missingChecks, ["audit"]);
  assert.deepEqual(result.reasons, ["required check audit not enforced"]);
  assert.deepEqual(result.weakenedFields, ["requiredStatusChecks"]);
});

test("protection drift: two missing checks deduped with requiredChecks order first", () => {
  // "ci" appears in both requiredChecks and desired.requiredStatusChecks, "lint"
  // and "audit" each appear in both lists too. requiredChecks order is first.
  const desired = snap({ requiredStatusChecks: ["audit", "lint", "ci"] });
  const result = evaluateProtectionDrift(input({ desired, requiredChecks: ["ci", "lint", "audit"], actual: snap() }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.missingChecks, ["lint", "audit"]);
  assert.deepEqual(result.reasons, ["required check lint not enforced", "required check audit not enforced"]);
  assert.deepEqual(result.weakenedFields, ["requiredStatusChecks"]);
});

test("protection drift: strict true to false", () => {
  const result = evaluateProtectionDrift(input({ actual: snap({ strict: false }) }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.reasons, ["strict status checks disabled"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, ["strict"]);
});

test("protection drift: reviews 2 to 1", () => {
  const desired = snap({ requiredApprovingReviews: 2 });
  const result = evaluateProtectionDrift(input({ desired, actual: snap({ requiredApprovingReviews: 1 }) }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.reasons, ["required approving reviews lowered from 2 to 1"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, ["requiredApprovingReviews"]);
});

test("protection drift: enforceAdmins true to false", () => {
  const result = evaluateProtectionDrift(input({ actual: snap({ enforceAdmins: false }) }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.reasons, ["enforce admins disabled"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, ["enforceAdmins"]);
});

test("protection drift: force pushes allowed", () => {
  const result = evaluateProtectionDrift(input({ actual: snap({ allowForcePushes: true }) }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.reasons, ["force pushes allowed"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, ["allowForcePushes"]);
});

test("protection drift: deletions allowed", () => {
  const result = evaluateProtectionDrift(input({ actual: snap({ allowDeletions: true }) }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.reasons, ["deletions allowed"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, ["allowDeletions"]);
});

test("protection drift: extra protections in actual are enforced", () => {
  const desired = snap({ strict: false });
  const actual = snap({
    requiredStatusChecks: ["ci", "extra"],
    strict: true,
    requiredApprovingReviews: 3,
  });
  const result = evaluateProtectionDrift(input({ desired, actual }));
  assert.equal(result.status, "enforced");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, []);
});

test("protection drift: everything weakened at once keeps fixed order", () => {
  const desired = snap({ requiredStatusChecks: ["ci", "audit"], requiredApprovingReviews: 2 });
  const actual = snap({
    requiredStatusChecks: ["ci"],
    strict: false,
    requiredApprovingReviews: 1,
    enforceAdmins: false,
    allowForcePushes: true,
    allowDeletions: true,
  });
  const result = evaluateProtectionDrift(input({ desired, requiredChecks: ["ci", "lint"], actual }));
  assert.equal(result.status, "weakened");
  assert.deepEqual(result.missingChecks, ["lint", "audit"]);
  assert.deepEqual(result.reasons, [
    "required check lint not enforced",
    "required check audit not enforced",
    "strict status checks disabled",
    "required approving reviews lowered from 2 to 1",
    "enforce admins disabled",
    "force pushes allowed",
    "deletions allowed",
  ]);
  assert.deepEqual(result.weakenedFields, [
    "requiredStatusChecks",
    "strict",
    "requiredApprovingReviews",
    "enforceAdmins",
    "allowForcePushes",
    "allowDeletions",
  ]);
});

test("protection drift: unknown wins and frozen inputs are not mutated", () => {
  const desired = Object.freeze(snap());
  const requiredChecks = Object.freeze(["ci", "lint"]);
  const result = evaluateProtectionDrift(input({ desired, actual: null, requiredChecks }));
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.reasons, ["branch protection unavailable"]);
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.weakenedFields, []);
  assert.deepEqual(desired, snap());
  assert.deepEqual([...requiredChecks], ["ci", "lint"]);
});
