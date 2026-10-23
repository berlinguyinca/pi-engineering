/**
 * Standalone proof (acceptance 1 seed): Pi runs a mission/worker path with
 * AutoSpec, GitHub, InferWeave and Herdr all unconfigured. No network, no
 * throw, and no control-plane outbox or lineage state is created.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeFile } from "node:fs/promises";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { createIngestFromEnv } from "../../src/runtime/herdr/ingestFromEnv.ts";
import { resolveStateRoot } from "../../src/runtime/isolation/stateDir.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const OPTIONAL_ENV = /^(HERDR_|AUTOSPEC_|INFERWEAVE_|GITHUB_|GH_|PI_GATEWAY_)/;

test("a mission runs end to end with every optional adapter absent and touches no network", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (OPTIONAL_ENV.test(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error("network is forbidden in standalone mode");
  }) as typeof fetch;
  // Every net-based client (http, https, named imports of connect) goes through Socket.prototype.connect.
  const realSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const target = args[0] as { path?: string } | string | undefined;
    const isUnixPath = typeof target === "string" ? Number.isNaN(Number(target)) : typeof target?.path === "string";
    if (!isUnixPath) calls.push(`connect ${JSON.stringify(args[0])}`);
    if (!isUnixPath) throw new Error("TCP sockets are forbidden in standalone mode");
    return (realSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-standalone-agent-"));
  const fixture = await makeFixtureRepo();
  try {
    assert.equal(createIngestFromEnv(process.env), null, "no Herdr ingest without configuration");

    const worker = new FakeWorkerExecutor({
      planner: () => ({
        status: "completed",
        summary: "planned",
        details: {
          tasks: [
            {
              title: "implement add",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/add.js"],
            },
          ],
        },
      }),
      scout: () => ({ status: "completed", summary: "scouted", details: {} }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker,
      verifier: new CommandVerifier(),
      agentDir, // empty: nothing from the operator's real providers / settings
    });
    try {
      const plan = await rt.plan("build add");
      const result = await rt.executePlan(plan.plan_work_item.id, { parallel: false });
      assert.equal(result.outcome, "completed", `expected completed, got ${result.outcome}: ${result.summary}`);
    } finally {
      await rt.close();
    }

    assert.deepEqual(calls, [], "no network or socket call");
    const controlPlane = join(resolveStateRoot(), "control-plane");
    const leftovers = existsSync(controlPlane) ? readdirSync(controlPlane) : [];
    assert.deepEqual(
      leftovers.filter((f) => f.startsWith("outbox") || f.startsWith("seq") || f === "instance-id"),
      [],
      "no outbox or sequence state without an emitter",
    );
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realSocketConnect;
    rmSync(agentDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    await fixture.cleanup();
  }
});

test("lineage code present but no emitter configured: hooks run, stage is never called, nothing is written or sent", async () => {
  const { MissionStore } = await import("../../src/orchestration/missionStore.ts");
  const { JsonlEventStore } = await import("../../src/platform/eventstore/jsonl.ts");
  const { WorkGraph } = await import("../../src/platform/WorkGraph.ts");
  const { LineageEmitter } = await import("../../src/runtime/herdr/lineage.ts");

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realSocketConnect = net.Socket.prototype.connect;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error("network is forbidden");
  }) as typeof fetch;
  net.Socket.prototype.connect = (() => {
    calls.push("connect");
    throw new Error("sockets are forbidden");
  }) as typeof net.Socket.prototype.connect;
  try {
    let staged = 0;
    // A real emitter that is simply NOT attached: if any hook reached for it, stage() would count.
    const unattached = new LineageEmitter({
      source: "pi-x-00000001",
      sink: {
        stage: async () => {
          staged++;
        },
      },
    });

    const exercise = (attach: boolean) => {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      if (attach) store.setLineage(unattached);
      const mission = store.createMission({
        mission_id: `MSN-${attach ? "on" : "off"}`,
        title: "t",
        goal: "g",
        user_request: "u",
        repository: "/repo",
        base_ref: "base-a",
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const task = store.createTask({
        task_id: "t1",
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "o",
      });
      const ex = store.createExecution({ task_id: task.task_id, mission_id: mission.mission_id, backend: "agent" });
      store.setExecutionStatus(ex.execution_id, "RUNNING", {});
      store.setExecutionStatus(ex.execution_id, "SUCCEEDED", {});
      store.addHandoffRecord({
        id: `hf-${attach}`,
        kind: "context",
        state: "prepared",
        missionId: mission.mission_id,
        predecessor: { sessionId: "s1", generation: 1 },
        createdAt: new Date().toISOString(),
      });
      const graph = WorkGraph.create(JsonlEventStore.inMemory());
      if (attach) graph.setLineage(unattached);
      const parent = graph.createWorker({ projectId: "P", role: "lead" });
      const child = graph.createWorker({ projectId: "P", role: "h", parentWorkerId: parent.id });
      graph.setWorkerStatus(child.id, "RUNNING");
      graph.complete(child.id);
      graph.restart(parent.id);
    };

    exercise(false);
    await unattached.idle();
    assert.equal(staged, 0, "no emitter configured => stage never called");
    assert.equal(unattached.stats().emitted, 0);
    assert.deepEqual(calls, []);
    const controlPlane = join(resolveStateRoot(), "control-plane");
    const leftovers = existsSync(controlPlane) ? readdirSync(controlPlane) : [];
    assert.deepEqual(
      leftovers.filter((f) => f.startsWith("outbox") || f.startsWith("seq") || f === "instance-id"),
      [],
    );

    // control: the same run with the emitter attached does reach stage(), so the check above is not vacuous
    exercise(true);
    await unattached.idle();
    assert.ok(staged > 0, "attached emitter is reached by the same hooks");
    assert.deepEqual(calls, [], "even attached, a stage-only sink makes no network call");
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realSocketConnect;
  }
});
