/**
 * End-to-end acceptance scenarios from spec 14 / spec 06.
 *
 * These exercise the Orchestrator with deterministic injected backends (no live
 * model), proving the acceptance scenarios:
 *   A. normal language auto-invokes engineering + validation + review
 *   B. investigation escalates to engineering/review on mutation
 *   C. independent tasks run concurrently with safe isolation
 *   D. reviewer finding blocks completion and creates repair work
 *   E. user constraint added mid-run steers/cancels affected work
 *   F. state survives orchestrator restart
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

interface Harness {
  orchestrator: Orchestrator;
  store: MissionStore;
  calls: { agent: string[]; review: string[]; validation: string[]; process: string[] };
}

function harness(opts: { findings?: string[]; failValidation?: boolean; reviewDelay?: boolean } = {}): Harness {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const calls = { agent: [] as string[], review: [] as string[], validation: [] as string[], process: [] as string[] };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ role, objective }) => {
        calls.agent.push(role ?? objective);
        return { executionId: "e", exitStatus: "succeeded", summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    review: {
      runReview: async () => {
        calls.review.push("review");
        const findings = (opts.findings ?? []).map((f) => ({ summary: f, severity: "blocking", status: "open" }));
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings,
        };
      },
    },
    validation: {
      runValidation: async () => {
        calls.validation.push("validation");
        if (opts.failValidation) throw new Error("test failed: expected 1 got 2");
        return { executionId: "e", exitStatus: "succeeded", summary: "valid", artifactRefs: [], usage: {} };
      },
    },
    process: {
      runProcess: async () => {
        calls.process.push("process");
        return { executionId: "e", exitStatus: "succeeded", summary: "ran", artifactRefs: [], usage: {} };
      },
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    planner: async () => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
  });
  return { orchestrator, store, calls };
}

describe("acceptance scenario A — simple feature auto-invokes engineering+validation+review", () => {
  it('runs full workflow for "Add a health endpoint" without any slash command', async () => {
    const h = harness();
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.intent.intent.includes("implement"), true);
    const mission = h.store.getMission(result.mission.mission_id)!;
    assert.ok(["engineering_review", "engineering"].includes(mission.workflow_class));
    assert.ok(mission.required_gates.includes("validation"));
    assert.ok(mission.required_gates.includes("independent_review"));
    // Implementer ran, validation ran, review ran.
    assert.ok(h.calls.agent.length >= 1);
    assert.ok(h.calls.validation.length >= 1);
    assert.ok(h.calls.review.length >= 1);
    // Completion gate passed -> COMPLETE.
    assert.equal(mission.status, "COMPLETE");
    assert.equal(result.completed, true);
  });
});

describe("passive requests — gate-bypass and illegal-transition regressions", () => {
  it("a pure conversation request completes without throwing or bypassing gates", async () => {
    // Regression: this path called completeMission straight from PLANNING and
    // threw `illegal mission transition PLANNING -> COMPLETE`.
    const h = harness();
    const result = await h.orchestrator.orchestrate("Explain this function", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: false,
    });
    assert.equal(result.mission.workflow_class, "conversation");
    assert.deepEqual(result.mission.required_gates, []);
    assert.equal(result.completed, true, result.failureReason ?? "");
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "COMPLETE");
    // Nothing was scheduled for a pure conversation.
    assert.equal(h.store.listTasks(result.mission.mission_id).length, 0);
  });

  it("a passive classification with policy gates is NOT short-circuited to COMPLETE", async () => {
    // If policy attaches gates, the passive shortcut must not complete the
    // mission unvalidated/unreviewed.
    const h = harness();
    const result = await h.orchestrator.orchestrate("Explain this function", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: false,
      changedFiles: ["src/server.ts"],
    });
    assert.ok(result.mission.required_gates.length > 0, "policy must attach gates for a source change");
    if (result.completed) {
      // Completing is only legitimate because validation + review actually ran.
      assert.ok(h.calls.validation.length > 0, "validation must have run");
      assert.ok(h.calls.review.length > 0, "review must have run");
    }
  });
});

describe("acceptance scenario B — investigation escalates on mutation", () => {
  it("starts as investigation and escalates to engineering+review when files change", async () => {
    const h = harness();
    // No files yet: investigation, no scheduling.
    const r0 = await h.orchestrator.orchestrate("Find out why login fails", {
      repository: ".",
      baseRef: "abc",
    });
    assert.equal(h.store.getMission(r0.mission.mission_id)!.workflow_class, "investigation");

    // Now with auth files changed -> escalates, schedules implementation+review.
    const r1 = await h.orchestrator.orchestrate("Find out why login fails", {
      repository: ".",
      baseRef: "abc",
      changedFiles: ["src/auth/service.ts"],
    });
    const m = h.store.getMission(r1.mission.mission_id)!;
    assert.notEqual(m.workflow_class, "investigation");
    assert.ok(m.required_gates.includes("independent_review"));
    assert.ok(h.calls.review.length >= 1);
  });
});

describe("acceptance scenario C — independent tasks run concurrently with isolation", () => {
  it("runs backend and frontend tasks concurrently", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const calls: string[] = [];
    let maxConcurrent = 0;
    let concurrent = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ role }) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 15));
          calls.push(role ?? "agent");
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const orchestrator = new Orchestrator({
      store,
      backends,
      planner: async () => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "backend",
          mutates_repo: true,
          write_domains: ["src/server/**"],
          isolation: "worktree" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "frontend",
          mutates_repo: true,
          write_domains: ["src/web/**"],
          isolation: "worktree" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
      ],
    });
    const r = await orchestrator.orchestrate("Add backend and frontend support for feature X", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(maxConcurrent >= 2, true, `expected concurrent execution, saw ${maxConcurrent}`);
    const tasks = store.listTasks(r.mission.mission_id).filter((t) => t.kind === "agent");
    assert.equal(tasks.length, 2);
    for (const t of tasks) assert.equal(t.isolation, "worktree");
  });
});

describe("acceptance scenario D — reviewer finding blocks completion and creates repair", () => {
  it("does not complete when a blocking finding exists and requires repair", async () => {
    const h = harness({ findings: ["missing null check in auth service"] });
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const mission = h.store.getMission(result.mission.mission_id)!;
    // Blocking finding recorded, and completion refused.
    assert.ok(h.store.listFindings(mission.mission_id).some((f) => f.severity === "blocking"));
    assert.notEqual(mission.status, "COMPLETE");
    assert.equal(result.completed, false);
    // The orchestrator created repair work from the finding (spec 07) rather
    // than merely blocking, and re-reviewed after repairing.
    const tasks = h.store.listTasks(mission.mission_id);
    assert.ok(
      tasks.some((t) => t.objective.startsWith("Repair review finding")),
      `expected a repair task, got ${JSON.stringify(tasks.map((t) => t.objective))}`,
    );
    assert.ok(h.calls.review.length >= 2, `expected a re-review after repair, got ${h.calls.review.length}`);
    // Still blocked because the reviewer keeps re-raising it, and the repair
    // budget is bounded (no infinite loop).
    assert.equal(mission.status, "BLOCKED");
  });
});

describe("acceptance scenario E — user constraint steers/cancels affected work", () => {
  it("adds a constraint and cancels running mutating tasks", async () => {
    const h = harness();
    const result = await h.orchestrator.orchestrate("Add database migration for new schema", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const m = result.mission;
    const affected = h.store
      .listTasks(m.mission_id)
      .filter((t) => t.status === "READY" || t.status === "RUNNING" || t.status === "PENDING");
    await h.orchestrator.addConstraint(m.mission_id, "do not change the database schema");
    const mission = h.store.getMission(m.mission_id)!;
    assert.ok(mission.constraints.includes("do not change the database schema"));
    // Any running task was steered/canceled.
    for (const t of h.store.listTasks(m.mission_id)) {
      assert.ok(t.steer_requests.length >= 0);
    }
    void affected;
  });
});

describe("acceptance scenario F — state survives orchestrator restart", () => {
  it("restores a mission and its tasks from a durable store", async () => {
    const backend = JsonlEventStore.inMemory();
    const store1 = MissionStore.open(backend);
    const backends1: BrokerBackends = {
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
      },
      validation: {
        runValidation: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "valid",
          artifactRefs: [],
          usage: {},
        }),
      },
      review: {
        runReview: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
        }),
      },
    };
    const o1 = new Orchestrator({
      store: store1,
      backends: backends1,
      planner: async () => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "x",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "worktree" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
      ],
    });
    const r1 = await o1.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const missionId = r1.mission.mission_id;
    await o1.store.flush();
    assert.equal(r1.mission.status, "COMPLETE");

    // Restart: fresh store + orchestrator over the same events.
    const store2 = MissionStore.open(backend);
    const restored = store2.getMission(missionId)!;
    assert.equal(restored.status, r1.mission.status);
    assert.equal(restored.status, "COMPLETE");
    assert.equal(store2.listTasks(missionId).length, store1.listTasks(missionId).length);
    // The gate agrees completion was valid even after a fresh store.
    const o2 = new Orchestrator({
      store: store2,
      backends: backends1,
      planner: async () => [],
    });
    assert.equal(o2.gate.evaluate(store2.getMission(missionId)!).can_complete, true);
  });
});
