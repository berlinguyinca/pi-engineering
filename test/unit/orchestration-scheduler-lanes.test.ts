import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { InMemoryLaneCoordinator } from "../../src/orchestration/lanes.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function makeMission(store: MissionStore) {
  const mission = store.createMission({
    title: "lanes",
    goal: "lanes",
    user_request: "lanes",
    repository: "repo-1",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  store.transitionMission(mission.mission_id, "PLANNING");
  store.transitionMission(mission.mission_id, "READY");
  store.transitionMission(mission.mission_id, "EXECUTING");
  return mission;
}

function bindRepo(store: MissionStore, missionId: string, repoId = "repo-1") {
  store.bindWorkspaceManifest({
    manifestId: `WM-${repoId}`,
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: `/tmp/${repoId}`, source: "existing_manifest", access: "read" }],
    repositories: [
      {
        repoId,
        canonicalRoot: `/tmp/${repoId}`,
        baseRef: "main",
        baseSha: "base",
        writableDomains: ["**"],
      },
    ],
    dependencyEdges: [],
    hash: `wm-${repoId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function makeTask(store: MissionStore, missionId: string, objective: string, domains: string[], repoId = "repo-1") {
  return store.createTask({
    mission_id: missionId,
    kind: "agent",
    role: "implementer",
    objective,
    repo_id: repoId,
    mutates_repo: true,
    write_domains: domains,
    isolation: "none",
    execution_budget_ms: 60_000,
    max_attempts: 1,
  });
}

function resolveRepository() {
  return async (repoId: string) => ({ repoId, root: `/tmp/${repoId}`, git: {} as never });
}

/** Deferred agent backend: each invocation resolves on an external release. */
function deferredBackend() {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  return {
    starts,
    release(objective: string) {
      releases.get(objective)?.();
    },
    runAgent: async ({ objective }: { objective: string }) => {
      starts.push(objective);
      await new Promise<void>((resolve) => releases.set(objective, resolve));
      return { executionId: objective, exitStatus: "succeeded" as const, summary: "done", artifactRefs: [], usage: {} };
    },
  };
}

async function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}

function newStore() {
  const eventStore = JsonlEventStore.inMemory();
  return { eventStore, store: MissionStore.open(eventStore) };
}

describe("MissionScheduler dispatch", () => {
  it("never dispatches a non-mutating task twice while its first dispatch is still starting", async () => {
    const { store } = newStore();
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "investigator",
      objective: "look",
      repo_id: "repo-1",
      mutates_repo: false,
      write_domains: [],
      isolation: "none",
      execution_budget_ms: 60_000,
      max_attempts: 3,
    });
    const backend = deferredBackend();
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: { agent: { runAgent: backend.runAgent } },
    });
    // A slow start: the task stays READY for many pass ticks before the broker runs it.
    const execute = broker.execute.bind(broker);
    broker.execute = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return execute(input);
    };
    const scheduler = new MissionScheduler({ store, broker, limits: { maxActive: 2, maxAgents: 2 } });
    const running = scheduler.runMission(mission.mission_id);
    await until(() => backend.starts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    backend.release("look");
    await running;
    assert.deepEqual(backend.starts, ["look"], "one dispatch, one worker");
    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    assert.equal(store.listExecutions(mission.mission_id).length, 1);
  });
});

describe("MissionScheduler cleanup", () => {
  it("leaves activeTasks even when the lane release throws", async () => {
    class ThrowingRelease extends InMemoryLaneCoordinator {
      override release(): Promise<void> {
        throw new Error("lane release exploded");
      }
    }
    const { store } = newStore();
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    const task = makeTask(store, mission.mission_id, "a", ["src/a"]);
    const backend = deferredBackend();
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: { agent: { runAgent: backend.runAgent } },
    });
    const lanes = new ThrowingRelease({ config: { leaseMs: 300_000, maxRepoWriters: 4 } });
    const scheduler = new MissionScheduler({ store, broker, lanes, ownerId: "owner-1" });
    const running = scheduler.runMission(mission.mission_id);
    const settled = running.then(
      () => "ok",
      (error: Error) => error.message,
    );
    await until(() => backend.starts.length === 1);
    backend.release("a");
    assert.equal(await settled, "lane release exploded");
    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    assert.equal((scheduler as unknown as { activeTasks: Map<string, unknown> }).activeTasks.size, 0);
  });
});

describe("MissionScheduler lane integration", () => {
  it("serializes overlapping write domains across tasks on the same repo", async () => {
    const { eventStore, store } = newStore();
    void eventStore;
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    const t1 = makeTask(store, mission.mission_id, "a", ["src/a"]);
    const t2 = makeTask(store, mission.mission_id, "a/nested", ["src/a/nested/**"]);
    const backend = deferredBackend();
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: { agent: { runAgent: backend.runAgent } },
    });
    const lanes = new InMemoryLaneCoordinator({ config: { leaseMs: 300_000, maxRepoWriters: 4 } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      lanes,
      ownerId: "owner-1",
      limits: { maxActive: 2, maxAgents: 2 },
    });
    const running = scheduler.runMission(mission.mission_id);
    await until(() => backend.starts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(backend.starts, ["a"], "overlapping task must wait until the first releases its lane");
    assert.equal(store.getTask(t2.task_id)?.status, "PENDING", "lane-blocked task stays pending until the lane frees");
    backend.release("a");
    await until(() => backend.starts.length === 2);
    backend.release("a/nested");
    await running;
    assert.equal(store.getTask(t1.task_id)?.status, "SUCCEEDED");
    assert.equal(store.getTask(t2.task_id)?.status, "SUCCEEDED");
  });

  it("runs non-overlapping write domains in parallel", async () => {
    const { store } = newStore();
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    makeTask(store, mission.mission_id, "a", ["src/a"]);
    makeTask(store, mission.mission_id, "b", ["src/b"]);
    let active = 0;
    let peak = 0;
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: {
        agent: {
          runAgent: async ({ objective }) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 50));
            active--;
            return { executionId: objective, exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      lanes: new InMemoryLaneCoordinator({ config: { leaseMs: 300_000, maxRepoWriters: 4 } }),
      ownerId: "owner-1",
      limits: { maxActive: 2, maxAgents: 2 },
    });
    await scheduler.runMission(mission.mission_id);
    assert.equal(peak, 2, "disjoint domains should run concurrently");
  });

  it("waits on a foreign live claim, then proceeds via takeover when the lease expires", async () => {
    const { eventStore, store } = newStore();
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    const task = makeTask(store, mission.mission_id, "mine", ["src/a"]);
    let now = 1_000_000;
    const backend = deferredBackend();
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: { agent: { runAgent: backend.runAgent } },
    });
    const lanes = new InMemoryLaneCoordinator({ config: { leaseMs: 100, maxRepoWriters: 4 }, now: () => now });
    // A foreign host holds src/a.
    await lanes.acquire({
      repoId: "repo-1",
      domains: ["src/a"],
      ownerId: "foreign",
      missionId: "MSN-foreign",
      taskId: "TSK-foreign",
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      lanes,
      ownerId: "owner-1",
      now: () => now,
      limits: { maxActive: 1, maxAgents: 1 },
    });
    const running = scheduler.runMission(mission.mission_id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(backend.starts.length, 0, "must not dispatch while the foreign claim is live");
    assert.equal(store.getTask(task.task_id)?.status, "PENDING");
    // Advance the clock past the foreign lease: the next pass should take it over.
    now = now + 10_000;
    await until(() => backend.starts.length === 1);
    backend.release("mine");
    await running;
    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    const acquired = eventStore.all().filter((e) => e.type === "lane.acquired" && e.payload.task_id === task.task_id);
    assert.ok(acquired.length >= 1, "lane.acquired recorded on takeover");
  });

  it("never fails a task on lane contention — it waits instead", async () => {
    const { store } = newStore();
    const mission = makeMission(store);
    bindRepo(store, mission.mission_id);
    const task = makeTask(store, mission.mission_id, "mine", ["src/a"]);
    let now = 1_000_000;
    const broker = new ExecutionBroker({
      store,
      resolveRepository: resolveRepository(),
      backends: {
        agent: {
          runAgent: async ({ objective }) => ({
            executionId: objective,
            exitStatus: "succeeded" as const,
            summary: "done",
            artifactRefs: [],
            usage: {},
          }),
        },
      },
    });
    const lanes = new InMemoryLaneCoordinator({ config: { leaseMs: 100, maxRepoWriters: 4 }, now: () => now });
    await lanes.acquire({
      repoId: "repo-1",
      domains: ["src/a"],
      ownerId: "foreign",
      missionId: "MSN-foreign",
      taskId: "TSK-foreign",
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      lanes,
      ownerId: "owner-1",
      now: () => now,
      limits: { maxActive: 1, maxAgents: 1 },
    });
    const running = scheduler.runMission(mission.mission_id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.notEqual(store.getTask(task.task_id)?.status, "FAILED", "blocked task must not be failed");
    now = now + 10_000;
    await running;
    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
  });
});
