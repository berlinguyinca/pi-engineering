/**
 * Resume after a real crash: a planner-worker mission runs in a child
 * process that is SIGKILLed mid-mission; a fresh executor resumes it from
 * .pi-eng/planner-worker/<mission>/ without re-running passed contracts.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { type ChatRequestRecord, startGatewayServer } from "../support/gatewayServer.ts";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const SRC = resolve(import.meta.dirname, "../../src/plannerWorker");
const CATALOG = [
  { id: "flash-a", x_capabilities: ["coding.planning", "coding.review"], x_context_window: 131072, x_state: "hot" },
  { id: "big-b", x_capabilities: ["coding.implementation"], x_context_window: 262144, x_state: "hot" },
];

const contract = (id: string, deps: string[]) => ({
  task_id: id,
  objective: `write ${id}`,
  depends_on: deps,
  scope: { allowed: [`src/${id}/**`] },
  acceptance: [`${id} exists`],
  verification: [`test -f src/${id}/done.txt`],
});

const taskOf = (req: ChatRequestRecord) => /task_id: ([\w.-]+)/.exec(req.user)?.[1] ?? "";

test("a mission killed mid-run resumes contract by contract without losing passed work", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  let child: ReturnType<typeof spawn> | null = null;
  let crashed = false;
  const server = await startGatewayServer({
    models: CATALOG,
    respond: (req) => {
      if (req.system.startsWith("You are the PLANNER")) {
        return {
          content: JSON.stringify({
            contracts: [contract("one", []), contract("two", ["one"]), contract("three", ["two"])],
          }),
        };
      }
      if (req.system.startsWith("You are an IMPLEMENTER")) {
        const id = taskOf(req);
        if (id === "two" && !crashed) {
          // The process dies in the middle of contract `two`.
          crashed = true;
          child?.kill("SIGKILL");
        }
        return {
          content: JSON.stringify({
            status: "completed",
            summary: `did ${id}`,
            files: [{ path: `src/${id}/done.txt`, content: id }],
          }),
        };
      }
      return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
    },
  });
  cleanups.push(() => server.close());
  const stateDir = join(fixture.root, ".pi-eng", "planner-worker", "PW-crash");
  const script = join(fixture.root, "..", `pw-crash-${Date.now()}.ts`);
  cleanups.push(() => import("node:fs/promises").then((fs) => fs.rm(script, { force: true })));
  await writeFile(
    script,
    `import { PlannerWorkerExecutor } from ${JSON.stringify(join(SRC, "executor.ts"))};
import { fetchCatalog } from ${JSON.stringify(join(SRC, "gateway.ts"))};
import { GatewayChatWorkerExecutor } from ${JSON.stringify(join(SRC, "gatewayWorker.ts"))};
import { RoleResolver } from ${JSON.stringify(join(SRC, "resolver.ts"))};
const [repoRoot, baseUrl, stateDir] = process.argv.slice(2);
const conn = { baseUrl };
await new PlannerWorkerExecutor({
  repoRoot, stateDir, concurrency: 1,
  worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
  resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
}).run({ mission_id: "PW-crash", summary: "three files", architectural_context: [], acceptance_criteria: [], constraints: [] });
`,
  );
  const proc = spawn(process.execPath, [script, fixture.root, server.baseUrl, stateDir], { stdio: "ignore" });
  child = proc;
  const signal = await new Promise<NodeJS.Signals | null>((r) => proc.on("exit", (_code, sig) => r(sig)));
  assert.equal(signal, "SIGKILL");

  const before = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  assert.equal(before.planner_model, "flash-a", "the planner model is part of the durable state");
  assert.equal(
    before.contracts.find((c: { contract: { task_id: string } }) => c.contract.task_id === "one").status,
    "passed",
  );
  // The crash left worktrees behind.
  assert.ok(
    (await exec("git", ["-C", fixture.root, "worktree", "list"])).stdout.split("\n").filter(Boolean).length > 1,
  );

  const conn = { baseUrl: server.baseUrl };
  const report = await new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir,
    worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
    resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
  }).resume();
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  const implementations = server.requests.filter((r) => r.system.startsWith("You are an IMPLEMENTER")).map(taskOf);
  assert.deepEqual(implementations, ["one", "two", "two", "three"], "passed contract `one` is never re-run");
  assert.equal(server.requests.filter((r) => r.system.startsWith("You are the PLANNER")).length, 1, "no re-planning");
  const two = report.contracts.find((c) => c.contract.task_id === "two")!;
  assert.ok(two.history.some((h) => h.note === "resumed after interruption"));
  for (const id of ["one", "two", "three"]) {
    assert.equal(await readFile(join(fixture.root, "src", id, "done.txt"), "utf8"), id);
  }
  assert.equal((await exec("git", ["-C", fixture.root, "worktree", "list"])).stdout.trim().split("\n").length, 1);
  assert.equal((await exec("git", ["-C", fixture.root, "branch", "--list", "pi-eng-pw-*"])).stdout.trim(), "");
  // Implementers stay separated from the planner after a restart.
  const after_ = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  assert.equal(after_.planner_model, "flash-a", "resume restores the planner model");
  // The final review covers contracts integrated before the crash too.
  const finalReview = server.requests.find(
    (r) => r.system.startsWith("You are the REVIEWER") && taskOf(r) === "final-review",
  );
  assert.ok(finalReview, "a final review ran");
  for (const id of ["one", "two", "three"]) {
    assert.ok(finalReview.user.includes(`+++ b/src/${id}/done.txt`), `final review diff covers ${id}`);
  }
  // Telemetry and transitions continue across the restart.
  assert.ok((report.metrics.find((m) => m.role === "implementer")?.accepted_tasks ?? 0) >= 3);
  await assert.rejects(
    new PlannerWorkerExecutor({
      repoRoot: fixture.root,
      stateDir,
      worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
      resolver: new RoleResolver({ provider: "iw" }),
    }).resume(),
    /already completed/,
  );
});
