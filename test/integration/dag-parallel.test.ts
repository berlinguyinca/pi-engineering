import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

/**
 * Deterministic overlap barrier: a worker blocks until `needed` workers have
 * entered (or a timeout). Replaces a wall-clock sleep so "independent tasks run
 * concurrently" is asserted deterministically rather than by scheduler timing
 * under full-suite load (which made this test flaky).
 */
function parallelBarrier(needed: number, timeoutMs = 5000): { arrived: () => Promise<void> } {
  let count = 0;
  let release: () => void;
  let settled = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      release();
    }
  }, timeoutMs);
  return {
    async arrived() {
      count++;
      if (count >= needed && !settled) {
        settled = true;
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

test("executePlan parallel runs independent tasks concurrently and integrates safely", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let active = 0;
    let peak = 0;
    const barrier = parallelBarrier(2);
    const worker = new FakeWorkerExecutor({
      planner: () => ({
        status: "completed",
        summary: "planned 3 independent tasks",
        details: {
          tasks: [
            {
              title: "implement add",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/add.js"],
            },
            {
              title: "implement subtract",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/subtract.js"],
            },
            {
              title: "implement multiply",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/multiply.js"],
            },
          ],
        },
      }),
      scout: () => ({ status: "completed", summary: "scouted", details: {} }),
      implementer: async (req) => {
        active++;
        peak = Math.max(peak, active);
        // Block until at least two implementers are active: deterministic overlap.
        await barrier.arrived();
        const body = req.task.toLowerCase();
        const file = body.includes("add") ? "add.js" : body.includes("subtract") ? "subtract.js" : "multiply.js";
        const op = body.includes("add") ? "+" : body.includes("subtract") ? "-" : "*";
        await writeFile(
          join(req.cwd, "src", file),
          `export function ${file.replace(".js", "")}(a, b) {\n  return a ${op} b;\n}\n`,
        );
        active--;
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const plan = await rt.plan("build add, subtract, multiply");
    assert.equal(plan.tasks.length, 3);
    const dag = await rt.executePlan(plan.plan_work_item.id, { parallel: true, concurrency: 3 });
    assert.equal(dag.outcome, "completed", `expected completed, got ${dag.outcome}: ${dag.summary}`);
    assert.ok(peak > 1, `expected concurrent implementer runs, but peak concurrency was ${peak}`);
    for (const f of ["add.js", "subtract.js", "multiply.js"]) {
      const content = (await (await import("node:fs/promises")).readFile(join(fixture.root, "src", f), "utf-8")).trim();
      assert.ok(content.length > 0, `${f} should be present in the promoted tree`);
    }
    const finalTasks = rt.ledger.listTasks(plan.plan_work_item.id);
    for (const t of finalTasks) {
      assert.equal(t.status, "completed");
      assert.ok(t.result_work_item_id, `${t.id} should link to a result work item`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("executePlan parallel still blocks a task whose dependency fails", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      planner: () => ({
        status: "completed",
        summary: "planned",
        details: {
          tasks: [
            {
              title: "implement add",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/add.js"],
            },
            {
              title: "implement subtract",
              kind: "implementation",
              risk: "medium",
              depends_on: [0],
              scope_paths: ["src/subtract.js"],
            },
          ],
        },
      }),
      scout: () => ({ status: "completed", summary: "scouted", details: {} }),
      implementer: async (req) => {
        // Always break add (the root), so subtract (dependent) must block.
        await writeFile(join(req.cwd, "src", "add.js"), 'export function add(a, b) {\n  throw new Error("boom");\n}\n');
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const plan = await rt.plan("add then subtract");
    const dag = await rt.executePlan(plan.plan_work_item.id, { parallel: true, concurrency: 2 });
    assert.equal(dag.outcome, "failed");
    const t1 = rt.ledger.listTasks(plan.plan_work_item.id).find((t) => t.title === "implement add");
    const t2 = rt.ledger.listTasks(plan.plan_work_item.id).find((t) => t.title === "implement subtract");
    assert.ok(t1 && t2);
    assert.equal(t1.status, "failed");
    assert.equal(t2.status, "blocked");
  } finally {
    await fixture.cleanup();
  }
});
