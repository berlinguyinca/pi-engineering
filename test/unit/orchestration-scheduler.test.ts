import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionScheduler, classifyFailure, domainsOverlap } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/** Deterministic overlap barrier (see dag-parallel/blackhole tests). */
function parallelBarrier(needed: number, timeoutMs = 5000): { arrived: () => Promise<void> } {
  let count = 0;
  let release: () => void;
  let settled = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      release();
    }
  }, timeoutMs);
  return {
    async arrived() {
      count++;
      if (count >= needed && !settled) {
        settled = true;
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

function makeBroker(store: MissionStore, backends: BrokerBackends) {
  return new ExecutionBroker({ store, backends });
}

describe("MissionScheduler (spec 02)", () => {
  it("runs independent tasks concurrently (parallelism)", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Backend (src/server) and frontend (src/web) — non-overlapping.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "backend",
      write_domains: ["src/server/**"],
      mutates_repo: true,
      isolation: "worktree",
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "frontend",
      write_domains: ["src/web/**"],
      mutates_repo: true,
      isolation: "worktree",
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const barrier = parallelBarrier(2);
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Block until both agents are active: deterministic overlap.
          await barrier.arrived();
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
    assert.ok(maxConcurrent >= 2, `expected concurrent execution, saw ${maxConcurrent}`);
  });

  it("serializes overlapping write domains", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Both write src/shared — must NOT run concurrently.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "a",
      write_domains: ["src/shared/**"],
      mutates_repo: true,
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "b",
      write_domains: ["src/shared/util.ts"],
      mutates_repo: true,
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(maxConcurrent, 1, `overlapping writes must serialize, saw ${maxConcurrent}`);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
  });

  it("respects dependency order", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const order: string[] = [];
    const a = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "scout", objective: "scout" });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "impl",
      depends_on: [a.task_id],
    });
    const c = store.createTask({
      mission_id: m.mission_id,
      kind: "review",
      role: "reviewer",
      objective: "review",
      depends_on: [b.task_id],
    });
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ role }) => {
          order.push(role);
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
      review: {
        runReview: async () => {
          order.push("reviewer");
          return { executionId: "e", exitStatus: "succeeded", summary: "reviewed", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.deepEqual(order, ["scout", "implementer", "reviewer"]);
    assert.equal(store.getTask(c.task_id)!.status, "SUCCEEDED");
  });

  it("retries transient failures then succeeds", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 3,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          if (calls === 1) throw new Error("transient 429 rate limited");
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(t.task_id)!.attempt, 2);
  });

  it("fails a task after exhausting retries", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 2,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          throw new Error("transient 429 rate limited");
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
  });
});

describe("write-domain conflict detection", () => {
  it("detects overlapping and disjoint domains", () => {
    assert.ok(domainsOverlap(["src/server/**"], ["src/server/api.ts"]));
    assert.ok(domainsOverlap(["src/shared/"], ["src/shared/util.ts"]));
    assert.ok(!domainsOverlap(["src/server/**"], ["src/web/**"]));
    assert.ok(domainsOverlap(["src/a"], ["src/a/b.ts"]));
  });
});

describe("failure classifier (spec 02)", () => {
  it("classifies transient vs merge vs test failures", () => {
    const task = { failure_policy: "retry" } as never;
    assert.equal(classifyFailure(new Error("429 rate limit"), task).action, "retry");
    assert.equal(classifyFailure(new Error("merge conflict in src/a.ts"), task).action, "repair");
    assert.equal(classifyFailure(new Error("test failed: expected 1 got 2"), task).action, "repair");
    assert.equal(classifyFailure(new Error("context overflow max tokens"), task).action, "retry");
  });
});
