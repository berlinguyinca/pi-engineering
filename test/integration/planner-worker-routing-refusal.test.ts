import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import type { CatalogModel } from "../../src/plannerWorker/gateway.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { DEFAULT_ROLE_CONFIG } from "../../src/plannerWorker/roles.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const candidate: CatalogModel = {
  id: "rejected-default",
  alias: false,
  aliases: [],
  capabilities: [],
  modalities: ["text"],
  contextWindow: 4096,
  tools: false,
  state: "hot",
};

for (const role of ["planner", "implementer", "reviewer"] as const) {
  test(`public mission never dispatches a rejected ${role} through the worker default`, async (t) => {
    const fixture = await makeFixtureRepo();
    t.after(fixture.cleanup);
    const requests: WorkerRequest[] = [];
    const routedRoles: string[] = [];
    const resolver = new RoleResolver({
      provider: "gw",
      catalog: [candidate],
      config: { ...DEFAULT_ROLE_CONFIG, [role]: { ...DEFAULT_ROLE_CONFIG[role], min_context: 128_000, tools: true } },
      fallback: async (requested) => {
        routedRoles.push(requested);
        return { provider: "gw", id: requested === role ? candidate.id : "allowed" };
      },
    });
    const executor = new PlannerWorkerExecutor({
      repoRoot: fixture.root,
      stateDir: join(fixture.root, ".state", role),
      resolver,
      worker: {
        async run(req) {
          requests.push(req);
          if (req.role === "planner") {
            return {
              result: {
                status: "completed",
                summary: "plan",
                claims: [],
                evidence_refs: [],
                new_hypotheses: [],
                proposed_tasks: [],
                details: {},
              },
              usage: null,
              structured: {
                decisions: [],
                contracts: [
                  {
                    task_id: "task",
                    objective: "Inspect the repository",
                    depends_on: [],
                    scope: { allowed: ["src/**"] },
                    acceptance: ["inspection completed"],
                    verification: ["true"],
                    risk: "medium",
                  },
                ],
              },
            };
          }
          return {
            result: {
              status: "completed",
              claims: [],
              evidence_refs: [],
              new_hypotheses: [],
              proposed_tasks: [],
              details: {},
              summary: JSON.stringify({ status: "completed", summary: "inspected", files: [] }),
            },
            usage: null,
          };
        },
      },
    });
    // A rejected role may fail its contract or reject the mission. Neither is
    // permitted to reach a worker with an implicit, already-rejected default.
    await executor
      .run({
        mission_id: `refuse-${role}`,
        summary: "routing refusal",
        architectural_context: [],
        acceptance_criteria: [],
        constraints: [],
      })
      .catch(() => undefined);
    assert.ok(routedRoles.includes(role), `mission must reach ${role} routing`);
    const rejected = requests.filter((req) => req.role === role);
    assert.equal(
      rejected.length,
      0,
      `${role} dispatched with ${JSON.stringify(rejected.map((req) => req.modelOverride))}`,
    );
    if (role !== "planner") assert.ok(requests.some((req) => req.role === "planner"));
  });
}

test("no-catalog standalone mission still dispatches its configured worker default", async (t) => {
  const fixture = await makeFixtureRepo();
  t.after(fixture.cleanup);
  const requests: WorkerRequest[] = [];
  const executor = new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".state", "standalone"),
    resolver: new RoleResolver({ provider: "standalone" }),
    worker: {
      async run(req) {
        requests.push(req);
        return {
          result: {
            status: "failed",
            summary: "stop after observing default dispatch",
            error: "test stop",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
          },
          usage: null,
        };
      },
    },
  });
  const report = await executor.run({
    mission_id: "standalone",
    summary: "standalone",
    architectural_context: [],
    acceptance_criteria: [],
    constraints: [],
  });
  assert.equal(report.status, "failed");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((req) => req.modelOverride === undefined));
});
