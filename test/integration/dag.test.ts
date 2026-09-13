import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("plan + executePlan runs a dependency-ordered task DAG through the pipeline", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      planner: () => ({
        status: "completed",
        summary: "planned 2 tasks",
        details: {
          tasks: [
            {
              title: "implement add to return the sum",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/add.js"],
            },
            {
              title: "implement subtract to return the difference",
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
        const body = req.task.toLowerCase();
        if (body.includes("add")) {
          await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        } else if (body.includes("subtract")) {
          await writeFile(
            join(req.cwd, "src", "subtract.js"),
            `export function subtract(a, b) {\n  return a - b;\n}\n`,
          );
        }
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });

    const plan = await rt.plan("Build a small math module with add and subtract");
    assert.equal(plan.outcome, "planned");
    assert.equal(plan.tasks.length, 2);
    const [t1, t2] = plan.tasks;
    assert.ok(t1 && t2);
    assert.equal(t1.depends_on.length, 0);
    assert.deepEqual(t2.depends_on, [t1.id]);

    const dag = await rt.executePlan(plan.plan_work_item.id);
    assert.equal(dag.outcome, "completed");
    assert.deepEqual(
      dag.order.map((t) => t.id),
      [t1.id, t2.id],
    );
    // Both tasks completed and linked to result work items.
    const finalTasks = rt.ledger.listTasks(plan.plan_work_item.id);
    for (const t of finalTasks) {
      assert.equal(t.status, "completed");
      assert.ok(t.result_work_item_id, `${t.id} should be linked to a result work item`);
    }
    // Both files actually exist in the promoted tree.
    assert.ok((await readFile(join(fixture.root, "src", "add.js"), "utf-8")).includes("a + b"));
    assert.ok((await readFile(join(fixture.root, "src", "subtract.js"), "utf-8")).includes("a - b"));
    // Plan work item marked COMPLETED.
    assert.equal(rt.ledger.getWorkItem(plan.plan_work_item.id)!.status, "COMPLETED");
  } finally {
    await fixture.cleanup();
  }
});

test("executePlan blocks downstream tasks when a dependency fails", async () => {
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
        // Deliberately produce a BROKEN add that fails the fixture test.
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  throw new Error("boom");\n}\n`);
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const plan = await rt.plan("Build add then subtract");
    const dag = await rt.executePlan(plan.plan_work_item.id);
    // add (the root) failed verification, so nothing completed -> failed.
    assert.equal(dag.outcome, "failed");
    const finalTasks = rt.ledger.listTasks(plan.plan_work_item.id);
    const t1 = finalTasks.find((t) => t.title === "implement add");
    const t2 = finalTasks.find((t) => t.title === "implement subtract");
    assert.ok(t1 && t2);
    assert.equal(t1.status, "failed"); // add failed its own pipeline run
    assert.equal(t2.status, "blocked"); // subtract blocked because add failed
    assert.ok(!t2.result_work_item_id, "blocked task must not be linked to a result work item");
  } finally {
    await fixture.cleanup();
  }
});

test("executePlan is idempotent: re-running does not re-execute completed tasks", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let implInvocations = 0;
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
          ],
        },
      }),
      scout: () => ({ status: "completed", summary: "scouted", details: {} }),
      implementer: async (req) => {
        implInvocations += 1;
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const plan = await rt.plan("add");
    const first = await rt.executePlan(plan.plan_work_item.id);
    assert.equal(first.outcome, "completed");
    assert.equal(implInvocations, 1);
    const link = rt.ledger.listTasks(plan.plan_work_item.id)[0]!.result_work_item_id;

    const second = await rt.executePlan(plan.plan_work_item.id);
    assert.equal(second.outcome, "completed");
    assert.equal(implInvocations, 1, "completed task must not be re-executed");
    const after = rt.ledger.listTasks(plan.plan_work_item.id)[0]!;
    assert.equal(after.result_work_item_id, link, "result link must be preserved on re-run");
  } finally {
    await fixture.cleanup();
  }
});

test("plan records a diagnostic when the planner returns more than 10 tasks or invalid deps", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `task ${i}`,
      kind: "implementation" as const,
      risk: "low" as const,
      depends_on: [999], // invalid index, dropped with a recorded finding
      scope_paths: [`src/t${i}.js`],
    }));
    const worker = new FakeWorkerExecutor({
      planner: () => ({ status: "completed", summary: "planned", details: { tasks: many } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const plan = await rt.plan("big goal");
    assert.equal(plan.outcome, "planned");
    assert.equal(plan.tasks.length, 10, "truncated to the 10-task cap");
    const decisions = rt.ledger.listEntities("decision").filter((d) => d.claim.includes("truncated to 10"));
    assert.ok(decisions.length >= 1, "truncation must be recorded as a decision, not silently dropped");
    const findings = rt.ledger.listEntities("finding").filter((f) => f.claim.includes("invalid depends_on"));
    assert.ok(findings.length >= 1, "invalid depends_on must be recorded as a finding");
  } finally {
    await fixture.cleanup();
  }
});

test("executePlan throws on an unknown plan id", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({});
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    await assert.rejects(() => rt.executePlan("WI-does-not-exist"), /Unknown plan work item/);
  } finally {
    await fixture.cleanup();
  }
});
