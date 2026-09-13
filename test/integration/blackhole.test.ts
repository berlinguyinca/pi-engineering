import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

function fakeWorker() {
  return new FakeWorkerExecutor({
    scout: () => ({
      status: "completed",
      summary: "s",
      claims: [],
      details: {},
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
    }),
    implementer: async (req) => {
      await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
      return {
        status: "completed",
        summary: "implemented",
        claims: [],
        details: {},
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      };
    },
    reviewer: () => ({
      status: "completed",
      summary: "clean",
      claims: [],
      details: { findings: [] },
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
    }),
  });
}

test("blackhole disabled (default) is backward compatible: no sessions, no lifecycle events", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
    });
    assert.equal(rt.blackhole, null, "no blackhole manager when not configured");
    const report = await rt.engineer("Implement add(a, b) to return a + b");
    assert.equal(report.outcome, "promoted");
    // No blackhole events were emitted.
    const events = rt.ledger.events();
    assert.ok(!events.some((e) => e.type.startsWith("blackhole.")), "no blackhole events when disabled");
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole enabled: worker sessions get isolated stores and lifecycle events are recorded", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    assert.ok(rt.blackhole, "manager created");
    assert.equal(rt.blackhole.enabled, true);
    assert.equal(rt.blackhole.state().provider, "builtin");
    // A worker session opens a store.
    const store = rt.blackhole.openSession({ project: fixture.root, workItem: "WI-x", role: "implementer" });
    assert.equal(store.size, 0);
    store.observe("working fact", ["evt:1"], "P1");
    assert.equal(store.recall(10).length, 1);

    // Lifecycle event was emitted at manager open (authoritative EventStore).
    const events = rt.ledger.events();
    const payload = (e: { type: string; payload: Record<string, unknown> }) => e.payload as { action: string };
    assert.ok(
      events.some((e) => e.type === "blackhole.lifecycle" && payload(e).action === "started"),
      "blackhole.lifecycle(started) recorded",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole promotion: propose + decide with evidence records durable memory and audit events", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    const bh = rt.blackhole!;
    const store = bh.openSession({ project: fixture.root, workItem: "WI-x", role: "implementer" });
    const candId = await bh.proposePromotion({
      store,
      text: "remember that add should be integer-safe",
      sourceRefs: ["commit:abc"],
      proposedBy: "reviewer",
      evidenceIds: ["EVID-1"],
    });
    const decided = await bh.decidePromotion(store, { action: "promote", candidateId: candId, decidedBy: "operator" });
    assert.equal(decided.state, "promoted");
    assert.equal(decided.promoted, true);
    const durable = await bh.durable.recallAll();
    assert.equal(durable.length, 1);
    assert.equal(durable[0]!.text, "remember that add should be integer-safe");
    // Audit events recorded.
    const events = rt.ledger.events();
    assert.ok(events.some((e) => e.type === "blackhole.promotion.proposed"));
    assert.ok(events.some((e) => e.type === "blackhole.promotion.decided"));
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole promotion: evidence-gated — cannot promote without evidence", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    const bh = rt.blackhole!;
    const store = bh.openSession({ project: fixture.root, workItem: "WI-x", role: "implementer" });
    const candId = await bh.proposePromotion({
      store,
      text: "speculative",
      sourceRefs: [],
      proposedBy: "reviewer",
      evidenceIds: [],
    });
    await assert.rejects(
      () => bh.decidePromotion(store, { action: "promote", candidateId: candId, decidedBy: "operator" }),
      /no evidence/,
    );
    assert.equal(await (await bh.durable.recallAll()).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole recall: prior session memory is recalled for a stable session identity", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    const bh = rt.blackhole!;
    const identity = {
      project: fixture.root,
      workItem: "WI-stable",
      role: "implementer",
      workerId: "cand-1",
      runId: "cand-1",
      sessionId: "cand-1",
    };
    const store = bh.openSessionFor(identity);
    store.observe("remember the integer-safety constraint", ["evt"], "P1");
    const recalled = bh.recall(identity, 10);
    assert.ok(
      recalled.some((e) => e.text.includes("integer-safety")),
      "recall returns prior session memory",
    );
    // A different worker (same work item, different candidate) must NOT recall
    // this candidate's memory (isolation).
    const other = bh.recall({ ...identity, workerId: "cand-2", runId: "cand-2", sessionId: "cand-2" }, 10);
    assert.ok(!other.some((e) => e.text.includes("integer-safety")), "distinct candidate does not recall peer memory");
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole TTL: idle sessions are pruned so per-process memory is bounded", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true, sessionTtlMs: 1 } },
    });
    const bh = rt.blackhole!;
    const identity = {
      project: fixture.root,
      workItem: "WI-ttl",
      role: "implementer",
      workerId: "c",
      runId: "c",
      sessionId: "c",
    };
    bh.openSessionFor(identity);
    assert.ok(bh.state().sessions >= 1);
    await new Promise((r) => setTimeout(r, 10));
    const removed = bh.pruneIdleSessions();
    assert.ok(removed >= 1, `idle session should be pruned (removed=${removed})`);
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole tournament isolation: candidates sharing a work item get distinct memory scopes", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker: fakeWorker(),
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    const bh = rt.blackhole!;
    // Simulate the runtime's keying: candidates share one work item but have
    // distinct candidate ids (sessionScope), so their memory is isolated.
    const wiId = "WI-shared";
    const candA = "CAND-A";
    const candB = "CAND-B";
    const mk = (role: string, scope: string) => ({
      project: fixture.root,
      workItem: wiId,
      role,
      workerId: scope,
      runId: scope,
      sessionId: scope,
    });
    const storeA = bh.openSessionFor(mk("implementer", candA));
    storeA.observe("candidate A secret", ["evt"], "P1");
    // Candidate B's implementer and reviewer scopes must NOT recall A's secret.
    const bRecall = bh.recall(mk("implementer", candB), 10);
    assert.ok(!bRecall.some((e) => e.text.includes("candidate A secret")));
    const reviewerRecall = bh.recall(mk("reviewer", candA), 10);
    assert.ok(
      !reviewerRecall.some((e) => e.text.includes("candidate A secret")),
      "reviewer role is isolated from implementer",
    );
    // A's own scope DOES recall it (same work item, same candidate scope).
    const aRecall = bh.recall(mk("implementer", candA), 10);
    assert.ok(aRecall.some((e) => e.text.includes("candidate A secret")));
  } finally {
    await fixture.cleanup();
  }
});

test("blackhole session isolation: parallel tournament candidates never share working memory", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let active = 0;
    let maxActive = 0;
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        active -= 1;
        return {
          status: "completed",
          summary: "i",
          claims: [],
          details: {},
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        };
      },
      reviewer: () => ({
        status: "completed",
        summary: "clean",
        claims: [],
        details: { findings: [] },
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker,
      verifier: new CommandVerifier(),
      blackhole: { config: { enabled: true } },
    });
    const report = await rt.tournament("Implement add", { n: 2, parallel: true });
    assert.equal(report.outcome, "promoted");
    assert.ok(maxActive >= 2, "candidates overlapped");
    // Every candidate has its own isolated session store; no two share a key.
    const keys = new Set<string>();
    for (const e of report.entries) {
      const store = rt.blackhole!.openSessionFor({
        project: fixture.root,
        workItem: report.work_item.id,
        runId: e.candidate.id,
        role: "implementer",
        workerId: e.candidate.id,
        sessionId: e.candidate.id,
      });
      store.observe(`candidate ${e.candidate.id} secret`, ["evt"], "P1");
      keys.add(store.key);
    }
    assert.equal(keys.size, 2, "each candidate gets a distinct isolated memory store");
    assert.equal(rt.blackhole!.state().sessions >= 2, true);
  } finally {
    await fixture.cleanup();
  }
});
