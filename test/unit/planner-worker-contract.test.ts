import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dagLayers,
  matchesScope,
  parsePlannerOutput,
  parseTaskContract,
  readyContracts,
  scopeConflict,
  validateContractDag,
} from "../../src/plannerWorker/contract.ts";
import { assertTransition, canTransition, isTerminal } from "../../src/plannerWorker/stateMachine.ts";
import type { TaskContract } from "../../src/plannerWorker/types.ts";

function raw(id: string, deps: string[] = [], allowed: string[] = [`src/${id}/**`]): Record<string, unknown> {
  return {
    task_id: id,
    objective: `implement ${id}`,
    depends_on: deps,
    scope: { allowed },
    acceptance: [`${id} works`],
    verification: ["node --version"],
    constraints: ["do not touch unrelated files"],
    risk: "medium",
  };
}

function contract(id: string, deps: string[] = [], allowed?: string[]): TaskContract {
  const r = parseTaskContract(raw(id, deps, allowed));
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r.contract;
}

test("parseTaskContract accepts the spec example shape and fills defaults", () => {
  const r = parseTaskContract({
    task_id: "auth-003",
    objective: "Implement refresh-token rotation.",
    depends_on: ["auth-001", "auth-002"],
    scope: { allowed: ["src/auth/**", "tests/auth/**"] },
    acceptance: ["refresh tokens are validated", "expired tokens are rejected"],
    verification: ["cargo test auth", "cargo clippy"],
    constraints: ["do not redesign authentication"],
  });
  assert.ok(r.ok);
  assert.equal(r.contract.risk, "medium");
  assert.deepEqual(r.contract.scope.forbidden, []);
  assert.deepEqual(r.contract.relevant_files, []);
});

test("parseTaskContract rejects unsafe or unbounded scope globs", () => {
  for (const bad of ["/etc/**", "../outside/**", "**", "*", ".", "", "src\\win", "src/ space/**"]) {
    const r = parseTaskContract(raw("t1", [], [bad]));
    assert.equal(r.ok, false, `scope ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(parseTaskContract(raw("t1", [], [])).ok, false, "empty allowed scope is rejected");
});

test("parseTaskContract rejects missing objective, bad ids, self-dependency and bad risk", () => {
  assert.equal(parseTaskContract({ ...raw("t1"), objective: "  " }).ok, false);
  assert.equal(parseTaskContract({ ...raw("t1"), task_id: "has space" }).ok, false);
  assert.equal(parseTaskContract(raw("t1", ["t1"])).ok, false);
  assert.equal(parseTaskContract({ ...raw("t1"), risk: "extreme" }).ok, false);
  assert.equal(parseTaskContract({ ...raw("t1"), acceptance: [] }).ok, false);
  assert.equal(parseTaskContract("not an object").ok, false);
});

test("validateContractDag rejects cycles, duplicates and unknown dependencies", () => {
  const cyc = validateContractDag([contract("a", ["c"]), contract("b", ["a"]), contract("c", ["b"])]);
  assert.equal(cyc.ok, false);
  assert.match(cyc.errors.join(" "), /cycle/);
  assert.match(cyc.errors.join(" "), /a -> c -> b -> a|a.*c.*b/);

  const dup = validateContractDag([contract("a"), contract("a")]);
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(" "), /duplicate/);

  const unknown = validateContractDag([contract("a", ["ghost"])]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(" "), /unknown/);

  assert.equal(validateContractDag([]).ok, false, "an empty plan is not a plan");
  assert.equal(validateContractDag([contract("a"), contract("b", ["a"])]).ok, true);
});

test("dagLayers groups independent contracts for parallel execution", () => {
  const layers = dagLayers([
    contract("plan"),
    contract("db", ["plan"]),
    contract("api", ["plan"]),
    contract("tests", ["plan"]),
    contract("integration", ["db", "api", "tests"]),
  ]);
  assert.deepEqual(
    layers.map((l) => l.map((c) => c.task_id).sort()),
    [["plan"], ["api", "db", "tests"], ["integration"]],
  );
});

test("readyContracts returns contracts whose dependencies all passed", () => {
  const cs = [contract("a"), contract("b", ["a"]), contract("c", ["a", "b"])];
  assert.deepEqual(
    readyContracts(cs, new Set()).map((c) => c.task_id),
    ["a"],
  );
  assert.deepEqual(
    readyContracts(cs, new Set(["a"])).map((c) => c.task_id),
    ["b"],
  );
});

test("matchesScope honours allowed and forbidden globs", () => {
  const scope = { allowed: ["src/auth/**", "tests/auth/*.test.ts"], forbidden: ["src/auth/legacy/**"] };
  assert.equal(matchesScope("src/auth/token.ts", scope), true);
  assert.equal(matchesScope("src/auth/deep/nested/x.ts", scope), true);
  assert.equal(matchesScope("tests/auth/a.test.ts", scope), true);
  assert.equal(matchesScope("tests/auth/sub/a.test.ts", scope), false);
  assert.equal(matchesScope("src/auth/legacy/old.ts", scope), false);
  assert.equal(matchesScope("src/other.ts", scope), false);
});

test("scopeConflict detects overlapping write scopes", () => {
  assert.equal(scopeConflict(contract("a", [], ["src/a/**"]), contract("b", [], ["src/b/**"])), false);
  assert.equal(scopeConflict(contract("a", [], ["src/**"]), contract("b", [], ["src/b/x.ts"])), true);
  assert.equal(scopeConflict(contract("a", [], ["src/*.ts"]), contract("b", [], ["src/x.ts"])), true);
});

test("parsePlannerOutput accepts JSON or YAML and validates the DAG", () => {
  const json = JSON.stringify({ contracts: [raw("a"), raw("b", ["a"])], decisions: ["reuse X"] });
  const ok = parsePlannerOutput(`Here is the plan:\n\`\`\`json\n${json}\n\`\`\``);
  assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));
  assert.equal(ok.plan.contracts.length, 2);
  assert.deepEqual(ok.plan.decisions, ["reuse X"]);

  const yaml =
    "contracts:\n  - task_id: a\n    objective: do a\n    scope:\n      allowed: [src/a/**]\n    acceptance: [a ok]\n    verification: [true]\n";
  const y = parsePlannerOutput(yaml);
  assert.ok(y.ok, y.ok ? "" : y.errors.join("; "));

  const cyclic = parsePlannerOutput({ contracts: [raw("a", ["b"]), raw("b", ["a"])] });
  assert.equal(cyclic.ok, false);
  assert.equal(parsePlannerOutput("no structure here").ok, false);
});

test("task state machine allows the documented lifecycle and rejects illegal moves", () => {
  assert.ok(canTransition("pending", "ready"));
  assert.ok(canTransition("ready", "running"));
  assert.ok(canTransition("running", "reviewing"));
  assert.ok(canTransition("reviewing", "needs_fix"));
  assert.ok(canTransition("needs_fix", "running"));
  assert.ok(canTransition("reviewing", "passed"));
  assert.ok(canTransition("running", "blocked"));
  assert.ok(canTransition("blocked", "pending"));
  assert.ok(canTransition("needs_fix", "escalated"));
  assert.ok(canTransition("escalated", "running"));
  assert.equal(canTransition("pending", "running"), false);
  assert.equal(canTransition("passed", "running"), false);
  assert.equal(canTransition("failed", "ready"), false);
  assert.throws(() => assertTransition("ready", "passed"), /illegal contract transition ready -> passed/);
  assert.ok(isTerminal("passed"));
  assert.ok(isTerminal("failed"));
  assert.equal(isTerminal("escalated"), false);
});
