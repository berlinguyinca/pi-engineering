import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../../src/core/types.ts";
import { tasksConflict, topoSort } from "../../src/plan/taskDag.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";

function t(id: string, depends_on: string[], scope_paths: string[]): Task {
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

// Access the private static via bracket to keep it testable without exposing API.
const computeWaves = (
  EngineeringRuntime as unknown as {
    computeParallelWaves(tasks: Task[]): Task[][];
  }
).computeParallelWaves;

test("parallel waves: independent disjoint tasks share a wave", () => {
  const tasks = [t("T1", [], ["src/a.ts"]), t("T2", [], ["src/b.ts"]), t("T3", [], ["src/c.ts"])];
  const waves = computeWaves(tasks);
  assert.equal(waves.length, 1, "all independent and disjoint -> single wave");
  assert.equal(waves[0]!.length, 3);
});

test("parallel waves: dependencies force later waves", () => {
  const tasks = [t("T1", [], ["src/a.ts"]), t("T2", ["T1"], ["src/b.ts"]), t("T3", [], ["src/c.ts"])];
  const waves = computeWaves(tasks);
  // T1 and T3 in wave 0; T2 in wave 1.
  assert.equal(waves.length, 2);
  assert.deepEqual(waves[0]!.map((x) => x.id).sort(), ["T1", "T3"]);
  assert.deepEqual(
    waves[1]!.map((x) => x.id),
    ["T2"],
  );
});

test("parallel waves: write-scope conflicts serialize even when independent", () => {
  const tasks = [t("T1", [], ["src/shared.ts"]), t("T2", [], ["src/shared.ts"]), t("T3", [], ["src/other.ts"])];
  const waves = computeWaves(tasks);
  // T1 and T2 conflict -> different waves; T3 can join either.
  assert.ok(waves.length >= 2);
  const wave0 = waves[0]!.map((x) => x.id);
  const wave1 = waves[1]!.map((x) => x.id);
  assert.ok(!(wave0.includes("T1") && wave0.includes("T2")), "conflicting tasks must not share a wave");
  assert.ok(!(wave1.includes("T1") && wave1.includes("T2")), "conflicting tasks must not share a wave");
});

test("parallel waves: chain serializes a diamond into correct dependency waves", () => {
  const tasks = [
    t("A", [], ["src/a.ts"]),
    t("B", [], ["src/b.ts"]),
    t("C", ["A", "B"], ["src/c.ts"]),
    t("D", ["C"], ["src/d.ts"]),
  ];
  const waves = computeWaves(tasks);
  assert.equal(waves.length, 3);
  assert.deepEqual(waves[0]!.map((x) => x.id).sort(), ["A", "B"]);
  assert.deepEqual(
    waves[1]!.map((x) => x.id),
    ["C"],
  );
  assert.deepEqual(
    waves[2]!.map((x) => x.id),
    ["D"],
  );
});

test("parallel waves: preserve topological validity within and across waves", () => {
  const tasks = [
    t("T2", ["T1"], ["src/b.ts"]),
    t("T1", [], ["src/a.ts"]),
    t("T4", ["T2", "T3"], ["src/d.ts"]),
    t("T3", ["T1"], ["src/c.ts"]),
  ];
  const waves = computeWaves(tasks);
  const pos = new Map<string, number>();
  let idx = 0;
  for (const w of waves) for (const x of w) pos.set(x.id, idx++);
  for (const task of tasks) for (const dep of task.depends_on) assert.ok(pos.get(dep)! < pos.get(task.id)!);
});

test("tasksConflict: shared scope path is a conflict", () => {
  assert.equal(tasksConflict(t("A", [], ["src/x.ts"]), t("B", [], ["src/x.ts"])), true);
  assert.equal(tasksConflict(t("A", [], ["src/x.ts"]), t("B", [], ["src/y.ts"])), false);
});

test("topoSort: still orders dependencies first", () => {
  const tasks = [t("T2", ["T1"], []), t("T1", [], [])];
  const order = topoSort(tasks);
  assert.deepEqual(
    order.map((x) => x.id),
    ["T1", "T2"],
  );
});
