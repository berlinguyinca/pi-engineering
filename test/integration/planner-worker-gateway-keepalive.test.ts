/**
 * A gateway worker's chat completion is non-streaming: nothing arrives until
 * the whole answer does. The in-flight request is itself the worker's sign of
 * life — while its connection is open the worker reports activity, so a long
 * generation is not mistaken for a hung worker. The keepalive is bounded
 * (default the gateway's 12 h request horizon) so a wedged connection still
 * ends up judged by inactivity.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { startGatewayServer } from "../support/gatewayServer.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const CATALOG = [
  { id: "flash-a", x_capabilities: ["coding.planning", "coding.review"], x_context_window: 131072, x_state: "hot" },
  { id: "big-b", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
];

async function slowImplementerMission(worker: { keepaliveIntervalMs: number; keepaliveLimitMs?: number }) {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  let implementations = 0;
  const server = await startGatewayServer({
    models: CATALOG,
    respond: async (req) => {
      if (req.system.startsWith("You are the PLANNER")) {
        return {
          content: JSON.stringify({
            contracts: [
              {
                task_id: "alpha",
                objective: "write alpha",
                depends_on: [],
                scope: { allowed: ["src/alpha/**"] },
                acceptance: ["alpha exists"],
                verification: ["test -f src/alpha/done.txt"],
              },
            ],
          }),
        };
      }
      if (req.system.startsWith("You are an IMPLEMENTER")) {
        implementations++;
        // A long non-streaming generation: nothing on the wire for 2 s.
        await new Promise((r) => setTimeout(r, 2_000));
        return {
          content: JSON.stringify({
            status: "completed",
            summary: "did alpha",
            files: [{ path: "src/alpha/done.txt", content: "alpha" }],
          }),
        };
      }
      return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
    },
  });
  cleanups.push(() => server.close());
  const conn = { baseUrl: server.baseUrl };
  const report = await new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".pi-eng", "planner-worker", "PW-slow"),
    worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a", ...worker }),
    resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
    workerInactivityMs: 600,
    ladder: { max_local_attempts: 1, max_diagnosed_attempts: 0, max_escalation_attempts: 0, max_replans: 0 },
  }).run({
    mission_id: "PW-slow",
    summary: "write alpha",
    architectural_context: [],
    acceptance_criteria: [],
    constraints: [],
  });
  return { report, implementations: () => implementations };
}

test("a non-streaming completion longer than the inactivity window keeps its worker alive", async () => {
  const { report, implementations } = await slowImplementerMission({ keepaliveIntervalMs: 100 });
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(implementations(), 1, "the slow answer was waited for, not aborted and retried");
});

test("the in-flight keepalive is bounded, so a wedged request is still judged by inactivity", async () => {
  const { report } = await slowImplementerMission({ keepaliveIntervalMs: 100, keepaliveLimitMs: 200 });
  assert.notEqual(report.status, "completed", "keepalive stopped after its bound and the watchdog fired");
});
