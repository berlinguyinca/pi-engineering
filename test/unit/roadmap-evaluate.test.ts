import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAll, evaluateMilestone } from "../../src/roadmap/evaluate.ts";
import type { EvidenceFreshness, FindingsBudget } from "../../src/roadmap/evaluate.ts";
import { RoadmapEvidenceStore } from "../../src/roadmap/evidence.ts";
import type { MilestoneDef, RoadmapDef, RoadmapEvidence } from "../../src/roadmap/types.ts";

function milestone(over: Partial<MilestoneDef> = {}): MilestoneDef {
  return {
    id: "M01",
    name: "Test Milestone",
    required: true,
    dependsOn: [],
    scope: { paths: ["src/"] },
    acceptance: [{ id: "M01-A1", description: "d", evidence: { required: [{ type: "unit", id: "e1" }] } }],
    verification: { requires: ["unit"] },
    ...over,
  };
}

function record(over: Partial<RoadmapEvidence> = {}): RoadmapEvidence {
  return {
    id: "M01:unit",
    milestone: "M01",
    type: "unit",
    status: "pass",
    commit: "abc",
    generatedAt: "",
    paths: ["src/"],
    proof: "node --test",
    source: "generated",
    ...over,
  };
}

const fresh: EvidenceFreshness = {
  isStale: async () => [],
  implementationExists: async () => true,
};
const stale: EvidenceFreshness = {
  isStale: async () => ["src/ledger.ts"],
  implementationExists: async () => true,
};
const noImpl: EvidenceFreshness = {
  isStale: async () => [],
  implementationExists: async () => false,
};

function budget(critical = 0, high = 0): FindingsBudget {
  return { critical, high };
}

async function evalM(m: MilestoneDef, records: RoadmapEvidence[], fr: EvidenceFreshness, findings: FindingsBudget) {
  const store = RoadmapEvidenceStore.inMemory();
  for (const r of records) await store.put(r);
  return evaluateMilestone(m, store, fr, new Map(), findings);
}

test("evaluate: implementation exists, no evidence -> IMPLEMENTED", async () => {
  const e = await evalM(milestone(), [], fresh, budget());
  assert.equal(e.state, "IMPLEMENTED");
  assert.ok(e.missingEvidence.includes("unit"));
});

test("evaluate: no implementation, no evidence -> NOT_STARTED", async () => {
  const e = await evalM(milestone(), [], noImpl, budget());
  assert.equal(e.state, "NOT_STARTED");
});

test("evaluate: passing + fresh evidence -> VERIFIED", async () => {
  const e = await evalM(milestone(), [record()], fresh, budget());
  assert.equal(e.state, "VERIFIED");
  assert.equal(e.blockers.length, 0);
});

test("evaluate: stale evidence -> NEEDS_REVERIFICATION", async () => {
  const e = await evalM(milestone(), [record()], stale, budget());
  assert.equal(e.state, "NEEDS_REVERIFICATION");
  assert.ok(e.staleEvidence.includes("unit"));
});

test("evaluate: no implementation -> not verified even with evidence", async () => {
  const e = await evalM(milestone(), [record()], noImpl, budget());
  assert.notEqual(e.state, "VERIFIED");
});

test("evaluate: failing evidence record -> not verified", async () => {
  const e = await evalM(milestone(), [record({ status: "fail" })], fresh, budget());
  assert.notEqual(e.state, "VERIFIED");
  assert.ok(e.missingEvidence.includes("unit"));
});

test("evaluate: unresolved findings block VERIFIED", async () => {
  const e = await evalM(milestone(), [record()], fresh, budget(1, 0));
  assert.notEqual(e.state, "VERIFIED");
  assert.ok(e.blockers.some((b) => b.includes("critical")));
});

test("evaluate: deferred milestone is DEFERRED", async () => {
  const m = milestone({ required: false, deferredReason: "later" });
  const e = await evalM(m, [], fresh, budget());
  assert.equal(e.state, "DEFERRED");
});

test("evaluate: dependency not verified blocks downstream", async () => {
  const a = milestone({ id: "M01" });
  const b = milestone({ id: "M02", dependsOn: ["M01"] });
  const roadmap: RoadmapDef = {
    roadmap: { id: "demo", version: "1.0", codename: "demo" },
    milestones: [a, b],
    release_gate: {
      require: {
        allRequiredMilestonesVerified: true,
        tests: { unit: "pass", integration: "pass" },
        typecheck: "pass",
        lint: "pass",
        packageLoad: "pass",
        freshReview: { unresolvedCritical: 0, unresolvedHigh: 0 },
      },
    },
    backlog: [],
    waivers: [],
  };
  const store = RoadmapEvidenceStore.inMemory();
  // only M02 has evidence; M01 (its dep) has none.
  await store.put(record({ id: "M02:unit", milestone: "M02" }));
  const results = await evaluateAll(roadmap, store, fresh, async () => budget());
  const bEval = results.get("M02");
  assert.ok(bEval);
  assert.notEqual(bEval.state, "VERIFIED");
  assert.ok(bEval.blockers.some((x) => x.includes("M01")));
});
