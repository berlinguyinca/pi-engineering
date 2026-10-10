import assert from "node:assert/strict";
import { test } from "node:test";
import { plannerStateTempPath } from "../../src/plannerWorker/executor.ts";

test("plannerStateTempPath yields a unique sibling temp name per persist, even within one process", () => {
  const dir = "/tmp/planner-state";
  const a = plannerStateTempPath(dir);
  const b = plannerStateTempPath(dir);
  // Two PlannerWorkerExecutor instances sharing a stateDir in the same process
  // share process.pid; the temp name must still differ so one instance cannot
  // clobber the other's in-progress temp file before its atomic rename.
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`${dir}/state.json.tmp-`), a);
  assert.match(a, /state\.json\.tmp-\d+-\d+$/, a);
});

test("plannerStateTempPath stays under the caller's stateDir and is a sibling of state.json", () => {
  const dir = "/tmp/planner-state";
  const path = plannerStateTempPath(dir);
  assert.equal(path.slice(0, dir.length), dir);
  assert.ok(path.includes("state.json.tmp-"));
});
