/**
 * Planner/worker workers are judged by INACTIVITY, never by duration (owner:
 * "if it takes 8h, then it takes 8h"). Every worker the planner/worker
 * executor starts runs under its own watchdog — whether or not Pi handed the
 * mission an abort signal — using the configured worker inactivity window
 * (`limits.worker_inactivity_ms` / PI_ENGINEERING_WORKER_INACTIVITY_MS,
 * default 1 h). Worker activity re-arms it, and a worker waiting for inference
 * capacity is alive however long the wait.
 *
 * Implementers here are real child processes; the window is shrunk so the
 * behaviour is observable in real time.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";
import { WAITING_FOR_INFERENCE_SUMMARY } from "../../src/workers/activity.ts";
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

/** How an implementer attempt behaves, as a real child process. */
type Behaviour = "silent" | "chatty" | "capacity-wait";

interface Attempt {
  behaviour: Behaviour;
  ms: number;
  aborted: boolean;
  reason: string | null;
  request: WorkerRequest;
}

/**
 * Implementer attempts run a real node child: `silent` never prints and never
 * exits; `chatty` prints every 50 ms for 2 s; `capacity-wait` reports a wait
 * for inference capacity, stays silent for 2 s, then resumes and finishes.
 * Every printed line is forwarded as worker activity, like tool output from a
 * live session. Other roles go to the scripted gateway.
 */
class ChildImplementer implements WorkerExecutor {
  readonly attempts: Attempt[] = [];
  private readonly script: Behaviour[];
  private readonly gateway: WorkerExecutor;
  constructor(script: Behaviour[], gateway: WorkerExecutor) {
    this.script = script;
    this.gateway = gateway;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    if (req.role !== "implementer") return this.gateway.run(req);
    const behaviour = this.script[this.attempts.length] ?? "chatty";
    const started = Date.now();
    const attempt: Attempt = { behaviour, ms: 0, aborted: false, reason: null, request: req };
    this.attempts.push(attempt);
    const code = {
      silent: "setInterval(()=>{},1e6)",
      chatty: "const t=setInterval(()=>console.log('tick'),50);setTimeout(()=>{clearInterval(t);process.exit(0)},2000)",
      "capacity-wait": "setTimeout(()=>{console.log('served');process.exit(0)},2000)",
    }[behaviour];
    if (behaviour === "capacity-wait") {
      req.onActivity?.({ kind: "state", summary: WAITING_FOR_INFERENCE_SUMMARY, meaningfulProgress: false });
    }
    const exit = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
      const kill = () => child.kill("SIGKILL");
      req.signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", () =>
        req.onActivity?.({
          kind: "tool",
          phase: "completed",
          toolName: "bash",
          summary: "",
          meaningfulProgress: false,
        }),
      );
      child.on("close", (c) => {
        req.signal?.removeEventListener("abort", kill);
        resolve(c);
      });
    });
    attempt.ms = Date.now() - started;
    attempt.aborted = req.signal?.aborted ?? false;
    const reason = req.signal?.reason;
    attempt.reason = reason instanceof DOMException ? reason.name : null;
    if (exit !== 0) {
      return {
        result: {
          status: "failed",
          summary: "worker aborted",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
          error: "aborted",
        },
        usage: null,
        error: "aborted",
        toolCalls: 0,
      };
    }
    await mkdir(join(req.cwd, "src", "alpha"), { recursive: true });
    await writeFile(join(req.cwd, "src", "alpha", "done.txt"), "alpha");
    return {
      result: {
        status: "completed",
        summary: "did alpha",
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: {},
      },
      usage: null,
      toolCalls: 1,
    };
  }
}

async function mission(
  script: Behaviour[],
  opts: { workerInactivityMs?: number; signal?: AbortSignal } = {},
): Promise<{ report: Awaited<ReturnType<PlannerWorkerExecutor["run"]>>; worker: ChildImplementer }> {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const server = await startGatewayServer({
    models: CATALOG,
    respond: (req) => {
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
                risk: "medium",
              },
            ],
          }),
        };
      }
      if (req.system.startsWith("You are the REVIEWER")) {
        return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
      }
      return { content: JSON.stringify({ diagnosis: "the worker hung", required_changes: ["finish"] }) };
    },
  });
  cleanups.push(() => server.close());
  const conn = { baseUrl: server.baseUrl };
  const worker = new ChildImplementer(script, new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }));
  const report = await new PlannerWorkerExecutor({
    repoRoot: fixture.root,
    stateDir: join(fixture.root, ".pi-eng", "planner-worker", "PW-live"),
    worker,
    resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
    ...(opts.workerInactivityMs !== undefined ? { workerInactivityMs: opts.workerInactivityMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).run({
    mission_id: "PW-live",
    summary: "write alpha",
    architectural_context: [],
    acceptance_criteria: [],
    constraints: [],
  });
  return { report, worker };
}

test("without a mission signal, a silent worker is killed only after the configured inactivity window", async () => {
  const prev = process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
  process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS = "700";
  try {
    const { report, worker } = await mission(["silent", "chatty"]);
    assert.equal(report.status, "completed", report.failure_reason ?? "");
    const [hung, retry] = worker.attempts;
    assert.ok(hung && retry);
    assert.equal(hung.aborted, true, "the silent worker was aborted");
    assert.equal(hung.reason, "InactivityError");
    assert.ok(hung.ms >= 650, `not before the configured window (${hung.ms}ms)`);
    assert.ok(hung.ms < 20_000, `but promptly after it (${hung.ms}ms)`);
    // Every worker carries an owner signal and waits for capacity without a cap.
    assert.ok(hung.request.signal, "a watchdog signal even though Pi gave the mission none");
    assert.equal(hung.request.unboundedInferenceWait, true);
    assert.equal(retry.aborted, false);
  } finally {
    if (prev === undefined) delete process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
    else process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS = prev;
  }
});

test("with a mission signal, a silent worker is still caught by the inactivity watchdog", async () => {
  const mission_ = new AbortController();
  const { report, worker } = await mission(["silent", "chatty"], {
    workerInactivityMs: 600,
    signal: mission_.signal,
  });
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(worker.attempts[0]?.reason, "InactivityError");
  assert.ok((worker.attempts[0]?.ms ?? 0) >= 550);
  assert.equal(mission_.signal.aborted, false, "the watchdog never aborts the mission itself");
});

test("a worker with steady activity outlives the inactivity window", async () => {
  const { report, worker } = await mission(["chatty"], { workerInactivityMs: 500 });
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(worker.attempts.length, 1, "first attempt passed");
  assert.ok((worker.attempts[0]?.ms ?? 0) >= 1_900, "ran four times longer than the window");
});

test("waiting for inference capacity longer than the window does not fail the task", async () => {
  const { report, worker } = await mission(["capacity-wait"], { workerInactivityMs: 500 });
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  assert.equal(worker.attempts.length, 1, "no attempt was spent on the wait");
  assert.equal(worker.attempts[0]?.aborted, false);
});
