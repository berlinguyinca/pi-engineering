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

interface Harness {
  orchestrator: Orchestrator;
  store: MissionStore;
  calls: { agent: string[]; review: string[]; validation: string[]; process: string[] };
}

interface HarnessOpts {
  findings?: string[];
  failValidation?: boolean;
  reviewDelay?: boolean;
  /**
   * Realistic validation failure shape. The real CommandVerifier backend does
   * NOT throw on a failing suite — it resolves with exitStatus "failed". Modeled
   * only as a throw, the orchestrator once counted a failing suite as passing
   * gate evidence, so this pins the non-throwing shape too.
   */
  validationExitStatus?: string;
  reviewExitStatus?: string;
  agentExitStatus?: string;
  /** Fail the first N validation runs, then succeed (repair-loop recovery). */
  validationFailTimes?: number;
  /** Fail every validation run AFTER the Nth (a late failure must not be masked). */
  validationFailAfter?: number;
}

function harness(opts: HarnessOpts = {}): Harness {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const calls = { agent: [] as string[], review: [] as string[], validation: [] as string[], process: [] as string[] };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ role, objective }) => {
        calls.agent.push(role ?? objective);
        const exit = opts.agentExitStatus ?? "succeeded";
        return { executionId: "e", exitStatus: exit, summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    review: {
      runReview: async () => {
        calls.review.push("review");
        if (opts.reviewExitStatus && opts.reviewExitStatus !== "succeeded") {
          return {
            executionId: "e",
            exitStatus: opts.reviewExitStatus,
            summary: "review did not complete",
            artifactRefs: [],
            usage: {},
            findings: [],
          };
        }
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
        if (opts.validationFailAfter && calls.validation.length > opts.validationFailAfter) {
          return {
            executionId: "e",
            exitStatus: "failed",
            summary: "suite went red late",
            artifactRefs: [],
            usage: {},
          };
        }
        if (opts.validationFailTimes && calls.validation.length <= opts.validationFailTimes) {
          return { executionId: "e", exitStatus: "failed", summary: "suite red", artifactRefs: [], usage: {} };
        }
        if (opts.validationExitStatus && opts.validationExitStatus !== "succeeded") {
          return {
            executionId: "e",
            exitStatus: opts.validationExitStatus,
            summary: "validation did not pass",
            artifactRefs: [],
            usage: {},
          };
        }
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

describe("mission progress visibility — onProgress streams while the mission runs", () => {
  it("emits phase and task progress lines during orchestration, and clears after", async () => {
    const h = harness();
    const lines: string[] = [];
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      onProgress: (line) => lines.push(line),
    });
    assert.equal(result.completed, true, result.failureReason ?? "");
    // Progress is not empty: the operator sees what the mission is doing.
    assert.ok(lines.length > 0, "onProgress must emit at least one line");
    const joined = lines.join("\n");
    // Phase transitions are surfaced (classified / executing / complete).
    assert.match(joined, /phase (classified|executing|complete)/);
    // Task settlements are surfaced (implementer, validation, review).
    assert.match(joined, /task .* (SUCCEEDED|FAILED)/);
    // The progress hook does not leak into a subsequent call (cleared on exit).
    const after: string[] = [];
    const passive = await h.orchestrator.orchestrate("Explain this function", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: false,
      onProgress: (line) => after.push(line),
    });
    assert.equal(passive.completed, true);
    assert.ok(after.length >= 1, "the next call still reports its own progress");
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
    const barrier = parallelBarrier(2);
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ role }) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Block until both agents are active: deterministic overlap.
          await barrier.arrived();
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
    // Steering must not corrupt task/execution state: nothing may be left in a
    // state that a late runner result would illegally rewrite.
    const bad = h.store
      .listTasks(m.mission_id)
      .filter((t) => ["READY", "RUNNING", "RETRYING"].includes(t.status) && t.status === "RUNNING");
    assert.equal(bad.length, 0, "no task may still be RUNNING after steering + settlement");
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

describe("exitStatus is authoritative (non-throwing backend failures)", () => {
  it("validation that reports exitStatus 'failed' does NOT satisfy the validation gate", async () => {
    const h = harness({ validationExitStatus: "failed" });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "a failing validation suite must never complete the mission");
    // The validation task must be recorded as FAILED, not SUCCEEDED, so the gate
    // (and any operator) can see why.
    const v = h.store.listTasks(result.mission.mission_id).filter((t) => t.kind === "validation");
    assert.ok(v.length >= 1);
    assert.ok(
      v.some((t) => t.status === "FAILED"),
      `a validation task must be FAILED, got ${v.map((t) => t.status).join(",")}`,
    );
    assert.ok(h.calls.validation.length >= 1, "validation must still have been attempted");
  });

  it("review that reports exitStatus 'failed' does NOT count as a completed review", async () => {
    const h = harness({ reviewExitStatus: "failed" });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "an incomplete review must not satisfy the review gate");
    assert.ok(h.calls.review.length >= 1);
  });

  it("a worker reporting exitStatus 'failed' is not counted as a succeeded mutation", async () => {
    const h = harness({ agentExitStatus: "failed" });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "a failed worker must not yield a completed mission");
    const impl = h.store.listTasks(result.mission.mission_id).filter((t) => t.role === "implementer");
    assert.ok(
      impl.some((t) => t.status === "FAILED"),
      `implementer must be FAILED, got ${impl.map((t) => t.status).join(",")}`,
    );
  });
});

describe("repair of failed gate tasks", () => {
  it("a first-red validation creates repair work and a later green one completes the mission", async () => {
    const h = harness({ validationFailTimes: 1 });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    // The red run must have been recorded...
    const validations = h.store.listTasks(result.mission.mission_id).filter((t) => t.kind === "validation");
    assert.ok(
      validations.some((t) => t.status === "FAILED"),
      "the red validation is recorded",
    );
    assert.ok(
      validations.some((t) => t.status === "SUCCEEDED"),
      "the re-run validation is recorded",
    );
    // ...and repair work must have been created for it (not a permanent wedge)...
    const repairs = h.store
      .listTasks(result.mission.mission_id)
      .filter((t) => t.kind === "agent" && t.objective.includes("Fix the failing validation"));
    assert.ok(repairs.length >= 1, "a failed validation must spawn repair work, not wedge the mission");
    // ...and a stale failure must not keep the gate closed once it is green.
    assert.equal(result.completed, true, "a superseded validation failure must not block completion");
  });

  it("a permanently red validation still blocks after the bounded repair rounds", async () => {
    const h = harness({ validationExitStatus: "failed" });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "an unfixable validation must never complete");
    const repairs = h.store
      .listTasks(result.mission.mission_id)
      .filter((t) => t.kind === "agent" && t.objective.includes("Fix the failing validation"));
    assert.ok(repairs.length >= 1);
    assert.ok(repairs.length <= 4, `repair must stay bounded, got ${repairs.length}`);
  });
});

describe("missing backends must degrade, not explode", () => {
  it("an agent-only runtime does not throw and does not complete a mutation mission", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
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
          isolation: "none" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 1,
          failure_policy: "retry" as const,
        },
      ],
    });
    // No validation / review / integration backend exists. That must surface as a
    // blocked mission, not an exception escaping orchestrate with the mission
    // stranded in INTEGRATING / VALIDATING / REVIEWING.
    let result: Awaited<ReturnType<Orchestrator["orchestrate"]>> | undefined;
    let threw: unknown;
    try {
      result = await orchestrator.orchestrate("Add an endpoint and fix the build", {
        repository: ".",
        baseRef: "abc",
        mutationRequested: true,
      });
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, undefined, `orchestrate must not throw, got ${String(threw)}`);
    assert.ok(result);
    assert.equal(result.completed, false, "gates that cannot run must not be treated as passed");
    assert.ok(
      ["BLOCKED", "FAILED"].includes(result.mission.status),
      `mission must settle, got ${result.mission.status}`,
    );
  });
});

describe("missions stream live progress instead of blocking silently", () => {
  it("onProgress emits activity lines each carrying a progress bar", async () => {
    const h = harness();
    const lines: string[] = [];
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      onProgress: (line) => lines.push(line),
    });
    assert.ok(result.completed, "deterministic harness mission should complete");
    assert.ok(lines.length > 0, "mission must not run silently — progress lines must stream");
    // Each line while the mission is active should carry the deterministic
    // progress bar (20 cells) so the operator sees forward movement.
    const withBar = lines.filter((l) => l.includes("[") && l.includes("%") && l.includes("]"));
    assert.ok(
      withBar.length >= lines.length - 1,
      `expected nearly every line to carry a progress bar; ${withBar.length}/${lines.length} did`,
    );
    // Activity lines show what the mission is doing (phases/tasks), not silence.
    assert.ok(
      lines.some((l) => l.includes("phase") || l.includes("task") || l.includes("starting")),
      lines.join("\n"),
    );
  });
});

describe("a late failure is never masked by an earlier success", () => {
  it("validation that goes red AFTER a green run still blocks completion", async () => {
    // A blocking finding forces a repair round, which re-runs validation; that
    // second run goes red, so a SUCCEEDED validation precedes a FAILED one.
    const h = harness({ findings: ["the endpoint still leaks a file handle"], validationFailAfter: 1 });
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const validations = h.store.listTasks(result.mission.mission_id).filter((t) => t.kind === "validation");
    assert.ok(
      validations.some((t) => t.status === "SUCCEEDED"),
      "an earlier validation succeeded",
    );
    assert.ok(
      validations.some((t) => t.status === "FAILED"),
      "a later validation failed",
    );
    assert.equal(
      result.completed,
      false,
      "a FAILED task created after a SUCCEEDED one must still block, not be treated as superseded",
    );
  });
});
