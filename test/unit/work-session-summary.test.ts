import assert from "node:assert/strict";
import { test } from "node:test";
import { getSessionSummary } from "../../src/work/sessionSummary.ts";
import { formatSessionSummary, formatWorkStatusRow } from "../../src/work/summaryText.ts";
import type { WorkGraph, WorkRun, WorkTask } from "../../src/work/types.ts";
import { emptyWorkGraph } from "../../src/work/types.ts";

const task = (id: string, session: string, over: Partial<WorkTask> = {}): WorkTask => ({
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
  session_ids: [session],
  ...over,
});
const run = (id: string, task_id: string, session: string | null, over: Partial<WorkRun> = {}): WorkRun => ({
  id,
  task_id,
  source: "ledger",
  session_id: session,
  health: "finished",
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
    task("T1", "A", { state: "done", updated_at: "2026-01-01T00:00:00Z" }),
    task("T2", "A", { state: "blocked" }),
    task("T3", "A", { state: "working" }),
    task("T4", "B"),
  ],
  runs: [
    run("R1", "T1", "A", { ended_at: "2026-01-01T00:00:00Z" }),
    run("R2", "T2", "A", { health: "failed", ended_at: "2026-01-02T00:00:00Z" }),
    run("R3", "T3", "A", { health: "active", last_heartbeat_at: "2026-01-03T00:00:00Z" }),
    run("R4", "T3", "A", { health: "failed", ended_at: "2026-01-02T12:00:00Z" }),
    run("R5", "T4", "B", { health: "failed", ended_at: "2026-01-01T00:00:00Z" }),
  ],
});

test("getSessionSummary counts, last activity, retries from the projection", () => {
  const s = getSessionSummary(graph(), "A", { linkedPrs: (id) => (id === "T3" ? ["#12", "#12"] : []) });
  assert.equal(s.known, true);
  assert.deepEqual([s.tasks.length, s.done, s.blocked, s.running, s.counts.working], [3, 1, 1, 1, 1]);
  assert.equal(s.last_activity_at, "2026-01-03T00:00:00Z");
  assert.equal(s.retry.retries, 1);
  assert.equal(s.retry.failed_attempts, 2);
  assert.deepEqual(s.retry.tasks_awaiting_retry, ["T2"]);
  assert.deepEqual(s.linked_prs, ["#12"]);
  assert.equal(s.tasks.find((t) => t.id === "T3")?.attempts, 2);
});

test("getSessionSummary on an unknown session is empty, not an error", () => {
  const s = getSessionSummary(graph(), "nope");
  assert.equal(s.known, false);
  assert.equal(s.tasks.length, 0);
  assert.equal(s.last_activity_at, null);
  assert.equal(formatSessionSummary(s), "No tracked work for session nope.");
});

test("formatSessionSummary renders the typed summary", () => {
  const text = formatSessionSummary(getSessionSummary(graph(), "A"));
  assert.match(text, /Session A: 3 task\(s\) — 1 done, 1 working, 1 blocked/);
  assert.match(text, /awaiting retry: T2/);
  assert.match(text, /PRs: none linked/);
});

const manyIdle = (): WorkGraph => {
  const g = emptyWorkGraph();
  for (let i = 1; i <= 6; i++) {
    g.tasks.push(task(`I${i}`, `idle${i}`, { state: "open" }));
    g.runs.push(run(`IR${i}`, `I${i}`, `idle${i}`, { ended_at: `2026-01-0${i}T00:00:00Z` }));
  }
  g.tasks.push(task("L1", "live1"));
  g.runs.push(run("LR1", "L1", "live1", { health: "active", started_at: "2025-01-01T00:00:00Z" }));
  return g;
};

test("status row shows N most recent idle sessions plus +K idle, never hiding live ones", () => {
  const row = formatWorkStatusRow(manyIdle(), { maxIdleSessions: 2 }) ?? "";
  assert.match(row, /live1 live/);
  assert.match(row, /idle6 idle \| idle5 idle \| \+4 idle/);
  assert.doesNotMatch(row, /idle4 idle/);
  assert.equal(row.includes("\n"), false);
});

test("status row: limit 0 hides all idle names but keeps live and the tail; default is 3", () => {
  const zero = formatWorkStatusRow(manyIdle(), { maxIdleSessions: 0 }) ?? "";
  assert.match(zero, /live1 live \| \+6 idle/);
  const def = formatWorkStatusRow(manyIdle()) ?? "";
  assert.match(def, /\+3 idle/);
});
