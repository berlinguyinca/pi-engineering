import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemorySpecStore,
  SpecApprovalController,
  SpecApprovalError,
  approvalEligible,
  approvalInvalidated,
  blockingFindingFingerprint,
  canonicalSort,
  computeFullRecordHash,
  computePlanHash,
  computeSemanticSpecHash,
  coverageComplete,
  preservesProtectedInputs,
  sha256,
  stableTaskId,
  validatePlannedTasks,
  validateReviewResult,
  workspaceIdentityHash,
  acceptanceHash,
  type MissionSpecRevision,
  type ProtectedUserCriteria,
  type SpecPlannedTask,
  type SpecReviewEvidence,
  type SpecScopeEnvelope,
} from "../../src/orchestration/specApproval.ts";
import type { SpecWorkerModel } from "../../src/orchestration/specBackends.ts";

function protectedInputs(overrides: Partial<ProtectedUserCriteria> = {}): ProtectedUserCriteria {
  return {
    userRequest: "Add a health endpoint to the API",
    constraints: ["Do not add new dependencies"],
    acceptance: [{ id: "AC-1", text: "GET /health returns 200" }],
    requiredGates: ["validation", "review"],
    workspace: {
      manifestHash: "manifest-hash",
      manifestGeneration: 1,
      repositoryId: "repo-api",
      repositoryRoot: "/workspace/api",
      baseSha: "base-api",
    },
    policyVersion: "policy-v1",
    ...overrides,
  };
}

const envelope: SpecScopeEnvelope = {
  repositoryId: "repo-api",
  repositoryRoot: "/workspace/api",
  writableDomains: ["src/**", "test/**"],
  baseSha: "base-api",
};

function planTask(overrides: Partial<SpecPlannedTask> = {}): SpecPlannedTask {
  return {
    task_id: "TSK-health",
    kind: "agent",
    role: "implementer",
    objective: "implement the health endpoint",
    repo_id: "repo-api",
    depends_on: [],
    mutates_repo: true,
    write_domains: ["src/**"],
    acceptance_ids: ["AC-1"],
    deliverables: ["implementation", "tests"],
    execution_budget_ms: 60_000,
    isolation: "worktree",
    ...overrides,
  };
}

describe("canonical hashing", () => {
  it("is deterministic and order-insensitive for unordered collections", () => {
    const a = sha256({ x: ["b", "a", "a"], y: { k: 1, j: 2 } });
    const b = sha256({ y: { j: 2, k: 1 }, x: ["a", "b"] });
    assert.equal(a, b);
  });
  it("semantic spec hash excludes plan, ids, timestamps, and provenance", () => {
    const prot = protectedInputs();
    const h1 = computeSemanticSpecHash(prot, ["derived"], "summary", ["tests"], [], [], []);
    const h2 = computeSemanticSpecHash(prot, ["derived"], "summary", ["tests"], [], [], []);
    assert.equal(h1, h2);
    // A different design summary changes the hash.
    const h3 = computeSemanticSpecHash(prot, ["derived"], "different", ["tests"], [], [], []);
    assert.notEqual(h1, h3);
  });
  it("plan hash is deterministic and covers normalized tasks only", () => {
    const p1 = computePlanHash([planTask()]);
    const p2 = computePlanHash([planTask({ task_id: "TSK-other" })]);
    // Task ID is derived from the plan, so it is not part of plan identity.
    assert.equal(p1, p2);
    assert.notEqual(p1, computePlanHash([planTask({ objective: "different" })]));
  });
  it("stable task ids are deterministic and ordinal-dependent", () => {
    const a1 = stableTaskId("M1", "hash1", "repo-api", 1);
    const a2 = stableTaskId("M1", "hash1", "repo-api", 1);
    const b = stableTaskId("M1", "hash1", "repo-api", 2);
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
  });
  it("full-record hash covers the complete persisted envelope", () => {
    const revision = buildRevision();
    const full = computeFullRecordHash(revision);
    assert.ok(full.startsWith("sha256:"));
  });
  it("blocking finding fingerprint is stable, order-insensitive, and ignores non-blocking findings", () => {
    const a = blockingFindingFingerprint([
      { severity: "blocking" as const, title: "x", detail: "d" },
      { severity: "major" as const, title: "y", detail: "d" },
    ]);
    const b = blockingFindingFingerprint([
      { severity: "blocking" as const, title: "x", detail: "d" },
    ]);
    // Major findings do not affect the blocking fingerprint.
    assert.equal(a, b);
    assert.equal(
      blockingFindingFingerprint([
        { severity: "blocking" as const, title: "x", detail: "d" },
        { severity: "blocking" as const, title: "z", detail: "e" },
      ]),
      blockingFindingFingerprint([
        { severity: "blocking" as const, title: "z", detail: "e" },
        { severity: "blocking" as const, title: "x", detail: "d" },
      ]),
    );
  });
  it("canonicalSort deep-sorts keys", () => {
    assert.deepEqual(canonicalSort({ b: 1, a: 2 }), { a: 2, b: 1 });
  });
});

describe("strict planned-task validation", () => {
  it("accepts a well-formed plan", () => {
    const plan = validatePlannedTasks([planTask()], envelope, ["AC-1"]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.task_id, "TSK-health");
  });
  it("rejects unknown acceptance IDs", () => {
    assert.throws(
      () => validatePlannedTasks([planTask({ acceptance_ids: ["AC-nope"] })], envelope, ["AC-1"]),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "UNKNOWN_ACCEPTANCE",
    );
  });
  it("rejects out-of-envelope write domains", () => {
    assert.throws(
      () => validatePlannedTasks([planTask({ write_domains: ["/etc/**"] })], envelope, ["AC-1"]),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "WRITE_DOMAIN_OUTSIDE_REPOSITORY",
    );
  });
  it("rejects tasks targeting another repository", () => {
    assert.throws(
      () => validatePlannedTasks([planTask({ repo_id: "repo-other" })], envelope, ["AC-1"]),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "SCOPE_VIOLATION",
    );
  });
  it("rejects duplicate task IDs", () => {
    assert.throws(
      () => validatePlannedTasks([planTask(), planTask()], envelope, ["AC-1"]),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "DUPLICATE_TASK_ID",
    );
  });
  it("rejects an oversized deliverable set", () => {
    assert.throws(
      () => validatePlannedTasks([planTask({ deliverables: ["a", "b", "c", "d", "e"] })], envelope, ["AC-1"], 4),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "DECOMPOSITION_REQUIRED",
    );
  });
});

describe("coverage and preservation", () => {
  it("coverageComplete requires every acceptance criterion", () => {
    assert.ok(coverageComplete([planTask()], ["AC-1"]));
    assert.ok(!coverageComplete([planTask()], ["AC-1", "AC-2"]));
  });
  it("preservesProtectedInputs rejects weakening", () => {
    const prot = protectedInputs();
    assert.ok(preservesProtectedInputs(prot, prot));
    assert.ok(!preservesProtectedInputs(prot, protectedInputs({ userRequest: "weakened" })));
    assert.ok(!preservesProtectedInputs(prot, protectedInputs({ constraints: [] })));
    assert.ok(
      !preservesProtectedInputs(prot, {
        ...prot,
        workspace: { ...prot.workspace, baseSha: "other" },
      }),
    );
  });
});

describe("strict reviewer output validation", () => {
  it("rejects malformed verdict", () => {
    assert.throws(
      () => validateReviewResult({ verdict: "maybe", findings: [], acceptanceResults: [] }, ["AC-1"]),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "MALFORMED_REVIEW",
    );
  });
  it("rejects invented provenance", () => {
    assert.throws(
      () =>
        validateReviewResult(
          { verdict: "approve", findings: [], acceptanceResults: [{ acceptanceId: "AC-1", result: "covered" }] },
          ["AC-1"],
        ),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "INVENTED_PROVENANCE",
    );
  });
  it("rejects incomplete acceptance results", () => {
    assert.throws(
      () =>
        validateReviewResult(
          {
            verdict: "approve",
            findings: [],
            acceptanceResults: [],
            reviewerSession: "s1",
            reviewerModel: "m1",
            provider: "p1",
          },
          ["AC-1"],
        ),
      (e: unknown) => e instanceof SpecApprovalError && e.code === "INCOMPLETE_REVIEW",
    );
  });
  it("accepts a complete well-formed review", () => {
    const results = validateReviewResult(
      {
        verdict: "approve",
        findings: [],
        acceptanceResults: [{ acceptanceId: "AC-1", result: "covered" }],
        reviewerSession: "s1",
        reviewerModel: "m1",
        provider: "p1",
      },
      ["AC-1"],
    );
    assert.equal(results.length, 1);
  });
});

describe("approval eligibility and invalidation", () => {
  it("approvalEligible requires exact review + coverage + policy version", () => {
    const revision = buildRevision();
    const review = buildReview("approve", revision);
    assert.ok(approvalEligible(revision, review, ["AC-1"], "policy-v1"));
    assert.ok(!approvalEligible(revision, buildReview("request_changes", revision), ["AC-1"], "policy-v1"));
    assert.ok(!approvalEligible(revision, review, ["AC-1"], "policy-v2"));
  });
  it("approvalInvalidated detects bound-input changes", () => {
    const revision = buildRevision();
    const review = buildReview("approve", revision);
    const prot = protectedInputs();
    const approval = {
      missionId: "M1",
      approvalId: "AP-1",
      revisionId: revision.revisionId,
      semanticSpecHash: revision.semanticSpecHash,
      planHash: revision.planHash,
      acceptanceHash: acceptanceHash(prot.acceptance),
      workspaceIdentityHash: workspaceIdentityHash(prot.workspace),
      baseSha: "base-api",
      policyVersion: "policy-v1",
      reviewIds: [review.reviewId],
      actor: "policy" as const,
      rationale: "",
      approvedAt: "t",
    };
    // No bound-input change keeps it valid.
    assert.equal(approvalInvalidated(approval, prot, revision.planHash), null);
    // A changed base SHA invalidates.
    assert.equal(
      approvalInvalidated(approval, { ...prot, workspace: { ...prot.workspace, baseSha: "changed" } }, revision.planHash),
      "BASE_SHA",
    );
    // A changed acceptance set invalidates.
    const changedAcceptance = { ...prot, acceptance: [{ id: "AC-9", text: "different" }] };
    assert.equal(approvalInvalidated(approval, changedAcceptance, revision.planHash), "ACCEPTANCE");
    // A changed policy version invalidates first.
    assert.equal(approvalInvalidated(approval, { ...prot, policyVersion: "policy-v2" }, revision.planHash), "POLICY_VERSION");
    // A changed normalized plan invalidates.
    assert.equal(approvalInvalidated(approval, prot, "other-plan-hash"), "NORMALIZED_PLAN");
  });
});

function buildRevision(): MissionSpecRevision {
  const prot = protectedInputs();
  const plan = validatePlannedTasks([planTask()], envelope, ["AC-1"]);
  const semanticSpecHash = computeSemanticSpecHash(prot, ["derived"], "summary", ["tests"], [], [], []);
  const planHash = computePlanHash(plan);
  const revision: MissionSpecRevision = {
    missionId: "M1",
    revisionId: "SPCREV-1",
    revisionNumber: 1,
    predecessorId: null,
    protected: prot,
    derivedAcceptance: ["derived"],
    designSummary: "summary",
    testObligations: ["tests"],
    assumptions: [],
    risks: [],
    nonGoals: [],
    plan,
    semanticSpecHash,
    planHash,
    fullRecordHash: "",
    authorSession: "sess",
    authorModel: "local",
    createdAt: "t",
  };
  revision.fullRecordHash = computeFullRecordHash(revision);
  return revision;
}

function buildReview(verdict: "approve" | "request_changes", revision: MissionSpecRevision): SpecReviewEvidence {
  return {
    missionId: "M1",
    reviewId: "RV-1",
    revisionId: revision.revisionId,
    semanticSpecHash: revision.semanticSpecHash,
    planHash: revision.planHash,
    verdict,
    findings: verdict === "approve" ? [] : [{ severity: "blocking", title: "gap", detail: "detail" }],
    proposedAdjustments: [],
    uncoveredRisks: [],
    scopeViolations: [],
    acceptanceResults: [{ acceptanceId: "AC-1", result: "covered" }],
    summary: "ok",
    confidence: 0.9,
    reviewerSession: "s1",
    reviewerModel: "m1",
    provider: "p1",
    independenceMode: "fresh_context",
    reviewedAt: "t",
  };
}

const authorModel: SpecWorkerModel = { id: "local/local", provider: "local" };
const distinctReviewerModel: SpecWorkerModel = { id: "local/reviewer", provider: "local" };

function fakeBackends(reviewVerdicts: Array<"approve" | "request_changes">, refineTurns = 1) {
  let reviewIndex = 0;
  let refineCount = 0;
  return {
    author: {
      async draft() {
        return {
          ok: true,
          draft: {
            derivedAcceptance: ["derived"],
            designSummary: "summary",
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [planTask()],
          },
          sessionId: "sess",
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
          acceptanceResults: [{ acceptanceId: "AC-1", result: "covered" }],
          summary: "ok",
          confidence: 0.9,
          sessionId: "rv-sess",
          modelId: verdict === "approve" ? "local/reviewer" : "local/reviewer",
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
            designSummary: `summary-${refineCount}`,
            testObligations: ["tests"],
            assumptions: [],
            risks: [],
            nonGoals: [],
            proposedTasks: [planTask({ objective: `implement refined ${refineCount}` })],
          },
          sessionId: "rf-sess",
          modelId: "local/local",
        };
      },
    },
    refineTurns,
  };
}

describe("SpecApprovalController", () => {
  it("drafts, reviews, approves, and materializes", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["approve"]);
    const controller = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    const result = await controller.run();
    assert.ok(result.approved);
    assert.ok(result.approval);
    assert.ok(result.materialized?.ready);
    assert.equal(result.materialized?.created.length, 1);
    assert.equal(store.getApproval("M1")?.approvalId, result.approval?.approvalId);
  });

  it("refines within budget when review requests changes, then approves", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["request_changes", "approve"]);
    const controller = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    const result = await controller.run();
    assert.ok(result.approved);
    assert.equal(result.state.semanticRoundsUsed, 1);
    assert.ok(result.revision!.revisionNumber >= 2);
  });

  it("stops when refinement budget is exhausted", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["request_changes", "request_changes", "request_changes"]);
    const controller = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
      semanticRoundsLimit: 2,
    });
    const result = await controller.run();
    assert.ok(!result.approved);
    assert.equal(result.state.stopReason, "REFINEMENT_EXHAUSTED");
    assert.ok(result.resumeCondition);
  });

  it("records same-model reduced independence when no distinct reviewer model exists", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["approve"]);
    const controller = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: null,
    });
    const result = await controller.run();
    assert.ok(result.approved);
    const review = store.getLatestReview("M1")!;
    assert.equal(review.independenceMode, "same_model_reduced");
    assert.ok(result.state.warning?.includes("same-model"));
  });

  it("replays from the last durable boundary and reuses approved tasks", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["approve"]);
    const first = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    const r1 = await first.run();
    assert.ok(r1.approved);
    const second = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    const r2 = await second.run();
    assert.ok(r2.approved);
    // Idempotent: tasks reused, not duplicated.
    assert.equal(r2.materialized!.created.length, 0);
    assert.equal(r2.materialized!.reused.length, 1);
  });

  it("invalidates a stale approval when bound inputs change", async () => {
    const store = new MemorySpecStore();
    const backends = fakeBackends(["approve"]);
    const first = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: protectedInputs(),
      acceptanceIds: ["AC-1"],
      envelope,
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    await first.run();
    assert.ok(store.getApproval("M1"));
    // Base SHA changed -> stale approval must not authorize execution.
    const prot = protectedInputs();
    const changed = { ...prot, workspace: { ...prot.workspace, baseSha: "base-changed" } };
    const second = new SpecApprovalController({
      missionId: "M1",
      protectedInputs: changed,
      acceptanceIds: ["AC-1"],
      envelope: { ...envelope, baseSha: "base-changed" },
      store,
      author: backends.author as never,
      reviewer: backends.reviewer as never,
      refiner: backends.refiner as never,
      authorModel,
      reviewerModel: distinctReviewerModel,
    });
    await second.run();
    assert.ok(store.invalidatedFor("M1"));
  });
});
