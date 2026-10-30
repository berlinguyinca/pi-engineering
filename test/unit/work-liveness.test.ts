import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Actor } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { evaluateWorkCompletion } from "../../src/work/completionPolicy.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { formatWorkStatus } from "../../src/work/statusText.ts";

const user: Actor = { type: "user" };
const worker: Actor = { type: "agent", run_id: "RUN-a", role: "implementer", model: "m1" };
const STALE = 300_000;

/** A ledger with one started run; the clock is relative to the start event, so no sleeping. */
async function started() {
  const ledger = Ledger.fromEvents([]);
  const wi = await ledger.createWorkItem("g", "low", ["r"], user);
  const start = await ledger.emitEvent("agent.started", wi.id, worker, {}, { run_id: "RUN-a", task_id: wi.id });
  const t0 = Date.parse(start.timestamp);
  let now = t0;
  const projection = new LedgerWorkProjection(ledger, { now: () => now, staleAfterMs: STALE });
  return {
    ledger,
    wi,
    t0,
    projection,
    advance: (ms: number) => {
      now = t0 + ms;
    },
    beat: (payload: Record<string, unknown> = {}) =>
      ledger.emitEvent("agent.heartbeat", wi.id, worker, payload, { run_id: "RUN-a", task_id: wi.id }),
  };
}
const run = (p: LedgerWorkProjection) => p.graph().runs[0];

describe("run liveness", () => {
  it("a fresh start is active and carries its owner", async () => {
    const s = await started();
    s.advance(1000);
    assert.equal(run(s.projection)?.health, "active");
    assert.equal(run(s.projection)?.owner, "implementer@m1");
  });

  it("a crashed run with no heartbeat becomes unknown, never healthy, and blocks completion", async () => {
    const s = await started();
    s.advance(STALE + 1);
    const g = s.projection.graph();
    assert.equal(g.runs[0]?.health, "unknown");
    const verdict = evaluateWorkCompletion(g.tasks[0]!, g.runs);
    assert.ok(verdict.blockers.some((b) => /RUN-a is unknown/.test(b)));
  });

  it("a heartbeat keeps the run active; its absence afterwards makes it unknown again", async () => {
    const s = await started();
    s.advance(STALE - 1);
    await s.beat({ last_progress_at: new Date(s.t0 + STALE - 1).toISOString() });
    // heartbeat timestamps are real wall-clock; place the clock just after it
    const hb = Date.parse(s.ledger.events().at(-1)!.timestamp);
    const p = new LedgerWorkProjection(s.ledger, { now: () => hb + 1000, staleAfterMs: STALE });
    assert.equal(run(p)?.health, "active");
    const later = new LedgerWorkProjection(s.ledger, { now: () => hb + STALE + 1, staleAfterMs: STALE });
    assert.equal(run(later)?.health, "unknown");
  });

  it("heartbeats without meaningful progress past the threshold are stalled", async () => {
    const s = await started();
    await s.beat({ last_progress_at: new Date(s.t0).toISOString() });
    // Place the heartbeat well after the start: it is fresh, but the last progress is older than the threshold.
    const hbAt = s.t0 + STALE + 10_000;
    const events = s.ledger
      .events()
      .map((e) => (e.type === "agent.heartbeat" ? { ...e, timestamp: new Date(hbAt).toISOString() } : e));
    const reload = async (evs: typeof events) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-liveness-"));
      try {
        const file = join(dir, "ledger.jsonl");
        await writeFile(file, `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`);
        return await Ledger.create(file);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    const p = new LedgerWorkProjection(await reload(events), { now: () => hbAt + 1000, staleAfterMs: STALE });
    assert.equal(run(p)?.health, "stalled");
    const progressed = events.map((e) =>
      e.type === "agent.heartbeat" ? { ...e, payload: { last_progress_at: new Date(hbAt - 1000).toISOString() } } : e,
    );
    const q = new LedgerWorkProjection(await reload(progressed), { now: () => hbAt + 1000, staleAfterMs: STALE });
    assert.equal(run(q)?.health, "active");
  });

  it("a heartbeat that states waiting or recovering is shown as such", async () => {
    const s = await started();
    await s.beat({ phase: "waiting" });
    assert.equal(run(s.projection)?.health, "waiting");
    await s.beat({ phase: "recovering" });
    assert.equal(run(s.projection)?.health, "recovering");
    await s.beat({});
    assert.equal(run(s.projection)?.health, "active");
  });

  it("a terminal run is final whatever the clock says", async () => {
    const s = await started();
    await s.ledger.emitEvent("agent.completed", s.wi.id, worker, {}, { run_id: "RUN-a", task_id: s.wi.id });
    s.advance(10 * STALE);
    await s.beat();
    assert.equal(run(s.projection)?.health, "finished");
  });

  it("a replayed heartbeat key is idempotent", async () => {
    const s = await started();
    const meta = { run_id: "RUN-a", task_id: s.wi.id, idempotency_key: "RUN-a:hb:1" };
    const a = await s.ledger.emitEvent("agent.heartbeat", s.wi.id, worker, {}, meta);
    const b = await s.ledger.emitEvent("agent.heartbeat", s.wi.id, worker, {}, meta);
    assert.equal(a.event_id, b.event_id);
  });

  it("/work shows owner and last heartbeat, and says state unknown for a silent run", async () => {
    const s = await started();
    s.advance(STALE + 1);
    const text = formatWorkStatus(s.projection.graph());
    assert.match(text, /RUN-a state unknown · owner implementer@m1 · last heartbeat \d{4}-/);
    assert.doesNotMatch(text, /RUN-a active/);
  });
});

describe("verification is bound to required gates and the current commit", () => {
  async function candidateItem(head?: string) {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    await ledger.updateWorkItem(wi.id, { status: "VERIFYING" }, user);
    const c = await ledger.createCandidate(wi.id, "base", "b", null, "implementer", "RUN-a", null, worker);
    if (head) await ledger.changeCandidate(c.id, { head_commit: head }, wi.id, worker);
    await ledger.updateWorkItem(wi.id, { current_candidate_id: c.id }, user);
    const ev = (type: string, status: "passed" | "failed", summary: Record<string, unknown> = {}) =>
      ledger.recordEvidence(
        c.id,
        type,
        "t",
        null,
        status === "passed" ? 0 : 1,
        status,
        summary,
        [],
        "deterministic",
        wi.id,
        worker,
      );
    const status = () =>
      new LedgerWorkProjection(ledger).graph().tasks.find((t) => t.id === wi.id)?.verification_status;
    return { ledger, wi, c, ev, status };
  }

  it("regression: one passing lint row no longer yields passed when the run required a test stage", async () => {
    const t = await candidateItem("abc");
    await t.ev("verify.lint", "passed", { head_commit: "abc", required_stages: ["lint", "test"] });
    assert.equal(t.status(), "incomplete");
    await t.ev("verify.test", "passed", { head_commit: "abc", required_stages: ["lint", "test"] });
    assert.equal(t.status(), "passed");
  });

  it("policy-required evidence types must have a passing row", async () => {
    const t = await candidateItem();
    await t.ev("verify.lint", "passed");
    const p = new LedgerWorkProjection(t.ledger, { requiredEvidence: () => ["verify.lint", "verify.test"] });
    assert.equal(p.graph().tasks[0]?.verification_status, "incomplete");
  });

  it("evidence for another commit of the same candidate is stale", async () => {
    const t = await candidateItem("new");
    await t.ev("verify.test", "passed", { head_commit: "old", required_stages: ["test"] });
    assert.equal(t.status(), "stale");
    await t.ev("verify.test", "passed", { head_commit: "new", required_stages: ["test"] });
    assert.equal(t.status(), "passed");
  });

  it("a mismatched tree is stale", async () => {
    const t = await candidateItem("abc");
    await t.ledger.changeCandidate(t.c.id, { tree: "T2" }, t.wi.id, worker);
    await t.ev("verify.test", "passed", { head_commit: "abc", tree: "T1" });
    assert.equal(t.status(), "stale");
  });

  it("a failing row still fails, and a candidate that records no commit keeps the old behaviour", async () => {
    const t = await candidateItem();
    await t.ev("verify.test", "passed");
    assert.equal(t.status(), "passed");
    await t.ev("verify.lint", "failed");
    assert.equal(t.status(), "failed");
  });

  it("a plan task derives verification from the work item it produced", async () => {
    const t = await candidateItem("abc");
    await t.ev("verify.test", "passed", { head_commit: "abc", required_stages: ["test"] });
    const plan = await t.ledger.createWorkItem("plan", "low", ["r"], user);
    const task = await t.ledger.createTask(plan.id, "sub", "implementation", "low", user);
    await t.ledger.updateTask(task.id, { result_work_item_id: t.wi.id }, plan.id, user);
    const g = new LedgerWorkProjection(t.ledger).graph();
    assert.equal(g.tasks.find((x) => x.id === task.id)?.verification_status, "passed");
  });
});
