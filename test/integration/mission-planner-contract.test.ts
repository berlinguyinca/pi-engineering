import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/index.ts";
import { scopesOverlap } from "../../src/plan/taskDag.ts";
import { PLANNER_PROMPT } from "../../src/plannerWorker/prompts.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const PLAN = JSON.stringify({
  decisions: ["split by package"],
  contracts: [
    {
      task_id: "api",
      objective: "Add the REST endpoint in src/api",
      scope: { allowed: ["src/api/**"] },
      acceptance: ["endpoint responds"],
      verification: ["npm test -- api"],
      relevant_files: ["src/api/routes.ts"],
    },
    {
      task_id: "ui",
      objective: "Add the settings page in src/ui",
      scope: { allowed: ["src/ui/**"] },
      acceptance: ["page renders"],
      verification: ["npm test -- ui"],
      relevant_files: ["src/ui/Settings.tsx"],
    },
    {
      task_id: "docs",
      objective: "Document both in docs/",
      depends_on: ["api", "ui"],
      scope: { allowed: ["docs/**"] },
      acceptance: ["docs updated"],
      verification: ["true"],
      relevant_files: ["docs/usage.md"],
    },
  ],
});

const BIG_GOAL =
  "Add a REST endpoint under src/api for exporting reports, build a settings page under src/ui to trigger the export, and document both features in docs/usage.md with examples and migration notes for existing users.";

describe("mission planner contract", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let agentDir = "";
  const saved = process.env.PI_MISSION_PLANNER;
  before(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-eng-agentdir-"));
  });
  after(async () => {
    if (saved === undefined) process.env.PI_MISSION_PLANNER = undefined;
    for (const c of cleanups) await c().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });

  async function plan(goal: string, plannerReply: string | undefined) {
    const fx = await makeFixtureRepo();
    cleanups.push(fx.cleanup);
    const calls: WorkerRequest[] = [];
    const worker = new FakeWorkerExecutor({
      planner: (req) => {
        calls.push(req);
        return { summary: plannerReply ?? "" };
      },
    });
    const runtime = await EngineeringRuntime.open({ cwd: fx.root, agentDir, worker });
    const mission = runtime.missionStore!.createMission({
      title: "t",
      goal,
      user_request: goal,
      repository: fx.root,
      base_ref: "HEAD",
      risk_profile: {} as never,
      workflow_class: "engineering",
    });
    const tasks = await runtime.missionPlanner!(runtime.missionStore!.getMission(mission.mission_id)!, {} as never);
    return { tasks, calls, runtime, mission };
  }

  it("non-trivial goal yields a DAG with disjoint parallel domains and contextRef", async () => {
    const { tasks, calls } = await plan(BIG_GOAL, PLAN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.role, "planner");
    assert.ok(calls[0]?.task.includes(PLANNER_PROMPT));
    assert.equal(tasks.length, 3);
    const [api, ui, docs] = tasks;
    assert.deepEqual(api?.write_domains, ["src/api/**"]);
    assert.equal(scopesOverlap("src/api", "src/ui"), false);
    assert.deepEqual(api?.depends_on, []);
    assert.deepEqual(ui?.depends_on, []);
    assert.equal(docs?.depends_on.length, 2);
    for (const t of tasks) {
      assert.match(t.context_ref ?? "", /relevant_files/);
      assert.match(t.context_ref ?? "", /verification/);
    }
  });

  it("serializes tasks whose write domains overlap", async () => {
    const overlapping = JSON.stringify({
      contracts: [
        { task_id: "a", objective: "one", scope: { allowed: ["src/**"] }, acceptance: ["x"], verification: ["true"] },
        {
          task_id: "b",
          objective: "two",
          scope: { allowed: ["src/api/**"] },
          acceptance: ["y"],
          verification: ["true"],
        },
      ],
    });
    const { tasks } = await plan(BIG_GOAL, overlapping);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]?.depends_on.length, 1);
  });

  it("trivial goal keeps the single task without a planner call", async () => {
    const { tasks, calls } = await plan("Fix the typo in README", PLAN);
    assert.equal(calls.length, 0);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
  });

  it("malformed plan falls back to one task and records a finding", async () => {
    const { tasks, calls, runtime, mission } = await plan(BIG_GOAL, "I could not produce JSON, sorry");
    assert.equal(calls.length, 1);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
    const finding = runtime
      .missionStore!.listFindings(mission.mission_id)
      .find((f) => f.category === "mission_planner");
    assert.ok(finding, "fallback is recorded as a finding");
    assert.notEqual(finding.severity, "blocking");
  });

  it("PI_MISSION_PLANNER=off never calls the planner", async () => {
    process.env.PI_MISSION_PLANNER = "off";
    try {
      const { tasks, calls } = await plan(BIG_GOAL, PLAN);
      assert.equal(calls.length, 0);
      assert.equal(tasks.length, 1);
    } finally {
      process.env.PI_MISSION_PLANNER = undefined;
    }
  });
});
