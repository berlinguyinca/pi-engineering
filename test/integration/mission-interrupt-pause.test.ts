/**
 * Esc on a running mission pauses it; only an explicit cancel terminates it
 * (owner decision on the report "The mission tool keeps getting canceled").
 *
 * Real EngineeringRuntime, mission store, git worktrees and verifier; the
 * worker is an in-process WorkerExecutor whose first implementer attempt waits
 * on the gateway until the call is interrupted.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/index.ts";
import type { ModelRef } from "../../src/lifecycle/types.ts";
import { OPERATOR_PAUSE_STOP_REASON } from "../../src/orchestration/interrupt.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { onOperatorModelSelect, resetSessionModelChoice } from "../../src/runtime/operatorModelPin.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const GLM: ModelRef = { provider: "gw", id: "glm5.3-flash-modality-vision-quant-q6_k_xl" };
const DEEPSEEK: ModelRef = { provider: "gw", id: "deepseek_v4-flash-modality-text-quant-mxfp4" };

/** The first implementer attempt waits (out of capacity) until interrupted; later ones finish. */
function capacityWorker(seen: WorkerRequest[], started: () => void): WorkerExecutor {
  let blocked = false;
  return {
    async run(request) {
      seen.push({ ...request });
      const base = { claims: [], evidence_refs: [], new_hypotheses: [], proposed_tasks: [], details: {} };
      if (request.role === "implementer" && !blocked) {
        blocked = true;
        started();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          result: { ...base, status: "failed", summary: "aborted while waiting for capacity", error: "aborted" },
          usage: null,
        };
      }
      if (request.role === "implementer") {
        await writeFile(join(request.cwd, "src", "add.js"), "export function add(a, b) { return a + b; }\n");
      }
      return {
        result: { ...base, status: "completed", summary: `${request.role} completed` },
        usage: null,
        structured:
          request.resultTool === "review_result"
            ? {
                verdict: "approve",
                findings: [],
                missingTests: [],
                specGaps: [],
                acceptanceResults: [...request.task.matchAll(/Acceptance criterion ([^:]+):/g)].map((m) => ({
                  acceptanceId: m[1]!,
                  status: "passed" as const,
                  detail: "checked",
                })),
                summary: "approved",
              }
            : undefined,
      };
    },
  };
}

async function openRuntime(root: string, worker: WorkerExecutor) {
  return EngineeringRuntime.open({
    cwd: root,
    workDir: join(root, ".pi-eng"),
    roleRouter: { route: async () => ({ ...GLM }) },
    model: { ...GLM, api: "openai-completions", contextWindow: 262_144, maxTokens: 4096 } as never,
    worker,
  });
}

test("Esc on the mission tool pauses the mission; resume keeps the operator pin and preserved work", async () => {
  const fixture = await makeFixtureRepo();
  const seen: WorkerRequest[] = [];
  let started!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await openRuntime(fixture.root, capacityWorker(seen, started));
    const sessionId = RuntimeSession.current().sessionId;
    resetSessionModelChoice(sessionId, GLM);
    onOperatorModelSelect(sessionId, { model: DEEPSEEK, source: "set" });
    const rt = runtime;
    const mission = buildCoreTools(() => ({
      ledger: rt.ledger,
      artifacts: rt.artifacts,
      broker: rt.broker,
      orchestrator: rt.orchestrator,
      baseRef: () => rt.git!.headCommit(),
      currentWorkItemId: () => null,
      actor: () => ({ type: "user" }),
      resumeMission: (id, signal) => rt.resumeBlockedMission(id, signal),
      cancelMission: (id) => rt.cancelMission(id),
    })).find((tool) => tool.name === "mission")!;
    const ctx = { cwd: fixture.root } as never;

    const esc = new AbortController();
    const running = mission.execute(
      "call-1",
      { request: "Make add return the sum", mutate: true },
      esc.signal,
      undefined,
      ctx,
    );
    await workerStarted;
    esc.abort();
    const paused = await running;
    const text = paused.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    const missionId = String((paused.details as { missionId?: string }).missionId);

    const stored = rt.missionStore!.getMission(missionId)!;
    assert.notEqual(stored.status, "CANCELED", "an interrupt never cancels the mission");
    assert.equal(stored.status, "PAUSED_INFRASTRUCTURE");
    assert.match(text, new RegExp(`PAUSED by interrupt.*/mission resume ${missionId}`, "s"));
    const stop = rt.missionStore!.listMissionStops(missionId).at(-1);
    assert.equal(stop?.reason, OPERATOR_PAUSE_STOP_REASON);
    assert.ok(
      rt.missionStore!.listTasks(missionId).every((task) => task.status !== "CANCELED"),
      JSON.stringify(rt.missionStore!.listTasks(missionId).map((task) => [task.role, task.status])),
    );
    assert.equal(stored.operator_model_pin?.id, DEEPSEEK.id);

    // Resume through the tool's own action: the interrupted work runs again on the pin.
    const resumed = await mission.execute("call-2", { action: "resume", missionId }, undefined, undefined, ctx);
    const after = rt.missionStore!.getMission(missionId)!;
    assert.notEqual(after.status, "CANCELED", resumed.content.map((p) => ("text" in p ? p.text : "")).join("\n"));
    assert.notEqual(after.status, "PAUSED_INFRASTRUCTURE");
    const implementers = seen.filter((request) => request.role === "implementer");
    assert.equal(implementers.length, 2, "the interrupted implementer ran again");
    assert.deepEqual(implementers[1]!.modelOverride, DEEPSEEK, "resume keeps the operator pin");
    assert.equal(after.operator_model_pin?.id, DEEPSEEK.id);
    assert.equal(after.status, "COMPLETE", `${after.status}: ${after.failure_reason ?? ""}`);
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});

test("an explicit cancel is the only thing that terminates a paused or running mission", async () => {
  const fixture = await makeFixtureRepo();
  let started!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await openRuntime(fixture.root, capacityWorker([], started));
    const running = runtime.orchestrator!.orchestrate("Make add return the sum", {
      repository: fixture.root,
      baseRef: await runtime.git!.headCommit(),
      mutationRequested: true,
      interrupt: "pause",
      signal: new AbortController().signal,
    });
    await workerStarted;
    const missionId = runtime.missionStore!.listMissions().at(-1)!.mission_id;
    const canceled = await runtime.cancelMission(missionId);
    assert.equal(canceled.status, "CANCELED");
    assert.equal((await running).mission.status, "CANCELED");
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});

function missionToolFor(rt: EngineeringRuntime) {
  return buildCoreTools(() => ({
    ledger: rt.ledger,
    artifacts: rt.artifacts,
    broker: rt.broker,
    orchestrator: rt.orchestrator,
    baseRef: () => rt.git!.headCommit(),
    currentWorkItemId: () => null,
    actor: () => ({ type: "user" }),
    resumeMission: (id, signal) => rt.resumeBlockedMission(id, signal),
    cancelMission: (id) => rt.cancelMission(id),
    clearMissionModelPin: (id) => rt.clearMissionModelPin(id),
  })).find((tool) => tool.name === "mission")!;
}

test("the operator pause is recorded the instant Esc lands; supervisor ticks during the pause never resume it", async () => {
  const fixture = await makeFixtureRepo();
  const seen: WorkerRequest[] = [];
  let started!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await openRuntime(fixture.root, capacityWorker(seen, started));
    const rt = runtime;
    const esc = new AbortController();
    let settled = false;
    const running = missionToolFor(rt)
      .execute("call-1", { request: "Make add return the sum", mutate: true }, esc.signal, undefined, {
        cwd: fixture.root,
      } as never)
      .finally(() => {
        settled = true;
      });
    await workerStarted;
    const missionId = rt.missionStore!.listMissions().at(-1)!.mission_id;
    esc.abort();
    // Before any await: the pause is already on the mission record.
    assert.ok(rt.missionStore!.getMission(missionId)?.operator_paused_at, "operator pause recorded synchronously");
    // Real timers: the session's own supervisor keeps ticking through the
    // whole pause window (task RETRYING, no worker, stop not yet written).
    while (!settled) {
      await rt.missionSupervisor!.tick(missionId).catch(() => []);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await running;
    for (let i = 0; i < 5; i++) await rt.missionSupervisor!.tick(missionId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rt.missionStore!.getMission(missionId)?.status, "PAUSED_INFRASTRUCTURE");
    assert.equal(seen.filter((request) => request.role === "implementer").length, 1, "nothing resumed it");
    assert.equal(rt.missionStore!.listMissionResumptions(missionId).length, 0);
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});

test("Esc on a mission that cannot pause (NEEDS_ATTENTION) leaves it where it is instead of cancelling", async () => {
  const fixture = await makeFixtureRepo();
  let started!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await openRuntime(fixture.root, capacityWorker([], started));
    const rt = runtime;
    const esc = new AbortController();
    const running = missionToolFor(rt).execute(
      "call-1",
      { request: "Make add return the sum", mutate: true },
      esc.signal,
      undefined,
      { cwd: fixture.root } as never,
    );
    await workerStarted;
    const missionId = rt.missionStore!.listMissions().at(-1)!.mission_id;
    rt.missionStore!.transitionMission(missionId, "NEEDS_ATTENTION");
    esc.abort();
    const result = await running;
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    assert.equal(rt.missionStore!.getMission(missionId)?.status, "NEEDS_ATTENTION");
    assert.match(text, /interrupt noted/i);
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});

test("clear_pin releases a paused mission from a persisted operator pin before it resumes", async () => {
  const fixture = await makeFixtureRepo();
  const seen: WorkerRequest[] = [];
  let started!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await openRuntime(fixture.root, capacityWorker(seen, started));
    const rt = runtime;
    const sessionId = RuntimeSession.current().sessionId;
    resetSessionModelChoice(sessionId, GLM);
    onOperatorModelSelect(sessionId, { model: DEEPSEEK, source: "set" }, new Date(Date.now() - 1_000));
    const tool = missionToolFor(rt);
    const ctx = { cwd: fixture.root } as never;
    const esc = new AbortController();
    const running = tool.execute(
      "call-1",
      { request: "Make add return the sum", mutate: true },
      esc.signal,
      undefined,
      ctx,
    );
    await workerStarted;
    esc.abort();
    const paused = await running;
    const missionId = String((paused.details as { missionId?: string }).missionId);
    assert.equal(rt.missionStore!.getMission(missionId)?.operator_model_pin?.id, DEEPSEEK.id);

    const cleared = await tool.execute("call-2", { action: "clear_pin", missionId }, undefined, undefined, ctx);
    assert.match(cleared.content.map((part) => ("text" in part ? part.text : "")).join("\n"), /operator pin released/i);
    assert.equal(rt.missionStore!.getMission(missionId)?.operator_model_pin, null);

    await tool.execute("call-3", { action: "resume", missionId }, undefined, undefined, ctx);
    const implementers = seen.filter((request) => request.role === "implementer");
    assert.equal(implementers.length, 2);
    assert.deepEqual(implementers[1]!.modelOverride, GLM, "back on the role pin, not the released operator pin");
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});
