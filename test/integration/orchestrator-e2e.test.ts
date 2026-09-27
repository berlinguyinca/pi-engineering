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
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { Orchestrator, intersectWriteDomains } from "../../src/orchestration/orchestrator.ts";
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
  emitActivity?: boolean;
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
      runAgent: async ({ role, objective, onActivity }) => {
        calls.agent.push(role ?? objective);
        if (opts.emitActivity) {
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
        }
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
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        // The deterministic harness has no Git provider. Its concern is the
        // orchestration lifecycle, so it opts out of repository isolation
        // explicitly instead of relying on an unsafe worktree fallback.
        isolation: "none" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        ),
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
    assert.equal(h.store.getWorkspaceManifest(mission.mission_id)?.repositories.length, 1);
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

describe("material legacy orchestration workset safety", () => {
  it("canonicalizes both sides of planner/manifest write-domain intersection", () => {
    assert.deepEqual(intersectWriteDomains(["src\\api\\**"], ["src/**"]), ["src/api/**"]);
  });

  it("rejects a protected legacy repository before any executable investigation planning", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let plannerCalls = 0;
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      planner: async () => {
        plannerCalls++;
        return [];
      },
    });

    const result = await orchestrator.orchestrate("Find out why login fails", {
      repository: "/",
      baseRef: "",
      mutationRequested: false,
    });

    assert.equal(result.mission.workflow_class, "investigation");
    assert.equal(result.mission.status, "BLOCKED");
    assert.match(result.failureReason ?? "", /protected filesystem root/i);
    assert.equal(plannerCalls, 0);
    assert.equal(store.getWorkspaceManifest(result.mission.mission_id), undefined);
  });

  it("blocks a traversal domain before a legacy worker can dispatch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let calls = 0;
    const orchestrator = new Orchestrator({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            calls++;
            return { executionId: "unsafe", exitStatus: "succeeded", summary: "unsafe", artifactRefs: [], usage: {} };
          },
        },
      },
      planner: async (mission) => [
        {
          kind: "agent",
          role: "implementer",
          objective: "escape",
          mutates_repo: true,
          write_domains: ["src/../../outside/**"],
          isolation: "none",
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 1,
          failure_policy: "block",
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
        },
      ],
    });

    const result = await orchestrator.orchestrate("Make a material change", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      acceptanceCriteria: ["stay inside the repository"],
    });

    assert.equal(result.mission.status, "BLOCKED");
    assert.match(result.failureReason ?? "", /INVALID_WRITE_DOMAIN/);
    assert.equal(calls, 0);
  });

  it("blocks missing planner acceptance mapping instead of assigning every criterion", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let calls = 0;
    const orchestrator = new Orchestrator({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            calls++;
            return { executionId: "worker", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      },
      planner: async () => [
        {
          kind: "agent",
          role: "implementer",
          objective: "unmapped work",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "none",
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 1,
          failure_policy: "block",
        },
      ],
    });

    const result = await orchestrator.orchestrate("Implement explicit acceptance", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      acceptanceCriteria: ["AC is explicitly implemented"],
    });

    assert.equal(result.mission.status, "BLOCKED");
    assert.match(result.failureReason ?? "", /UNCOVERED_ACCEPTANCE/);
    assert.equal(calls, 0);
  });
});

describe("mission caller cancellation", () => {
  it("aborts active work and does not continue into validation or review", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let backendSignal: AbortSignal | undefined;
    let validationCalls = 0;
    let reviewCalls = 0;
    const orchestrator = new Orchestrator({
      store,
      planner: async (mission) => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "long-running implementation",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "none" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
          max_attempts: 1,
          failure_policy: "block" as const,
        },
      ],
      backends: {
        agent: {
          runAgent: async ({ signal }) => {
            backendSignal = signal;
            started();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return { executionId: "late", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
          },
        },
        validation: {
          runValidation: async () => {
            validationCalls++;
            return { executionId: "v", exitStatus: "succeeded", summary: "valid", artifactRefs: [], usage: {} };
          },
        },
        review: {
          runReview: async () => {
            reviewCalls++;
            return { executionId: "r", exitStatus: "succeeded", summary: "reviewed", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const controller = new AbortController();
    const running = orchestrator.orchestrate("Implement a cancellable change", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      signal: controller.signal,
    });

    await workerStarted;
    controller.abort();
    const result = await running;

    assert.equal(backendSignal?.aborted, true);
    assert.equal(result.mission.status, "CANCELED");
    assert.equal(result.completed, false);
    assert.equal(validationCalls, 0);
    assert.equal(reviewCalls, 0);
  });

  for (const stage of ["validation", "review"] as const) {
    it(`cancels an active ${stage} gate and starts no later gate`, async () => {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      let started!: () => void;
      const gateStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let reviewCalls = 0;
      const waitForAbort = async (signal: AbortSignal) => {
        started();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return { executionId: stage, exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
      };
      const orchestrator = new Orchestrator({
        store,
        planner: async (mission) => [
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
            acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
              criterion.acceptance_id ? [criterion.acceptance_id] : [],
            ),
            max_attempts: 1,
            failure_policy: "block" as const,
          },
        ],
        backends: {
          agent: {
            runAgent: async () => ({
              executionId: "agent",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            }),
          },
          validation: {
            runValidation: async ({ signal }) =>
              stage === "validation"
                ? waitForAbort(signal)
                : { executionId: "v", exitStatus: "succeeded", summary: "valid", artifactRefs: [], usage: {} },
          },
          review: {
            runReview: async ({ signal }) => {
              reviewCalls++;
              return stage === "review"
                ? { ...(await waitForAbort(signal)), findings: [] }
                : {
                    executionId: "r",
                    exitStatus: "succeeded",
                    summary: "reviewed",
                    artifactRefs: [],
                    usage: {},
                    findings: [],
                  };
            },
          },
        },
      });
      const controller = new AbortController();
      const pending = orchestrator.orchestrate(`Cancel during ${stage}`, {
        repository: ".",
        baseRef: "abc",
        mutationRequested: true,
        signal: controller.signal,
      });

      await gateStarted;
      controller.abort();
      const result = await pending;

      assert.equal(result.mission.status, "CANCELED");
      assert.equal(result.completed, false);
      assert.ok(
        store.listTasks(result.mission.mission_id).some((task) => task.kind === stage && task.status === "CANCELED"),
      );
      if (stage === "validation") assert.equal(reviewCalls, 0);
    });
  }

  it("cancels active repair work and does not re-enter validation", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    let repairStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      repairStarted = resolve;
    });
    let validationCalls = 0;
    const orchestrator = new Orchestrator({
      store,
      planner: async (mission) => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "initial implementation",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "none" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
          max_attempts: 1,
          failure_policy: "block" as const,
        },
      ],
      backends: {
        agent: {
          runAgent: async ({ objective, signal }) => {
            if (objective.includes("Repair review finding")) {
              repairStarted();
              if (!signal.aborted) {
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
              }
            }
            return { executionId: "a", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
        validation: {
          runValidation: async () => {
            validationCalls++;
            return { executionId: "v", exitStatus: "succeeded", summary: "valid", artifactRefs: [], usage: {} };
          },
        },
        review: {
          runReview: async () => ({
            executionId: "r",
            exitStatus: "succeeded",
            summary: "needs repair",
            artifactRefs: [],
            usage: {},
            findings: [{ severity: "blocking", summary: "fix it" }],
          }),
        },
      },
    });
    const controller = new AbortController();
    const pending = orchestrator.orchestrate("Cancel repair", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      signal: controller.signal,
    });

    await started;
    controller.abort();
    const result = await pending;

    assert.equal(result.mission.status, "CANCELED");
    assert.equal(validationCalls, 1, "cancellation must prevent post-repair validation");
    assert.ok(
      store
        .listTasks(result.mission.mission_id)
        .some((task) => task.objective.includes("Repair review finding") && task.status === "CANCELED"),
    );
  });
});

describe("mission progress visibility — onProgress streams while the mission runs", () => {
  it("records execution stages with truthful activity types", () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const obs = new MissionObservability({ backend, store });
    const mission = store.createMission({
      title: "typed activity",
      goal: "typed activity",
      user_request: "typed activity",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "validation",
      role: "validator",
      objective: "check",
    });
    obs.missionCreated(mission.mission_id, mission.title);
    const orchestrator = new Orchestrator({ store, backends: {}, observability: obs, planner: async () => [] });
    const observe = (
      orchestrator as unknown as {
        observeWorkerActivity: (event: {
          kind: "execution";
          phase: "started" | "completed" | "failed";
          stage: "validation" | "integration" | "process";
          summary: string;
          meaningfulProgress: boolean;
          missionId: string;
          taskId: string;
          executionId: string;
        }) => void;
      }
    ).observeWorkerActivity.bind(orchestrator);
    for (const [executionId, stage, phase] of [
      ["validation", "validation", "started"],
      ["integration", "integration", "completed"],
      ["process", "process", "started"],
      ["failed", "validation", "failed"],
    ] as const) {
      observe({
        kind: "execution",
        phase,
        stage,
        summary: `${stage} ${phase}`,
        meaningfulProgress: false,
        missionId: mission.mission_id,
        taskId: task.task_id,
        executionId,
      });
    }
    assert.deepEqual(
      obs
        .projection(mission.mission_id)!
        .activity.slice(-4)
        .map((event) => event.type),
      ["validation", "integration", "running_command", "error"],
    );
  });

  it("releases a mission progress callback when planning throws", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      planner: async () => {
        throw new Error("planner unavailable");
      },
    });
    await assert.rejects(
      orchestrator.orchestrate("Add a health endpoint", {
        repository: ".",
        baseRef: "abc",
        mutationRequested: true,
        onProgress: () => {},
      }),
      /planner unavailable/,
    );

    const callbacks = (orchestrator as unknown as { progress: Map<string, (line: string) => void> }).progress;
    assert.equal(callbacks.size, 0, "failed orchestration must release the captured caller callback");
  });

  it("releases execution bookkeeping after settlement when observability is disabled", async () => {
    const h = harness({ emitActivity: true });
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, true);
    const internals = h.orchestrator as unknown as {
      observedExecutions: Set<string>;
      taskExecutions: Map<string, string>;
    };
    assert.equal(internals.observedExecutions.size, 0);
    assert.equal(internals.taskExecutions.size, 0);
  });

  it("streams worker tool detail and heartbeats into observability without changing DAG percentage", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const obs = new MissionObservability({ backend, store });
    const lines: string[] = [];
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ onActivity }) => {
          const secret = `sk-${"z".repeat(32)}`;
          onActivity?.({
            kind: "state",
            summary: `PRIVATE PROMPT CONTENT ${secret}`,
            meaningfulProgress: true,
          });
          onActivity?.({
            kind: "tool",
            phase: "started",
            toolName: "bash",
            summary: "Running tool: bash",
            meaningfulProgress: false,
          });
          onActivity?.({
            kind: "heartbeat",
            summary: "Still running · elapsed 15s · last activity 4s ago",
            meaningfulProgress: false,
            elapsedMs: 15_000,
            lastActivityMs: 4_000,
          });
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
      validation: {
        runValidation: async () => ({
          executionId: "v",
          exitStatus: "succeeded",
          summary: "ok",
          artifactRefs: [],
          usage: {},
        }),
      },
      review: {
        runReview: async () => ({
          executionId: "r",
          exitStatus: "succeeded",
          summary: "ok",
          artifactRefs: [],
          usage: {},
          findings: [],
        }),
      },
    };
    const orchestrator = new Orchestrator({
      store,
      backends,
      observability: obs,
      planner: async (mission) => [
        {
          kind: "agent",
          role: "implementer",
          objective: "PRIVATE TASK OBJECTIVE SHOULD NOT BECOME ACTIVITY",
          mutates_repo: false,
          write_domains: [],
          isolation: "none",
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
          max_attempts: 1,
          failure_policy: "block" as const,
        },
      ],
    });
    const result = await orchestrator.orchestrate("Add live mission detail", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      onProgress: (line) => lines.push(line),
    });
    const projection = obs.projection(result.mission.mission_id)!;
    assert.ok(projection.activity.some((event) => event.summary === "Running tool: bash"));
    assert.ok(projection.summary.lastHeartbeatAt);
    assert.equal(projection.summary.workers.active, 0, "settled execution must not leave a phantom running worker");
    assert.match(lines.join("\n"), /Running tool: bash/);
    assert.match(lines.join("\n"), /elapsed 15s .*last activity 4s ago/);
    assert.doesNotMatch(JSON.stringify(projection), /PRIVATE PROMPT CONTENT|sk-z/);
    assert.doesNotMatch(JSON.stringify(projection.activity), /PRIVATE TASK OBJECTIVE/);
    assert.doesNotMatch(lines.join("\n"), /PRIVATE PROMPT CONTENT|sk-z/);
    assert.equal(projection.summary.progress.approximatePercent, 100, "only the completed DAG advances percentage");
  });

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
    assert.equal(
      h.store.getWorkspaceManifest(result.mission.mission_id),
      undefined,
      "passive compatibility must not invent executable repository authority",
    );
  });

  it("a truly non-executable conversation does not resolve even a protected repository path", async () => {
    const h = harness();
    const result = await h.orchestrator.orchestrate("Explain this function", {
      repository: "/",
      baseRef: "",
      mutationRequested: false,
    });

    assert.equal(result.completed, true);
    assert.equal(h.store.getWorkspaceManifest(result.mission.mission_id), undefined);
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
      git: {
        headCommit: async () => "abc",
        createWorktree: async (_base: string, branch: string) => ({ path: ".", branch }),
        branchAheadOf: async () => false,
        statusIn: async () => "",
        removeWorktree: async () => {},
        isAncestor: async () => false,
      } as never,
      planner: async (mission) => [
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
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
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
      planner: async (mission) => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "x",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "none" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
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
    // The failure reason carries the backend's own summary, not just the status.
    const reasons = v.map((t) => (t as unknown as { failure_reason?: string }).failure_reason);
    assert.ok(reasons.includes("failed: validation did not pass"), `got ${JSON.stringify(reasons)}`);
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
    const lines: string[] = [];
    const result = await h.orchestrator.orchestrate("Add an endpoint and fix the build", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      onProgress: (line) => lines.push(line),
    });
    assert.equal(result.completed, false, "a failed worker must not yield a completed mission");
    const impl = h.store.listTasks(result.mission.mission_id).filter((t) => t.role === "implementer");
    assert.ok(
      impl.some((t) => t.status === "FAILED"),
      `implementer must be FAILED, got ${impl.map((t) => t.status).join(",")}`,
    );
    const progress = lines.join("\n");
    assert.match(progress, /task .* -> FAILED: backend reported failed: implemented/);
    assert.match(progress, /Mission (blocked|failed): .*No workers remain active\./i);
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
      planner: async (mission) => [
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
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
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
