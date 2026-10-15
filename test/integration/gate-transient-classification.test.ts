/**
 * A gate that dies on a provider failure (issue #170) says nothing about the
 * candidate: it is PROVIDER_TRANSIENT, re-runs alone against the same candidate,
 * and never creates repair work. A gate that returned a real verdict still
 * classifies as a gate failure and repairs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, ExecutionOutcome } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { FailureClassifier } from "../../src/orchestration/recovery.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

type GateScript = (call: number) => "ok" | ExecutionOutcome;

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function failed(summary: string): ExecutionOutcome {
  return { executionId: "e", exitStatus: "failed", summary, artifactRefs: [], usage: {} };
}

function harness(opts: { review?: GateScript; validation?: GateScript }) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const calls = { agent: 0, validation: 0, review: 0 };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () => {
        calls.agent++;
        return { executionId: "e", exitStatus: "succeeded", summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    validation: {
      runValidation: async () => {
        calls.validation++;
        const scripted = opts.validation?.(calls.validation) ?? "ok";
        if (scripted !== "ok") return scripted;
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "valid",
          artifactRefs: [],
          usage: {},
          validationEvidence: {
            command: "npm test",
            profile: "test",
            exitCode: 0,
            testSummary: { passed: 1 },
            noTargets: false,
            accessible: true,
            acceptanceResults: [],
          },
        };
      },
    },
    review: {
      runReview: async ({ acceptanceCriteria }) => {
        calls.review++;
        const scripted = opts.review?.(calls.review) ?? "ok";
        if (scripted !== "ok") return scripted;
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "review-gate",
            model: "test",
            provider: "test",
            verdict: "approve",
            independenceMode: "independent",
            findings: [],
            outputValid: true,
            accessible: true,
            acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
              acceptanceId: criterion.acceptanceId,
              status: "passed" as const,
              detail: "checked",
            })),
          },
        };
      },
    },
    process: {
      runProcess: async () => ({
        executionId: "e",
        exitStatus: "succeeded",
        summary: "ran",
        artifactRefs: [],
        usage: {},
      }),
    },
  };
  const clk = clock();
  const orchestrator = new Orchestrator({
    store,
    backends,
    git: {
      root: process.cwd(),
      headCommit: async () => "candidate-test-sha",
      captureDiff: async () => "diff --git a/src/health.ts b/src/health.ts",
      changedFiles: async () => ["src/health.ts"],
      loadCandidateLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadIntegrationRunInventory: async () => ({ records: [], diagnostics: [] }),
      loadPromotionLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadPendingBranchCleanupInventory: async () => ({ records: [], diagnostics: [] }),
    } as unknown as GitRepo,
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
    now: clk.now,
    sleep: clk.sleep,
    rand: () => 0,
  });
  return { orchestrator, store, calls };
}

async function run(h: ReturnType<typeof harness>) {
  const result = await h.orchestrator.orchestrate("Add a health endpoint", {
    repository: ".",
    baseRef: "abc",
    mutationRequested: true,
  });
  return { result, missionId: result.mission.mission_id };
}

function repairTasks(h: ReturnType<typeof harness>, missionId: string) {
  return h.store.listTasks(missionId).filter((task) => task.kind === "agent" && task.objective !== "implement");
}

describe("gate failures that are provider failures (issue #170)", () => {
  const providerFailures: Array<[string, string]> = [
    ["connection error", "Worker failed after 5 attempt(s): Connection error."],
    ["cut stream", "Stream ended without finish_reason"],
    ["grammar error", "HTTP 400 grammar: failed to parse grammar"],
    ["capacity hold", "gateway capacity hold: no slot available"],
    ["model-switch restart", "MODEL_SUPERSEDED: reviewer restarted on the same model"],
    ["no output", ""],
  ];

  for (const [label, summary] of providerFailures) {
    it(`classifies a reviewer that died on a ${label} as PROVIDER_TRANSIENT and re-runs only the review`, async () => {
      const h = harness({ review: (call) => (call === 1 ? failed(summary) : "ok") });
      const { result, missionId } = await run(h);

      const reviewTasks = h.store.listTasks(missionId).filter((task) => task.kind === "review");
      const firstReview = reviewTasks[0]!;
      const classification = h.store
        .listFailureClassifications(missionId)
        .find((entry) => entry.taskId === firstReview.task_id)!;
      assert.equal(classification.category, "PROVIDER_TRANSIENT");
      assert.ok(h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "PROBE_AND_BACKOFF"));
      assert.equal(
        h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "CREATE_REPAIR_TASKS"),
        false,
      );
      assert.equal(h.calls.review, 2, "only the review re-ran");
      assert.equal(h.calls.validation, 1, "validation was not re-run");
      assert.equal(h.calls.agent, 1, "the candidate was not touched");
      assert.equal(repairTasks(h, missionId).length, 0, "no repair tasks");
      assert.equal(result.mission.status, "COMPLETE");
      const candidate = h.store.getCandidate(missionId)!.identity;
      assert.equal(candidate.candidateSha, "candidate-test-sha");
      assert.equal(new Set(h.store.listCandidates(missionId).map((entry) => entry.identity.diffHash)).size, 1);
    });
  }

  it("re-runs only validation when the validator died on a provider error", async () => {
    const h = harness({ validation: (call) => (call === 1 ? failed("Connection error.") : "ok") });
    const { result, missionId } = await run(h);

    const first = h.store.listTasks(missionId).find((task) => task.kind === "validation")!;
    assert.equal(
      h.store.listFailureClassifications(missionId).find((entry) => entry.taskId === first.task_id)?.category,
      "PROVIDER_TRANSIENT",
    );
    assert.equal(h.calls.validation, 2);
    assert.equal(h.calls.review, 2, "review is refreshed once against the re-validated candidate");
    assert.equal(h.calls.agent, 1);
    assert.equal(repairTasks(h, missionId).length, 0);
    assert.equal(result.mission.status, "COMPLETE");
  });

  it("never spends repair rounds and parks the mission when the provider keeps failing", async () => {
    const h = harness({ review: () => failed("Connection error.") });
    const { result, missionId } = await run(h);

    assert.equal(result.mission.status, "BLOCKED");
    assert.equal(h.calls.agent, 1);
    assert.equal(repairTasks(h, missionId).length, 0);
    assert.equal(
      h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "CREATE_REPAIR_TASKS"),
      false,
    );
    assert.ok(h.calls.review <= 12, `gate re-runs must stay bounded, got ${h.calls.review}`);
  });

  it("still classifies a real request_changes verdict as REVIEW_FAILED and creates repair tasks", async () => {
    const h = harness({
      review: (call) =>
        call === 1
          ? {
              executionId: "e",
              exitStatus: "failed",
              summary: "review requested changes",
              artifactRefs: [],
              usage: {},
              findings: [{ severity: "blocking", category: "correctness", summary: "off by one" }],
              reviewEvidence: {
                reviewerSessionId: "review-gate",
                model: "test",
                provider: "test",
                verdict: "request_changes",
                independenceMode: "independent",
                findings: [{ severity: "blocking", summary: "off by one", status: "open" }],
                outputValid: true,
                accessible: true,
                acceptanceResults: [],
              },
            }
          : "ok",
    });
    const { missionId } = await run(h);

    const first = h.store.listTasks(missionId).find((task) => task.kind === "review")!;
    assert.equal(
      h.store.listFailureClassifications(missionId).find((entry) => entry.taskId === first.task_id)?.category,
      "REVIEW_FAILED",
    );
    assert.ok(h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "CREATE_REPAIR_TASKS"));
    assert.ok(repairTasks(h, missionId).length >= 1);
  });

  it("still classifies validation that ran and exited non-zero as VALIDATION_FAILED and repairs", async () => {
    const h = harness({
      validation: (call) =>
        call === 1
          ? {
              ...failed("suite red"),
              validationEvidence: {
                command: "npm test",
                profile: "test",
                exitCode: 1,
                testSummary: { failed: 1 },
                noTargets: false,
                accessible: true,
                acceptanceResults: [],
              },
            }
          : "ok",
    });
    const { missionId } = await run(h);

    const first = h.store.listTasks(missionId).find((task) => task.kind === "validation")!;
    assert.equal(
      h.store.listFailureClassifications(missionId).find((entry) => entry.taskId === first.task_id)?.category,
      "VALIDATION_FAILED",
    );
    assert.ok(h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "CREATE_REPAIR_TASKS"));
  });

  it("parks after repeated provider failures and a resume re-runs only the gate to COMPLETE", async () => {
    let providerUp = false;
    const h = harness({ review: () => (providerUp ? "ok" : failed("Connection error.")) });
    const { result, missionId } = await run(h);
    assert.equal(result.mission.status, "BLOCKED");
    const stop = h.store.listMissionStops(missionId).at(-1)!;
    assert.match(stop.resumeCondition, /resume the mission with \/mission resume .* once the provider answers/);
    const before = h.store.getCandidate(missionId)!.identity;
    const agentCalls = h.calls.agent;

    providerUp = true;
    h.store.resumeMission(missionId, "provider answers again");
    const resumed = await h.orchestrator.repairBlockedMission(missionId);

    assert.equal(resumed.status, "COMPLETE");
    assert.equal(h.calls.agent, agentCalls, "the candidate was not touched");
    assert.equal(repairTasks(h, missionId).length, 0);
    const after = h.store.getCandidate(missionId)!.identity;
    assert.equal(after.candidateSha, before.candidateSha);
    assert.equal(after.diffHash, before.diffHash);
  });

  it("resumes a legacy REVIEW_FAILED classification with a provider-error reason without repair tasks", async () => {
    let providerUp = false;
    const h = harness({ review: () => (providerUp ? "ok" : failed("Connection error.")) });
    const { missionId } = await run(h);
    const failedReview = h.store
      .listTasks(missionId)
      .filter((task) => task.kind === "review")
      .at(-1)!;
    // Production missions blocked before this fix carry the hard-coded gate category.
    h.store.classifyFailure(
      new FailureClassifier().classify({
        missionId,
        taskId: failedReview.task_id,
        executionId: failedReview.assigned_execution_id,
        summary: failedReview.failure_reason ?? "failed",
        category: "REVIEW_FAILED",
        observedAt: new Date().toISOString(),
      }),
    );

    providerUp = true;
    h.store.resumeMission(missionId, "operator resume");
    const resumed = await h.orchestrator.repairBlockedMission(missionId);

    assert.equal(resumed.status, "COMPLETE");
    assert.equal(repairTasks(h, missionId).length, 0);
    assert.equal(
      h.store.listRecoveryDecisions(missionId).some((decision) => decision.action === "CREATE_REPAIR_TASKS"),
      false,
    );
  });

  it("does not treat an implementer that merely mentions grammar as a provider failure", () => {
    const classifier = new FailureClassifier();
    for (const summary of [
      "worker emitted garbage: invalid worker output, grammar rules violated",
      "implementation defect: the expression grammar is wrong",
    ]) {
      const category = classifier.classify({ missionId: "MSN-x", summary }).category;
      assert.ok(["INVALID_WORKER_OUTPUT", "IMPLEMENTATION_DEFECT"].includes(category), `${summary} -> ${category}`);
    }
  });
});
