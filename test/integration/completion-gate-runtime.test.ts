import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { formatWorkStatus } from "../../src/work/statusText.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

let stateDir = "";
let agentDir = "";
let prior: string | undefined;
before(() => {
  // Never touch the developer's real runtime state.
  stateDir = mkdtempSync(join(tmpdir(), "pi-gate-state-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-gate-agent-"));
  prior = process.env.PI_ENGINEERING_STATE_DIR;
  process.env.PI_ENGINEERING_STATE_DIR = stateDir;
});
after(() => {
  if (prior === undefined) delete process.env.PI_ENGINEERING_STATE_DIR;
  else process.env.PI_ENGINEERING_STATE_DIR = prior;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

function plannedWorker(rtRef: { rt?: EngineeringRuntime }, strand: boolean): FakeWorkerExecutor {
  return new FakeWorkerExecutor({
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
      writeFileSync(join(req.cwd, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
      return { status: "completed", summary: "implemented", details: {} };
    },
    reviewer: async () => {
      const rt = rtRef.rt!;
      const wi = rt.ledger.listWorkItems().at(-1)!;
      // A run that started and never reported back, on the work item being engineered.
      if (strand)
        await rt.ledger.emitEvent(
          "agent.started",
          wi.id,
          { type: "agent", run_id: "stranded-run" },
          {},
          {
            task_id: wi.id,
            run_id: "stranded-run",
          },
        );
      return { status: "completed", summary: "clean", details: { findings: [] } };
    },
  });
}

test("a task is not settled complete while one of its runs is still live; /work says why", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const ref: { rt?: EngineeringRuntime } = {};
    ref.rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      agentDir,
      worker: plannedWorker(ref, true),
      verifier: new CommandVerifier(),
    });
    const rt = ref.rt;
    assert.ok(rt.transitions.authorityGeneration >= 1);
    const plan = await rt.plan("add");
    const report = await rt.executePlan(plan.plan_work_item.id);
    const task = rt.ledger.listTasks(plan.plan_work_item.id)[0]!;
    assert.equal(task.status, "blocked");
    assert.match(task.blocked_reason ?? "", /stranded-run is active/);
    assert.notEqual(report.outcome, "completed");
    const result = rt.ledger.getWorkItem(task.result_work_item_id!);
    assert.equal(result?.status, "BLOCKED");
    const text = formatWorkStatus(new LedgerWorkProjection(rt.ledger).graph(), 50);
    assert.match(text, /blocked: .*stranded-run is active/);
  } finally {
    await fixture.cleanup();
  }
});

test("execution.strict_completion: false in YAML restores unchecked completion", async () => {
  const fixture = await makeFixtureRepo();
  try {
    mkdirSync(join(fixture.root, ".pi"), { recursive: true });
    writeFileSync(join(fixture.root, ".pi", "engineering.yaml"), "execution:\n  strict_completion: false\n");
    const ref: { rt?: EngineeringRuntime } = {};
    ref.rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      agentDir,
      worker: plannedWorker(ref, true),
      verifier: new CommandVerifier(),
    });
    const plan = await ref.rt.plan("add");
    const report = await ref.rt.executePlan(plan.plan_work_item.id);
    assert.equal(report.outcome, "completed");
    assert.equal(ref.rt.ledger.listTasks(plan.plan_work_item.id)[0]!.status, "completed");
  } finally {
    await fixture.cleanup();
  }
});

test("a clean run completes exactly as before, and a second runtime gets a higher generation", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const ref: { rt?: EngineeringRuntime } = {};
    ref.rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      agentDir,
      worker: plannedWorker(ref, false),
      verifier: new CommandVerifier(),
    });
    const plan = await ref.rt.plan("add");
    const report = await ref.rt.executePlan(plan.plan_work_item.id);
    assert.equal(report.outcome, "completed");
    assert.equal(ref.rt.ledger.listTasks(plan.plan_work_item.id)[0]!.status, "completed");
    const second = await EngineeringRuntime.open({ cwd: fixture.root, agentDir, worker: plannedWorker({}, false) });
    assert.ok(second.transitions.authorityGeneration > ref.rt.transitions.authorityGeneration);
  } finally {
    await fixture.cleanup();
  }
});
