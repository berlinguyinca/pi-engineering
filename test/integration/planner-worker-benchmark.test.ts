import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type BenchmarkTask,
  renderBenchmarkTable,
  runPlannerWorkerBenchmark,
} from "../../src/benchmark/PlannerWorkerBenchmark.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { type ChatRequestRecord, type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const TASK: BenchmarkTask = {
  id: "two-modules",
  kind: "multi-file",
  mission: "Create src/a.mjs exporting a = 1 and src/b.mjs exporting b = 2. Keep src/keep.mjs unchanged.",
  files: { "package.json": '{"type":"module"}\n', "src/keep.mjs": "export const keep = true;\n" },
  acceptance: ["test -f src/a.mjs", "test -f src/b.mjs"],
  regression: ["grep -q 'keep = true' src/keep.mjs"],
};

const FILES = {
  a: { path: "src/a.mjs", content: "export const a = 1;\n" },
  b: { path: "src/b.mjs", content: "export const b = 2;\n" },
};

function scripted(req: ChatRequestRecord, inFlight: { now: number; max: number }) {
  if (req.system.startsWith("You are the PLANNER")) {
    return {
      content: JSON.stringify({
        contracts: [
          {
            task_id: "a",
            objective: "create a",
            scope: { allowed: ["src/a.mjs"] },
            acceptance: ["a exists"],
            verification: ["test -f src/a.mjs"],
          },
          {
            task_id: "b",
            objective: "create b",
            scope: { allowed: ["src/b.mjs"] },
            acceptance: ["b exists"],
            verification: ["test -f src/b.mjs"],
          },
        ],
      }),
    };
  }
  if (req.system.startsWith("You are an IMPLEMENTER")) {
    const id = /task_id: (\w+)/.exec(req.user)?.[1];
    // Solo modes get the whole mission; the planner-model-alone run (B) forgets b.
    const files =
      id === "a" ? [FILES.a] : id === "b" ? [FILES.b] : req.model === "flash-a" ? [FILES.a] : [FILES.a, FILES.b];
    return { content: JSON.stringify({ status: "completed", summary: "ok", files }), delayMs: 120, track: inFlight };
  }
  return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
}

test("benchmark modes A-D run real repositories through a real gateway and report comparable metrics", async () => {
  const inFlight = { now: 0, max: 0 };
  const server: GatewayServer = await startGatewayServer({
    models: [
      {
        id: "flash-a",
        x_capabilities: ["coding.planning", "coding.review", "coding.debugging"],
        x_context_window: 131072,
      },
      { id: "big-b", x_capabilities: ["coding.implementation"], x_context_window: 262144 },
    ],
    respond: async (req) => {
      const reply = scripted(req, inFlight);
      if ("track" in reply) {
        inFlight.now++;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        await new Promise((r) => setTimeout(r, reply.delayMs));
        inFlight.now--;
        return { content: reply.content };
      }
      return reply;
    },
  });
  cleanups.push(() => server.close());
  const workDir = await mkdtemp(join(tmpdir(), "pwbench-test-"));
  cleanups.push(() => rm(workDir, { recursive: true, force: true }));
  const conn = { baseUrl: server.baseUrl };
  const catalog = await fetchCatalog(conn);
  const { runs, summaries } = await runPlannerWorkerBenchmark({
    worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
    resolver: () => new RoleResolver({ provider: "iw", catalog }),
    tasks: [TASK],
    workDir,
    soloAttempts: 1,
  });
  const byMode = new Map(runs.map((r) => [r.mode, r]));
  assert.deepEqual([...byMode.keys()], ["A", "B", "C", "D"]);

  // A: implementer model alone; B: planner model alone — chosen by role, not by name.
  assert.deepEqual(byMode.get("A")?.models, { implementer: "big-b" });
  assert.deepEqual(byMode.get("B")?.models, { planner: "flash-a" });
  assert.equal(byMode.get("A")?.success, true);
  assert.equal(byMode.get("B")?.success, false, "B forgot b.mjs");
  assert.equal(byMode.get("B")?.tests_passed, 1);
  // C/D: planner, implementer and reviewer roles on their own models.
  for (const mode of ["C", "D"] as const) {
    const r = byMode.get(mode)!;
    assert.equal(r.success, true, r.error ?? "");
    assert.equal(r.models.planner, "flash-a");
    assert.equal(r.models.implementer, "big-b");
    assert.equal(r.models.reviewer, "flash-a");
    assert.equal(r.regressions, 0);
    assert.ok(r.invocations >= 5, `plan + 2 implement + 2 review + final (${r.invocations})`);
  }
  assert.ok(byMode.get("C")!.prompt_tokens > byMode.get("A")!.prompt_tokens);
  assert.ok(inFlight.max >= 2, "mode D ran workers in parallel");

  const summaryC = summaries.find((s) => s.mode === "C")!;
  assert.equal(summaryC.success_rate, 1);
  assert.ok(summaryC.success_per_time > 0);
  assert.equal(summaries.find((s) => s.mode === "B")!.success_per_time, 0);
  const table = renderBenchmarkTable(summaries);
  assert.match(table, /plan -> parallel workers -> review/);
  assert.match(table, /success\/\(gpu\+wall\)s/);
});
