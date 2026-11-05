/**
 * V02: the drift runner's scores are pinned to the V01 answer key, so any change in detector
 * behaviour breaks this test loudly instead of silently moving a reported metric.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTasks, main, score, toInput } from "../../scripts/bench-task-drift.ts";

const tasks = loadTasks();
const scores = score(tasks);

test("the five-task fixture scores exactly as the answer key says", () => {
  assert.equal(tasks.length, 5);
  assert.deepEqual(scores, { truePositives: 2, falsePositives: 0, falseNegatives: 1, trueNegatives: 2, precision: 1, recall: 2 / 3, falsePositiveIds: [], missedIds: ["drift-03"] });
});

test("the two clean controls (drift-01, drift-05) produce no signal", () => {
  assert.deepEqual(scores.falsePositiveIds, []);
  assert.equal(scores.trueNegatives, 2);
});

test("drift-03, in-scope but off-objective, is a reported recall miss", () => {
  assert.ok(scores.missedIds.includes("drift-03")); // path scope cannot see it; only relevance can
  assert.equal(scores.falseNegatives, 1);
  assert.equal(scores.recall, 2 / 3);
});

test("precision and recall are finite numbers or null, never NaN or Infinity", () => {
  for (const value of [scores.precision, scores.recall]) assert.ok(value === null || Number.isFinite(value));
});

test("actions map to detector input: only `change` mutates", () => {
  const drift02 = tasks.find((t) => t.id === "drift-02");
  assert.ok(drift02 !== undefined);
  assert.deepEqual(toInput(drift02).actions, [
    { iteration: 1, tool: "read", target: "src/panel/feeders/LedgerFeeder.ts", taskId: "drift-02", mutating: false },
    { iteration: 2, tool: "read", target: "src/panel/PanelState.ts", taskId: "drift-02", mutating: false },
    { iteration: 3, tool: "read", target: "test/unit/panel-state.test.ts", taskId: "drift-02", mutating: false },
    { iteration: 4, tool: "write", target: "package.json", taskId: "drift-02", mutating: true },
  ]);
});

test("measuring is deterministic and never fails on a missed task", () => {
  assert.equal(JSON.stringify(score(loadTasks())), JSON.stringify(score(tasks)));
  assert.equal(main(), 0); // recall < 1 is a finding, not an exit code
});
