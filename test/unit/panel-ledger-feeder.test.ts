import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { LedgerFeeder } from "../../src/panel/feeders/LedgerFeeder.ts";

const planner: Actor = { type: "agent", role: "planner" };
const implementer: Actor = { type: "agent", role: "implementer" };
const reviewer: Actor = { type: "agent", role: "reviewer", model: "opus-5" };

function freshLedger(): Ledger {
  return Ledger.fromEvents([]);
}

test("ledger feeder: a phase event publishes the work item, phase and goal", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "high", ["/repo"], planner);
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });

  feeder.onPhase({ workItemId: wi.id, phase: "implement", goal: "add retry" });

  assert.equal(state.snapshot.run?.workItemId, wi.id);
  assert.equal(state.snapshot.run?.phase, "implement");
  assert.equal(state.snapshot.run?.goal, "add retry");
  assert.equal(state.snapshot.run?.risk, "high");
});

test("ledger feeder: candidate changed files reach the state", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "medium", ["/repo"], planner);
  const cand = await ledger.createCandidate(wi.id, "abc123", "cand/1", null, "implementer", "run-1", null, implementer);
  await ledger.changeCandidate(cand.id, { changed_files: ["src/a.ts", "src/b.ts"] }, wi.id, implementer);

  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });
  feeder.onPhase({ workItemId: wi.id, phase: "review", goal: "add retry" });

  assert.deepEqual(
    state.snapshot.run?.files.map((f) => f.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(state.snapshot.run?.candidateId, cand.id);
});

test("ledger feeder: a finding is attributed to the reviewing role and model", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "medium", ["/repo"], planner);
  const cand = await ledger.createCandidate(wi.id, "abc123", "cand/1", null, "implementer", "run-1", null, implementer);
  await ledger.recordEntity("finding", "retry loop can spin", "open", reviewer, wi.id, {
    severity: "high",
    candidateId: cand.id,
  });

  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });
  feeder.onPhase({ workItemId: wi.id, phase: "review" });

  const finding = state.snapshot.run?.findings[0];
  assert.equal(finding?.severity, "high");
  assert.equal(finding?.claim, "retry loop can spin");
  // Entities carry no actor: attribution must come from the recording event.
  assert.equal(finding?.role, "reviewer");
  assert.equal(finding?.model, "opus-5");
});

test("ledger feeder: spend accumulates per model across phases", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "low", ["/repo"], planner);
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });

  feeder.onPhase({
    workItemId: wi.id,
    phase: "implement",
    model: "opus-5",
    usage: { input: 100, output: 20, cost: 0.1 },
  });
  feeder.onPhase({ workItemId: wi.id, phase: "review", model: "opus-5", usage: { input: 50, output: 10, cost: 0.05 } });
  feeder.onPhase({
    workItemId: wi.id,
    phase: "review",
    model: "haiku-4-5",
    usage: { input: 10, output: 5, cost: 0.001 },
  });

  const spend = state.snapshot.run?.spend ?? [];
  const opus = spend.find((s) => s.model === "opus-5");
  assert.equal(opus?.input, 150);
  assert.equal(opus?.output, 30);
  assert.ok(Math.abs((opus?.cost ?? 0) - 0.15) < 1e-9);
  assert.equal(spend.find((s) => s.model === "haiku-4-5")?.input, 10);
});

test("ledger feeder: a settled run clears the run view and its spend", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "low", ["/repo"], planner);
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });

  feeder.onPhase({ workItemId: wi.id, phase: "implement", model: "opus-5", usage: { input: 1, output: 1, cost: 0 } });
  feeder.onPhase({ workItemId: wi.id, phase: "settled" });
  assert.equal(state.snapshot.run === undefined, true, "a settled run clears the view");

  // A later run starts from zero rather than inheriting the previous spend.
  const next = await ledger.createWorkItem("second", "low", ["/repo"], planner);
  feeder.onPhase({ workItemId: next.id, phase: "implement" });
  assert.deepEqual(state.snapshot.run?.spend, []);
});

test("ledger feeder: a settle for a DIFFERENT run does not clear the live one", async () => {
  const ledger = freshLedger();
  const a = await ledger.createWorkItem("first", "low", ["/repo"], planner);
  const b = await ledger.createWorkItem("second", "low", ["/repo"], planner);
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger, state });

  feeder.onPhase({ workItemId: a.id, phase: "implement" });
  feeder.onPhase({ workItemId: b.id, phase: "implement" });
  feeder.onPhase({ workItemId: a.id, phase: "settled" });

  assert.equal(state.snapshot.run?.workItemId, b.id, "a stale settle must not clear the live run");
});

test("ledger feeder: an unknown work item does not publish a phantom run", () => {
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger: freshLedger(), state });
  feeder.onPhase({ workItemId: "WI-nonexistent", phase: "implement" });
  assert.equal(state.snapshot.run, undefined);
});

test("ledger feeder: an unreadable ledger marks the section instead of throwing", () => {
  const broken = {
    getWorkItem: () => {
      throw new Error("ledger unreadable");
    },
  } as unknown as Ledger;
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger: broken, state });

  assert.doesNotThrow(() => feeder.onPhase({ workItemId: "WI-1", phase: "implement" }));
  assert.match(state.snapshot.errors[0]?.message ?? "", /ledger unreadable/);
  assert.equal(state.snapshot.errors[0]?.section, "run");
});

test("ledger feeder: a recovered read clears the error", async () => {
  const ledger = freshLedger();
  const wi = await ledger.createWorkItem("add retry", "low", ["/repo"], planner);
  const state = new PanelState();
  state.noteError("run", "previous failure");
  const feeder = new LedgerFeeder({ ledger, state });

  feeder.onPhase({ workItemId: wi.id, phase: "implement" });
  assert.deepEqual(state.snapshot.errors, []);
});
