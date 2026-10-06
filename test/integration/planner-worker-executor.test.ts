/**
 * End-to-end planner/worker execution against a real git repository, real
 * verification child processes and a real local HTTP gateway whose replies
 * are scripted per role.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PlannerWorkerExecutor, runVerification } from "../../src/plannerWorker/executor.ts";
import { RouteEventFollower, fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import type { MissionBrief } from "../../src/plannerWorker/types.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import {
  type ChatRequestRecord,
  type GatewayServer,
  type ScriptedReply,
  inferweaveRefusal,
  startGatewayServer,
} from "../support/gatewayServer.ts";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const CATALOG = [
  {
    id: "flash-a",
    x_capabilities: ["coding.planning", "coding.review", "coding.debugging", "coding.analysis"],
    x_context_window: 131072,
    x_state: "hot",
  },
  { id: "big-b", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
  { id: "frontier-c", x_capabilities: ["coding.escalation"], x_context_window: 262144, x_state: "warm" },
];

type Role = "planner" | "implementer" | "reviewer" | "debugger" | "replanner";

function roleOf(req: ChatRequestRecord): Role {
  if (req.system.includes("An implementer reported")) return "replanner";
  if (req.system.startsWith("You are the PLANNER")) return "planner";
  if (req.system.startsWith("You are an IMPLEMENTER")) return "implementer";
  if (req.system.startsWith("You are the REVIEWER")) return "reviewer";
  return "debugger";
}

function taskOf(req: ChatRequestRecord): string {
  return /task_id: ([\w.-]+)/.exec(req.user)?.[1] ?? "";
}

const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const ADD_BROKEN = "export function add(a, b) {\n  return a - b;\n}\n";
const pass = {
  content: JSON.stringify({ status: "pass", issues: [], required_changes: [], contract_violation: false }),
};

function contract(id: string, extra: Record<string, unknown> = {}) {
  return {
    task_id: id,
    objective: `objective ${id}`,
    depends_on: [],
    scope: { allowed: [`src/${id}/**`] },
    acceptance: [`${id} done`],
    verification: [`test -f src/${id}/done.txt`],
    risk: "medium",
    ...extra,
  };
}

const brief = (id: string): MissionBrief => ({
  mission_id: id,
  summary: `mission ${id}`,
  architectural_context: [],
  acceptance_criteria: [],
  constraints: [],
});

async function setup(
  respond: (req: ChatRequestRecord, i: number) => ScriptedReply | Promise<ScriptedReply>,
  routes?: Record<string, string>,
) {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const server: GatewayServer = await startGatewayServer({ models: CATALOG, respond, ...(routes ? { routes } : {}) });
  cleanups.push(() => server.close());
  const conn = { baseUrl: server.baseUrl };
  const resolver = new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) });
  const worker = new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" });
  const events: string[] = [];
  const executor = new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    worker,
    resolver,
    stateDir: join(fixture.root, ".pi-eng", "planner-worker", "M"),
    concurrency: 3,
    verificationTimeoutMs: 60_000,
    routeEvents: new RouteEventFollower(conn),
    onEvent: (e) => events.push(`${e.type}:${e.task_id ?? ""}:${e.status ?? ""}:${e.text}`),
  });
  return { fixture, server, executor, events };
}

test("plan -> parallel implement -> review -> integrate, with planner and implementer on different models", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { fixture, server, executor } = await setup(async (req) => {
    const role = roleOf(req);
    if (role === "planner") {
      return {
        content: JSON.stringify({
          decisions: ["one directory per contract"],
          contracts: [
            contract("alpha"),
            contract("beta"),
            contract("gamma", { risk: "low" }),
            contract("delta", { depends_on: ["alpha", "beta"] }),
          ],
        }),
      };
    }
    if (role === "implementer") {
      const id = taskOf(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      return {
        content: JSON.stringify({
          status: "completed",
          summary: `did ${id}`,
          files: [{ path: `src/${id}/done.txt`, content: id }],
        }),
      };
    }
    if (req.user.startsWith("BATCH REVIEW")) {
      return { content: JSON.stringify({ reviews: [{ task_id: "gamma", status: "pass" }] }) };
    }
    return pass;
  });
  const report = await executor.run(brief("M-par"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.deepEqual(report.contracts.map((c) => [c.contract.task_id, c.status]).sort(), [
    ["alpha", "passed"],
    ["beta", "passed"],
    ["delta", "passed"],
    ["gamma", "passed"],
  ]);
  assert.ok(maxInFlight >= 2, `independent contracts must run concurrently (max in flight ${maxInFlight})`);

  // Planner, implementer and reviewer resolved by capability; planner != implementer.
  const byRole = new Map<string, Set<string>>();
  for (const r of server.requests) {
    const set = byRole.get(roleOf(r)) ?? new Set();
    set.add(r.model);
    byRole.set(roleOf(r), set);
  }
  assert.deepEqual([...(byRole.get("planner") ?? [])], ["flash-a"]);
  assert.deepEqual([...(byRole.get("implementer") ?? [])], ["big-b"]);
  assert.deepEqual([...(byRole.get("reviewer") ?? [])], ["flash-a"]);

  // The implementer of a dependent contract sees dependency results, not the planner transcript.
  const deltaReq = server.requests.find((r) => roleOf(r) === "implementer" && taskOf(r) === "delta");
  assert.match(deltaReq?.user ?? "", /did alpha/);
  assert.match(deltaReq?.system ?? "", /Do not redesign or re-plan/);

  // Low-risk work was batch-reviewed; medium-risk work immediately.
  assert.equal(server.requests.filter((r) => r.user.startsWith("BATCH REVIEW")).length, 1);

  // Every role/model change is an explicit transition.
  assert.ok(report.transitions.some((t) => t.role === "planner" && t.to === "flash-a"));
  assert.ok(report.transitions.some((t) => t.role === "implementer" && t.to === "big-b" && t.context === "handoff"));

  // The integrated result reached the checkout.
  for (const id of ["alpha", "beta", "gamma", "delta"]) {
    assert.equal(await readFile(join(fixture.root, "src", id, "done.txt"), "utf8"), id);
  }
  const metrics = report.metrics.find((m) => m.role === "implementer" && m.model === "big-b");
  assert.equal(metrics?.accepted_tasks, 4);
  assert.ok((metrics?.prompt_tokens ?? 0) > 0);
  const state = JSON.parse(await readFile(join(fixture.root, ".pi-eng", "planner-worker", "M", "state.json"), "utf8"));
  assert.equal(state.status, "completed");
});

test("a failed review produces a bounded correction contract and the fix passes", async () => {
  let implementations = 0;
  const { fixture, server, executor } = await setup((req) => {
    const role = roleOf(req);
    if (role === "planner") {
      return {
        content: JSON.stringify({
          contracts: [
            {
              task_id: "add",
              objective: "implement add(a, b)",
              scope: { allowed: ["src/**"] },
              acceptance: ["add returns the sum"],
              verification: ["node --test"],
              risk: "medium",
            },
          ],
        }),
      };
    }
    if (role === "implementer") {
      implementations++;
      // First attempt: style issue the reviewer rejects. Second: what the correction asked for.
      const content = implementations === 1 ? `${ADD_OK}// TODO remove\n` : ADD_OK;
      return {
        content: JSON.stringify({ status: "completed", summary: "add", files: [{ path: "src/add.js", content }] }),
      };
    }
    if (req.user.includes("TODO remove")) {
      return {
        content: JSON.stringify({
          status: "needs_fix",
          issues: [{ severity: "major", summary: "leftover TODO comment" }],
          required_changes: ["delete the TODO comment in src/add.js"],
        }),
      };
    }
    return pass;
  });
  const report = await executor.run(brief("M-fix"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  const fixReq = server.requests.filter((r) => roleOf(r) === "implementer")[1];
  assert.match(fixReq?.user ?? "", /delete the TODO comment in src\/add\.js/);
  assert.match(fixReq?.user ?? "", /correction:/);
  assert.doesNotMatch(fixReq?.user ?? "", /fix the review comments/i);
  const add = report.contracts[0]!;
  assert.equal(add.attempt, 2);
  assert.deepEqual(
    add.history.map((h) => h.to),
    ["ready", "running", "reviewing", "needs_fix", "running", "reviewing", "passed"],
  );
  assert.equal(await readFile(join(fixture.root, "src", "add.js"), "utf8"), ADD_OK);
  const reviewerMetrics = report.metrics.find((m) => m.role === "implementer");
  assert.equal(reviewerMetrics?.review_failures, 1);
});

test("identical failures stall the local loop, trigger diagnosis and then frontier escalation", async () => {
  const { server, executor, events } = await setup((req) => {
    const role = roleOf(req);
    if (role === "planner") {
      return {
        content: JSON.stringify({
          contracts: [
            {
              task_id: "add",
              objective: "implement add(a, b)",
              scope: { allowed: ["src/**"] },
              acceptance: ["add returns the sum"],
              verification: ["node --test"],
            },
          ],
        }),
      };
    }
    if (role === "implementer") {
      // The local implementer keeps producing the same wrong code; the escalation model gets it right.
      const content = req.model === "frontier-c" ? ADD_OK : ADD_BROKEN;
      return {
        content: JSON.stringify({ status: "completed", summary: "add", files: [{ path: "src/add.js", content }] }),
      };
    }
    if (role === "debugger") {
      return {
        content: JSON.stringify({ diagnosis: "subtraction instead of addition", required_changes: ["use a + b"] }),
      };
    }
    return pass;
  });
  const report = await executor.run(brief("M-esc"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  const add = report.contracts[0]!;
  assert.equal(add.rung, "escalated");
  assert.equal(report.stalled_events.length, 1);
  assert.ok(report.stalled_events[0]!.reasons.includes("identical failure"));
  assert.ok(events.some((e) => e.includes("LOCAL_LOOP_STALLED")));
  const roles = server.requests.map((r) => `${roleOf(r)}@${r.model}`);
  assert.ok(roles.includes("debugger@flash-a"), roles.join(","));
  assert.ok(roles.includes("implementer@frontier-c"), roles.join(","));
  const debugIndex = roles.indexOf("debugger@flash-a");
  const escIndex = roles.indexOf("implementer@frontier-c");
  assert.ok(debugIndex < escIndex, "diagnosis precedes escalation");
  assert.ok(report.transitions.some((t) => t.role === "escalation" && t.to === "frontier-c"));
  assert.equal(report.metrics.find((m) => m.role === "fixer")?.escalations, 1);
});

test("BLOCKED with evidence replans the DAG instead of silently redesigning", async () => {
  const { fixture, server, executor } = await setup((req) => {
    const role = roleOf(req);
    if (role === "planner") return { content: JSON.stringify({ contracts: [contract("impossible")] }) };
    if (role === "replanner") return { content: JSON.stringify({ contracts: [contract("possible")] }) };
    if (role === "implementer") {
      if (taskOf(req) === "impossible") {
        return {
          content: JSON.stringify({
            status: "blocked",
            summary: "cannot",
            evidence: "src/impossible requires an API that does not exist in this repo",
          }),
        };
      }
      return {
        content: JSON.stringify({
          status: "completed",
          summary: "ok",
          files: [{ path: "src/possible/done.txt", content: "possible" }],
        }),
      };
    }
    return pass;
  });
  const report = await executor.run(brief("M-replan"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(report.replans, 1);
  assert.deepEqual(
    report.contracts.map((c) => c.contract.task_id),
    ["possible"],
  );
  const replanReq = server.requests.find((r) => roleOf(r) === "replanner");
  assert.match(replanReq?.user ?? "", /API that does not exist/);
  assert.equal(await readFile(join(fixture.root, "src", "possible", "done.txt"), "utf8"), "possible");
});

test("an unavailable implementer route fails over to a gateway candidate without restarting", async () => {
  const { server, executor } = await setup((req) => {
    const role = roleOf(req);
    if (role === "planner") return { content: JSON.stringify({ contracts: [contract("one")] }) };
    if (role === "implementer" && req.model === "big-b") {
      // InferWeave's refusal: protocol code kept, availability additive.
      return inferweaveRefusal({
        code: "capacity_unavailable",
        availability: "NODE_LOST",
        message: "big-b lost its node",
        candidates: [
          { id: "big-b2", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
        ],
      });
    }
    if (role === "implementer") {
      return {
        content: JSON.stringify({
          status: "completed",
          summary: "ok",
          files: [{ path: "src/one/done.txt", content: "one" }],
        }),
      };
    }
    return pass;
  });
  const report = await executor.run(brief("M-failover"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  const implModels = server.requests.filter((r) => roleOf(r) === "implementer").map((r) => r.model);
  assert.deepEqual(implModels, ["big-b", "big-b2"]);
  assert.ok(
    report.transitions.some((t) => t.reason === "failover:NODE_LOST" && t.from === "big-b" && t.to === "big-b2"),
  );
});

test("the checkout is left alone when it moved during the mission", async () => {
  const { fixture, executor } = await setup(async (req) => {
    const role = roleOf(req);
    if (role === "planner") return { content: JSON.stringify({ contracts: [contract("solo")] }) };
    if (role === "implementer") {
      return {
        content: JSON.stringify({
          status: "completed",
          summary: "ok",
          files: [{ path: "src/solo/done.txt", content: "solo" }],
        }),
      };
    }
    return pass;
  });
  // Dirty the operator's checkout: the result must stay on the mission branch.
  await exec("sh", ["-c", "echo local > src/add.js"], { cwd: fixture.root });
  const report = await executor.run(brief("M-dirty"));
  assert.equal(report.status, "completed");
  await assert.rejects(readFile(join(fixture.root, "src", "solo", "done.txt"), "utf8"));
  const branch = await exec("git", ["-C", fixture.root, "show", "pi-eng-pw-M-dirty:src/solo/done.txt"]);
  assert.equal(branch.stdout, "solo");
});

test("long task ids never share a branch, and a rejecting pre-commit hook cannot drop an attempt", async () => {
  const long = "x".repeat(50);
  const ids = [`${long}-one`, `${long}-two`];
  const { fixture, executor } = await setup((req) => {
    const role = roleOf(req);
    if (role === "planner") {
      return {
        content: JSON.stringify({
          contracts: ids.map((id, i) => ({
            ...contract(id),
            scope: { allowed: [`src/p${i}/**`] },
            verification: [`test -f src/p${i}/done.txt`],
          })),
        }),
      };
    }
    if (role === "implementer") {
      const i = ids.indexOf(taskOf(req));
      return {
        content: JSON.stringify({
          status: "completed",
          summary: "ok",
          files: [{ path: `src/p${i}/done.txt`, content: String(i) }],
        }),
      };
    }
    return pass;
  });
  await mkdir(join(fixture.root, ".git", "hooks"), { recursive: true });
  await writeFile(join(fixture.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
  await chmod(join(fixture.root, ".git", "hooks", "pre-commit"), 0o755);
  const report = await executor.run(brief("M-long"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(await readFile(join(fixture.root, "src", "p0", "done.txt"), "utf8"), "0");
  assert.equal(await readFile(join(fixture.root, "src", "p1", "done.txt"), "utf8"), "1");
  // Contract and review branches are cleaned up; nothing is left but the checkout's own branch.
  const branches = await exec("git", ["-C", fixture.root, "branch", "--list", "pi-eng-pw-*"]);
  assert.equal(branches.stdout.trim(), "");
});

test("verification commands come from model output and never see credentials", async () => {
  process.env.PW_TEST_API_TOKEN = "secret";
  try {
    const run = await runVerification('test -z "$PW_TEST_API_TOKEN" && test -n "$PATH"', process.cwd());
    assert.equal(run.passed, true, run.output_tail);
  } finally {
    delete process.env.PW_TEST_API_TOKEN;
  }
});

test("a hot swap of the implementation route mid-mission is logged and followed without a restart", async () => {
  let server: GatewayServer | null = null;
  const { executor, server: srv } = await setup(
    (req) => {
      const role = roleOf(req);
      if (role === "planner") {
        return {
          content: JSON.stringify({ contracts: [contract("first"), contract("second", { depends_on: ["first"] })] }),
        };
      }
      if (role === "implementer") {
        const id = taskOf(req);
        // The operator re-binds the route while `first` is in flight: it stays pinned.
        if (id === "first") server?.rebind("coding-implementation", "big-b2");
        return {
          content: JSON.stringify({
            status: "completed",
            summary: id,
            files: [{ path: `src/${id}/done.txt`, content: id }],
          }),
        };
      }
      return pass;
    },
    { "coding-implementation": "big-b" },
  );
  server = srv;
  srv.setModels([
    ...CATALOG,
    { id: "big-b2", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
  ]);
  const report = await executor.run(brief("M-swap"));
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  const impl = srv.requests.filter((r) => roleOf(r) === "implementer");
  assert.deepEqual(
    impl.map((r) => [r.model, r.resolved]),
    [
      ["coding-implementation", "big-b"],
      ["coding-implementation", "big-b2"],
    ],
  );
  const swaps = report.transitions.filter((t) => t.from === "big-b" && t.to === "big-b2");
  assert.equal(swaps.length, 1, JSON.stringify(report.transitions));
  assert.equal(swaps[0]?.reason, "MODEL_ROUTE_CHANGED");
});
