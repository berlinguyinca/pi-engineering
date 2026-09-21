import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceContract } from "../../src/cav/contract.ts";
import { runJourney } from "../../src/cav/contract.ts";
import { ProtectedArtifactGuard } from "../../src/cav/guard.ts";

const okContract: AcceptanceContract = {
  requirementId: "AC-TEST-01",
  title: "test contract",
  protectedPath: "tests/acceptance/contracts/ac-test-01.ts",
  journey: [
    { id: "s1", description: "first", assert: () => 1 + 1 === 2 },
    { id: "s2", description: "second", assert: () => "a".length === 1 },
  ],
};

test("a passing journey reports passed=true with all steps green", async () => {
  const r = await runJourney(okContract);
  assert.equal(r.passed, true);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.steps.length, 2);
  assert.ok(r.steps.every((s) => s.passed));
});

test("a failing journey fails closed and stops at the first failing step", async () => {
  const c: AcceptanceContract = {
    ...okContract,
    requirementId: "AC-TEST-02",
    journey: [
      { id: "s1", description: "ok", assert: () => true },
      { id: "s2", description: "boom", assert: () => false },
      { id: "s3", description: "never runs", assert: () => true },
    ],
  };
  const r = await runJourney(c);
  assert.equal(r.passed, false);
  assert.equal(r.steps.length, 2); // stops at s2, never reaches s3
  assert.ok(r.blockers.some((b) => b.includes("s2")));
});

test("a step that throws fails closed", async () => {
  const c: AcceptanceContract = {
    ...okContract,
    requirementId: "AC-TEST-03",
    journey: [
      {
        id: "s1",
        description: "throws",
        assert: () => {
          throw new Error("x");
        },
      },
    ],
  };
  const r = await runJourney(c);
  assert.equal(r.passed, false);
  assert.ok(r.blockers.some((b) => b.includes("x")));
});

test("acceptance contracts are protected artifacts", () => {
  const guard = new ProtectedArtifactGuard();
  assert.ok(guard.isProtected("tests/acceptance/contracts/ac-test-01.ts"));
  assert.ok(!guard.isProtected("src/cav/contract.ts"));
});
