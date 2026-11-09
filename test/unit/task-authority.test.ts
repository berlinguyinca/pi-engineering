import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePlannerContractHash, deriveTaskAuthority, verifyAuthority } from "../../src/bootstrap/taskAuthority.ts";

const SOURCE = {
  goal: "  Persist canonical original task identity  ",
  scope: [" src/bootstrap/taskAuthority.ts ", "test/unit/task-authority.test.ts", "src/bootstrap/taskAuthority.ts"],
  nonGoals: [" no fs", "no network"],
  tests: ["test/unit/task-authority.test.ts"],
};
const accept = (source: unknown): string => {
  const r = deriveTaskAuthority(source);
  assert.equal(r.ok, true, JSON.stringify((r as { reasons?: string[] }).reasons));
  return (r as { authorityHash: string }).authorityHash;
};
const refuse = (source: unknown): string[] => {
  const r = deriveTaskAuthority(source);
  assert.equal(r.ok, false, "expected refusal");
  return (r as { reasons: string[] }).reasons;
};
const BASE = accept(SOURCE);

test("T01 regression: modifying planner output — restating goal/scope/nonGoals/tests with different content — cannot move the authority hash", () => {
  const planner = {
    goal: "Ship the planner's own task",
    scope: ["src/**"],
    nonGoals: ["no limits"],
    tests: ["nothing"],
    plan: "replan",
    tasks: ["do it"],
  };
  const verdict = verifyAuthority(BASE, { source: SOURCE, plannerOutput: planner });
  assert.equal(
    verdict.authorityHash,
    BASE,
    "authority recomputes from the frozen operator source, unmoved by the planner",
  );
  assert.equal(verdict.ok, true, "a matching authority stays valid however the planner drifts");
  assert.deepEqual(
    verdict.diverged,
    ["goal", "scope", "nonGoals", "tests"],
    "drift is named exactly, so it stays visible",
  );
  assert.deepEqual(verifyAuthority(BASE, { source: SOURCE }).diverged, [], "no planner output means no reported drift");
  assert.deepEqual(
    verifyAuthority(BASE, { source: SOURCE, plannerOutput: { plan: "replan", tasks: ["do it"], restatement: planner } })
      .diverged,
    verdict.diverged,
    "a restatement nested under plannerOutput.restatement names the same drift as the top level",
  );
  assert.notEqual(
    derivePlannerContractHash({ plan: "replan", tasks: ["do it"], restatement: planner }),
    derivePlannerContractHash({ plan: "replan", tasks: ["do it"] }),
    "the planner artifact is recorded, not ignored",
  );
  const hijack = verifyAuthority(BASE, {
    source: {},
    plannerOutput: { goal: SOURCE.goal, scope: SOURCE.scope, nonGoals: SOURCE.nonGoals, tests: SOURCE.tests },
  });
  assert.equal(hijack.ok, false);
  assert.equal(hijack.authorityHash, null, "planner output is never substituted for the frozen source");
});
test("T01: changing any one of goal/scope/nonGoals/tests by one item changes the authority hash", () => {
  for (const [patched, label] of [
    [{ ...SOURCE, goal: "Persist canonical original task identities" }, "goal"],
    [{ ...SOURCE, scope: [...SOURCE.scope, "src/other.ts"] }, "scope"],
    [{ ...SOURCE, nonGoals: [...SOURCE.nonGoals, "no ui"] }, "nonGoals"],
    [{ ...SOURCE, tests: [...SOURCE.tests, "test/unit/other.test.ts"] }, "tests"],
  ] as const) {
    assert.notEqual(accept(patched), BASE, `${label} is authority-bearing`);
  }
  assert.match(BASE, /^sha256:[0-9a-f]{64}$/u, "same hash form as the gate prints");
});
test("T01: authority and planner-contract digests differ for identical words; whitespace and duplicates canonicalize away; order is meaning-bearing", () => {
  const words = { goal: "hash me", scope: ["a"], nonGoals: ["b"], tests: ["c"] };
  assert.notEqual(
    accept(words),
    derivePlannerContractHash({ plan: "hash me", tasks: ["a", "b", "c"], restatement: words }),
  );
  assert.equal(
    accept({
      goal: "Persist canonical original task identity",
      scope: ["src/bootstrap/taskAuthority.ts", "test/unit/task-authority.test.ts"],
      nonGoals: ["no fs", "no network"],
      tests: ["test/unit/task-authority.test.ts"],
    }),
    BASE,
    "trim and first-occurrence dedup carry no hash weight",
  );
  assert.notEqual(
    accept({
      ...SOURCE,
      scope: ["test/unit/task-authority.test.ts", "src/bootstrap/taskAuthority.ts", "test/unit/task-authority.test.ts"],
    }),
    BASE,
    "a scope list is a contract, not a set",
  );
});
test("T01: malformed sources are refused with stable reasons, never a placeholder", () => {
  assert.deepEqual(refuse({ ...SOURCE, scope: ["ok", 7] }), ["scope: member 1 is not a string"]);
  assert.deepEqual(refuse({ ...SOURCE, goal: "   " }), ["goal: empty after trimming"]);
  assert.deepEqual(refuse({ ...SOURCE, tests: ["", "  "] }), ["tests: empty after canonicalization"]);
  assert.deepEqual(refuse({ ...SOURCE, nonGoals: "no fs" }), ["nonGoals: expected an array of strings"]);
  assert.deepEqual(refuse({ ...SOURCE, origin: "planner" }), [
    'origin: planner-authored content cannot define task authority, expected "operator"',
  ]);
  assert.deepEqual(refuse("the model rewrote it"), ["source: expected an operator-authored task object"]);
});
test("T01: derive and verify are pure — the operator's object is byte-identical afterwards", () => {
  const before = JSON.stringify(SOURCE);
  accept(SOURCE);
  verifyAuthority(BASE, { source: SOURCE, plannerOutput: { goal: "x", scope: ["y"] } });
  derivePlannerContractHash({ plan: " p ", tasks: [" a ", "a", ""], restatement: { goal: "x" } });
  assert.equal(JSON.stringify(SOURCE), before, "no input mutation");
  assert.equal(accept(SOURCE), BASE, "identical input re-derives identically");
});
