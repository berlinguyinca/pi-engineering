/**
 * A planner-worker mission is owned by exactly one live process. `/mission
 * resume` rebuilds the integration worktree and discards the worktrees of
 * every unfinished contract, so resuming a mission another process is still
 * running would delete worktrees under live workers. The mission's state
 * directory therefore holds a lock naming its owner by pid AND process start
 * time: a live owner refuses the resume; a dead owner's lock (SIGKILL, crash)
 * is reclaimed.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PlannerWorkerExecutor } from "../../src/plannerWorker/executor.ts";
import { fetchCatalog } from "../../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { MissionLockedError, acquireMissionLock } from "../../src/plannerWorker/missionLock.ts";
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

/** A real process that takes the mission lock, reports it, and holds it until killed. */
function lockHolder(stateDir: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { acquireMissionLock } = await import(${JSON.stringify(join(SRC, "missionLock.ts"))});
await acquireMissionLock(process.argv[1]);
console.log("locked");
setInterval(() => {}, 1e6);`,
      stateDir,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  return new Promise((resolveLocked, reject) => {
    child.stdout?.on("data", (b: Buffer) => {
      if (b.toString().includes("locked")) resolveLocked(child);
    });
    child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

async function killed(child: ReturnType<typeof spawn>): Promise<void> {
  const gone = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await gone;
}

test("resume is refused while another live process owns the mission, and reclaims a SIGKILLed owner's lock", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  let child: ReturnType<typeof spawn> | null = null;
  let crashed = false;
  const server = await startGatewayServer({
    models: CATALOG,
    respond: (req) => {
      if (req.system.startsWith("You are the PLANNER")) {
        return { content: JSON.stringify({ contracts: [contract("one", []), contract("two", ["one"])] }) };
      }
      if (req.system.startsWith("You are an IMPLEMENTER")) {
        const id = taskOf(req);
        if (id === "two" && !crashed) {
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
  const stateDir = join(fixture.root, ".pi-eng", "planner-worker", "PW-lock");
  const script = join(fixture.root, "..", `pw-lock-${Date.now()}.ts`);
  cleanups.push(() => rm(script, { force: true }));
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
}).run({ mission_id: "PW-lock", summary: "two files", architectural_context: [], acceptance_criteria: [], constraints: [] });
`,
  );
  // 1. The original run is SIGKILLed mid-mission: its lock is left behind.
  const proc = spawn(process.execPath, [script, fixture.root, server.baseUrl, stateDir], { stdio: "ignore" });
  child = proc;
  assert.equal(await new Promise((r) => proc.on("exit", (_c, sig) => r(sig))), "SIGKILL");
  const stale = JSON.parse(await readFile(join(stateDir, "mission.lock"), "utf8"));
  assert.equal(stale.pid, proc.pid, "the crashed run owned the mission");

  // 2. Another live process takes the mission over (reclaiming the dead owner's lock).
  const holder = await lockHolder(stateDir);
  const worktreesBefore = (await exec("git", ["-C", fixture.root, "worktree", "list"])).stdout;
  assert.ok(worktreesBefore.trim().split("\n").length > 1, "the crash left worktrees behind");

  const conn = { baseUrl: server.baseUrl };
  const executor = () =>
    new PlannerWorkerExecutor({
      repoRoot: fixture.root,
      stateDir,
      worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel: "flash-a" }),
      resolver: new RoleResolver({ provider: "iw", loadCatalog: () => fetchCatalog(conn) }),
    });
  await assert.rejects(executor().resume(), (err: unknown) => {
    assert.ok(err instanceof MissionLockedError, String(err));
    assert.match((err as Error).message, new RegExp(`pid ${holder.pid}`));
    return true;
  });
  assert.equal(
    (await exec("git", ["-C", fixture.root, "worktree", "list"])).stdout,
    worktreesBefore,
    "a refused resume touches no worktree",
  );

  // 3. The live owner is SIGKILLed too: its lock is stale and resume reclaims it.
  await killed(holder);
  const report = await executor().resume();
  assert.equal(report.status, "completed", report.failure_reason ?? "");
  for (const id of ["one", "two"]) assert.equal(await readFile(join(fixture.root, "src", id, "done.txt"), "utf8"), id);
  await assert.rejects(readFile(join(stateDir, "mission.lock")), "the lock is released when the mission settles");
});

test("a lock held by this very process is refused, and released locks can be retaken", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const dir = join(fixture.root, ".pi-eng", "planner-worker", "PW-self");
  const lock = await acquireMissionLock(dir);
  await assert.rejects(acquireMissionLock(dir), MissionLockedError);
  await lock.release();
  const again = await acquireMissionLock(dir);
  await again.release();
});

test("a corrupt lock file is reclaimed", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const dir = join(fixture.root, ".pi-eng", "planner-worker", "PW-corrupt");
  const first = await acquireMissionLock(dir);
  await writeFile(join(dir, "mission.lock"), "{not json");
  const lock = await acquireMissionLock(dir);
  await lock.release();
  await first.release(); // not its lock any more: a no-op
});

/** A real process that takes the lock and is SIGKILLed: its lock is left behind, owned by a dead pid. */
async function deadOwner(stateDir: string): Promise<string> {
  const holder = await lockHolder(stateDir);
  await killed(holder);
  return readFile(join(stateDir, "mission.lock"), "utf8");
}

/**
 * Real resumer processes: each waits for `go`, races for the lock, and
 * reports `won` (then checks after a pause that the lock is still its own)
 * or `refused`.
 */
function resumer(stateDir: string, go: string): { done: Promise<string>; ready: Promise<void> } {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { existsSync, readFileSync } from "node:fs";
const { acquireMissionLock } = await import(${JSON.stringify(join(SRC, "missionLock.ts"))});
const [dir, go] = process.argv.slice(1);
console.log("ready");
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 2));
try {
  await acquireMissionLock(dir);
} catch (err) {
  console.log(err.name === "MissionLockedError" ? "refused" : "error " + err.message);
  process.exit(0);
}
await new Promise((r) => setTimeout(r, 1500));
const lock = JSON.parse(readFileSync(dir + "/mission.lock", "utf8"));
console.log(lock.pid === process.pid ? "won intact" : "won stolen");`,
      stateDir,
      go,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  let out = "";
  let markReady!: () => void;
  const ready = new Promise<void>((r) => {
    markReady = r;
  });
  child.stdout?.on("data", (b: Buffer) => {
    out += b.toString();
    if (out.includes("ready")) markReady();
  });
  const done = new Promise<string>((r) => child.on("exit", () => r(out.replace("ready", "").trim())));
  return { done, ready };
}

const ROUNDS = Number(process.env.PW_LOCK_ROUNDS ?? 6);
const RACERS = 6;

test("concurrent resumers over a dead owner's lock: exactly one wins and nobody deletes the winner's lock", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  for (let round = 0; round < ROUNDS; round++) {
    const dir = join(fixture.root, ".pi-eng", "planner-worker", `PW-race-${round}`);
    await deadOwner(dir);
    const go = join(dir, "go");
    const racers = Array.from({ length: RACERS }, () => resumer(dir, go));
    await Promise.all(racers.map((r) => r.ready));
    await writeFile(go, "");
    const outcomes = (await Promise.all(racers.map((r) => r.done))).sort();
    assert.deepEqual(
      outcomes,
      [...Array.from({ length: RACERS - 1 }, () => "refused"), "won intact"],
      `round ${round}: ${outcomes.join(", ")}`,
    );
  }
});

test("a takeover abandoned by a crashed claimant does not wedge the mission", async () => {
  const fixture = await makeFixtureRepo();
  cleanups.push(fixture.cleanup);
  const dir = join(fixture.root, ".pi-eng", "planner-worker", "PW-abandoned");
  const stale = JSON.parse(await deadOwner(dir));
  // A claimant died mid-takeover: its claim marker names a dead process too.
  const deadClaimant = await deadOwner(join(fixture.root, ".pi-eng", "planner-worker", "PW-other"));
  await writeFile(join(dir, `mission.lock.takeover-${stale.token}`), deadClaimant);
  const lock = await acquireMissionLock(dir);
  assert.equal(JSON.parse(await readFile(join(dir, "mission.lock"), "utf8")).pid, process.pid);
  await lock.release();
});
