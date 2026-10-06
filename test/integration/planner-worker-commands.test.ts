import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPlannerWorkerConfig, parsePlannerWorkerConfig, plannerWorkerDir } from "../../src/plannerWorker/config.ts";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { engineeringCommand } from "../../src/plannerWorker/extension.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { chooseExecutionMode, isNontrivialMission } from "../../src/plannerWorker/mode.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const CATALOG = [
  { id: "flash-a", x_capabilities: ["coding.planning", "coding.review"], ctx_per_request: 131072 },
  { id: "big-b", x_capabilities: ["coding.implementation"], ctx_per_request: 262144 },
];

test("planner_worker config: defaults, overrides and actionable issues", async () => {
  const defaults = parsePlannerWorkerConfig(undefined);
  assert.equal(defaults.mode, "auto");
  assert.equal(defaults.roles.implementer.capability, "coding.implementation");
  assert.equal(defaults.ladder.max_local_attempts, 2);
  assert.deepEqual(defaults.issues, []);

  const custom = parsePlannerWorkerConfig({
    mode: "planner-worker",
    provider: "iw",
    concurrency: 4,
    roles: { implementer: { alias: "impl-route", preferred_family: "next-gen" }, wizard: {} },
    escalation: { max_local_attempts: 0, max_replans: 5 },
  });
  assert.equal(custom.mode, "planner-worker");
  assert.equal(custom.provider, "iw");
  assert.equal(custom.roles.implementer.alias, "impl-route");
  assert.equal(custom.roles.implementer.capability, "coding.implementation");
  assert.equal(custom.ladder.max_local_attempts, 2, "invalid value falls back");
  assert.equal(custom.ladder.max_replans, 5);
  assert.equal(custom.issues.length, 2);

  // Read from the repository's layered .pi/engineering.yaml.
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  await mkdir(join(fixture.root, ".pi"), { recursive: true });
  await writeFile(join(fixture.root, ".pi", "engineering.yaml"), "planner_worker:\n  mode: single\n  concurrency: 3\n");
  const loaded = await loadPlannerWorkerConfig(fixture.root, join(fixture.root, "no-agent-dir"));
  assert.equal(loaded.mode, "single");
  assert.equal(loaded.concurrency, 3);
});

test("auto selects planner-worker only for nontrivial missions on a gateway that advertises distinct roles", async () => {
  assert.equal(isNontrivialMission("what does add do?").nontrivial, false);
  assert.equal(isNontrivialMission("fix typo").nontrivial, false);
  assert.equal(
    isNontrivialMission("Implement refresh-token rotation in the auth service and add tests for expiry").nontrivial,
    true,
  );
  const server: GatewayServer = await startGatewayServer({ models: CATALOG, respond: () => ({ content: "" }) });
  cleanups.push(() => server.close());
  const resolver = new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog({ baseUrl: server.baseUrl }) });
  const goal = "Implement refresh-token rotation in the auth service and add tests for expiry";
  assert.equal((await chooseExecutionMode("auto", goal, resolver)).mode, "planner-worker");
  assert.equal((await chooseExecutionMode("auto", "explain the code", resolver)).mode, "single");
  assert.equal((await chooseExecutionMode("single", goal, resolver)).mode, "single");

  // A plain gateway (no capabilities) keeps the existing single-model workflow under auto…
  server.setModels([{ id: "only-model", ctx_per_request: 32768 }]);
  const plain = new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog({ baseUrl: server.baseUrl }) });
  const decision = await chooseExecutionMode("auto", goal, plain);
  assert.equal(decision.mode, "single");
  assert.match(decision.reason, /does not advertise/);
  // …and one model for every role cannot separate planning from implementation.
  server.setModels([
    { id: "solo", x_capabilities: ["coding.planning", "coding.implementation"], ctx_per_request: 32768 },
  ]);
  const solo = new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog({ baseUrl: server.baseUrl }) });
  assert.match((await chooseExecutionMode("auto", goal, solo)).reason, /no distinct planner and implementer/);
  // The operator can still force it.
  assert.equal((await chooseExecutionMode("planner-worker", "x", solo)).mode, "planner-worker");
});

test("/engineering-mode persists the mode; status, plan and workers render a real mission's state", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const config = parsePlannerWorkerConfig(undefined);
  const root = fixture.root;
  assert.match((await engineeringCommand("status", "", root, config)).text, /No planner-worker mission/);
  assert.equal((await engineeringCommand("mode", "bogus", root, config)).level, "error");
  assert.match((await engineeringCommand("mode", "planner-worker", root, config)).text, /set to planner-worker/);
  assert.match((await engineeringCommand("mode", "", root, config)).text, /engineering mode: planner-worker/);

  const server = await startGatewayServer({
    models: CATALOG,
    respond: (req) => {
      if (req.system.startsWith("You are the PLANNER")) {
        return {
          content: JSON.stringify({
            decisions: ["keep it small"],
            contracts: [
              {
                task_id: "one",
                objective: "write one",
                scope: { allowed: ["src/one/**"] },
                acceptance: ["exists"],
                verification: ["test -f src/one/x"],
              },
              {
                task_id: "two",
                objective: "write two",
                depends_on: ["one"],
                scope: { allowed: ["src/two/**"] },
                acceptance: ["exists"],
                verification: ["test -f src/two/x"],
              },
            ],
          }),
        };
      }
      if (req.system.startsWith("You are an IMPLEMENTER")) {
        const id = /task_id: (\w+)/.exec(req.user)?.[1] ?? "x";
        return {
          content: JSON.stringify({ status: "completed", summary: id, files: [{ path: `src/${id}/x`, content: id }] }),
          usage: { prompt_tokens: 900, completion_tokens: 80, cached_tokens: 300 },
        };
      }
      return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
    },
  });
  cleanups.push(() => server.close());
  const conn = { baseUrl: server.baseUrl };
  const executor = new PlannerWorkerExecutor({
    repoRoot: root,
    worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
    resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
    stateDir: join(plannerWorkerDir(root), "PW-1"),
  });
  const report = await executor.run({
    mission_id: "PW-1",
    summary: "two files",
    architectural_context: [],
    acceptance_criteria: [],
    constraints: [],
  });
  assert.equal(report.status, "completed", report.failure_reason ?? "");

  const status = (await engineeringCommand("status", "", root, config)).text;
  assert.match(status, /Mission: PW-1 \[completed\] {2}mode=planner-worker/);
  assert.match(status, /Planner:\n {2}flash-a\n {2}complete/);
  assert.match(status, /one → big-b → passed/);
  assert.match(status, /Reviewer:\n {2}flash-a\n {2}idle/);
  assert.match(status, /Local attempts: 2/);
  assert.match(status, /Escalations: 0/);

  const plan = (await engineeringCommand("plan", "", root, config)).text;
  assert.match(plan, /Layer 1:\n {2}\[passed\] one \(medium\) write one/);
  assert.match(plan, /after: one/);
  assert.match(plan, /Decisions: keep it small/);

  const workers = (await engineeringCommand("workers", "", root, config)).text;
  assert.match(workers, /implementer {2}big-b/);
  assert.match(workers, /MODEL_TRANSITION/);
  assert.match(workers, /planner: - → flash-a \(planning\)/);
  const implRow = report.metrics.find((m) => m.role === "implementer");
  assert.equal(implRow?.prompt_tokens, 1800);
  assert.equal(implRow?.cached_tokens, 600);
  assert.equal(implRow?.accepted_tasks, 2);
});
