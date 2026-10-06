import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { WORKER_INSTRUCTION, buildHandoff, renderHandoff } from "../../src/plannerWorker/handoff.ts";
import { runPlanner } from "../../src/plannerWorker/planner.ts";
import type { MissionBrief } from "../../src/plannerWorker/types.ts";
import { type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

const servers: GatewayServer[] = [];
const dirs: string[] = [];
after(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const brief: MissionBrief = {
  mission_id: "M1",
  summary: "Add a greeting module and its tests.",
  architectural_context: ["plain ESM modules under src/"],
  acceptance_criteria: ["greet() returns a greeting"],
  constraints: ["no new dependencies"],
};

const SECRET_REASONING = "PLANNER-PRIVATE-REASONING-7f3a";

const goodPlan = {
  decisions: ["keep greet pure"],
  architectural_context: ["src/greet.mjs exports greet"],
  contracts: [
    {
      task_id: "greet-1",
      objective: "Create src/greet.mjs exporting greet(name)",
      depends_on: [],
      scope: { allowed: ["src/**"] },
      acceptance: ["greet('a') returns 'hello a'"],
      verification: ["node -e \"import('./src/greet.mjs')\""],
      constraints: ["no dependencies"],
      risk: "low",
      relevant_files: ["src/greet.mjs"],
    },
    {
      task_id: "greet-2",
      objective: "Add a test for greet",
      depends_on: ["greet-1"],
      scope: { allowed: ["test/**"] },
      acceptance: ["test passes"],
      verification: ["node --test test"],
      risk: "medium",
    },
  ],
};

test("runPlanner retries invalid planner output with validation feedback, then yields a contract DAG", async () => {
  const server = await startGatewayServer({
    respond: (_req, i) =>
      i === 0
        ? { content: JSON.stringify({ contracts: [{ ...goodPlan.contracts[0], scope: { allowed: ["**"] } }] }) }
        : {
            content: `${SECRET_REASONING}: I considered many designs.\n\`\`\`json\n${JSON.stringify(goodPlan)}\n\`\`\``,
          },
  });
  servers.push(server);
  const cwd = await mkdtemp(join(tmpdir(), "pw-planner-"));
  dirs.push(cwd);
  const worker = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "coding-planning" });
  const result = await runPlanner({ worker, brief, cwd, model: { provider: "iw", id: "coding-planning" } });
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  assert.equal(result.plan.contracts.length, 2);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0]?.model, "coding-planning");
  assert.match(server.requests[1]?.user ?? "", /rejected by validation/);
  assert.match(server.requests[1]?.user ?? "", /unbounded/);
  assert.match(result.transcript, new RegExp(SECRET_REASONING));

  // The implementer handoff carries the contract and dependency results — never the planner transcript.
  const contract = result.plan.contracts[1]!;
  const handoff = buildHandoff({
    kind: "planner_to_worker",
    brief,
    plan: result.plan,
    contract,
    from: "planner",
    to: "implementer",
    dependencies: [
      { task_id: "greet-1", summary: "created src/greet.mjs", changed_files: ["src/greet.mjs"] },
      { task_id: "unrelated", summary: "should not appear", changed_files: [] },
    ],
  });
  const text = renderHandoff(handoff);
  assert.doesNotMatch(text, new RegExp(SECRET_REASONING));
  assert.doesNotMatch(text, /should not appear/);
  assert.match(text, /created src\/greet\.mjs/);
  assert.match(text, /Add a test for greet/);
  assert.match(text, /keep greet pure/);
  assert.ok(handoff.token_estimate > 0 && handoff.token_estimate < 2000);
  assert.match(WORKER_INSTRUCTION, /Do not redesign or re-plan/);
});

test("runPlanner gives up after bounded attempts when the planner never produces a valid DAG", async () => {
  const server = await startGatewayServer({
    respond: () => ({
      content: JSON.stringify({
        contracts: [
          { ...goodPlan.contracts[0], task_id: "a", depends_on: ["b"] },
          { ...goodPlan.contracts[0], task_id: "b", depends_on: ["a"] },
        ],
      }),
    }),
  });
  servers.push(server);
  const cwd = await mkdtemp(join(tmpdir(), "pw-planner-"));
  dirs.push(cwd);
  const worker = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "m" });
  const result = await runPlanner({ worker, brief, cwd, maxAttempts: 3 });
  assert.equal(result.ok, false);
  assert.equal(server.requests.length, 3);
  assert.match(result.ok ? "" : result.errors.join(" "), /cycle/);
});

test("the gateway executor writes an implementer's files inside its worktree only", async () => {
  const server = await startGatewayServer({
    respond: () => ({
      content: JSON.stringify({
        status: "completed",
        summary: "done",
        files: [
          { path: "src/greet.mjs", content: "export const greet = (n) => `hello ${n}`;\n" },
          { path: "../escape.txt", content: "no" },
          { path: "/etc/evil", content: "no" },
        ],
      }),
      usage: { prompt_tokens: 120, completion_tokens: 30, cached_tokens: 64 },
      servedModel: "backing-model-x",
    }),
  });
  servers.push(server);
  const cwd = await mkdtemp(join(tmpdir(), "pw-impl-"));
  dirs.push(cwd);
  const worker = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "coding-implementation" });
  const run = await worker.run({ role: "implementer", task: "do it", tools: ["read", "write"], cwd });
  assert.equal(run.result.status, "completed");
  assert.deepEqual(run.result.details.files_written, ["src/greet.mjs"]);
  assert.match(await readFile(join(cwd, "src/greet.mjs"), "utf8"), /hello/);
  assert.equal(run.usage?.cacheRead, 64);
  assert.equal(run.usage?.model, "backing-model-x");
});
