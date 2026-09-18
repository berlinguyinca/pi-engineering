import assert from "node:assert/strict";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { checkBypass, deriveCavMetrics, runMutationSuite } from "../../src/cav/mutation.ts";

// The target verifier: a guard that fails closed when the input is invalid.
const guard = (input: number): boolean => {
  if (Number.isNaN(input)) throw new Error("guard: invalid input");
  return input >= 0;
};

test("a mutant that removes the NaN guard is KILLED by the verifier", () => {
  const suite = runMutationSuite([
    {
      id: "M1-remove-nan-guard",
      description: "remove the NaN guard so invalid input passes",
      apply: () => (input: number) => input >= 0, // mutant: no throw on NaN
      killedBy: (fn) => {
        // Original contract: guard THROWS on NaN. Mutant dropped the throw,
        // so fn(NaN) no longer throws => assertion fails => mutant killed.
        const fnAny = fn as (input: number) => boolean;
        if (!fnAny(Number.NaN) && !fnAny(Number.NaN)) {
          // NaN is rejected (NaN>=0 is false) — but the guard's real contract
          // is to THROW. Assert it throws:
        }
        let threw = false;
        try {
          fnAny(Number.NaN);
        } catch {
          threw = true;
        }
        if (!threw) throw new Error("M1 not killed: NaN guard was removed");
        return true;
      },
    },
    {
      id: "M2-negate-boundary",
      description: "negate the boundary so negatives pass",
      apply: () => (input: number) => input <= 0,
      killedBy: (fn) => {
        // Original contract: -1 is REJECTED. Mutant accepts it.
        const fnAny = fn as (input: number) => boolean;
        if (fnAny(-1)) throw new Error("M2 not killed: negative was accepted");
        return true;
      },
    },
  ]);
  assert.equal(suite.total, 2);
  assert.equal(suite.killed, 2, JSON.stringify(suite.mutants));
  assert.equal(suite.survived, 0);
  assert.equal(suite.passed, true);
});

test("a surviving mutant is a real finding (verifier weakness)", () => {
  const suite = runMutationSuite([
    {
      id: "M3-undetected",
      description: "mutant drops the NaN throw; a weak test misses it",
      apply: () => (input: number) => input >= 0, // mutant: no throw on NaN
      killedBy: (fn) => {
        // Weak verifier: only checks the boundary (-5 rejected), never asserts
        // the NaN-throw contract. The mutation (dropped NaN throw) is NOT
        // detected => returns false => the mutant SURVIVES.
        const fnAny = fn as (i: number) => boolean;
        void fnAny; // weak test does not exercise the NaN contract
        return false;
      },
    },
  ]);
  assert.equal(suite.passed, false);
  assert.equal(suite.survived, 1);
});

test("anti-bypass blocks a protected-artifact bypass and flags undetected bypass", () => {
  // Guard that fails closed: any bypass attempt is detected.
  assert.equal(checkBypass(true, (attempted) => attempted).blocked, true);
  const undetected = checkBypass(true, () => false);
  assert.equal(undetected.blocked, false);
  assert.ok(undetected.blockers.some((b) => b.includes("CRITICAL")));
  // No bypass attempted => not blocked.
  assert.equal(checkBypass(false, () => true).blocked, false);
});

test("metrics derive verified/tested/blocked/unknown and the release gate", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const steps = [{ id: "CAV-23-02" }, { id: "CAV-23-03" }, { id: "CAV-BLOCKED-01" }, { id: "CAV-UNKNOWN-01" }];
  const BASE = {
    gitSha: "x",
    workerRunId: "r",
    gateType: "unit",
    tool: "node",
    command: "cmd",
    exitCode: 0,
  };
  await ledger.record("CAV-23-02", "VERIFIED", { ...BASE, role: "reviewer" });
  await ledger.record("CAV-23-03", "TESTED", { ...BASE, role: "implementer" });
  const m = deriveCavMetrics(steps, ledger, (id) => id === "CAV-BLOCKED-01");
  assert.equal(m.verified, 1);
  assert.equal(m.tested, 1);
  assert.equal(m.blocked, 1);
  assert.equal(m.unknown, 1);
  assert.equal(m.verifiedRatio, 0.25);
  assert.equal(m.phasePct, 25);
});
