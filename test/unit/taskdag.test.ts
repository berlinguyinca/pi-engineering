import { test } from "node:test";
import assert from "node:assert/strict";
import { topoSort, tasksConflict, blockedByFailure } from "../../src/plan/taskDag.ts";
import type { Task } from "../../src/core/types.ts";

function t(id: string, depends_on: string[], scope_paths: string[] = []): Task {
  return {
    id,
    work_item_id: "WI-plan",
    title: id,
    kind: "implementation",
    depends_on,
    status: "ready",
    scope_paths,
    risk: "medium",
    result_work_item_id: null,
  };
}

test("topoSort returns dependencies before dependents", () => {
  // T2/T3/T4 depend on T1; T5 depends on T2 and T3.
  const tasks = [
    t("T2", ["T1"]),
    t("T1", []),
    t("T4", ["T1"]),
    t("T5", ["T2", "T3"]),
    t("T3", ["T1"]),
  ];
  const order = topoSort(tasks);
  const pos = new Map(order.map((x, i) => [x.id, i]));
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      assert.ok(pos.get(dep)! < pos.get(task.id)!, `${dep} must precede ${task.id}`);
    }
  }
  assert.equal(order.length, 5);
});

test("topoSort throws on a dependency cycle", () => {
  assert.throws(() => topoSort([t("A", ["B"]), t("B", ["A"])]), /cycle/);
});

test("topoSort throws on an unknown dependency", () => {
  assert.throws(() => topoSort([t("A", ["MISSING"])]), /unknown task/);
});

test("tasksConflict detects overlapping write scopes", () => {
  assert.equal(tasksConflict(t("A", [], ["src/a.ts"]), t("B", [], ["src/a.ts"])), true);
  assert.equal(tasksConflict(t("A", [], ["src/a.ts"]), t("B", [], ["src/b.ts"])), false);
});

test("blockedByFailure propagates to transitive dependents", () => {
  // T2 depends on T1; T3 depends on T2. Failing T1 blocks T2 and T3.
  const tasks = [t("T1", []), t("T2", ["T1"]), t("T3", ["T2"]), t("T4", [])];
  const blocked = blockedByFailure(tasks, new Set(["T1"]));
  assert.deepEqual(blocked.map((x) => x.id).sort(), ["T2", "T3"]);
});
