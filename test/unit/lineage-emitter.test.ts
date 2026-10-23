/**
 * Lineage events (T02, Pi side): typed node/edge events with stable ids,
 * emitted from the real transition points and only when an emitter is configured.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { HerdrAgentRuntime } from "../../src/runtime/herdr/HerdrAgentRuntime.ts";
import type { HerdrAgent, HerdrCli, HerdrStatus } from "../../src/runtime/herdr/HerdrCli.ts";
import type { EnvelopeV2 } from "../../src/runtime/herdr/envelope.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { LineageEmitter, createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-lineage-"));
  dirs.push(d);
  return d;
}

function rig(source = "pi-hosta-00000001") {
  const dir = tmp();
  const store = new EnvelopeStore({ dir, source });
  const emitter = createLineageEmitter({ store }, { host: source })!;
  return { dir, store, emitter };
}

async function lineageEvents(store: EnvelopeStore, emitter: LineageEmitter): Promise<EnvelopeV2[]> {
  await emitter.idle();
  return (await store.outbox.pending()).filter((e) => e.entity_type === "lineage");
}

const edges = (events: EnvelopeV2[], type?: string) =>
  events
    .filter((e) => e.event_type === "edge.add" && (!type || e.payload.edge_type === type))
    .map((e) => e.payload as { edge_type: string; from_id: string; to_id: string; attrs?: Record<string, unknown> });
const nodeIds = (events: EnvelopeV2[]) =>
  new Set(events.filter((e) => e.event_type === "node.upsert").map((e) => String(e.payload.node_id)));

function manifest(missionId: string): WorkspaceManifest {
  return {
    manifestId: "WM-1",
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      { repoId: "repo-a", canonicalRoot: "/repo", baseRef: "main", baseSha: "base-a", writableDomains: ["src/**"] },
    ],
    dependencyEdges: [],
    hash: "hash-1",
    createdAt: "2026-09-26T10:00:00.000Z",
  };
}

function missionRig(emitter: LineageEmitter | null, backend = JsonlEventStore.inMemory()) {
  const store = MissionStore.open(backend);
  if (emitter) store.setLineage(emitter);
  const mission = store.createMission({
    mission_id: "MSN-lin",
    title: "t",
    goal: "g",
    user_request: "u",
    repository: "/repo",
    base_ref: "base-a",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest(manifest(mission.mission_id));
  const task = store.createTask({
    task_id: "task-a",
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "implement",
    repo_id: "repo-a",
    acceptance_ids: ["AC-1"],
    deliverables: ["implementation"],
    execution_budget_ms: 60_000,
    checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
    candidate_generation: 0,
    mission_generation: 0,
    fencing_token: 0,
  });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    checkpoint_id: "TCP-lin",
    repo_id: "repo-a",
    base_sha: "base-a",
  });
  store.setExecutionStatus(execution.execution_id, "RUNNING", {});
  return { store, backend, mission, task, execution };
}

const SHA = "a".repeat(40);

describe("lineage: spawn vs handoff", () => {
  it("emits distinct spawn and handoff edge types with the contract direction", async () => {
    const { store: envStore, emitter } = rig();
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitter);
    const parent = graph.createWorker({ projectId: "P", role: "lead" });
    const child = graph.createWorker({ projectId: "P", role: "helper", parentWorkerId: parent.id });

    const { store } = missionRig(emitter);
    store.addHandoffRecord({
      id: "hf-1",
      kind: "phase_transition",
      state: "prepared",
      missionId: "MSN-lin",
      predecessor: { sessionId: "s-old", generation: 1 },
      createdAt: new Date().toISOString(),
    });
    store.transitionHandoffRecord("hf-1", "validated");
    store.transitionHandoffRecord("hf-1", "acknowledged", { sessionId: "s-new", generation: 2 });

    const events = await lineageEvents(envStore, emitter);
    const spawn = edges(events, "spawn");
    const handoff = edges(events, "handoff");
    assert.ok(spawn.some((e) => e.from_id === `agent:${parent.id}` && e.to_id === `agent:${child.id}`));
    assert.ok(spawn.some((e) => e.from_id === `attempt:${parent.id}.g1` && e.to_id === `attempt:${child.id}.g1`));
    assert.deepEqual(
      handoff.map((e) => [e.from_id, e.to_id]),
      [["session:s-old", "session:s-new"]],
    );
    assert.equal(
      spawn.some((e) => e.to_id.startsWith("session:")),
      false,
    );
    assert.equal(
      handoff.some((e) => e.from_id.startsWith("agent:")),
      false,
    );
    const handoffNode = events.filter((e) => e.event_type === "node.upsert" && e.payload.node_id === "handoff:hf-1");
    assert.deepEqual(
      handoffNode.map((e) => e.payload.state),
      ["prepared", "validated", "acknowledged"],
    );
    for (const e of events) {
      assert.equal(e.entity_type, "lineage");
      assert.equal(e.visibility_scope, "private");
    }
  });

  it("a same-session generation bump is not a rollover: no handoff edge and no new session", async () => {
    const { store: envStore, emitter } = rig();
    const { store } = missionRig(emitter);
    store.addHandoffRecord({
      id: "hf-gen",
      kind: "supervisor",
      state: "prepared",
      missionId: "MSN-lin",
      predecessor: { sessionId: "s-1", generation: 1 },
      createdAt: new Date().toISOString(),
    });
    store.transitionHandoffRecord("hf-gen", "validated");
    store.transitionHandoffRecord("hf-gen", "acknowledged", { sessionId: "s-1", generation: 2 });
    const events = await lineageEvents(envStore, emitter);
    assert.equal(edges(events, "handoff").length, 0);
    assert.equal(
      [...nodeIds(events)].some((id) => id.startsWith("session:")),
      false,
    );
  });
});

describe("lineage: no parent, no spawn edge", () => {
  it("a worker without a parent and a mission execution emit no spawn edge", async () => {
    const { store: envStore, emitter } = rig();
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitter);
    graph.createWorker({ projectId: "P", role: "solo" });
    missionRig(emitter);
    const events = await lineageEvents(envStore, emitter);
    assert.ok(events.length > 0);
    assert.equal(edges(events, "spawn").length, 0);
  });

  it("a restart is a new attempt of the same agent and does not re-add the spawn edge", async () => {
    const { store: envStore, emitter } = rig();
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitter);
    const parent = graph.createWorker({ projectId: "P", role: "lead" });
    const child = graph.createWorker({ projectId: "P", role: "helper", parentWorkerId: parent.id });
    graph.restart(child.id);
    const events = await lineageEvents(envStore, emitter);
    const attempts = [...nodeIds(events)].filter((id) => id.startsWith(`attempt:${child.id}`));
    assert.deepEqual(attempts.sort(), [`attempt:${child.id}.g1`, `attempt:${child.id}.g2`]);
    assert.equal([...nodeIds(events)].filter((id) => id === `agent:${child.id}`).length, 1, "one logical agent");
    assert.equal(edges(events, "spawn").filter((e) => e.to_id === `attempt:${child.id}.g2`).length, 0);
  });

  it("the Herdr runtime emits a spawn edge only when parentRuntimeId is given", async () => {
    const { store: envStore, emitter } = rig();
    const rt = new HerdrAgentRuntime({ cli: new FakeCli(), lineage: emitter });
    const lead = await rt.create({ role: "lead", objective: "o" });
    await rt.start(lead);
    const child = await rt.create({ role: "helper", objective: "o", parentRuntimeId: lead });
    await rt.start(child);
    await rt.terminate(child);
    const events = await lineageEvents(envStore, emitter);
    assert.deepEqual(
      edges(events, "spawn").map((e) => [e.from_id, e.to_id]),
      [
        [`agent:${lead}`, `agent:${child}`],
        [`attempt:${lead}`, `attempt:${child}`],
      ],
    );
    const ended = events.filter((e) => e.event_type === "node.state");
    assert.deepEqual(
      ended.map((e) => [e.payload.node_id, e.payload.state]),
      [[`attempt:${child}`, "cancelled"]],
      "terminate ends the attempt; the logical agent gets no state change",
    );
  });
});

describe("lineage: hook-level dedupe", () => {
  it("a repeated start/terminate/complete at the hook does not add events", async () => {
    const { store: envStore, emitter } = rig();
    const rt = new HerdrAgentRuntime({ cli: new FakeCli(), lineage: emitter });
    const lead = await rt.create({ role: "lead", objective: "o" });
    const child = await rt.create({ role: "helper", objective: "o", parentRuntimeId: lead });
    await rt.start(child);
    await rt.terminate(child);
    const once = (await lineageEvents(envStore, emitter)).length;
    assert.ok(once > 0);
    await rt.start(child);
    await rt.terminate(child);
    assert.equal((await lineageEvents(envStore, emitter)).length, once, "runtime hooks dedupe");

    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitter);
    const w = graph.createWorker({ projectId: "P", role: "r" });
    graph.complete(w.id);
    const afterFirst = (await lineageEvents(envStore, emitter)).length;
    await new Promise((r) => setTimeout(r, 5));
    graph.complete(w.id);
    assert.equal((await lineageEvents(envStore, emitter)).length, afterFirst, "WorkGraph terminal state dedupes");

    const m = missionRig(emitter);
    m.store.setExecutionStatus(m.execution.execution_id, "FAILED", {});
    const afterFail = (await lineageEvents(envStore, emitter)).length;
    await new Promise((r) => setTimeout(r, 5));
    m.store.setExecutionStatus(m.execution.execution_id, "FAILED", {});
    assert.equal((await lineageEvents(envStore, emitter)).length, afterFail, "MissionStore end dedupes");
  });
});

describe("lineage: session rollover and migration", () => {
  it("a new session under the same attempt keeps agent and attempt ids", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    const events = await lineageEvents(envStore, emitter);
    const sessions = events.filter(
      (e) => e.event_type === "node.upsert" && String(e.payload.node_id).startsWith("session:"),
    );
    assert.deepEqual(
      sessions.map((e) => e.payload.node_id),
      ["session:sess-1", "session:sess-2"],
    );
    for (const s of sessions) {
      const attrs = s.payload.attrs as Record<string, unknown>;
      assert.equal(attrs.agent_id, "agent:task-a");
      assert.equal(attrs.attempt_id, `attempt:${execution.execution_id}`);
    }
    assert.equal((sessions[1]?.payload.attrs as Record<string, unknown>).previous_session_id, "session:sess-1");
    const rolled = events.filter((e) => e.event_type === "node.state" && e.payload.state === "rolled_over");
    assert.deepEqual(
      rolled.map((e) => e.payload.node_id),
      ["session:sess-1"],
    );
    // exactly one logical agent / attempt across the whole run
    assert.deepEqual(
      [...nodeIds(events)].filter((id) => id.startsWith("agent:") || id.startsWith("attempt:")).sort(),
      ["agent:task-a", `attempt:${execution.execution_id}`].sort(),
    );
  });

  it("a verified checkpoint adds a checkpoint artifact produced by the attempt", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    await new CheckpointManager({
      store,
      snapshot: async () => ({
        candidateSha: SHA,
        branch: "b",
        worktree: "/wt",
        committedChanges: ["src/a.ts"],
        preservedUncommittedChanges: [],
      }),
    }).persist({ taskId: task.task_id, executionId: execution.execution_id });
    const events = await lineageEvents(envStore, emitter);
    const produced = edges(events, "produced");
    assert.deepEqual(
      produced.map((e) => [e.from_id, e.to_id, e.attrs?.commit]),
      [[`attempt:${execution.execution_id}`, "artifact:TCP-lin", SHA]],
    );
    const node = events.find((e) => e.payload.node_id === "artifact:TCP-lin" && e.event_type === "node.upsert");
    assert.equal((node?.payload.attrs as Record<string, unknown>).kind, "checkpoint");
  });

  it("host migration and resume keep node ids; only event ids and sources change", async () => {
    const a = rig("pi-hosta-00000001");
    const b = rig("pi-hostb-00000002");
    const backend = JsonlEventStore.inMemory();
    const first = missionRig(a.emitter, backend);
    await first.store.flush();
    first.store.setExecutionStatus(first.execution.execution_id, "FAILED", { exit_status: "died" });
    await first.store.flush();
    const before = await lineageEvents(a.store, a.emitter);

    // "migrate": reopen the durable history on another host with another source
    const reopened = MissionStore.open(backend);
    reopened.setLineage(b.emitter);
    await b.emitter.idle();
    assert.equal((await lineageEvents(b.store, b.emitter)).length, 0, "opening/replaying history emits nothing");
    const retry = reopened.createExecution({
      task_id: "task-a",
      mission_id: "MSN-lin",
      backend: "agent",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    const after = await lineageEvents(b.store, b.emitter);

    const agentsBefore = [...nodeIds(before)].filter((id) => id.startsWith("agent:"));
    const agentsAfter = [...nodeIds(after)].filter((id) => id.startsWith("agent:"));
    assert.deepEqual(agentsAfter, agentsBefore, "agent id survives host migration");
    assert.ok(nodeIds(after).has(`attempt:${retry.execution_id}`), "resume is a new attempt");
    assert.equal(nodeIds(after).has(`attempt:${first.execution.execution_id}`), false);
    assert.ok(after.every((e) => e.source === "pi-hostb-00000002"));
    const sameNodeEventA = before.find((e) => e.payload.node_id === "agent:task-a" && e.event_type === "node.upsert");
    const sameNodeEventB = after.find((e) => e.payload.node_id === "agent:task-a" && e.event_type === "node.upsert");
    assert.notEqual(sameNodeEventA?.event_id, sameNodeEventB?.event_id, "event ids are source-bound");
  });
});

describe("lineage: dedupe and ids", () => {
  it("a retry of the same transition dedupes; a repeated transition with a new discriminator does not", async () => {
    const { store, emitter } = rig();
    const spawn = (transition: string) =>
      emitter.workerSpawned({ agent: "a1", attempt: "t1", parentAgent: "p1", transition });
    spawn("created");
    spawn("created");
    await emitter.idle();
    const once = (await store.outbox.pending()).length;
    assert.equal(once, 3, "agent + attempt + spawn edge, no duplicates");
    spawn("created");
    await emitter.idle();
    assert.equal((await store.outbox.pending()).length, once);

    emitter.attemptState({ attempt: "t1" }, "blocked", "block@1");
    emitter.attemptState({ attempt: "t1" }, "running", "run@2");
    emitter.attemptState({ attempt: "t1" }, "blocked", "block@3");
    emitter.attemptState({ attempt: "t1" }, "blocked", "block@3");
    await emitter.idle();
    const states = (await store.outbox.pending()).filter((e) => e.event_type === "node.state");
    assert.equal(states.length, 3);
    assert.equal(new Set(states.map((e) => e.event_id)).size, 3);
    assert.equal(states.filter((e) => e.payload.state === "blocked").length, 2, "blocked twice, legitimately");
  });

  it("does not emit unknown kinds, unbound reviewed/validated edges, self edges or empty ids", async () => {
    const { store, emitter } = rig();
    emitter.nodeUpsert("widget:1", {}, "t");
    emitter.nodeUpsert("agent:", {}, "t");
    emitter.edgeAdd("validated", "agent:a", "commit:c", "t");
    emitter.edgeAdd("reviewed", "agent:a", "commit:c", "t", { plan_digest: "" });
    emitter.edgeAdd("spawn", "agent:a", "agent:a", "t");
    emitter.edgeAdd("mentions" as never, "agent:a", "agent:b", "t");
    emitter.workerSpawned({ agent: "", attempt: "x", transition: "t" });
    await emitter.idle();
    assert.equal((await store.outbox.pending()).length, 0);
    assert.equal(emitter.stats().dropped, 7);
    emitter.edgeAdd("validated", "agent:a", "commit:c", "t", { commit: SHA });
    await emitter.idle();
    assert.equal((await store.outbox.pending()).length, 1);
  });
});

describe("lineage: off and failure isolation", () => {
  it("with no emitter nothing is written and mission behaviour is unchanged", async () => {
    const withNone = missionRig(null);
    const withEmitter = missionRig(rig().emitter);
    await withNone.store.flush();
    await withEmitter.store.flush();
    assert.equal(withNone.backend.all().length, withEmitter.backend.all().length);
    assert.deepEqual(
      withNone.backend.all().map((e) => e.type),
      withEmitter.backend.all().map((e) => e.type),
    );
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    assert.doesNotThrow(() => graph.createWorker({ projectId: "P", role: "r", parentWorkerId: "ghost" }));
  });

  it("sink errors (sync throw and rejection) never reach the worker path", async () => {
    for (const sink of [
      {
        stage(): Promise<unknown> {
          throw new Error("sync boom");
        },
      },
      { stage: () => Promise.reject(new Error("async boom")) },
    ]) {
      const seen: unknown[] = [];
      const emitter = new LineageEmitter({ sink, source: "pi-x-00000001", onError: (e) => seen.push(e) });
      const graph = WorkGraph.create(JsonlEventStore.inMemory());
      graph.setLineage(emitter);
      const m = missionRig(emitter);
      assert.doesNotThrow(() => {
        const p = graph.createWorker({ projectId: "P", role: "r" });
        graph.createWorker({ projectId: "P", role: "r", parentWorkerId: p.id });
        graph.setWorkerStatus(p.id, "RUNNING");
        m.store.setExecutionStatus(m.execution.execution_id, "SUCCEEDED", {});
      });
      await emitter.idle();
      assert.ok(seen.length > 0);
      assert.equal(emitter.stats().errors, seen.length);
    }
    // a throwing error hook is contained too
    const emitter = new LineageEmitter({
      sink: { stage: () => Promise.reject(new Error("x")) },
      source: "pi-x-00000001",
      onError: () => {
        throw new Error("hook");
      },
    });
    emitter.nodeUpsert("agent:a", {}, "t");
    await emitter.idle();
  });

  it("a v1-only ingest (no envelope store) yields no emitter", async () => {
    const { ControlPlaneIngest } = await import("../../src/runtime/herdr/ControlPlaneIngest.ts");
    const ingest = new ControlPlaneIngest({ url: "http://127.0.0.1:9", fetch: async () => new Response("{}") });
    assert.equal(createLineageEmitter({ ingest }), null);
  });
});

class FakeCli implements HerdrCli {
  async status(): Promise<HerdrStatus> {
    return { ok: true, serverVersion: "0.9.1", protocol: 22 };
  }
  async listAgents(): Promise<HerdrAgent[]> {
    return [];
  }
  async getAgent(): Promise<HerdrAgent | null> {
    return null;
  }
  async readAgent(): Promise<string> {
    return "";
  }
  async prompt(): Promise<void> {}
  async wait(target: string): Promise<HerdrAgent> {
    return { agent_status: "done", cwd: "/tmp", pane_id: target, workspace_id: "w", revision: 1, state_change_seq: 1 };
  }
  async startAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async closePane(): Promise<void> {}
  async createWorktree(repo: string): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "w", path: repo };
  }
}
