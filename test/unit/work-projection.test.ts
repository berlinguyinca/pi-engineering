import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Actor } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { Execution } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { LedgerWorkProjection, workStateOf } from "../../src/work/ledgerProjection.ts";
import { type MissionReader, missionWorkState, projectLegacyMissions } from "../../src/work/legacyMissionAdapter.ts";
import { mergeWorkGraphs } from "../../src/work/types.ts";

const actor: Actor = { type: "agent", run_id: "RUN-a", model: "m1" };
const user: Actor = { type: "user" };

async function tmpFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-work-"));
  return { dir, file: join(dir, "ledger.jsonl") };
}

describe("ledger event envelope (schema_version 2)", () => {
  it("leaves events untouched unless the writer supplies envelope fields", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("fix nav", "low", ["r"], user);
    const created = ledger.events(wi.id)[0];
    assert.equal(created?.schema_version, undefined);
    assert.equal(created?.run_id, undefined);
    const ev = await ledger.emitEvent(
      "agent.started",
      wi.id,
      actor,
      {},
      { run_id: "RUN-a", session_id: "S1", task_id: wi.id },
    );
    assert.equal(ev.schema_version, 2);
    assert.equal(ev.session_id, "S1");
  });

  it("deduplicates by idempotency key, concurrently and across a restart", async () => {
    const { dir, file } = await tmpFile();
    try {
      const ledger = await Ledger.create(file);
      const wi = await ledger.createWorkItem("g", "low", ["r"], user);
      const meta = { idempotency_key: "start:RUN-a", run_id: "RUN-a" };
      const [a, b] = await Promise.all([
        ledger.emitEvent("agent.started", wi.id, actor, {}, meta),
        ledger.emitEvent("agent.started", wi.id, actor, {}, meta),
      ]);
      assert.equal(a.event_id, b.event_id, "concurrent appends with one key commit once");
      const again = await ledger.emitEvent("agent.started", wi.id, actor, {}, meta);
      assert.equal(again.event_id, a.event_id);

      const reopened = await Ledger.create(file);
      const afterRestart = await reopened.emitEvent("agent.started", wi.id, actor, {}, meta);
      assert.equal(afterRestart.event_id, a.event_id, "the key survives a restart");
      const lines = (await readFile(file, "utf-8")).split("\n").filter(Boolean);
      assert.equal(lines.filter((l) => l.includes('"agent.started"')).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays a log that mixes pre-envelope and envelope events", async () => {
    const { dir, file } = await tmpFile();
    try {
      const ledger = await Ledger.create(file);
      const wi = await ledger.createWorkItem("mixed", "low", ["r"], user);
      await ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "RUN-a", session_id: "S1" });
      const reopened = await Ledger.create(file);
      const g = new LedgerWorkProjection(reopened).graph();
      assert.equal(g.tasks.length, 1);
      assert.equal(g.runs[0]?.session_id, "S1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LedgerWorkProjection", () => {
  it("a finished run does not make the task done", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("refactor", "medium", ["r"], user);
    await ledger.updateWorkItem(wi.id, { status: "EXECUTING" }, user);
    await ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "RUN-a", session_id: "S1" });
    await ledger.emitEvent("agent.completed", wi.id, actor, {}, { run_id: "RUN-a" });
    const g = new LedgerWorkProjection(ledger).graph();
    assert.equal(g.runs[0]?.health, "finished");
    assert.equal(g.tasks[0]?.state, "working");
    assert.deepEqual(g.tasks[0]?.run_ids, ["RUN-a"]);
    assert.deepEqual(g.tasks[0]?.session_ids, ["S1"]);
  });

  it("a late start event does not reopen a finished run", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    await ledger.emitEvent("agent.completed", wi.id, actor, {}, { run_id: "RUN-a" });
    await ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "RUN-a" });
    assert.equal(new LedgerWorkProjection(ledger).graph().runs[0]?.health, "finished");
  });

  it("maps failures to blocked, never done", () => {
    for (const s of ["FAILED", "PARTIAL", "BUDGET_EXHAUSTED", "BLOCKED"] as const)
      assert.equal(workStateOf(s), "blocked");
    assert.equal(workStateOf("NEEDS_HUMAN"), "needs_input");
    assert.equal(workStateOf("COMPLETED"), "done");
  });

  it("binds verification to the current candidate (the ledger's revision identity)", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    assert.equal(new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status, "not_required");
    const c1 = await ledger.createCandidate(wi.id, "base", "b1", null, "implementer", "RUN-a", null, actor);
    await ledger.updateWorkItem(wi.id, { current_candidate_id: c1.id }, user);
    assert.equal(new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status, "pending");
    await ledger.recordEvidence(c1.id, "test", "node", "npm test", 0, "passed", {}, [], "deterministic", wi.id, actor);
    assert.equal(new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status, "passed");
    const c2 = await ledger.createCandidate(wi.id, "base", "b2", null, "implementer", "RUN-b", c1.id, actor);
    await ledger.updateWorkItem(wi.id, { current_candidate_id: c2.id }, user);
    assert.equal(
      new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status,
      "stale",
      "evidence for the old revision is not evidence for the new one",
    );
  });

  it("catches up incrementally and replays to the same graph", async () => {
    const { dir, file } = await tmpFile();
    try {
      const ledger = await Ledger.create(file);
      const proj = new LedgerWorkProjection(ledger);
      const wi = await ledger.createWorkItem("g", "low", ["r"], user);
      assert.equal(proj.catchUp(), 1);
      assert.equal(proj.catchUp(), 0, "nothing new on a second pass");
      await ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "RUN-a", session_id: "S1" });
      assert.equal(proj.catchUp(), 1);
      const live = proj.graph();
      const replayed = new LedgerWorkProjection(await Ledger.create(file)).graph();
      assert.deepEqual(replayed, live);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy Mission adapter", () => {
  it("projects a real MissionStore without writing to its event log", () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const m = store.createMission({
      mission_id: "MSN-legacy",
      title: "old work",
      goal: "g",
      user_request: "r",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "do it",
      repo_id: ".",
      mutates_repo: false,
      write_domains: [],
      isolation: "none",
      execution_budget_ms: 60_000,
      max_attempts: 1,
    });
    const before = backend.count();
    const g = projectLegacyMissions(store);
    assert.equal(backend.count(), before, "projection appended nothing");
    assert.equal(g.tasks.length, 2);
    assert.equal(g.tasks[0]?.id, "MSN-legacy", "historical ids are kept");
    assert.equal(g.tasks[0]?.state, "open");
    assert.equal(g.tasks[1]?.parent_id, "MSN-legacy");
    assert.equal(g.tasks[0]?.verification_status, "unknown");
  });

  it("maps executions to runs, sessions and handoffs", () => {
    const reader: MissionReader = {
      listMissions: () => [
        { mission_id: "MSN-1", title: "t", status: "EXECUTING", created_at: "2026-01-01T00:00:00Z" } as never,
      ],
      listTasks: () => [{ task_id: "TSK-1", mission_id: "MSN-1", objective: "o", status: "RUNNING" } as never],
      listExecutions: () =>
        [
          {
            execution_id: "EXC-1",
            task_id: "TSK-1",
            mission_id: "MSN-1",
            session_id: "S1",
            status: "FAILED",
            error: "oom",
            model: "m",
            worktree: "/w",
            started_at: null,
            ended_at: null,
          },
          {
            execution_id: "EXC-2",
            task_id: "TSK-1",
            mission_id: "MSN-1",
            session_id: "S2",
            status: "CANCELED",
            model: null,
            worktree: null,
            started_at: null,
            ended_at: null,
          },
        ] as unknown as Execution[],
      listHandoffRecords: () =>
        [
          {
            id: "H-1",
            kind: "rollover",
            state: "acknowledged",
            missionId: "MSN-1",
            predecessor: { sessionId: "S1", generation: 1 },
            successor: { sessionId: "S2", generation: 2 },
            createdAt: "2026-01-01T00:00:00Z",
          },
        ] as unknown as HandoffRecord[],
    };
    const g = projectLegacyMissions(reader);
    assert.deepEqual(
      g.runs.map((r) => [r.health, r.outcome]),
      [
        ["failed", "oom"],
        ["finished", "cancelled"],
      ],
    );
    assert.deepEqual(
      g.sessions.map((s) => s.id),
      ["S1", "S2"],
    );
    assert.deepEqual(g.handoffs[0] && [g.handoffs[0].from_session, g.handoffs[0].to_session], ["S1", "S2"]);
    assert.equal(g.tasks[0]?.state, "working");
  });

  it("treats in-flight and waiting mission statuses as working, and only COMPLETE as done", () => {
    for (const s of [
      "EXECUTING",
      "VALIDATING",
      "REVIEWING",
      "WAITING_FOR_CAPACITY",
      "RECOVERING_PROCESS",
      "PAUSED_INFRASTRUCTURE",
      "CANCELING",
    ] as const) {
      assert.equal(missionWorkState(s), "working", s);
    }
    assert.equal(missionWorkState("COMPLETE"), "done");
    assert.equal(missionWorkState("WAITING_FOR_USER"), "needs_input");
    assert.equal(missionWorkState("FAILED"), "blocked");
  });
});

describe("mixed legacy and new work", () => {
  it("merges both stores into one graph with no double writer", async () => {
    const ledger = Ledger.fromEvents([]);
    await ledger.createWorkItem("new work", "low", ["r"], user);
    const reader: MissionReader = {
      listMissions: () => [{ mission_id: "MSN-1", title: "old", status: "COMPLETE", created_at: "x" } as never],
      listTasks: () => [],
      listExecutions: () => [],
      listHandoffRecords: () => [],
    };
    const g = mergeWorkGraphs(new LedgerWorkProjection(ledger).graph(), projectLegacyMissions(reader));
    assert.deepEqual(g.tasks.map((t) => t.source).sort(), ["ledger", "mission"]);
    assert.deepEqual(g.conflicts, []);
  });

  it("reports an id that two stores both claim", () => {
    const one = {
      tasks: [{ id: "X", source: "ledger" }],
      runs: [],
      sessions: [],
      handoffs: [],
      conflicts: [],
    } as never;
    const two = {
      tasks: [{ id: "X", source: "mission" }],
      runs: [],
      sessions: [],
      handoffs: [],
      conflicts: [],
    } as never;
    const g = mergeWorkGraphs(one, two);
    assert.deepEqual(g.conflicts, ["task:X"]);
    assert.equal(g.tasks.length, 1);
  });
});

describe("review hardening", () => {
  it("rejects an idempotency key reused for a different request instead of dropping the write", async () => {
    const ledger = Ledger.fromEvents([]);
    const a = await ledger.createWorkItem("a", "low", ["r"], user);
    const b = await ledger.createWorkItem("b", "low", ["r"], user);
    await ledger.emitEvent("agent.started", a.id, actor, {}, { idempotency_key: "k" });
    await assert.rejects(
      ledger.emitEvent("agent.started", b.id, actor, {}, { idempotency_key: "k" }),
      /idempotency key k/,
    );
    await assert.rejects(
      ledger.emitEvent("agent.failed", a.id, actor, {}, { idempotency_key: "k" }),
      /idempotency key k/,
    );
  });

  it("does not invent a run from an actor's run id on non-lifecycle events", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    await ledger.recordEvidence(null, "test", "node", "npm test", 0, "passed", {}, [], "deterministic", wi.id, actor);
    assert.deepEqual(new LedgerWorkProjection(ledger).graph().runs, []);
  });

  it("keeps a terminal run final in both directions", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    await ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "RUN-a" });
    await ledger.emitEvent("agent.completed", wi.id, actor, {}, { run_id: "RUN-a" });
    await ledger.emitEvent("agent.failed", wi.id, actor, {}, { run_id: "RUN-a" });
    const run = new LedgerWorkProjection(ledger).graph().runs[0];
    assert.equal(run?.health, "finished");
    assert.equal(run?.outcome, "completed");
  });

  it("does not count unverified evidence as a pass", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    const c = await ledger.createCandidate(wi.id, "base", "b", null, "implementer", "RUN-a", null, actor);
    await ledger.updateWorkItem(wi.id, { current_candidate_id: c.id }, user);
    await ledger.recordEvidence(c.id, "test", "node", "npm test", 0, "passed", {}, [], "unverified", wi.id, actor);
    assert.equal(new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status, "pending");
  });

  it("does not call a started item with no candidate 'not required'", async () => {
    const ledger = Ledger.fromEvents([]);
    const wi = await ledger.createWorkItem("g", "low", ["r"], user);
    await ledger.updateWorkItem(wi.id, { status: "VERIFYING" }, user);
    assert.equal(new LedgerWorkProjection(ledger).graph().tasks[0]?.verification_status, "unknown");
  });

  it("uses the position as a real cursor", async () => {
    const ledger = Ledger.fromEvents([]);
    const proj = new LedgerWorkProjection(ledger);
    await ledger.createWorkItem("g", "low", ["r"], user);
    proj.catchUp();
    assert.equal(proj.cursor().position, 1);
    await ledger.createWorkItem("h", "low", ["r"], user);
    assert.equal(proj.catchUp(), 1);
    assert.equal(proj.cursor().position, 2);
  });

  it("maps legacy BLOCKED and SKIPPED tasks, and never claims a pass for a COMPLETE mission", () => {
    const reader: MissionReader = {
      listMissions: () => [{ mission_id: "MSN-1", title: "t", status: "COMPLETE", created_at: "x" } as never],
      listTasks: () =>
        [
          { task_id: "T1", mission_id: "MSN-1", objective: "o", status: "BLOCKED" },
          { task_id: "T2", mission_id: "MSN-1", objective: "o", status: "SKIPPED" },
        ] as never,
      listExecutions: () => [],
      listHandoffRecords: () => [],
    };
    const g = projectLegacyMissions(reader);
    assert.deepEqual(
      g.tasks.map((t) => t.state),
      ["done", "blocked", "cancelled"],
    );
    assert.equal(g.tasks[0]?.verification_status, "unknown");
  });
});
