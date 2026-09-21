import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candidate, ExecutionProvenance, TaskRequest } from "../../src/uieng/schemas.ts";
import {
  COMPLEXITY_METRIC_IDS,
  DEFAULT_CRITICAL_METRIC_IDS,
  PROMOTION_LEVELS,
  evaluateCandidate,
  tournamentPlan,
} from "../../src/uieng/tournament.ts";
import type {
  EvaluateCandidateOptions,
  GateBudgets,
  TournamentAcceptanceDecision,
} from "../../src/uieng/tournament.ts";

function taskRequest(): TaskRequest {
  return {
    schema_version: 1,
    kind: "task_request",
    id: "TASK-TOURNAMENT-1",
    type: "ui_feature",
    required_capabilities: ["visual"],
    optional_capabilities: [],
    artifacts: [],
    context: "Add a settings panel.",
    latency_class: "interactive",
    quality_class: "high",
    reasoning_class: "deep",
    vision: true,
    image_generation: false,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const prov: ExecutionProvenance = {
    schema_version: 1,
    kind: "execution_provenance",
    id: "PRV-CAND",
    selected_model: "model-alpha",
    provider: "provider-a",
  };
  return {
    schema_version: 1,
    kind: "candidate",
    id: "CAND-TEST",
    task_request: taskRequest(),
    artifacts: [],
    provenance: prov,
    status: "complete",
    ...overrides,
  };
}

function evaluator(overrides: Partial<ExecutionProvenance> = {}): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: "PRV-EVAL",
    selected_model: "model-beta",
    provider: "provider-b",
    ...overrides,
  };
}

describe("tournamentPlan", () => {
  it("scales candidate count by UI-impact level", () => {
    assert.equal(tournamentPlan(taskRequest(), "L0_none").candidateCount, 1);
    assert.equal(tournamentPlan(taskRequest(), "L1_micro").candidateCount, 2);
    assert.equal(tournamentPlan(taskRequest(), "L2_feature_workflow").candidateCount, 3);
    assert.equal(tournamentPlan(taskRequest(), "L3_system_design_system").candidateCount, 5);
  });

  it("builds one worktree slot per candidate with unique branches", () => {
    const plan = tournamentPlan(taskRequest(), "L3_system_design_system");
    assert.equal(plan.worktrees.length, 5);
    const branches = plan.worktrees.map((w) => w.branch);
    assert.equal(new Set(branches).size, 5);
    for (const w of plan.worktrees) {
      assert.equal(w.base, "main");
      assert.ok(w.candidateId.length >= 3);
    }
    assert.equal(plan.candidates.length, 5);
    assert.ok(plan.candidates.every((c) => c.status === "pending"));
  });

  it("derives the evaluation battery from policy + usability catalogs", () => {
    const plan = tournamentPlan(taskRequest(), "L3_system_design_system");
    assert.ok(plan.evaluationBattery.rubricMetricIds.length > 0);
    assert.ok(plan.evaluationBattery.viewports.length > 0);
    assert.ok(plan.evaluationBattery.scenarios.length > 0);
    assert.ok(plan.evaluationBattery.browserTests.includes("accessibility"));
    // The battery references real rubric metrics.
    for (const id of plan.evaluationBattery.rubricMetricIds) {
      assert.match(id, /^[a-z_]+$/);
    }
  });

  it("L2/L3 plans require approval; low-impact plans do not", () => {
    assert.equal(tournamentPlan(taskRequest(), "L1_micro").requiresApproval, false);
    assert.equal(tournamentPlan(taskRequest(), "L2_feature_workflow").requiresApproval, true);
    assert.equal(tournamentPlan(taskRequest(), "L3_system_design_system").requiresApproval, true);
  });

  it("exposes the MergeQueue promotion path", () => {
    assert.deepEqual(PROMOTION_LEVELS, ["candidate", "integration", "main"]);
    assert.deepEqual(tournamentPlan(taskRequest(), "L2_feature_workflow").promotionLevels, [
      "candidate",
      "integration",
      "main",
    ]);
  });
});

describe("evaluateCandidate Pareto gate", () => {
  const baseline: Record<string, number> = {
    critical_task_completion: 60,
    visual_hierarchy: 50,
    touch_targets: 70,
    keyboard_navigation: 65,
    component_complexity: 80,
    dependency_complexity: 70,
    code_duplication: 75,
    design_entropy: 70,
    interaction_latency: 50,
  };

  function scores(overrides: Record<string, number> = {}): Record<string, number> {
    return { ...baseline, ...overrides };
  }

  function opts(overrides: Partial<EvaluateCandidateOptions>): EvaluateCandidateOptions {
    return {
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
      criticalMetricIds: ["critical_task_completion", "touch_targets", "keyboard_navigation"],
      ...overrides,
    };
  }

  it("accepts a candidate that meets targets, keeps critical floors, and differs in provenance", () => {
    const decision = evaluateCandidate(baseline, scores({ critical_task_completion: 90 }), opts({}));
    assert.equal(decision.accepted, true);
    assert.equal(decision.requiresApproval, false);
    assert.deepEqual(decision.evaluation.verdict, "pass");
  });

  it("rejects when the evaluator is the same model that produced the candidate (no self-approval)", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({ critical_task_completion: 90 }),
      opts({ evaluatorProvenance: candidate().provenance }),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "self_approval"));
  });

  it("rejects on critical metric regression below the baseline floor", () => {
    const decision = evaluateCandidate(baseline, scores({ critical_task_completion: 30 }), opts({}));
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "critical_task_completion" && f.severity === "critical"));
  });

  it("rejects when a target delta is not met", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({ visual_hierarchy: 55 }),
      opts({ targetDeltas: { visual_hierarchy: 20 } }),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "visual_hierarchy"));
  });

  it("rejects when deterministic tests fail", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({}),
      opts({ deterministicTests: { passed: false, failures: ["npx tsc --noEmit"] } }),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "deterministic_tests"));
  });

  it("rejects when performance/complexity budgets are exceeded", () => {
    const budgets: GateBudgets = { performanceFloor: 80, complexityFloor: 0 };
    const decision = evaluateCandidate(baseline, scores({ interaction_latency: 30 }), opts({ budgets }));
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "interaction_latency"));
  });

  it("rejects when a protected contract regresses beyond budget", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({ critical_task_completion: 90, touch_targets: 30 }),
      opts({ protectedContracts: ["touch_targets"] }),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "touch_targets"));
  });

  it("rejects when reviewer disagreement is above threshold", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({}),
      opts({ disagreementIndex: 0.9, disagreementThreshold: 0.35 }),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.findings.some((f) => f.rubric === "disagreement"));
  });

  it("sets requiresApproval for L2/L3 impact and risk flags", () => {
    const lowRisk = evaluateCandidate(baseline, scores({}), opts({ impactLevel: "L1_micro" }));
    assert.equal(lowRisk.requiresApproval, false);

    const l3 = evaluateCandidate(baseline, scores({}), opts({ impactLevel: "L3_system_design_system" }));
    assert.equal(l3.requiresApproval, true);

    const risky = evaluateCandidate(baseline, scores({}), opts({ riskFlags: ["security_sensitive", "destructive"] }));
    assert.equal(risky.requiresApproval, true);
  });

  it("never decides on a single aggregate score; findings are per-metric", () => {
    const decision = evaluateCandidate(
      baseline,
      scores({ critical_task_completion: 90 }),
      opts({}),
    ) as TournamentAcceptanceDecision;
    assert.equal(decision.accepted, true);
    // The decision carries the per-metric evaluation findings and no aggregate.
    assert.ok(Array.isArray(decision.evaluation.findings));
  });

  it("uses the rubric-derived default critical metric set when none is supplied", () => {
    assert.ok(DEFAULT_CRITICAL_METRIC_IDS.length > 0);
    assert.ok(DEFAULT_CRITICAL_METRIC_IDS.includes("critical_task_completion"));
    const decision = evaluateCandidate(
      baseline,
      scores({ critical_task_completion: 10 }),
      opts({ criticalMetricIds: undefined }),
    );
    assert.equal(decision.accepted, false);
  });

  it("exposes complexity budget metric ids", () => {
    assert.ok(COMPLEXITY_METRIC_IDS.includes("component_complexity"));
    assert.ok(COMPLEXITY_METRIC_IDS.includes("design_entropy"));
  });
});
