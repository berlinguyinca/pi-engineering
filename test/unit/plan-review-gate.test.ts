import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { PlanTaskInput } from "../../src/orchestration/orchestrator.ts";
import {
  MemoryPlanLedger,
  canonicalPlanText,
  planDigestOf,
  resolvePlanReviewPolicy,
} from "../../src/orchestration/planRecords.ts";
import { gatePlanBeforeWorkers } from "../../src/orchestration/planReview.ts";
import { FilePendingPlanStore, PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { EnvelopeDraft } from "../../src/runtime/herdr/envelope.ts";

const task = (objective: string, domains: string[] = ["src/auth/**"]): PlanTaskInput => ({
  kind: "agent",
  role: "implementer",
  objective,
  mutates_repo: true,
  write_domains: domains,
  isolation: "worktree",
  depends_on: [],
  priority: 0,
  execution_requirements: {},
  acceptance_ids: [],
  deliverables: ["implementation"],
  checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
  max_attempts: 3,
  failure_policy: "retry",
});
// High risk: auth path => default policy is `require`.
const HIGH = (n = "change login token handling") => [task(n)];
const LOW = () => [task("fix typo in readme", ["README.md"])];

type Reply = Awaited<ReturnType<PlannotatorTransport["submitPlan"]>>;
function transport(
  reply: (digest: string, n: number) => Reply | Promise<Reply>,
): PlannotatorTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    submitPlan: async (p) => {
      calls.push(p.planDigest ?? "");
      return reply(p.planDigest ?? "", calls.length);
    },
  };
}

describe("plan digest and policy", () => {
  it("digest is stable, order-insensitive for set fields, and sensitive to content", () => {
    const a = task("x", ["b/**", "a/**"]);
    const b = { ...task("x", ["a/**", "b/**"]) };
    assert.equal(planDigestOf(canonicalPlanText("g", [a])), planDigestOf(canonicalPlanText("g", [b])));
    assert.notEqual(
      planDigestOf(canonicalPlanText("g", [a])),
      planDigestOf(canonicalPlanText("g", [task("y", ["a/**", "b/**"])])),
    );
    assert.match(planDigestOf("x"), /^[0-9a-f]{64}$/);
  });

  it("risk-based defaults, policy table, and a reasoned override", () => {
    assert.equal(resolvePlanReviewPolicy("low").mode, "skip");
    assert.equal(resolvePlanReviewPolicy("medium").mode, "offer");
    assert.equal(resolvePlanReviewPolicy("critical").mode, "require");
    assert.equal(resolvePlanReviewPolicy("low", { modes: { low: "offer" } }).source, "policy");
    const ov = resolvePlanReviewPolicy("high", { override: { mode: "skip", reason: " hotfix ", operator: "ops" } });
    assert.deepEqual([ov.mode, ov.source, ov.overrideReason, ov.operator], ["skip", "override", "hotfix", "ops"]);
    assert.throws(() => resolvePlanReviewPolicy("high", { override: { mode: "skip", reason: "  " } }), /reason/);
  });
});

describe("gatePlanBeforeWorkers", () => {
  it("low risk skips review with a recorded reason and needs no adapter", async () => {
    const ledger = new MemoryPlanLedger();
    const r = await gatePlanBeforeWorkers({ missionId: "M1", goal: "g", plan: async () => LOW(), ledger });
    assert.equal(r.status, "proceed");
    assert.equal(r.mode, "skip");
    const [d] = ledger.listPlanDecisions("M1");
    assert.equal(d?.outcome, "skipped");
    assert.match(d!.reason, /risk default: skip/);
    assert.equal(ledger.listPlanRevisions("M1")[0]?.planDigest, d?.planDigest);
  });

  it("require + Plannotator unavailable blocks (fail closed)", async () => {
    const ledger = new MemoryPlanLedger();
    const r = await gatePlanBeforeWorkers({ missionId: "M2", goal: "g", plan: async () => HIGH(), ledger });
    assert.equal(r.status, "blocked");
    assert.equal(r.status === "blocked" && r.code, "plannotator_unavailable");
    assert.deepEqual(r.tasks, []);
    assert.match(r.reason, /failing closed|unavailable/);
    assert.equal(ledger.listPlanDecisions("M2")[0]?.proceed, false);
  });

  it("require + transport timeout blocks", async () => {
    const adapter = new PlannotatorAdapter({
      transport: { submitPlan: () => new Promise(() => {}) },
      decisionTimeoutMs: 20,
    });
    const r = await gatePlanBeforeWorkers({
      missionId: "M3",
      goal: "g",
      plan: async () => HIGH(),
      ledger: new MemoryPlanLedger(),
      adapter,
    });
    assert.equal(r.status, "blocked");
    assert.match(r.reason, /did not answer within 20ms/);
  });

  it("offer + unavailable proceeds with the skip recorded", async () => {
    const ledger = new MemoryPlanLedger();
    const r = await gatePlanBeforeWorkers({
      missionId: "M4",
      goal: "g",
      plan: async () => HIGH(),
      ledger,
      policy: { modes: { high: "offer" } },
      adapter: new PlannotatorAdapter({
        transport: { submitPlan: async () => Promise.reject(new Error("econnrefused")) },
      }),
    });
    assert.equal(r.status, "proceed");
    const d = ledger.listPlanDecisions("M4")[0]!;
    assert.equal(d.outcome, "skipped");
    assert.match(d.reason, /offer: review not obtained \(unavailable: econnrefused\)/);
  });

  it("approval is bound to the digest: a decision echoing another digest authorises nothing", async () => {
    const ledger = new MemoryPlanLedger();
    const t = transport(() => ({ decision: "approved", externalDecisionId: "E1", planDigest: "f".repeat(64) }));
    const r = await gatePlanBeforeWorkers({
      missionId: "M5",
      goal: "g",
      plan: async () => HIGH(),
      ledger,
      adapter: new PlannotatorAdapter({ transport: t }),
    });
    assert.equal(r.status, "blocked");
    assert.equal(r.status === "blocked" && r.code, "digest_mismatch");
    assert.equal(ledger.listPlanDecisions("M5")[0]?.outcome, "digest_mismatch");
  });

  it("approval of digest A never authorises digest B", async () => {
    const ledger = new MemoryPlanLedger();
    const store = new PlannotatorAdapter({
      transport: transport((d) => ({ decision: "approved", externalDecisionId: "E", planDigest: d })),
    });
    const a = await gatePlanBeforeWorkers({
      missionId: "M6",
      goal: "g",
      plan: async () => HIGH("plan A"),
      ledger,
      adapter: store,
    });
    assert.equal(a.status, "proceed");
    // Another plan for the same run, with an adapter that cannot reach Plannotator, must not inherit A's approval.
    const ledger2 = new MemoryPlanLedger();
    const b = await gatePlanBeforeWorkers({
      missionId: "M6",
      goal: "g",
      plan: async () => HIGH("plan B"),
      ledger: ledger2,
      adapter: store,
    });
    assert.equal(b.status, "proceed"); // fresh review of B happened (transport approves B itself)
    assert.notEqual(a.planDigest, b.planDigest);
    const adapter = new PlannotatorAdapter({ transport: null });
    assert.equal(adapter.decisionFor("M6", b.planDigest), undefined);
    const unavailable = await adapter.reviewPlan({
      runId: "M6",
      planRef: "p",
      goal: "g",
      riskClass: "high",
      planDigest: b.planDigest,
    });
    assert.equal(unavailable.outcome, "unavailable");
  });

  it("changes requested makes a new revision that needs a fresh decision", async () => {
    const ledger = new MemoryPlanLedger();
    const t = transport((digest, n) =>
      n === 1
        ? {
            decision: "annotated",
            externalDecisionId: "E1",
            annotations: ["split the auth change"],
            planDigest: digest,
          }
        : { decision: "approved", externalDecisionId: "E2", approvedBy: "ops", planDigest: digest },
    );
    const seen: string[][] = [];
    const r = await gatePlanBeforeWorkers({
      missionId: "M7",
      goal: "g",
      plan: async () => HIGH("v1"),
      replan: async (fb) => {
        seen.push(fb.annotations);
        return HIGH("v2 split");
      },
      ledger,
      adapter: new PlannotatorAdapter({ transport: t }),
    });
    assert.equal(r.status, "proceed");
    assert.equal(r.revision, 2);
    assert.deepEqual(seen, [["split the auth change"]]);
    const revs = ledger.listPlanRevisions("M7");
    assert.equal(revs.length, 2);
    assert.equal(revs[1]?.parentRevision, 1);
    assert.equal(revs[1]?.parentDigest, revs[0]?.planDigest);
    assert.notEqual(revs[0]?.planDigest, revs[1]?.planDigest);
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[0], revs[0]?.planDigest);
    assert.equal(t.calls[1], revs[1]?.planDigest);
    assert.deepEqual(
      ledger.listPlanDecisions("M7").map((d) => d.outcome),
      ["changes_requested", "approved"],
    );
  });

  it("changes requested without a replanner blocks; an unchanged replan blocks; rejection blocks", async () => {
    const annotated = (d: string) => ({ decision: "annotated" as const, externalDecisionId: "E", planDigest: d });
    const a = await gatePlanBeforeWorkers({
      missionId: "M8",
      goal: "g",
      plan: async () => HIGH(),
      ledger: new MemoryPlanLedger(),
      adapter: new PlannotatorAdapter({ transport: transport(annotated) }),
    });
    assert.equal(a.status === "blocked" && a.code, "changes_requested");
    const b = await gatePlanBeforeWorkers({
      missionId: "M9",
      goal: "g",
      plan: async () => HIGH(),
      replan: async () => HIGH(),
      ledger: new MemoryPlanLedger(),
      adapter: new PlannotatorAdapter({ transport: transport(annotated) }),
    });
    assert.equal(b.status === "blocked" && b.code, "replan_unchanged");
    const c = await gatePlanBeforeWorkers({
      missionId: "M10",
      goal: "g",
      plan: async () => HIGH(),
      ledger: new MemoryPlanLedger(),
      adapter: new PlannotatorAdapter({
        transport: transport((d) => ({ decision: "rejected", externalDecisionId: "E", planDigest: d })),
      }),
    });
    assert.equal(c.status === "blocked" && c.code, "plan_rejected");
  });

  it("stops after maxRevisions", async () => {
    let n = 0;
    const r = await gatePlanBeforeWorkers({
      missionId: "M11",
      goal: "g",
      plan: async () => HIGH("v0"),
      replan: async () => HIGH(`v${++n}`),
      maxRevisions: 2,
      ledger: new MemoryPlanLedger(),
      adapter: new PlannotatorAdapter({
        transport: transport((d) => ({ decision: "annotated", externalDecisionId: "E", planDigest: d })),
      }),
    });
    assert.equal(r.status === "blocked" && r.code, "max_revisions");
  });

  it("an explicit override is recorded with its reason, mode and operator", async () => {
    const ledger = new MemoryPlanLedger();
    const r = await gatePlanBeforeWorkers({
      missionId: "M12",
      goal: "g",
      plan: async () => HIGH(),
      ledger,
      policy: { override: { mode: "skip", reason: "production hotfix, reviewer offline", operator: "alice" } },
    });
    assert.equal(r.status, "proceed");
    const [p] = ledger.listPlanPolicies("M12");
    assert.equal(p?.source, "override");
    assert.equal(p?.defaultMode, "require");
    assert.equal(p?.mode, "skip");
    assert.equal(p?.overrideReason, "production hotfix, reviewer offline");
    assert.equal(p?.operator, "alice");
    assert.equal(ledger.listPlanDecisions("M12")[0]?.outcome, "skipped");
  });

  it("restart: the plan, a pending decision and the final decision all survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-plan-restart-"));
    const file = join(dir, "orchestration.jsonl");
    const pendingFile = join(dir, "pending-plans.jsonl");

    // Process 1: submit; the reviewer never answers (process "dies" mid-wait).
    let backend = await JsonlEventStore.open(file);
    let store = MissionStore.open(backend);
    const hang = new PlannotatorAdapter({
      store: new FilePendingPlanStore(pendingFile),
      transport: { submitPlan: () => new Promise(() => {}) },
      decisionTimeoutMs: 60_000,
    });
    let planCalls = 0;
    void gatePlanBeforeWorkers({
      missionId: "M13",
      goal: "g",
      plan: async () => {
        planCalls++;
        return HIGH();
      },
      ledger: store,
      adapter: hang,
    });
    await new Promise((r) => setTimeout(r, 50));
    await store.flush();
    backend.close();
    assert.equal(planCalls, 1);

    // Process 2: a fresh adapter on the same files sees the pending request and resumes it.
    backend = await JsonlEventStore.open(file);
    store = MissionStore.open(backend);
    const pending = new FilePendingPlanStore(pendingFile).all().filter((p) => p.state === "pending");
    assert.equal(pending.length, 1);
    const digest = store.listPlanRevisions("M13")[0]!.planDigest;
    assert.equal(pending[0]?.planDigest, digest);
    const submits: string[] = [];
    const resumed = new PlannotatorAdapter({
      store: new FilePendingPlanStore(pendingFile),
      transport: {
        submitPlan: async (p) => {
          submits.push(p.planDigest ?? "");
          return { decision: "rejected", externalDecisionId: "WRONG" };
        },
        fetchDecision: async (p) => ({
          decision: "approved",
          externalDecisionId: "E-OK",
          approvedBy: "ops",
          planDigest: p.planDigest,
        }),
      },
    });
    const r = await gatePlanBeforeWorkers({
      missionId: "M13",
      goal: "g",
      plan: async () => {
        planCalls++;
        return HIGH("DIFFERENT");
      },
      ledger: store,
      adapter: resumed,
    });
    assert.equal(r.status, "proceed");
    assert.equal(planCalls, 1, "the planner is not called again on restart");
    assert.equal(r.planDigest, digest);
    assert.deepEqual(submits, [], "resumed by fetching, not resubmitting");
    await store.flush();
    backend.close();

    // Process 3: the final decision is replayed without asking anyone.
    backend = await JsonlEventStore.open(file);
    store = MissionStore.open(backend);
    const again = await gatePlanBeforeWorkers({
      missionId: "M13",
      goal: "g",
      plan: async () => HIGH("X"),
      ledger: store,
    });
    assert.equal(again.status, "proceed");
    assert.equal(again.status === "proceed" && again.outcome, "approved");
    backend.close();
  });

  it("emits plan node, produced, supersession and reviewed(plan_digest) edges only when an emitter is configured", async () => {
    const drafts: EnvelopeDraft[] = [];
    const emitter = { stage: async (d: EnvelopeDraft) => void drafts.push(d) };
    const t = transport((d, n) =>
      n === 1
        ? { decision: "annotated", externalDecisionId: "E1", planDigest: d }
        : { decision: "approved", externalDecisionId: "E2", planDigest: d },
    );
    const ledger = new MemoryPlanLedger();
    await gatePlanBeforeWorkers({
      missionId: "M14",
      goal: "g",
      plan: async () => HIGH("v1"),
      replan: async () => HIGH("v2"),
      ledger,
      emitter,
      adapter: new PlannotatorAdapter({ transport: t }),
    });
    const nodes = drafts.filter(
      (d) => d.event_type === "node.upsert" && (d.payload as { node_type: string }).node_type === "plan",
    );
    assert.deepEqual(
      nodes.map((d) => d.entity_id),
      ["plan:M14/1", "plan:M14/2"],
    );
    const edges = drafts
      .filter((d) => d.event_type === "edge.add")
      .map((d) => d.payload as { edge_type: string; from_id: string; to_id: string; attrs: Record<string, string> });
    assert.ok(edges.some((e) => e.edge_type === "produced" && e.from_id === "mission:M14" && e.to_id === "plan:M14/2"));
    assert.ok(
      edges.some((e) => e.edge_type === "supersession" && e.from_id === "plan:M14/2" && e.to_id === "plan:M14/1"),
    );
    const reviewed = edges.filter((e) => e.edge_type === "reviewed");
    assert.equal(reviewed.length, 2);
    const revs = ledger.listPlanRevisions("M14");
    assert.equal(reviewed[1]?.attrs.plan_digest, revs[1]?.planDigest);
    assert.equal(reviewed[0]?.attrs.plan_digest, revs[0]?.planDigest);
    assert.ok(drafts.every((d) => d.entity_type === "lineage" && d.mission_id === "M14" && d.event_id));
    assert.equal(new Set(drafts.map((d) => d.event_id)).size, drafts.length, "event ids are unique");

    const none = new MemoryPlanLedger();
    await gatePlanBeforeWorkers({ missionId: "M15", goal: "g", plan: async () => LOW(), ledger: none });
    assert.equal(drafts.filter((d) => d.mission_id === "M15").length, 0);
  });

  it("an emitter that throws never blocks planning", async () => {
    const r = await gatePlanBeforeWorkers({
      missionId: "M16",
      goal: "g",
      plan: async () => LOW(),
      ledger: new MemoryPlanLedger(),
      emitter: { stage: async () => Promise.reject(new Error("disk full")) },
    });
    assert.equal(r.status, "proceed");
  });

  it("a changed submission under the same mission mints a new revision and needs a fresh decision", async () => {
    const ledger = new MemoryPlanLedger();
    const t = transport((d) => ({ decision: "approved", externalDecisionId: "E", planDigest: d }));
    const adapter = new PlannotatorAdapter({ transport: t });
    const first = await gatePlanBeforeWorkers({
      missionId: "M20",
      goal: "g",
      plan: async () => HIGH("v1"),
      current: HIGH("v1"),
      ledger,
      adapter,
    });
    assert.equal(first.revision, 1);
    const second = await gatePlanBeforeWorkers({
      missionId: "M20",
      goal: "g",
      plan: async () => HIGH("v1"),
      current: HIGH("totally different"),
      ledger,
      adapter,
    });
    assert.equal(second.status, "proceed");
    assert.equal(second.revision, 2);
    assert.notEqual(second.planDigest, first.planDigest);
    assert.equal(second.status === "proceed" && second.tasks[0]?.objective, "totally different");
    assert.equal(t.calls.length, 2, "the new plan was reviewed, not waved through on the first approval");
    assert.equal(ledger.listPlanRevisions("M20")[1]?.parentDigest, first.planDigest);
  });

  it("the digest covers every execution-relevant field and cannot collide on separators", () => {
    const d = (t: PlanTaskInput) => planDigestOf(canonicalPlanText("g", [t]));
    const base = task("x", ["a/**"]);
    assert.notEqual(d({ ...base, deliverables: ["a, b"] }), d({ ...base, deliverables: ["a", "b"] }));
    for (const change of [
      { isolation: "none" },
      { kind: "aggregation" },
      { max_attempts: 9 },
      { failure_policy: "fail" },
      { execution_requirements: { model: "m" } },
      { priority: 5 },
      { execution_budget_ms: 1000 },
      { context_ref: "other" },
    ]) {
      assert.notEqual(d({ ...base, ...(change as object) } as PlanTaskInput), d(base), JSON.stringify(change));
    }
    assert.equal(d({ ...base, write_domains: ["b/**", "a/**"] }), d({ ...base, write_domains: ["a/**", "b/**"] }));
  });

  it("a recorded skip does not satisfy a now-stricter policy; a recorded approval does", async () => {
    const ledger = new MemoryPlanLedger();
    const skipped = await gatePlanBeforeWorkers({
      missionId: "M21",
      goal: "g",
      plan: async () => HIGH(),
      ledger,
      policy: { override: { mode: "skip", reason: "hotfix" } },
    });
    assert.equal(skipped.status, "proceed");
    const now = await gatePlanBeforeWorkers({ missionId: "M21", goal: "g", plan: async () => HIGH(), ledger });
    assert.equal(now.status === "blocked" && now.code, "plannotator_unavailable", "default policy is require");

    const approvedLedger = new MemoryPlanLedger();
    const adapter = new PlannotatorAdapter({
      transport: transport((d) => ({ decision: "approved", externalDecisionId: "E", planDigest: d })),
    });
    await gatePlanBeforeWorkers({
      missionId: "M22",
      goal: "g",
      plan: async () => HIGH(),
      ledger: approvedLedger,
      adapter,
    });
    const stillOk = await gatePlanBeforeWorkers({
      missionId: "M22",
      goal: "g",
      plan: async () => HIGH(),
      ledger: approvedLedger,
      policy: { modes: { high: "require" } },
    });
    assert.equal(stillOk.status, "proceed");
  });

  it("an unidentified approver is recorded as null, and approvals need a digest echo when required", async () => {
    const adapter = new PlannotatorAdapter({
      operator: "someone-configured",
      transport: { submitPlan: async () => ({ decision: "approved", externalDecisionId: "E" }) },
    });
    const r = await adapter.reviewPlan({
      runId: "R",
      planRef: "p",
      goal: "g",
      riskClass: "high",
      planDigest: "a".repeat(64),
    });
    assert.equal(r.outcome, "approved");
    assert.equal(r.decision.approvedBy, null);

    const strict = new PlannotatorAdapter({
      requireDigestEcho: true,
      transport: { submitPlan: async () => ({ decision: "approved", externalDecisionId: "E" }) },
    });
    const bad = await strict.reviewPlan({
      runId: "R2",
      planRef: "p",
      goal: "g",
      riskClass: "high",
      planDigest: "a".repeat(64),
    });
    assert.equal(bad.outcome, "digest_mismatch");
    assert.match(bad.reason, /did not echo/);
    const empty = new PlannotatorAdapter({
      requireDigestEcho: true,
      transport: { submitPlan: async () => ({ decision: "approved", externalDecisionId: "E", planDigest: "" }) },
    });
    assert.equal(
      (await empty.reviewPlan({ runId: "R3", planRef: "p", goal: "g", riskClass: "high", planDigest: "a".repeat(64) }))
        .outcome,
      "digest_mismatch",
    );
  });
});
