import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskView, formatTeamView, formatWorkStatusRow, formatWorkSummary } from "../../src/work/summaryText.ts";
import type { WorkGraph, WorkRun, WorkTask } from "../../src/work/types.ts";
import { emptyWorkGraph } from "../../src/work/types.ts";

const task = (id: string, over: Partial<WorkTask> = {}): WorkTask => ({
  id,
  source: "ledger",
  title: `Title ${id}`,
  state: "working",
  raw_status: "EXECUTING",
  verification_status: "pending",
  parent_id: null,
  created_at: null,
  updated_at: null,
  run_ids: [],
  session_ids: [],
  ...over,
});
const run = (id: string, task_id: string, over: Partial<WorkRun> = {}): WorkRun => ({
  id,
  task_id,
  source: "ledger",
  session_id: null,
  health: "active",
  outcome: null,
  model: null,
  worktree: null,
  started_at: null,
  ended_at: null,
  ...over,
});
const graph = (): WorkGraph => ({
  ...emptyWorkGraph(),
  tasks: [
    task("WI-1", { state: "done", verification_status: "passed" }),
    task("WI-2", { state: "blocked", blocked_reason: "gate refused\nnewline", verification_status: "failed" }),
    task("WI-3"),
  ],
  runs: [
    run("R1", "WI-3", { last_heartbeat_at: "2026-10-30T10:00:00Z", owner: "worker@qwen" }),
    run("R2", "WI-3", { health: "unknown" }),
    run("R3", "WI-1", { health: "finished" }),
  ],
  handoffs: [
    {
      id: "H1",
      source: "ledger",
      task_id: "WI-3",
      from_session: "S1",
      to_session: null,
      state: "pending",
      created_at: null,
    },
  ],
});

test("summary: empty graph and events", () => {
  assert.equal(formatWorkSummary(emptyWorkGraph(), []), "No tracked work yet.");
});

test("summary: unresolved, blocked reasons, unknown runs, handoffs, events oldest first", () => {
  const out = formatWorkSummary(graph(), [
    { timestamp: "2026-10-30T10:02:00Z", type: "agent.heartbeat", run_id: "R1" },
    { timestamp: "2026-10-30T10:01:00Z", type: "agent.started", run_id: "R1" },
  ]);
  assert.match(out, /3 task\(s\) — 1 done, 1 working, 1 blocked/);
  assert.match(out, /WI-2 \[blocked\].*verify:failed/);
  assert.match(out, /blocked: gate refused newline/);
  assert.doesNotMatch(out, /WI-1 \[done\]/);
  assert.match(out, /R2 on WI-3: state unknown · owner unknown · no heartbeat/);
  assert.match(out, /R1 on WI-3: active · owner worker@qwen · heartbeat 2026-10-30T10:00:00Z/);
  assert.match(out, /H1 WI-3: S1 → unclaimed \[pending\]/);
  assert.ok(out.indexOf("10:01:00Z agent.started") < out.indexOf("10:02:00Z agent.heartbeat"));
});

test("summary: output is bounded", () => {
  const g = emptyWorkGraph();
  g.tasks = Array.from({ length: 500 }, (_, i) => task(`T${i}`, { title: "x".repeat(1000) }));
  const events = Array.from({ length: 500 }, (_, i) => ({
    timestamp: `2026-10-30T10:${String(i % 60).padStart(2, "0")}:00Z`,
    type: "e",
  }));
  const out = formatWorkSummary(g, events);
  assert.ok(out.split("\n").length < 40);
  assert.ok(out.split("\n").every((l) => l.length <= 200));
  assert.match(out, /last 12 of 500/);
});

test("status row: single line, absent when nothing is open, notes unknown runs", () => {
  assert.equal(formatWorkStatusRow(emptyWorkGraph()), undefined);
  assert.equal(formatWorkStatusRow({ ...emptyWorkGraph(), tasks: [task("A", { state: "done" })] }), undefined);
  const row = formatWorkStatusRow(graph());
  assert.equal(row, "work 2 open | 2 runs (1 unknown) | 1 blocked");
  assert.ok(!row?.includes("\n"));
});

test("task view: one task, or a pointer to /work", () => {
  const out = formatTaskView(graph(), "WI-3");
  assert.match(out, /^WI-3 \[ledger\]/);
  assert.match(out, /run R2 state unknown/);
  assert.match(out, /handoff H1/);
  assert.doesNotMatch(out, /WI-2/);
  assert.match(formatTaskView(graph(), "nope"), /No task nope.*\/work/);
});

test("team view: preference plus live runs per task only", () => {
  const out = formatTeamView(graph(), "team");
  assert.match(out, /^Execution preference: team/);
  assert.match(out, /WI-3 Title WI-3\n {2}R1 active/);
  assert.doesNotMatch(out, /R3/);
  assert.match(formatTeamView(emptyWorkGraph(), "adaptive"), /No live runs\./);
});
