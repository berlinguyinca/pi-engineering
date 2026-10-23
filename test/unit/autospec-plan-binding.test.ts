import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type DagIngestResult,
  ISSUE_REFS_EXTENSION,
  ingestAutoSpecDag,
} from "../../src/integrations/autospec/dagIngest.ts";
import { bindAutoSpecPlan } from "../../src/integrations/autospec/planBinding.ts";
import { MemoryPlanLedger, canonicalPlanText, planDigestOf } from "../../src/orchestration/planRecords.ts";
import { PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";

type Rec = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/autospec-dag/valid.json", import.meta.url), "utf8")) as {
  mission: Rec;
  tasks: Rec[];
};

function ingest(mutate?: (d: { mission: Rec; tasks: Rec[] }) => void): Extract<DagIngestResult, { ok: true }> {
  const d = structuredClone(fixture);
  d.mission.state = "PLANNED";
  d.tasks[1]!.executor = "pi-local";
  mutate?.(d);
  const r = ingestAutoSpecDag({ mission: d.mission, tasks: d.tasks });
  assert.equal(r.ok, true, !r.ok ? r.message : "");
  return r as Extract<DagIngestResult, { ok: true }>;
}
/** An auth-path surface makes the plan high risk: the default policy is `require`. */
const highRisk = (d: { tasks: Rec[] }) => (d.tasks[0]!.affected_surfaces = [{ path: "src/auth/login.ts" }]);

const approver = (calls: string[]): PlannotatorTransport => ({
  submitPlan: async (p) => {
    calls.push(p.planDigest ?? "");
    return { decision: "approved", externalDecisionId: `E${calls.length}`, planDigest: p.planDigest ?? "" };
  },
});

describe("AutoSpec plan -> T03 plan-review binding", () => {
  it("a rejected ingest never reaches the gate", async () => {
    const bad = ingestAutoSpecDag({ mission: fixture.mission, tasks: fixture.tasks });
    const ledger = new MemoryPlanLedger();
    const out = await bindAutoSpecPlan(bad, { ledger, planReviewConfigured: true });
    assert.equal(out.status, "rejected");
    assert.equal(ledger.listPlanRevisions("m-fixture-1").length, 0);
  });

  it("without plan review configured the plan is returned unreviewed, nothing recorded", async () => {
    const ledger = new MemoryPlanLedger();
    const ing = ingest(highRisk);
    const out = await bindAutoSpecPlan(ing, { ledger, planReviewConfigured: false });
    assert.equal(out.status, "unreviewed");
    assert.equal(out.status === "unreviewed" && out.planDigest, planDigestOf(canonicalPlanText(ing.goal, ing.tasks)));
    assert.equal(ledger.listPlanDecisions("m-fixture-1").length, 0);
    assert.equal(ledger.listPlanRevisions("m-fixture-1").length, 0);
  });

  it("a high-risk AutoSpec plan with `require` and no reviewer is blocked (no exemption)", async () => {
    const ledger = new MemoryPlanLedger();
    const out = await bindAutoSpecPlan(ingest(highRisk), { ledger, adapter: null, planReviewConfigured: true });
    assert.equal(out.status, "gated");
    if (out.status !== "gated") return;
    assert.equal(out.gate.status, "blocked");
    assert.equal(out.gate.status === "blocked" && out.gate.code, "plannotator_unavailable");
    assert.equal(out.gate.mode, "require");
    assert.equal(out.gate.riskClass === "high" || out.gate.riskClass === "critical", true);
  });

  it("an approval binds to the exact digest and the revision records the AutoSpec tasks", async () => {
    const ledger = new MemoryPlanLedger();
    const calls: string[] = [];
    const adapter = new PlannotatorAdapter({ transport: approver(calls) });
    const ing = ingest(highRisk);
    const out = await bindAutoSpecPlan(ing, { ledger, adapter, planReviewConfigured: true });
    assert.equal(out.status === "gated" && out.gate.status, "proceed");
    const digest = planDigestOf(canonicalPlanText(ing.goal, ing.tasks));
    assert.deepEqual(calls, [digest]);
    const rev = ledger.listPlanRevisions("m-fixture-1");
    assert.equal(rev.length, 1);
    assert.equal(rev[0]!.planDigest, digest);
    assert.deepEqual(
      rev[0]!.tasks.map((t) => t.task_id),
      ["t-1", "t-2"],
    );
    // Restart/replay: same plan, same digest -> no second review.
    const again = await bindAutoSpecPlan(ing, { ledger, adapter, planReviewConfigured: true });
    assert.equal(again.status === "gated" && again.gate.status, "proceed");
    assert.equal(calls.length, 1);
  });

  it("changing one edge or one issue ref after approval needs a fresh decision", async () => {
    const ledger = new MemoryPlanLedger();
    const calls: string[] = [];
    const adapter = new PlannotatorAdapter({ transport: approver(calls) });
    await bindAutoSpecPlan(ingest(highRisk), { ledger, adapter, planReviewConfigured: true });
    assert.equal(calls.length, 1);

    // One extra prerequisite edge.
    const edge = ingest((d) => {
      highRisk(d);
      d.tasks[0]!.depends_on = [];
      d.tasks[1]!.depends_on = ["t-1"];
      d.tasks.push({
        ...structuredClone(d.tasks[0]!),
        idempotency_key: "idem-t3",
        sequence: 3,
        task_id: "t-3",
        depends_on: ["t-1"],
        affected_surfaces: [{ path: "src/auth/session.ts" }],
      });
    });
    const o2 = await bindAutoSpecPlan(edge, { ledger, adapter, planReviewConfigured: true });
    assert.equal(o2.status === "gated" && o2.gate.status, "proceed");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0], calls[1]);

    // Same plan but a different issue ref.
    const withRef = (ref: string) =>
      ingest((d) => {
        highRisk(d);
        d.tasks[0]!.extensions = { [ISSUE_REFS_EXTENSION]: [ref] };
      });
    await bindAutoSpecPlan(withRef("berlinguyinca/autospec#1"), { ledger, adapter, planReviewConfigured: true });
    await bindAutoSpecPlan(withRef("berlinguyinca/autospec#2"), { ledger, adapter, planReviewConfigured: true });
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls).size, 4);
  });

  it("an approval for plan A does not let an edited plan B through when no reviewer answers", async () => {
    const ledger = new MemoryPlanLedger();
    const adapter = new PlannotatorAdapter({ transport: approver([]) });
    await bindAutoSpecPlan(ingest(highRisk), { ledger, adapter, planReviewConfigured: true });
    const edited = ingest((d) => {
      highRisk(d);
      d.tasks[1]!.depends_on = [];
    });
    const out = await bindAutoSpecPlan(edited, { ledger, adapter: null, planReviewConfigured: true });
    assert.equal(out.status === "gated" && out.gate.status, "blocked");
  });

  it("the configured policy decides: a medium-risk plan under default policy is only offered review", async () => {
    const ledger = new MemoryPlanLedger();
    const out = await bindAutoSpecPlan(ingest(), { ledger, adapter: null, planReviewConfigured: true });
    assert.equal(out.status === "gated" && out.gate.status, "proceed");
    assert.equal(out.status === "gated" && out.gate.mode, "offer");
    assert.equal(ledger.listPlanDecisions("m-fixture-1")[0]?.outcome, "skipped");
    // ...and a stricter configured policy applies to AutoSpec plans like any other.
    const strict = await bindAutoSpecPlan(ingest(), {
      ledger: new MemoryPlanLedger(),
      adapter: null,
      policy: { modes: { low: "require", medium: "require", high: "require", critical: "require" } },
      planReviewConfigured: true,
    });
    assert.equal(strict.status === "gated" && strict.gate.status, "blocked");
  });
});
