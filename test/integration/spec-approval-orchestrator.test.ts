import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionSpecStore } from "../../src/orchestration/missionSpecStore.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import {
  SpecApprovalController,
  type ProtectedUserCriteria,
  type SpecControllerResult,
  type SpecScopeEnvelope,
  type SpecWorkerModel,
} from "../../src/orchestration/specApproval.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const manifest: WorkspaceManifest = {
  manifestId: "WM-spec",
  missionId: "",
  generation: 1,
  authorizedRoots: [{ canonicalPath: "/workspace/api", source: "explicit_user_path", access: "write" }],
  repositories: [
    {
      repoId: "repo-api",
      canonicalRoot: "/workspace/api",
      baseRef: "main",
      baseSha: "base-api",
      writableDomains: ["src/**", "test/**"],
    },
  ],
  dependencyEdges: [],
  hash: "manifest-hash",
  createdAt: "2026-09-28T10:00:00.000Z",
};

const authorModel: SpecWorkerModel = { id: "local/local", provider: "local" };
const reviewerModel: SpecWorkerModel = { id: "local/reviewer", provider: "local" };

function specBackends(reviewVerdicts: Array<"approve" | "request_changes">) {
  let reviewIndex = 0;
  let refineCount = 0;
  return {
    author: {
      async draft() {
        return {
          ok: true,
          draft: {
            derivedAcceptance: ["derived"],
            designSummary: "spec summary",
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [
              {
                kind: "agent",
                role: "implementer",
                objective: "implement the health endpoint",
                mutates_repo: true,
                write_domains: ["src/**"],
                acceptance_ids: [],
                deliverables: ["implementation", "tests"],
                execution_budget_ms: 60_000,
                isolation: "none",
              },
            ],
          },
          sessionId: "author-sess",
          modelId: "local/local",
        };
      },
    },
    reviewer: {
      async review() {
        const verdict = reviewVerdicts[Math.min(reviewIndex++, reviewVerdicts.length - 1)]!;
        return {
          ok: true,
          verdict,
          findings: verdict === "approve" ? [] : [{ severity: "blocking", title: "gap", detail: "detail" }],
          proposedAdjustments: [],
          uncoveredRisks: [],
          scopeViolations: [],
          acceptanceResults: [],
          summary: "ok",
          confidence: 0.9,
          sessionId: "review-sess",
          modelId: "local/reviewer",
        };
      },
    },
    refiner: {
      async refine() {
        refineCount += 1;
        return {
          ok: true,
          draft: {
            derivedAcceptance: ["derived"],
            designSummary: `spec summary refined ${refineCount}`,
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [
              {
                kind: "agent",
                role: "implementer",
                objective: "implement the health endpoint",
                mutates_repo: true,
                write_domains: ["src/**"],
                acceptance_ids: [],
                deliverables: ["implementation", "tests"],
                execution_budget_ms: 60_000,
                isolation: "none",
              },
            ],
          },
          sessionId: "refiner-sess",
          modelId: "local/local",
        };
      },
    },
  };
}

function buildSpecApprovalHook(
  store: MissionStore,
  backends: ReturnType<typeof specBackends>,
  reviewVerdicts: Array<"approve" | "request_changes">,
) {
  return async (input: {
    missionId: string;
    protectedInputs: ProtectedUserCriteria;
    acceptanceIds: string[];
    envelope: SpecScopeEnvelope;
  }): Promise<SpecControllerResult> => {
    const specStore = new MissionSpecStore(store);
    const controller = new SpecApprovalController({
      missionId: input.missionId,
      protectedInputs: input.protectedInputs,
      acceptanceIds: input.acceptanceIds,
      envelope: input.envelope,
      store: specStore,
      author: backends.author,
      reviewer: backends.reviewer,
      refiner: backends.refiner,
      authorModel,
      reviewerModel,
    });
    return controller.run();
  };
}

function harness(reviewVerdicts: Array<"approve" | "request_changes"> = ["approve"]) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const calls = { agent: 0, review: 0, validation: 0 };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () => {
        calls.agent += 1;
        return { executionId: "e", exitStatus: "succeeded", summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    review: {
      runReview: async () => ({
        executionId: "e",
        exitStatus: "succeeded",
        summary: "reviewed",
        artifactRefs: [],
        usage: {},
        findings: [],
        reviewEvidence: {
          reviewerSessionId: "s",
          model: "test",
          provider: "test",
          verdict: "approve" as const,
          independenceMode: "independent" as const,
          findings: [],
          outputValid: true,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    validation: {
      runValidation: async () => ({
        executionId: "e",
        exitStatus: "succeeded",
        summary: "valid",
        artifactRefs: [],
        usage: {},
        validationEvidence: {
          command: "npm test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1, failed: 0 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    process: { runProcess: async () => ({ executionId: "e", exitStatus: "succeeded", summary: "ran", artifactRefs: [], usage: {} }) },
  };
  const specBackendSet = specBackends(reviewVerdicts);
  const orchestrator = new Orchestrator({
    store,
    backends,
    planner: async () => [],
    specApproval: buildSpecApprovalHook(store, specBackendSet, reviewVerdicts),
    workspaceResolver: {
      resolve: async () => ({ manifest: { ...manifest, missionId: "" }, manifestSource: "test" }),
    } as never,
  });
  return { orchestrator, store, calls };
}

describe("autonomous spec approval through the orchestrator", () => {
  it("approves the exact plan and materializes tasks from the current approval before dispatch", async () => {
    const h = harness(["approve"]);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "base-api",
      mutationRequested: true,
    });
    assert.equal(result.completed, true);
    const mission = h.store.getMission(result.mission.mission_id)!;
    assert.ok(mission.status === "COMPLETE" || mission.status === "EXECUTING");
    const approval = h.store.getSpecApproval(mission.mission_id);
    assert.ok(approval, "an approval must be durably persisted");
    assert.equal(approval.actor, "policy");
    const revision = h.store.getSpecRevision(mission.mission_id)!;
    assert.equal(approval.semanticSpecHash, revision.semanticSpecHash);
    assert.equal(approval.planHash, revision.planHash);
    // At least one implementation task was materialized from the approved plan.
    assert.ok(h.store.listTasks(mission.mission_id).length >= 1);
  });

  it("refines within budget when review requests changes, then approves and executes", async () => {
    const h = harness(["request_changes", "approve"]);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "base-api",
      mutationRequested: true,
    });
    assert.equal(result.completed, true);
    const mission = h.store.getMission(result.mission.mission_id)!;
    const revision = h.store.getSpecRevision(mission.mission_id)!;
    // At least one refinement occurred.
    assert.ok(revision.revisionNumber >= 2);
    assert.ok(h.store.getSpecApproval(mission.mission_id));
  });
});
