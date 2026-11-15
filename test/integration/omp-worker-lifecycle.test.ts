/**
 * Worker lifecycle against a REAL omp (gated on OMP_BIN; offline scripted model): negotiation is cached per
 * runtime open, every tournament leg and DAG task runs on its own fresh omp process, aborts and timeouts
 * propagate, and no process outlives a run. Processes are counted by a launcher wrapper that logs its pid and
 * then execs the real binary, so the logged pid IS the omp process.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { shortHash } from "../../src/git/shortHash.ts";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import { OMP_HOME_ENV, OMP_MODEL_ENV, selectOmpWorker } from "../../src/omp/selectWorker.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { type EngineerScript, engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import type { ModelScript } from "../support/scriptedModelServer.ts";

const real = realOmpEnv();
const skip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";

const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const ADD_BAD = "export function add(a, b) {\n  return a - b;\n}\n";
const SUB_OK = "export function subtract(a, b) {\n  return a - b;\n}\n";
const dir = mkdtempSync(join(tmpdir(), "pe-omp-lifecycle-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The omp processes (descendants included) that belong to THIS test's repository: matched by command line, then
 * kept only when their working directory is the repository or one of its candidate worktrees
 * (`<parent>/pi-eng-<hash of the repo root>-*`). A machine-wide match would also count the omp processes of
 * other test files running concurrently.
 */
const ompProcesses = (root: string): string[] => {
  const worktree = `pi-eng-${shortHash(root)}-`;
  const mine = (cwd: string): boolean =>
    cwd === root || cwd.startsWith(`${root}/`) || basename(cwd).startsWith(worktree);
  try {
    const pids = execFileSync("pgrep", ["-f", "--", `${real!.args.split(/\s+/)[0] ?? real!.bin}.*--mode rpc`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return pids.filter((pid) => {
      try {
        const out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"], { encoding: "utf8" });
        const cwd =
          out
            .split("\n")
            .find((l) => l.startsWith("n"))
            ?.slice(1) ?? "";
        return mine(cwd);
      } catch {
        return false; // gone between pgrep and lsof
      }
    });
  } catch {
    return [];
  }
};

interface Launcher {
  readonly env: NodeJS.ProcessEnv;
  pids(): number[];
}

/** A launcher that records its own pid, then becomes the real omp (exec keeps the pid). */
function launcher(base: NodeJS.ProcessEnv, name: string): Launcher {
  const log = join(dir, `${name}.pids`);
  const wrapper = join(dir, `${name}.sh`);
  writeFileSync(log, "");
  writeFileSync(wrapper, `#!/bin/sh\necho $$ >> "${log}"\nexec "${real!.bin}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return {
    env: { ...base, PI_ENGINEERING_OMP_BIN: wrapper },
    pids: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number),
  };
}

async function openRuntime(root: string, script: ModelScript) {
  const offline = await startOfflineOmp(script);
  const counted = launcher(offline.env, `run-${Math.random().toString(36).slice(2)}`);
  const picked = await selectOmpWorker(
    () => ({
      run: async () => {
        throw new Error("the legacy executor must never run");
      },
    }),
    counted.env,
  );
  assert.equal(picked?.selection.path, "omp");
  const rt = await EngineeringRuntime.open({ cwd: root, worker: picked!.executor, verifier: new CommandVerifier() });
  return {
    rt,
    offline,
    counted,
    close: async () => {
      await rt.close();
      await offline.close();
    },
  };
}

/** Worker runs the model has started: each omp worker process makes exactly one first-turn request. */
const workerRuns = (turns: ReadonlyArray<{ assistantTurns: number }>): number =>
  turns.filter((t) => t.assistantTurns === 0).length;

const task = (title: string, scope: string, dependsOn: number[] = []) => ({
  title,
  kind: "implementation",
  risk: "medium",
  depends_on: dependsOn,
  scope_paths: [scope],
});

const settle = async (pids: number[]): Promise<number[]> => {
  for (let i = 0; i < 30 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  return pids.filter(alive);
};

describe("omp worker lifecycle (real omp)", { skip }, () => {
  it("negotiates once per runtime open; every tournament leg and the next command get fresh processes; none are left", async () => {
    const fx = await makeFixtureRepo();
    const leg = (n: number): string => (n === 1 ? ADD_OK : n === 2 ? ADD_BAD : ADD_OK);
    const script: EngineerScript = { implement: (run) => ({ path: "src/add.js", content: leg(run) }) };
    const o = await openRuntime(fx.root, engineerModelScript(script));

    try {
      const afterOpen = o.counted.pids().length;
      assert.equal(afterOpen, 2, "negotiation spawns exactly two processes, at open");
      let seen = 0;
      const sampler = setInterval(() => {
        seen = Math.max(seen, ompProcesses(fx.root).length);
      }, 100);
      try {
        await o.rt.tournament("Implement add(a, b) to return the sum of a and b", { n: 3 });
      } finally {
        clearInterval(sampler);
      }
      assert.ok(seen > 0, "positive control: the scoped matcher sees this runtime's own live omp processes");
      const afterTournament = o.counted.pids();
      const turns = o.offline.server.turns;
      const firstTurns = (role: string): number =>
        turns.filter((t) => t.assistantTurns === 0 && new RegExp(`# Role: ${role}`).test(t.system)).length;
      // The launcher log is the only authority on processes; model requests are not 1:1 with them (a process may
      // be killed before its first request lands), so only the implementer count is exact and the rest are bounds.
      assert.equal(firstTurns("implementer"), 3, "each of the 3 legs ran its own implementer");
      const spawned = afterTournament.length - afterOpen;
      assert.ok(spawned >= 3 + 2, `at least 3 implementers plus a scout and a reviewer were spawned (saw ${spawned})`);
      assert.ok(spawned >= workerRuns(turns), "every model run came from its own process");
      assert.equal(new Set(afterTournament).size, afterTournament.length, "no process is reused");

      const beforeSecond = afterTournament.length;
      await o.rt.engineer("Implement add(a, b) to return the sum of a and b");
      const second = o.counted.pids();
      assert.ok(second.length > beforeSecond, "the next command spawns fresh worker processes");
      assert.equal(new Set(second).size, second.length, "and none is reused");
      assert.deepEqual(await settle(o.counted.pids()), [], "no omp process outlives its run");
    } finally {
      await o.close();
      await fx.cleanup();
    }
    assert.deepEqual(
      ompProcesses(fx.root),
      [],
      "no omp process (descendants included) is left after the runtime closed",
    );
  });

  it("each DAG task runs on fresh processes and the plan leaves none behind", async () => {
    const fx = await makeFixtureRepo();
    const tasks = [task("implement add", "src/add.js"), task("implement subtract", "src/subtract.js", [0])];
    const o = await openRuntime(
      fx.root,
      engineerModelScript({
        planner: tasks,
        implement: (_run, t) =>
          t.toLowerCase().includes("subtract")
            ? { path: "src/subtract.js", content: SUB_OK }
            : { path: "src/add.js", content: ADD_OK },
      }),
    );
    try {
      const plan = await o.rt.plan("Build add then subtract");
      const dag = await o.rt.executePlan(plan.plan_work_item.id);
      assert.equal(dag.outcome, "completed");
      const pids = o.counted.pids();
      assert.equal(pids.length - 2, workerRuns(o.offline.server.turns), "one process per run after negotiation");
      assert.equal(new Set(pids).size, pids.length);
      // The two implementer tasks each had their own implementer process.
      const implementers = o.offline.server.turns.filter(
        (t) => t.assistantTurns === 0 && /# Role: implementer/.test(t.system),
      );
      assert.equal(implementers.length, 2);
      assert.deepEqual(await settle(pids), []);
    } finally {
      await o.close();
      await fx.cleanup();
    }
  });

  const hang: ModelScript = () => ({ kind: "hang" });
  const request = (cwd: string, extra: Record<string, unknown> = {}) => ({
    role: "scout" as const,
    task: "inspect",
    tools: ["read"],
    cwd,
    ...extra,
  });

  async function executor(name: string) {
    const offline = await startOfflineOmp(hang);
    const counted = launcher(offline.env, name);
    const worker = new OmpWorkerExecutor({
      launch: { command: counted.env.PI_ENGINEERING_OMP_BIN!, args: real!.args.split(/\s+/).filter(Boolean) },
      model: offline.env[OMP_MODEL_ENV],
      home: offline.env[OMP_HOME_ENV],
      env: counted.env,
    });
    return { worker, offline, counted };
  }

  it("the owner's abort propagates to the omp process, which is gone when the run returns", async () => {
    const fx = await makeFixtureRepo();
    const { worker, offline, counted } = await executor("abort");
    try {
      const ac = new AbortController();
      const pending = worker.run(request(fx.root, { signal: ac.signal, timeoutMs: 60_000 }));
      for (let i = 0; i < 100 && offline.server.turns.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(offline.server.turns.length > 0, "the model was reached: the run is in flight");
      ac.abort();
      const run = await pending;
      assert.equal(run.result.status, "failed");
      assert.match(run.error ?? "", /aborted by owner/);
      assert.equal(counted.pids().length, 1);
      assert.deepEqual(counted.pids().filter(alive), [], "the aborted omp process is dead");
    } finally {
      await offline.close();
      await fx.cleanup();
    }
  });

  it("an inactivity timeout fails the run and kills the omp process", async () => {
    const fx = await makeFixtureRepo();
    const { worker, offline, counted } = await executor("timeout");
    try {
      const run = await worker.run(request(fx.root, { timeoutMs: 1500 }));
      assert.equal(run.result.status, "failed");
      assert.match(run.error ?? "", /no omp frame for 1500ms/);
      assert.deepEqual(counted.pids().filter(alive), [], "the timed-out omp process is dead");
    } finally {
      await offline.close();
      await fx.cleanup();
    }
  });
});
