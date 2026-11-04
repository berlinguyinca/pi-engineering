import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { MAX_PLAN_STEPS } from "../../src/ledger/Ledger.ts";
import { Ledger, LedgerAuthorityStaleError, LedgerRevisionConflictError } from "../../src/ledger/Ledger.ts";
import type { EnvelopeDraft } from "../../src/runtime/herdr/envelope.ts";
import { formatTaskGraph, parseNeighborhood } from "../../src/runtime/herdr/graphClient.ts";
import { LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { LedgerTransitions } from "../../src/runtime/ledgerTransitions.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { emitWorkTaskLineage } from "../../src/work/taskLineage.ts";
import { ledgerTaskRefs } from "../../src/work/taskRefs.ts";

const actor = { type: "system" as const };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pi-eng-plan-"));
  dirs.push(d);
  return join(d, "ledger.jsonl");
};
const PR = { host: "github.com", owner: "acme", repo: "w", number: 7 };

async function planned(f: string) {
  const ledger = await Ledger.create(f);
  const wi = await ledger.createWorkItem("goal", "low", ["."], actor);
  const t1 = await ledger.createTask(wi.id, "first", "implementation", "low", actor);
  const t2 = await ledger.createTask(wi.id, "second", "test", "low", actor);
  const steps = [t1, t2].map((t) => ({ task_id: t.id, title: t.title }));
  return { ledger, wi, t1, t2, steps };
}
const edges = (d: EnvelopeDraft[]) => d.filter((x) => x.event_type === "edge.add").map((x) => x.payload as any);
const project = (ledger: Ledger) => {
  const drafts: EnvelopeDraft[] = [];
  const lineage = new LineageEmitter({ sink: { stage: async (d) => void drafts.push(d) }, source: "t" });
  const graph = new LedgerWorkProjection(ledger, { now: () => Date.now(), staleAfterMs: 3_600_000 }).graph();
  emitWorkTaskLineage(lineage, graph, new Map(), ledgerTaskRefs(ledger));
  return drafts;
};

describe("plan.recorded", () => {
  it("records, replays and projects plan edges for tasks and the plan work item", async () => {
    const f = file();
    const { ledger, wi, t1, t2, steps } = await planned(f);
    const plan = await ledger.recordPlan(wi.id, { steps, artifact: { id: "art", version: "v1" } }, actor);
    assert.equal(plan?.id, `${wi.id}/1`);
    assert.deepEqual(plan?.steps, steps);
    const replay = await Ledger.create(f);
    assert.deepEqual(replay.listPlans(wi.id), ledger.listPlans(wi.id));
    assert.equal(replay.planFor(t2.id)?.id, `${wi.id}/1`);
    const e = edges(project(replay));
    for (const from of [`task:${t1.id}`, `task:${t2.id}`, `task:${wi.id}`]) {
      const dep = e.find((x) => x.edge_type === "dependency" && x.from_id === from);
      assert.equal(dep?.to_id, `plan:${wi.id}/1`);
      assert.equal(dep.attrs.plan_artifact_id, "art");
    }
  });

  it("is idempotent: the same steps write nothing, even across a reopen", async () => {
    const f = file();
    const { ledger, wi, steps } = await planned(f);
    await ledger.recordPlan(wi.id, { steps }, actor);
    await ledger.recordPlan(wi.id, { steps }, actor);
    await (await Ledger.create(f)).recordPlan(wi.id, { steps }, actor);
    assert.equal(
      readFileSync(f, "utf-8")
        .split("\n")
        .filter((l) => l.includes("plan.recorded")).length,
      1,
    );
  });

  it("a changed plan supersedes the old revision and emits a supersession edge", async () => {
    const { ledger, wi, t1, steps } = await planned(file());
    await ledger.recordPlan(wi.id, { steps }, actor);
    const second = await ledger.recordPlan(wi.id, { steps: [steps[0]!] }, actor);
    assert.equal(second?.supersedes, `${wi.id}/1`);
    assert.equal(ledger.listPlans(wi.id)[0]?.superseded_by, `${wi.id}/2`);
    const e = edges(project(ledger));
    assert.equal(
      e.find((x) => x.edge_type === "dependency" && x.from_id === `task:${t1.id}`)?.to_id,
      `plan:${wi.id}/2`,
    );
    const sup = e.find((x) => x.edge_type === "supersession");
    assert.deepEqual([sup.from_id, sup.to_id], [`plan:${wi.id}/2`, `plan:${wi.id}/1`]);
  });

  it("bounds steps and titles, and ignores unknown work items and empty plans", async () => {
    const { ledger, wi } = await planned(file());
    const many = Array.from({ length: MAX_PLAN_STEPS + 20 }, (_, i) => ({ task_id: `t${i}`, title: "x".repeat(500) }));
    const plan = await ledger.recordPlan(wi.id, { steps: many }, actor);
    assert.equal(plan?.steps.length, MAX_PLAN_STEPS);
    assert.equal(plan?.total_steps, MAX_PLAN_STEPS + 20);
    assert.equal(plan?.steps[0]?.title.length, 120);
    assert.equal(await ledger.recordPlan("WI-nope", { steps: many }, actor), undefined);
    assert.equal(await ledger.recordPlan(wi.id, { steps: [] }, actor), undefined);
  });

  it("a log without plan events replays unchanged and a malformed event is ignored", async () => {
    const f = file();
    const { ledger, wi, t1 } = await planned(f);
    const before = JSON.stringify(ledger.getWorkItem(wi.id));
    await ledger.emitEvent("plan.recorded", wi.id, actor, { plan_id: "x", revision: "no" });
    const replay = await Ledger.create(f);
    assert.deepEqual(replay.listPlans(wi.id), []);
    assert.equal(replay.planFor(t1.id), undefined);
    assert.equal(JSON.stringify(replay.getWorkItem(wi.id)), before);
    assert.deepEqual(
      edges(project(replay)).filter((x) => x.edge_type === "dependency"),
      [],
    );
  });

  it("rejects a stale revision guard and a stale authority generation, writing nothing", async () => {
    const { ledger, wi, steps } = await planned(file());
    await assert.rejects(
      ledger.recordPlan(wi.id, { steps }, actor, { guard: { expected_revision: ledger.revision(wi.id) - 1 } }),
      LedgerRevisionConflictError,
    );
    await ledger.updateWorkItem(wi.id, { goal: "g" }, actor, { authority_generation: 5 });
    await assert.rejects(
      ledger.recordPlan(wi.id, { steps }, actor, { authority_generation: 4 }),
      LedgerAuthorityStaleError,
    );
    assert.deepEqual(ledger.listPlans(wi.id), []);
    const ok = await ledger.recordPlan(wi.id, { steps }, actor, {
      guard: { expected_revision: ledger.revision(wi.id) },
      authority_generation: 5,
    });
    assert.equal(ok?.revision, 1);
  });

  it("is written through the guarded transition API", async () => {
    const { ledger, wi, steps } = await planned(file());
    const tr = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: false });
    assert.equal((await tr.recordPlan(wi.id, steps, actor))?.revision, 1);
    assert.equal(ledger.listPlans(wi.id).length, 1);
  });

  it("a PR linked to the work item reaches the task as a pr edge, and the Herdr read-back shows both", async () => {
    const { ledger, wi, steps } = await planned(file());
    await ledger.recordPlan(wi.id, { steps }, actor);
    await ledger.recordPrLink(wi.id, PR, actor);
    const drafts = project(ledger);
    const e = edges(drafts);
    assert.ok(
      e.some(
        (x) => x.edge_type === "issue_link" && x.from_id === `task:${wi.id}` && x.to_id === "pr:github.com/acme/w#7",
      ),
    );
    const body = {
      root: `task:${wi.id}`,
      nodes: [{ id: `task:${wi.id}`, node_type: "task" }],
      edges: e
        .filter((x) => x.from_id === `task:${wi.id}`)
        .map((x) => ({ edge_type: x.edge_type, from_id: x.from_id, to_id: x.to_id })),
    };
    const graph = parseNeighborhood(body);
    assert.ok(graph);
    const text = formatTaskGraph({ state: "ok", graph, cached: false }, wi.id);
    assert.match(text, /dependency: .*plan:/);
    assert.match(text, /issue_link: .*pr:github.com/);
  });
});
