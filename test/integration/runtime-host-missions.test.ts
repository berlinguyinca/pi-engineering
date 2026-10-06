/**
 * Active missions survive a runtime handover (spec §20, §41, §51, §57).
 *
 * Real EngineeringRuntime, orchestrator, mission store, supervisor, git
 * worktrees and CommandVerifier. The "inference" the workers need comes over
 * real HTTP from a local gateway whose capacity the test takes away and gives
 * back per role.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { INFERENCE_WAIT_STATES, readOrchestrationEvents } from "../../src/runtime/host/missionHandover.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { missionBag, writeMissionRuntime } from "../support/missionRuntime.ts";
import { startPiSession } from "../support/piSession.ts";

const exec = promisify(execFile);

const ENV: Record<string, string> = {
  // Exhaust the in-call retry window at once: the mission parks durably
  // (PAUSED_INFRASTRUCTURE) instead of holding a tool call open for hours.
  PI_GATEWAY_RETRY_WINDOW: "1",
  PI_GATEWAY_AUTO_RESUME_HORIZON: "1",
  PI_GATEWAY_PROBE_INTERVAL: "1",
  PI_GATEWAY_JITTER_MS: "1",
  PI_GATEWAY_MAX_BACKOFF: "1",
  PI_GATEWAY_HEALTH_URL: "",
  PI_SELF_UPDATE: "0",
};
const saved: Record<string, string | undefined> = {};
let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "rt-missions-"));
  ENV.HOME = join(root, "home");
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
after(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

/** A gateway: per-role outage and per-role "hold the response until released". */
function gateway() {
  const down = new Set<string>();
  const held = new Map<string, Array<() => void>>();
  const holdRoles = new Set<string>();
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url ?? "/", "http://x");
    if (parsed.pathname !== "/infer") {
      // Readiness: healthy while the implementer has capacity.
      res.writeHead(down.has("implementer") ? 503 : 200);
      res.end("{}");
      return;
    }
    const role = parsed.searchParams.get("role") ?? "";
    seen.push(role);
    const answer = () => {
      res.writeHead(down.has(role) ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !down.has(role) }));
    };
    if (holdRoles.has(role)) {
      holdRoles.delete(role);
      held.set(role, [...(held.get(role) ?? []), answer]);
    } else answer();
  });
  return {
    server,
    down,
    seen,
    hold: (role: string) => holdRoles.add(role),
    release: (role: string) => {
      for (const go of held.get(role) ?? []) go();
      held.delete(role);
    },
    isHeld: (role: string) => (held.get(role)?.length ?? 0) > 0,
  };
}

async function waitUntil(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function replayStore(repo: string): Promise<MissionStore> {
  const backend = JsonlEventStore.inMemory();
  await backend.appendAll(await readOrchestrationEvents(repo));
  return MissionStore.open(backend);
}

async function setup(name: string) {
  const gw = gateway();
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  const port = (gw.server.address() as { port: number }).port;
  process.env.PI_GATEWAY_HEALTH_URL = `http://127.0.0.1:${port}`;
  const fx = await makeFixtureRepo();
  writeFileSync(join(fx.root, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  await exec("git", ["-C", fx.root, "add", "-A"]);
  await exec("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
  const key = `__rt_missions_${process.pid}_${name}`;
  const b = missionBag(key, {
    repo: fx.root,
    gateway: `http://127.0.0.1:${port}`,
    goal: "Add a handover marker module",
  });
  const source = join(root, `runtime-src-${name}`);
  writeMissionRuntime(source, key, "A");
  const ext = new EngineeringHostExtension({
    installRoot: join(root, `install-${name}`),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
  });
  const pi = await startPiSession({ factories: [(api: never) => ext.install(api)], cwd: fx.root });
  const host = ext.host as NonNullable<typeof ext.host>;
  const close = async () => {
    await pi.close();
    gw.server.close();
    await fx.cleanup();
  };
  return { gw, fx, key, b, source, ext, pi, host, close };
}

test("active mission: handover waits for its safe point, same mission after rehydration, nothing replayed (§20, §51)", async () => {
  const w = await setup("active");
  try {
    w.gw.hold("investigator");
    const mission = w.pi.run("/start-mission investigate");
    await waitUntil("investigation inference in flight", () => w.gw.isHeld("investigator"));

    writeMissionRuntime(w.source, w.key, "B");
    await w.pi.run("/engineering reload");
    const task = w.host.pendingTask();
    assert.ok(task, "handover pending, not forced");
    assert.equal(task.phase, "waiting_safe_point");
    assert.deepEqual(w.host.operations.summarize(task.blocking), ["1 running command"]);
    assert.ok(
      w.b.values.every((v) => !v.startsWith("start:B")),
      "no new generation while the worker runs",
    );

    w.gw.release("investigator");
    await mission;
    const result = await task.promise;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.waitedForSafePoint, true);
    assert.ok(w.b.values.includes("start:B:g2"));
    const missionId = w.b.missionId as string;
    const callsBefore = w.b.workerCalls.length;

    const store = await replayStore(w.fx.root);
    const m = store.getMission(missionId);
    assert.ok(m, "same mission id after the new generation rehydrated");
    const diagnostics = () =>
      JSON.stringify({
        generation1Result: w.b.missionStatus,
        failure: m.failure_reason,
        tasks: store.listTasks(missionId).map((t) => `${t.kind}:${t.status}`),
        executions: store.listExecutions(missionId).map((e) => `${e.status}:${e.exit_status}`),
        calls: w.b.workerCalls,
      });
    // The handover must not change the outcome generation 1 reached, and the
    // new generation must not re-run it. (Whether the base orchestrator
    // completes this investigation is its own business: under a fully loaded
    // test run it has been seen to fail the task itself, before any handover.)
    assert.ok(["COMPLETE", "FAILED", "BLOCKED"].includes(w.b.missionStatus ?? ""), `terminal: ${diagnostics()}`);
    assert.equal(m.status, w.b.missionStatus, `outcome unchanged by the handover: ${diagnostics()}`);
    const executionsBefore = store.listExecutions(missionId).map((e) => `${e.execution_id}:${e.status}`);
    assert.ok(executionsBefore.length >= 1, "execution evidence kept");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(w.b.workerCalls.length, callsBefore, "the new generation replayed no completed work");
    const after = await replayStore(w.fx.root);
    assert.deepEqual(
      after.listExecutions(missionId).map((e) => `${e.execution_id}:${e.status}`),
      executionsBefore,
      "no execution added or rewritten by the new generation",
    );
    assert.equal(w.b.workerCalls.filter((c) => c.role === "investigator").length, 1, "no duplicate worker");
  } finally {
    await w.close();
  }
});

test("inference outage: update proceeds, mission stays WAITING, resumes on the new generation when capacity returns (§41, §57)", async () => {
  const w = await setup("outage");
  try {
    w.gw.down.add("implementer");
    await w.pi.run("/start-mission implement");
    const missionId = w.b.missionId as string;
    assert.ok(INFERENCE_WAIT_STATES.has(w.b.missionStatus as string), `parked: ${w.b.missionStatus}`);

    // The outage must not block the handover: a parked mission is a safe point.
    writeMissionRuntime(w.source, w.key, "B");
    await w.pi.run("/engineering reload");
    const result = w.host.lastHandover;
    assert.equal(result?.ok, true, result?.failure);
    assert.equal(result?.waitedForSafePoint, false, "no inference outage holds the update");
    assert.deepEqual(result?.snapshot?.inferenceWaitMissionIds, [missionId]);
    const health = await w.host.health();
    assert.equal(health.healthy, true, "inference availability is not runtime health");

    let store = await replayStore(w.fx.root);
    const parked = store.getMission(missionId);
    assert.ok(parked && INFERENCE_WAIT_STATES.has(parked.status), `still waiting after handover: ${parked?.status}`);
    assert.equal(w.b.resumes.length, 0, "nobody resumed while capacity was gone");

    // Capacity returns: the ACTIVE generation's watcher resumes the mission.
    const generation1Calls = w.b.workerCalls.filter((c) => c.generation === 1).length;
    w.gw.down.delete("implementer");
    await waitUntil(
      "mission resumed",
      () => w.b.resumes.length > 0 && !INFERENCE_WAIT_STATES.has(w.b.missionStatus ?? ""),
    );
    assert.deepEqual(
      [...new Set(w.b.resumes.map((r) => r.generation))],
      [2],
      "only the new generation resumed it; the old retry timer was disposed",
    );
    assert.equal(w.b.workerCalls.filter((c) => c.generation === 1).length, generation1Calls, "generation 1 is silent");
    assert.ok(w.b.workerCalls.some((c) => c.generation === 2 && c.role === "implementer" && c.ok));
    store = await replayStore(w.fx.root);
    const resumed = store.getMission(missionId);
    assert.ok(resumed, "same mission id");
    assert.notEqual(resumed.status, "FAILED", "the runtime update never failed the mission");
    assert.ok(!INFERENCE_WAIT_STATES.has(resumed.status), `resumed past the wait: ${resumed.status}`);
  } finally {
    await w.close();
  }
});
