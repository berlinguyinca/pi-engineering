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

/** Every edge endpoint was upserted as a node at or before the edge, in the same stream. */
function assertEndpointsUpserted(events: EnvelopeV2[]): void {
  const upserted = new Map<string, number>();
  for (const e of events) {
    if (e.event_type === "node.upsert") {
      const id = String(e.payload.node_id);
      if (!upserted.has(id)) upserted.set(id, e.source_sequence);
    }
  }
  const all = events.filter((e) => e.event_type === "edge.add");
  for (const e of all) {
    const p = e.payload as { from_id: string; to_id: string };
    for (const end of [p.from_id, p.to_id]) {
      const at = upserted.get(end);
      assert.ok(at !== undefined && at < e.source_sequence, `edge endpoint ${end} must be upserted before the edge`);
    }
  }
}

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

/** Run verify -> fence for a record the way the handoff driver does; the observed rollover only supplies the successor. */
async function verifyAndFence(
  store: MissionStore,
  mgr: CheckpointManager,
  taskId: string,
  executionId: string,
  handoffId: string,
  sha: string,
  session: string,
): Promise<void> {
  const cp = await mgr.persist({
    taskId,
    executionId,
    sessionId: session,
    snapshot: {
      candidateSha: sha,
      branch: "b",
      worktree: "/wt",
      committedChanges: [],
      preservedUncommittedChanges: [],
    },
    handoff: {},
  });
  const verdict = await store.verifyHandoff(handoffId, cp, {
    hashArtifact: async () => null,
    commitExists: async () => true,
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  await store.fenceHandoffSource(handoffId, async () => {});
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
    assertEndpointsUpserted(events);
    for (const session of ["session:s-old", "session:s-new"]) assert.ok(nodeIds(events).has(session), session);
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
    const ended = events.filter(
      (e) => e.event_type === "node.state" && !/^(tab|pane):/.test(String(e.payload.node_id)),
    );
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
    // Field-bearing upserts only: an edge endpoint also gets an empty "ensure" upsert (no fields, no ownership).
    const sessions = events.filter(
      (e) => e.event_type === "node.upsert" && String(e.payload.node_id).startsWith("session:") && e.payload.attrs,
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

  it("a rollover records the handoff edge between the two sessions from structured evidence", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    const events = await lineageEvents(envStore, emitter);
    const handoffs = edges(events, "handoff");
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]?.from_id, "session:sess-1");
    assert.equal(handoffs[0]?.to_id, "session:sess-2");
    assert.equal(handoffs[0]?.attrs?.source, "session_id_change");
  });

  it("ten sequential rollovers form one ordered handoff chain under one agent and attempt", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    const mgr = new CheckpointManager({ store });
    for (let i = 1; i <= 11; i++) {
      await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: `sess-${i}` });
    }
    const events = await lineageEvents(envStore, emitter);
    const chain = edges(events, "handoff").map((e) => `${e.from_id}>${e.to_id}`);
    assert.deepEqual(
      chain,
      Array.from({ length: 10 }, (_, i) => `session:sess-${i + 1}>session:sess-${i + 2}`),
    );
    assert.deepEqual(
      [...nodeIds(events)].filter((id) => id.startsWith("agent:") || id.startsWith("attempt:")).sort(),
      ["agent:task-a", `attempt:${execution.execution_id}`].sort(),
    );
    const rolled = events.filter((e) => e.event_type === "node.state" && e.payload.state === "rolled_over");
    assert.equal(rolled.length, 10, "every session but the last is rolled_over");
  });

  it("re-observing the same rollover does not add a second handoff edge", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    assert.equal(edges(await lineageEvents(envStore, emitter), "handoff").length, 1);
  });

  it("an observed rollover acknowledges the open handoff record that named the replaced session", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    const sha = "a".repeat(40);
    const record = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      kind: "context",
      state: "prepared",
      missionId: execution.mission_id,
      predecessor: { sessionId: "sess-1", generation: 0 },
      createdAt: new Date().toISOString(),
      ...extra,
    });
    store.addHandoffRecord(record("hf-ok", { checkpointSha: sha }));
    store.addHandoffRecord(record("hf-no-checkpoint"));
    store.addHandoffRecord(
      record("hf-other-session", { checkpointSha: sha, predecessor: { sessionId: "sess-9", generation: 0 } }),
    );
    const mgr = new CheckpointManager({ store });
    await verifyAndFence(store, mgr, task.task_id, execution.execution_id, "hf-ok", sha, "sess-1");
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });

    const done = store.getHandoffRecord("hf-ok");
    assert.equal(done?.state, "acknowledged");
    assert.deepEqual(done?.successor, { sessionId: "sess-2", generation: 1 });
    assert.equal(store.getHandoffRecord("hf-no-checkpoint")?.state, "prepared", "no checkpoint: never validated");
    assert.equal(store.getHandoffRecord("hf-other-session")?.state, "prepared", "different predecessor untouched");

    const events = await lineageEvents(envStore, emitter);
    const handoff = edges(events, "handoff").filter((e) => e.attrs?.handoff_id === "handoff:hf-ok");
    assert.equal(handoff.length, 1, "the explicit record's edge merges into the same edge key");
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
    assertEndpointsUpserted(events);
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
    assert.equal(once, 4, "agent + attempt + parent endpoint + spawn edge, no duplicates");
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
    assert.equal((await store.outbox.pending()).length, 3, "both endpoints upserted, then the edge");
  });
});

describe("lineage: attempt state transitions", () => {
  const stateEvents = (events: EnvelopeV2[]) =>
    events
      .filter((e) => e.event_type === "node.state" && !/^(tab|pane):/.test(String(e.payload.node_id)))
      .map((e) => [e.payload.node_id, e.payload.state]);

  it("Herdr: terminate on a completed worker is a no-op; wait failures emit failed; resume emits running", async () => {
    const { store: envStore, emitter } = rig();
    const cli = new FakeCli();
    const rt = new HerdrAgentRuntime({ cli, lineage: emitter });
    const a = await rt.create({ role: "r", objective: "o" });
    await rt.start(a);
    cli.waitStatus = "done";
    await rt.waitFor(a);
    await rt.terminate(a);
    assert.deepEqual(
      stateEvents(await lineageEvents(envStore, emitter)),
      [[`attempt:${a}`, "done"]],
      "done is not flipped",
    );

    const b = await rt.create({ role: "r", objective: "o" });
    await rt.start(b);
    cli.waitThrows = true;
    await assert.rejects(rt.waitFor(b), /timed out/);
    const failed = (await lineageEvents(envStore, emitter)).filter(
      (e) => e.event_type === "node.state" && e.payload.node_id === `attempt:${b}`,
    );
    assert.deepEqual(
      failed.map((e) => e.payload.state),
      ["failed"],
    );
    cli.waitThrows = false;
  });

  it("Herdr: polling a blocked worker adds one event; blocked -> working emits running", async () => {
    const { store: envStore, emitter } = rig();
    const cli = new FakeCli();
    const rt = new HerdrAgentRuntime({ cli, lineage: emitter });
    const a = await rt.create({ role: "r", objective: "o" });
    await rt.start(a);
    cli.waitStatus = "blocked";
    for (let i = 0; i < 5; i++) await rt.waitFor(a);
    assert.deepEqual(stateEvents(await lineageEvents(envStore, emitter)), [[`attempt:${a}`, "blocked"]]);
    cli.waitStatus = "working";
    await rt.waitFor(a);
    cli.waitStatus = "blocked";
    await rt.waitFor(a);
    const states = stateEvents(await lineageEvents(envStore, emitter)).map((s) => s[1]);
    assert.deepEqual(states, ["blocked", "running", "blocked"]);
    const ids = (await lineageEvents(envStore, emitter))
      .filter((e) => e.event_type === "node.state")
      .map((e) => e.event_id);
    assert.equal(new Set(ids).size, 3, "a repeated state is a distinct event only after a real change");
  });

  it("WorkGraph: same-millisecond changes stay distinct, repeats dedupe, completed is final", async () => {
    const { store: envStore, emitter } = rig();
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitter);
    const w = graph.createWorker({ projectId: "P", role: "r" });
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    const RealDate = Date;
    // freeze ISO timestamps too: new Date() is what WorkGraph stamps with
    globalThis.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [1_700_000_000_000]) as [number]));
      }
    } as DateConstructor;
    try {
      for (const st of ["RUNNING", "BLOCKED", "BLOCKED", "RUNNING", "BLOCKED"] as const)
        graph.setWorkerStatus(w.id, st);
      graph.complete(w.id);
      graph.cancel(w.id);
      graph.complete(w.id);
    } finally {
      globalThis.Date = RealDate;
      Date.now = realNow;
    }
    const events = await lineageEvents(envStore, emitter);
    assert.deepEqual(
      stateEvents(events).map((s) => s[1]),
      ["running", "blocked", "running", "blocked", "done"],
    );
    assert.equal(new Set(events.filter((e) => e.event_type === "node.state").map((e) => e.event_id)).size, 5);
  });

  it("MissionStore: the logical agent is upserted once; its state follows the aggregate of attempts", async () => {
    const { store: envStore, emitter } = rig();
    const { store, execution } = missionRig(emitter);
    store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "x" });
    const retry = store.createExecution({
      task_id: "task-a",
      mission_id: "MSN-lin",
      backend: "agent",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    store.setExecutionStatus(retry.execution_id, "RUNNING", {});
    store.setExecutionStatus(retry.execution_id, "SUCCEEDED", {});
    const events = await lineageEvents(envStore, emitter);
    const agentUpserts = events.filter((e) => e.event_type === "node.upsert" && e.payload.node_id === "agent:task-a");
    assert.equal(agentUpserts.filter((e) => e.payload.label !== undefined).length, 1, "label/state set once");
    assert.equal(agentUpserts[0]?.payload.label, "implementer", "label is the task's role, not the backend");
    const agentStates = events
      .filter((e) => e.event_type === "node.state" && e.payload.node_id === "agent:task-a")
      .map((e) => e.payload.state);
    assert.deepEqual(agentStates, ["failed", "running", "done"]);
  });

  it("MissionStore: a first checkpoint carrying a new session rolls over the execution's recorded session", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    store.setExecutionStatus(execution.execution_id, "RUNNING", { session_id: "S1" });
    await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      sessionId: "S2",
    });
    const events = await lineageEvents(envStore, emitter);
    assert.ok(nodeIds(events).has("session:S1"));
    assert.ok(nodeIds(events).has("session:S2"));
    assert.deepEqual(
      events
        .filter((e) => e.event_type === "node.state" && e.payload.state === "rolled_over")
        .map((e) => e.payload.node_id),
      ["session:S1"],
    );
  });

  it("a handoff transition is persisted, so a restart restores the state lineage reported", async () => {
    const { emitter } = rig();
    const { store, backend } = missionRig(emitter);
    store.addHandoffRecord({
      id: "hf-p",
      kind: "supervisor",
      state: "prepared",
      missionId: "MSN-lin",
      predecessor: { sessionId: "s-1", generation: 1 },
      createdAt: new Date().toISOString(),
    });
    store.transitionHandoffRecord("hf-p", "validated");
    store.transitionHandoffRecord("hf-p", "acknowledged", { sessionId: "s-2", generation: 2 });
    await store.flush();
    const reopened = MissionStore.open(backend);
    assert.equal(reopened.getHandoffRecord("hf-p")?.state, "acknowledged");
    assert.equal(reopened.getHandoffRecord("hf-p")?.successor?.sessionId, "s-2");
  });
});

describe("lineage: id and label bounds", () => {
  it("rejects control characters, bounds long ids with a hash, cleans labels", async () => {
    const { lineageNodeId } = await import("../../src/runtime/herdr/lineage.ts");
    assert.equal(lineageNodeId("agent", "a\nb"), undefined);
    assert.equal(lineageNodeId("agent", "a\u0000"), undefined);
    const long = "x".repeat(500);
    const id = lineageNodeId("agent", long)!;
    assert.ok(id.length <= "agent:".length + 200);
    assert.notEqual(id, lineageNodeId("agent", `${long}y`), "distinct long ids stay distinct");
    const { store, emitter } = rig();
    emitter.nodeUpsert("agent:a", { label: `bad\u0007label${"z".repeat(400)}` }, "t");
    emitter.nodeUpsert(`agent:${"q".repeat(300)}`, {}, "t");
    await emitter.idle();
    const pending = await store.outbox.pending();
    assert.equal(pending.length, 1, "an over-long raw node id is refused");
    const label = String(pending[0]?.payload.label);
    assert.ok(label.length <= 200 && [...label].every((c) => c.charCodeAt(0) > 31));
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
  waitStatus: HerdrAgent["agent_status"] = "done";
  waitThrows = false;
  async wait(target: string): Promise<HerdrAgent> {
    if (this.waitThrows) throw new Error("wait timed out");
    return {
      agent_status: this.waitStatus,
      cwd: "/tmp",
      pane_id: target,
      workspace_id: "w",
      revision: 1,
      state_change_seq: 1,
    };
  }
  async startAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async closePane(): Promise<void> {}
  async createWorkspace(repo: string) {
    return { workspaceId: "w", paneId: "w:p1", path: repo };
  }
  async createWorktree(repo: string) {
    return { workspaceId: "w", paneId: "w:p1", path: repo };
  }
}

describe("lineage: worker-review verdicts", () => {
  const evidence = (over: Record<string, unknown> = {}) =>
    ({
      evidenceId: "RE-lin",
      missionId: "MSN-lin",
      taskId: "task-a",
      executionId: "EX-review",
      identity: { candidateSha: SHA },
      verdict: "request_changes",
      independenceMode: "independent",
      findings: [{ severity: "high", summary: "x", status: "open" }],
      outputValid: true,
      accessible: true,
      recordedAt: "2026-09-26T10:00:00.000Z",
      ...over,
    }) as never;

  it("a valid verdict becomes a review node, a reviewed edge bound to the candidate commit and a produced edge", async () => {
    const { store: envStore, emitter } = rig();
    const { store } = missionRig(emitter);
    (store as unknown as { lineageReviewRecorded(e: unknown): void }).lineageReviewRecorded(evidence());
    const events = await lineageEvents(envStore, emitter);
    const reviewed = edges(events, "reviewed");
    assert.deepEqual(
      reviewed.map((e) => [e.from_id, e.to_id]),
      [["review:RE-lin", `commit:${SHA}`]],
    );
    assert.equal((reviewed[0] as { attrs?: { commit?: string } }).attrs?.commit, SHA);
    assert.equal(edges(events, "produced").length, 1);
    assertEndpointsUpserted(events);
  });

  it("an unreadable or invalid review projects nothing", async () => {
    const { store: envStore, emitter } = rig();
    const { store } = missionRig(emitter);
    const p = store as unknown as { lineageReviewRecorded(e: unknown): void };
    p.lineageReviewRecorded(evidence({ outputValid: false }));
    p.lineageReviewRecorded(evidence({ accessible: false }));
    const events = await lineageEvents(envStore, emitter);
    assert.equal(edges(events, "reviewed").length, 0);
  });
});

describe("lineage: tab and pane surfaces", () => {
  it("a top-level worker is a tab and a helper a pane, open on start and closed on terminate, without touching the agent", async () => {
    const { store: envStore, emitter } = rig();
    const rt = new HerdrAgentRuntime({ cli: new FakeCli(), lineage: emitter });
    const lead = await rt.create({ role: "lead", objective: "o" });
    await rt.start(lead);
    const child = await rt.create({ role: "helper", objective: "o", parentRuntimeId: lead });
    await rt.start(child);
    await rt.terminate(child);
    const events = await lineageEvents(envStore, emitter);
    const opened = events.filter(
      (e) => e.event_type === "node.upsert" && /^(tab|pane):/.test(String(e.payload.node_id)),
    );
    assert.deepEqual(
      opened.map((e) => [e.payload.node_id, e.payload.state, (e.payload.attrs as { agent_id: string }).agent_id]),
      [
        [`tab:${lead}`, "open", `agent:${lead}`],
        [`pane:${child}`, "open", `agent:${child}`],
      ],
    );
    const closed = events.filter(
      (e) => e.event_type === "node.state" && /^(tab|pane):/.test(String(e.payload.node_id)),
    );
    assert.deepEqual(
      closed.map((e) => [e.payload.node_id, e.payload.state]),
      [[`pane:${child}`, "closed"]],
    );
    assert.ok(
      !events.some((e) => e.event_type === "node.state" && e.payload.node_id === `agent:${child}`),
      "a surface close never changes the agent",
    );
  });
});

describe("lineage: removing a bound edge", () => {
  it("a validated edge can be withdrawn without restating its commit (a wildcard removal), but only with a reason", async () => {
    const { store: envStore, emitter } = rig();
    emitter.edgeRemove("validated", "gate:g1", `pr:github.com/a/b#1`, "upstream changed", "t1");
    emitter.edgeRemove("validated", "gate:g1", `pr:github.com/a/b#1`, "  ", "t2");
    const events = (await lineageEvents(envStore, emitter)).filter((e) => e.event_type === "edge.remove");
    assert.equal(events.length, 1, "no reason, no removal");
    assert.equal(events[0]?.payload.reason, "upstream changed");
    assert.equal((events[0]?.payload as { attrs?: unknown }).attrs, undefined);
  });
});

describe("lineage: observed handoff acknowledgement edge cases", () => {
  const sha = "a".repeat(40);
  const open = (missionId: string, extra: Record<string, unknown> = {}) => ({
    id: "hf-1",
    kind: "context",
    state: "prepared",
    missionId,
    predecessor: { sessionId: "sess-1", generation: 0 },
    checkpointSha: sha,
    createdAt: new Date().toISOString(),
    ...extra,
  });

  it("acknowledges through a checkpoint even when no lineage emitter is configured", async () => {
    const { store, task, execution } = missionRig(null);
    store.addHandoffRecord(open(execution.mission_id));
    const mgr = new CheckpointManager({ store });
    await verifyAndFence(store, mgr, task.task_id, execution.execution_id, "hf-1", sha, "sess-1");
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    assert.equal(store.getHandoffRecord("hf-1")?.state, "acknowledged");
  });

  it("an observed rollover never stands in for verification: an unverified checkpoint-bearing record stays prepared", async () => {
    const { store, task, execution } = missionRig(null);
    store.addHandoffRecord(open(execution.mission_id));
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    const rec = store.getHandoffRecord("hf-1");
    assert.equal(rec?.state, "prepared");
    assert.equal(rec?.verifiedAt, undefined);
    assert.equal(rec?.successor, undefined);
  });

  it("a verified but unfenced record is not acknowledged by observation either", async () => {
    const { store, task, execution } = missionRig(null);
    store.addHandoffRecord(open(execution.mission_id));
    const mgr = new CheckpointManager({ store });
    const cp = await mgr.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      sessionId: "sess-1",
      snapshot: {
        candidateSha: sha,
        branch: "b",
        worktree: "/wt",
        committedChanges: [],
        preservedUncommittedChanges: [],
      },
      handoff: {},
    });
    await store.verifyHandoff("hf-1", cp, { hashArtifact: async () => null, commitExists: async () => true });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    assert.equal(store.getHandoffRecord("hf-1")?.state, "validated");
  });

  it("does not acknowledge when another execution of the mission still holds the replaced session", () => {
    const { store, task, execution } = missionRig(null);
    const other = store.createTask({
      task_id: "task-b",
      mission_id: execution.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "other",
      repo_id: "repo-a",
      acceptance_ids: ["AC-2"],
      deliverables: ["other"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
    });
    const second = store.createExecution({
      task_id: other.task_id,
      mission_id: execution.mission_id,
      backend: "agent",
      checkpoint_id: "TCP-b",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    store.setExecutionStatus(execution.execution_id, "RUNNING", { session_id: "sess-1" });
    store.setExecutionStatus(second.execution_id, "RUNNING", { session_id: "sess-1" });
    store.addHandoffRecord(open(execution.mission_id));
    store.setExecutionStatus(second.execution_id, "RUNNING", { session_id: "sess-2" });
    assert.equal(store.getHandoffRecord("hf-1")?.state, "prepared", "ambiguous predecessor: left for its owner");
    assert.ok(task);
  });

  it("handoff bookkeeping failure never fails the checkpoint that observed the rollover", async () => {
    const { store, task, execution } = missionRig(null);
    store.addHandoffRecord(open(execution.mission_id));
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    (store as unknown as { transitionHandoffRecord: () => never }).transitionHandoffRecord = () => {
      throw new Error("boom");
    };
    const second = await mgr.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      sessionId: "sess-2",
    });
    assert.equal(second.sessionId, "sess-2");
  });

  it("the successor session node is created with its agent and attempt before the handoff edge references it", async () => {
    const { store: envStore, emitter } = rig();
    const { store, task, execution } = missionRig(emitter);
    store.addHandoffRecord(open(execution.mission_id));
    const mgr = new CheckpointManager({ store });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-1" });
    await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id, sessionId: "sess-2" });
    const events = await lineageEvents(envStore, emitter);
    const firstUpsert = events.find((e) => e.event_type === "node.upsert" && e.payload.node_id === "session:sess-2");
    assert.equal((firstUpsert?.payload.attrs as Record<string, unknown> | undefined)?.agent_id, "agent:task-a");
  });
});
