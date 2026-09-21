import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ROLLOUT_STAGE_ORDER,
  canAdvance,
  captureBaselineSnapshot,
  checkRollbackConditions,
  createRolloutState,
  evidenceAllowsAdvance,
  isAuthoritativeGate,
  nextStage,
  rolloutApprovalForChange,
  rolloutDisagreement,
  rolloutStageIndex,
  stageMutatesRepo,
} from "../../src/uieng/rollout.ts";
import type { RolloutEvidence, RolloutState } from "../../src/uieng/rollout.ts";
import type { EvidenceBundle, ExecutionProvenance } from "../../src/uieng/schemas.ts";

function provenance(overrides: Partial<ExecutionProvenance> = {}): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: "EXEC-ROLLOUT",
    provider: "test",
    selected_model: "test-model",
    site: "isolated-worktree",
    node: "node-0",
    ...overrides,
  };
}

function evidenceBundle(): EvidenceBundle {
  return {
    schema_version: 1,
    kind: "evidence_bundle",
    id: "EV-BASE",
    screenshots: [],
    route: "/settings",
  };
}

function passingEvidence(overrides: Partial<RolloutEvidence> = {}): RolloutEvidence {
  return {
    consecutivePasses: 3,
    deterministicTestsPass: true,
    uiQualityGatePass: true,
    disagreement: 0,
    requiresApproval: false,
    ...overrides,
  };
}

describe("staged rollout state machine", () => {
  it("exposes the canonical stage order", () => {
    assert.deepEqual(ROLLOUT_STAGE_ORDER, [
      "shadow",
      "advisory",
      "automatic_worktree_remediation",
      "low_risk_deterministic_auto_accept",
      "bounded_autonomous_improvements",
      "repository_policy_auto_merge",
    ]);
    assert.equal(rolloutStageIndex("shadow"), 0);
    assert.equal(rolloutStageIndex("repository_policy_auto_merge"), 5);
  });

  it("classifies mutation stages", () => {
    assert.equal(stageMutatesRepo("shadow"), false);
    assert.equal(stageMutatesRepo("advisory"), false);
    assert.equal(stageMutatesRepo("automatic_worktree_remediation"), true);
    assert.equal(stageMutatesRepo("repository_policy_auto_merge"), true);
  });

  it("advances through the sequence when config and evidence allow", () => {
    let stage = nextStage("shadow", {}, passingEvidence());
    assert.equal(stage, "advisory");
    stage = nextStage(stage, {}, passingEvidence());
    assert.equal(stage, "automatic_worktree_remediation");
    stage = nextStage(stage, {}, passingEvidence());
    assert.equal(stage, "low_risk_deterministic_auto_accept");
    stage = nextStage(stage, {}, passingEvidence());
    assert.equal(stage, "bounded_autonomous_improvements");
    // Auto-merge stage requires repository policy to allow it.
    assert.equal(nextStage(stage, {}, passingEvidence()), "bounded_autonomous_improvements");
    stage = nextStage(stage, { repositoryPolicyAllowsAutoMerge: true }, passingEvidence());
    assert.equal(stage, "repository_policy_auto_merge");
    // Terminal.
    assert.equal(
      nextStage(stage, { repositoryPolicyAllowsAutoMerge: true }, passingEvidence()),
      "repository_policy_auto_merge",
    );
  });

  it("does not advance from shadow without enough consecutive passes", () => {
    assert.equal(nextStage("shadow", {}, passingEvidence({ consecutivePasses: 2 })), "shadow");
  });

  it("blocks advancement when a behavioral test fails", () => {
    assert.equal(nextStage("advisory", {}, passingEvidence({ deterministicTestsPass: false })), "advisory");
    assert.equal(
      nextStage("automatic_worktree_remediation", {}, passingEvidence({ deterministicTestsPass: false })),
      "automatic_worktree_remediation",
    );
  });

  it("blocks auto-accept advancement for high-risk / protected changes", () => {
    assert.equal(canAdvance("automatic_worktree_remediation", { highRiskChange: true }), false);
    assert.equal(canAdvance("automatic_worktree_remediation", { protectedChange: true }), false);
    assert.equal(
      nextStage("automatic_worktree_remediation", { protectedChange: true }, passingEvidence()),
      "automatic_worktree_remediation",
    );
  });

  it("blocks auto-merge stage unless repository policy allows it", () => {
    assert.equal(canAdvance("bounded_autonomous_improvements", {}), false);
    assert.equal(canAdvance("bounded_autonomous_improvements", { repositoryPolicyAllowsAutoMerge: true }), true);
  });

  it("does not trust an advisory UI-quality gate when config distrusts it", () => {
    assert.equal(
      evidenceAllowsAdvance("advisory", { uiQualityGateTrusted: true }, passingEvidence({ uiQualityGatePass: false })),
      false,
    );
    assert.equal(
      evidenceAllowsAdvance("advisory", { uiQualityGateTrusted: false }, passingEvidence({ uiQualityGatePass: false })),
      true,
    );
  });
});

describe("baselines / provenance / rollback", () => {
  it("captures a baseline snapshot retaining evidence + scores + timestamp", () => {
    const snap = captureBaselineSnapshot(evidenceBundle(), { contrast: 80, touch_targets: 90 });
    assert.equal(snap.kind, "baseline_snapshot");
    assert.equal(snap.evidence.id, "EV-BASE");
    assert.deepEqual(snap.metric_scores, { contrast: 80, touch_targets: 90 });
    assert.ok(snap.captured_at);
  });

  it("retains baseline, provenance and rollback conditions in the state record", () => {
    const snap = captureBaselineSnapshot(evidenceBundle(), { contrast: 80 });
    const state: RolloutState = createRolloutState({
      missionId: "M-1",
      provenance: provenance(),
      baseline: snap,
      rollbackConditions: [{ metric_id: "contrast", max_drop: 20, authoritative: true }],
    });
    assert.equal(state.baseline?.evidence.id, "EV-BASE");
    assert.equal(state.provenance.selected_model, "test-model");
    assert.equal(state.rollback_conditions.length, 1);
    assert.equal(state.stage, "shadow");
  });

  it("rolls back when a candidate regresses below the baseline floor", () => {
    const snap = captureBaselineSnapshot(evidenceBundle(), { contrast: 80 });
    const state: RolloutState = createRolloutState({
      missionId: "M-1",
      provenance: provenance(),
      baseline: snap,
      rollbackConditions: [{ metric_id: "contrast", max_drop: 20, authoritative: true }],
    });
    const ok = checkRollbackConditions(state, { candidate_scores: { contrast: 65 } });
    assert.equal(ok.rollback, false);
    const bad = checkRollbackConditions(state, { candidate_scores: { contrast: 45 } });
    assert.equal(bad.rollback, true);
    assert.equal(bad.violations[0]?.metric_id, "contrast");
    assert.equal(bad.violations[0]?.authoritative, true);
  });

  it("rolls back on a failed deterministic behavioral test or broken protected contract", () => {
    const state: RolloutState = createRolloutState({
      missionId: "M-1",
      provenance: provenance(),
      baseline: captureBaselineSnapshot(evidenceBundle(), {}),
      rollbackConditions: [],
    });
    const byTest = checkRollbackConditions(state, { candidate_scores: {}, deterministic_tests_pass: false });
    assert.equal(byTest.rollback, true);
    assert.equal(byTest.violations[0]?.metric_id, "deterministic_tests");
    const byContract = checkRollbackConditions(state, { candidate_scores: {}, protected_contracts_intact: false });
    assert.equal(byContract.rollback, true);
    assert.equal(byContract.violations[0]?.metric_id, "protected_contracts");
  });

  it("reports advisory violations separately without masking them", () => {
    const snap = captureBaselineSnapshot(evidenceBundle(), { contrast: 80 });
    const state: RolloutState = createRolloutState({
      missionId: "M-1",
      provenance: provenance(),
      baseline: snap,
      rollbackConditions: [{ metric_id: "contrast", max_drop: 10, authoritative: false }],
    });
    const check = checkRollbackConditions(state, { candidate_scores: { contrast: 40 } });
    assert.equal(check.rollback, true);
    assert.equal(check.violations[0]?.authoritative, false);
  });

  it("returns no rollback when no baseline has been captured", () => {
    const state: RolloutState = createRolloutState({ missionId: "M-1", provenance: provenance() });
    const check = checkRollbackConditions(state, { candidate_scores: { contrast: 0 } });
    assert.equal(check.rollback, false);
    assert.equal(check.violations.length, 0);
  });
});

describe("policy guard", () => {
  it("treats behavioral gates as authoritative and UI-quality gates as advisory", () => {
    assert.equal(isAuthoritativeGate("behavioral"), true);
    assert.equal(isAuthoritativeGate("ui_quality"), false);
    assert.equal(isAuthoritativeGate({ id: "g1", kind: "behavioral" }), true);
    assert.equal(isAuthoritativeGate({ id: "g2", kind: "ui_quality" }), false);
  });
});

describe("reuse of autonomous-UI modules", () => {
  it("reuses tournament requiresApproval classification", () => {
    assert.equal(rolloutApprovalForChange("security-sensitive auth change"), true);
    assert.equal(rolloutApprovalForChange("fix button padding"), false);
  });

  it("computes reviewer disagreement via review.ts", () => {
    const reviews = [
      { roleId: "visual_critic", score: 0.9, confidence: 0.8, reasoning: "x" },
      { roleId: "usability_agent", score: 0.1, confidence: 0.8, reasoning: "y" },
    ];
    const d = rolloutDisagreement(reviews as never);
    assert.ok(typeof d === "number" && d >= 0 && d <= 1);
  });
});
