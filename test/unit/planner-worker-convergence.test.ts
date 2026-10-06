import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskContract } from "../../src/plannerWorker/contract.ts";
import {
  ConvergenceTracker,
  assessProgress,
  nextLadderAction,
  observeAttempt,
} from "../../src/plannerWorker/convergence.ts";
import type { CatalogModel } from "../../src/plannerWorker/gateway.ts";
import { DEFAULT_ROLE_CONFIG, mustDifferFrom, resolveRole } from "../../src/plannerWorker/roles.ts";
import { DEFAULT_ESCALATION_LADDER, type TaskContract, type VerificationRun } from "../../src/plannerWorker/types.ts";

function contract(objective = "do x"): TaskContract {
  const r = parseTaskContract({
    task_id: "t1",
    objective,
    scope: { allowed: ["src/**"] },
    acceptance: ["ok"],
    verification: ["npm test", "npm run lint"],
  });
  assert.ok(r.ok);
  return r.contract;
}

function ver(passed: boolean[], tail = "FAIL foo.test at 12ms"): VerificationRun[] {
  return passed.map((p, i) => ({
    command: `cmd${i}`,
    exit_code: p ? 0 : 1,
    passed: p,
    output_tail: p ? "" : tail,
    duration_ms: 5,
  }));
}

test("identical failures, repeated findings and an unchanged diff stall the local loop", () => {
  const tracker = new ConvergenceTracker({ stall_after: 2 });
  const c = contract();
  const verdict = {
    status: "needs_fix" as const,
    issues: [{ severity: "major" as const, summary: "Token not rotated" }],
    required_changes: [],
    contract_violation: false,
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    tracker.record(
      "t1",
      observeAttempt({
        attempt,
        contract: c,
        // Timing noise must not make identical failures look different.
        verification: ver([true, false], `FAIL foo.test at ${attempt * 7}ms`),
        verdict,
        diff: "+same",
        changedFiles: ["src/a.ts"],
      }),
    );
    if (attempt < 3) assert.equal(tracker.stalled("t1"), null);
  }
  const stalled = tracker.stalled("t1");
  assert.ok(stalled);
  assert.equal(stalled.type, "LOCAL_LOOP_STALLED");
  assert.equal(stalled.attempts, 3);
  for (const reason of ["identical failure", "repeated findings", "no test progress", "diff unchanged"]) {
    assert.ok(stalled.reasons.includes(reason), `missing ${reason} in ${stalled.reasons.join(",")}`);
  }
});

test("test progress or a changed contract counts as progress", () => {
  const c = contract();
  const a = observeAttempt({
    attempt: 1,
    contract: c,
    verification: ver([false, false]),
    verdict: null,
    diff: "a",
    changedFiles: ["x"],
  });
  const b = observeAttempt({
    attempt: 2,
    contract: c,
    verification: ver([true, false]),
    verdict: null,
    diff: "b",
    changedFiles: ["x"],
  });
  assert.equal(assessProgress(a, b).progressed, true);
  const c2 = observeAttempt({
    attempt: 3,
    contract: contract("do y"),
    verification: ver([false, false]),
    verdict: null,
    diff: "a",
    changedFiles: ["x"],
  });
  assert.equal(assessProgress(b, c2).progressed, true);
  const churn = observeAttempt({
    attempt: 3,
    contract: c,
    verification: ver([true, false]),
    verdict: null,
    diff: "c",
    changedFiles: ["x"],
  });
  const r = assessProgress(b, churn);
  assert.equal(r.progressed, false);
  assert.ok(r.reasons.includes("same files rewritten"));
});

test("escalation ladder: local retries, then diagnosis, then frontier escalation, then failure", () => {
  const ladder = DEFAULT_ESCALATION_LADDER;
  const base = { stalled: false, reviewerAskedEscalation: false, ladder, escalationAvailable: true };
  assert.deepEqual(nextLadderAction({ ...base, rung: "local", attemptsOnRung: 1 }), { kind: "retry", rung: "local" });
  assert.deepEqual(nextLadderAction({ ...base, rung: "local", attemptsOnRung: 2 }), { kind: "diagnose" });
  assert.deepEqual(nextLadderAction({ ...base, rung: "local", attemptsOnRung: 1, stalled: true }), {
    kind: "diagnose",
  });
  assert.deepEqual(nextLadderAction({ ...base, rung: "diagnosed", attemptsOnRung: 1 }), { kind: "escalate" });
  assert.deepEqual(nextLadderAction({ ...base, rung: "escalated", attemptsOnRung: 1 }), {
    kind: "fail",
    reason: "escalation attempts exhausted",
  });
  assert.deepEqual(nextLadderAction({ ...base, rung: "local", attemptsOnRung: 1, reviewerAskedEscalation: true }), {
    kind: "escalate",
  });
  assert.equal(
    nextLadderAction({ ...base, rung: "diagnosed", attemptsOnRung: 1, escalationAvailable: false }).kind,
    "fail",
  );
});

const catalog: CatalogModel[] = [
  {
    id: "alpha-fast-q4",
    alias: false,
    aliases: [],
    capabilities: ["coding.planning", "coding.review", "coding.implementation"],
    modalities: [],
    family: "fastfam",
    contextWindow: 128_000,
    state: "hot",
  },
  {
    id: "beta-big-q8",
    alias: false,
    aliases: [],
    capabilities: ["coding.implementation"],
    modalities: [],
    family: "bigfam",
    contextWindow: 256_000,
    state: "hot",
  },
];

test("roles resolve by capability and preferred family, and planner/implementer differ when alternatives exist", async () => {
  const config = {
    ...DEFAULT_ROLE_CONFIG,
    planner: { capability: "coding.planning", preferred_family: "fastfam" },
    implementer: { capability: "coding.implementation", preferred_family: "fastfam" },
  };
  const planner = await resolveRole("planner", { catalog, config, provider: "gw" });
  assert.equal(planner?.model.id, "alpha-fast-q4");
  // The implementer prefers the same family, but must differ from the planner.
  const implementer = await resolveRole("implementer", { catalog, config, provider: "gw", avoid: ["alpha-fast-q4"] });
  assert.equal(implementer?.model.id, "beta-big-q8");
  assert.deepEqual(implementer?.model, { provider: "gw", id: "beta-big-q8" });
  // With a single model there is no alternative: same model, with a note.
  const single = await resolveRole("implementer", {
    catalog: [catalog[0]!],
    config,
    provider: "gw",
    avoid: ["alpha-fast-q4"],
  });
  assert.equal(single?.model.id, "alpha-fast-q4");
  assert.match(single?.notes.join(" ") ?? "", /no model distinct/);
  assert.ok(mustDifferFrom("implementer").includes("planner"));
});

test("a logical alias wins; unavailable aliases and plain gateways fall back to static routing", async () => {
  const withAlias: CatalogModel[] = [
    ...catalog,
    {
      id: "coding-implementation",
      alias: true,
      backing: "beta-big-q8",
      aliases: [],
      capabilities: [],
      modalities: [],
      contextWindow: 256_000,
      routeGeneration: 3,
    },
  ];
  const viaAlias = await resolveRole("implementer", {
    catalog: withAlias,
    config: DEFAULT_ROLE_CONFIG,
    provider: "gw",
  });
  assert.equal(viaAlias?.via, "alias");
  assert.equal(viaAlias?.model.id, "coding-implementation");
  assert.equal(viaAlias?.backing, "beta-big-q8");

  const plain: CatalogModel[] = [{ id: "whatever", alias: false, aliases: [], capabilities: [], modalities: [] }];
  const seen: string[] = [];
  const fallback = async (role: string) => {
    seen.push(role);
    return { provider: "pinned", id: "pinned-model" };
  };
  const viaStatic = await resolveRole("reviewer", {
    catalog: plain,
    config: DEFAULT_ROLE_CONFIG,
    provider: "gw",
    fallback,
  });
  assert.equal(viaStatic?.via, "static");
  assert.deepEqual(viaStatic?.model, { provider: "pinned", id: "pinned-model" });
  assert.deepEqual(seen, ["reviewer"]);
  assert.equal(await resolveRole("reviewer", { catalog: plain, config: DEFAULT_ROLE_CONFIG, provider: "gw" }), null);

  const draining = withAlias.map((m) => (m.id === "coding-implementation" ? { ...m, state: "draining" } : m));
  const drained = await resolveRole("implementer", { catalog: draining, config: DEFAULT_ROLE_CONFIG, provider: "gw" });
  assert.notEqual(drained?.via, "alias");
});

test("a capability-speaking gateway with no listed serving model is asked with a cap: query", async () => {
  const listed: CatalogModel[] = [
    { id: "flash", alias: false, aliases: [], capabilities: ["coding.planning"], modalities: [], state: "hot" },
  ];
  const config = {
    ...DEFAULT_ROLE_CONFIG,
    implementer: { capability: "coding.implementation", preferred_family: "qwen-27b", min_context: 128000 },
  };
  const r = await resolveRole("implementer", { catalog: listed, config, provider: "iw" });
  assert.equal(r?.via, "query");
  assert.equal(r?.model.id, "cap:coding.implementation?minimum_context=128000&family=qwen-27b");
  // Once the gateway refused the query, static routing takes over.
  const fallback = async () => ({ provider: "pinned", id: "p" });
  const after = await resolveRole("implementer", {
    catalog: listed,
    config,
    provider: "iw",
    exclude: [r!.model.id],
    fallback,
  });
  assert.equal(after?.via, "static");
});
