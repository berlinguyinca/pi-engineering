import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateWorkCompletion } from "../../src/work/completionPolicy.ts";
import type { RunHealth, VerificationStatus, WorkRun, WorkTask, WorkTaskState } from "../../src/work/types.ts";

const task = (state: WorkTaskState, verification_status: VerificationStatus): WorkTask => ({
  id: "T1",
  source: "ledger",
  title: "t",
  state,
  raw_status: "",
  verification_status,
  parent_id: null,
  created_at: null,
  updated_at: null,
  run_ids: [],
  session_ids: [],
});
const run = (health: RunHealth, task_id = "T1"): WorkRun => ({
  id: `R-${health}`,
  task_id,
  source: "ledger",
  session_id: null,
  health,
  outcome: null,
  model: null,
  worktree: null,
  started_at: null,
  ended_at: null,
});

test("a working task with passed verification and no live run may complete", () => {
  assert.deepEqual(evaluateWorkCompletion(task("working", "passed"), [run("finished")]), {
    complete: true,
    blockers: [],
  });
  assert.equal(evaluateWorkCompletion(task("done", "not_required"), []).complete, true);
});

test("every live run health blocks completion", () => {
  for (const h of ["active", "waiting", "stalled", "recovering"] as const) {
    assert.equal(evaluateWorkCompletion(task("working", "passed"), [run(h)]).complete, false, h);
  }
});

test("a live run on another task does not block this one", () => {
  assert.equal(evaluateWorkCompletion(task("working", "passed"), [run("active", "T2")]).complete, true);
});

test("failed, stale, pending and unknown verification all block", () => {
  for (const v of ["failed", "stale", "pending", "unknown"] as const) {
    const verdict = evaluateWorkCompletion(task("working", v), []);
    assert.equal(verdict.complete, false, v);
    assert.ok(
      verdict.blockers.some((b) => b.includes(v)),
      v,
    );
  }
});

test("blocked, needs_input, open and cancelled tasks cannot complete", () => {
  for (const s of ["blocked", "needs_input", "open", "cancelled"] as const) {
    assert.equal(evaluateWorkCompletion(task(s, "passed"), []).complete, false, s);
  }
});
