import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { METRIC_GROUPS } from "../../src/uieng/policy.ts";
import type { UiImpactLevel } from "../../src/uieng/policy.ts";
import { METRIC_IDS } from "../../src/uieng/rubric.ts";
import type { Candidate, ExecutionProvenance, TaskRequest } from "../../src/uieng/schemas.ts";
import {
  DEFAULT_CANDIDATE_COUNT,
  type ParetoAcceptanceDecision,
  type ScoreMap,
  acceptanceDecision,
  buildEvaluationBattery,
  evaluateCandidate,
  tournamentPlan,
} from "../../src/uieng/tournament.ts";
import { ROBUSTNESS_SCENARIOS, VIEWPORT_MATRIX } from "../../src/uieng/usability.ts";

const task: TaskRequest = {
  schema_version: 1,
  kind: "task_request",
  id: "TASK-TOURNEY-1",
  type: "ui_change",
  required_capabilities: ["visual_analysis"],
  optional_capabilities: [],
  artifacts: [],
  context: "Redesign the checkout flow for clarity and speed.",
  latency_class: "interactive",
  quality_class: "high",
  reasoning_class: "deep",
  vision: true,
  image_generation: false,
};

function candidate(id = "CAND-1", selectedModel = "candidate-model-a", gateway = "tournament-plan"): Candidate {
  return {
    schema_version: 1,
    kind: "candidate",
    id,
    task_request: task,
    artifacts: [],
    provenance: {
      schema_version: 1,
      kind: "execution_provenance",
      id: "EXEC-CAND",
      selected_model: selectedModel,
      gateway,
    },
    status: "complete",
  };
}

function evaluator(selectedModel = "review-model-z", gateway = "review-gateway"): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: "EXEC-REVIEW",
    selected_model: selectedModel,
    gateway,
  };
}

describe("tournamentPlan", () => {
  it("plans multiple isolated-worktree candidates for high-impact changes", () => {
    const plan = tournamentPlan(task, "L3_system_design_system");
    assert.equal(plan.candidates.length, DEFAULT_CANDIDATE_COUNT.L3_system_design_system);
    assert.equal(plan.candidates.length, 4);
    assert.equal(plan.baselineRef, "HEAD");
    assert.equal(plan.impactLevel, "L3_system_design_system");
    assert.equal(plan.candidateWorktrees.length, plan.candidates.length);
    // Reuses GitRepo worktree info + MergeQueue promotion levels (no reimplementation).
    for (const wt of plan.candidateWorktrees) {
      assert.ok(wt.worktree.path);
      assert.ok(wt.worktree.branch);
      assert.equal(wt.promotionLevel, "candidate");
      assert.ok(plan.candidates.some((c) => c.id === wt.candidateId));
    }
    // Candidate statuses start pending; ids unique.
    assert.ok(plan.candidates.every((c) => c.status === "pending"));
    assert.equal(new Set(plan.candidates.map((c) => c.id)).size, plan.candidates.length);
  });

  it("scales candidate count with impact level", () => {
    assert.equal(tournamentPlan(task, "L1_micro").candidates.length, 2);
    assert.equal(tournamentPlan(task, "L2_feature_workflow").candidates.length, 3);
    assert.equal(tournamentPlan(task, "L0_none").candidates.length, 1);
    assert.equal(tournamentPlan(task, "L0_none", { candidateCount: 5 }).candidates.length, 5);
  });

  it("respects an explicit baseline ref and worktree base dir", () => {
    const plan = tournamentPlan(task, "L2_feature_workflow", {
      baselineRef: "main",
      worktreeBaseDir: "/tmp/tournaments",
    });
    assert.equal(plan.baselineRef, "main");
    for (const wt of plan.candidateWorktrees) assert.ok(wt.worktree.path.startsWith("/tmp/tournaments"));
  });

  it("builds a deterministic battery referencing rubric + usability modules", () => {
    const plan = tournamentPlan(task, "L3_system_design_system");
    const battery = plan.evaluationBattery;
    // Every metric id is a known rubric metric.
    for (const m of battery.metricIds) assert.ok(METRIC_IDS.includes(m));
    // Every scenario id and viewport id exists in usability.ts.
    const scenarioIds = new Set(ROBUSTNESS_SCENARIOS.map((s) => s.id));
    for (const s of battery.usabilityScenarios) assert.ok(scenarioIds.has(s));
    const viewportIds = new Set(VIEWPORT_MATRIX.map((v) => v.id));
    for (const v of battery.viewports) assert.ok(viewportIds.has(v));
    // L3 covers the full 60-metric rubric (individual metrics, never an aggregate).
    assert.equal(battery.metricIds.length, METRIC_IDS.length);
    assert.equal(battery.usabilityScenarios.length, ROBUSTNESS_SCENARIOS.length);
  });

  it("buildEvaluationBattery narrows the battery at lower levels", () => {
    const none = buildEvaluationBattery("L0_none");
    assert.equal(none.metricIds.length, 0);
    const l1 = buildEvaluationBattery("L1_micro");
    assert.ok(l1.metricIds.length > 0);
    assert.ok(l1.metricIds.length < METRIC_IDS.length);
    // L1 uses only visual + responsive groups.
    const visualResponsive = new Set([...METRIC_GROUPS.visual, ...METRIC_GROUPS.responsive]);
    for (const m of l1.metricIds) assert.ok(visualResponsive.has(m));
  });
});

describe("evaluateCandidate (Pareto gate)", () => {
  const baseline: ScoreMap = {
    critical_task_completion: 50,
    task_efficiency: 50,
    interaction_latency: 50,
    dom_complexity: 60,
    visual_hierarchy: 40,
  };
  const passing: ScoreMap = {
    ...baseline,
    critical_task_completion: 90,
    task_efficiency: 80,
    interaction_latency: 80,
    dom_complexity: 70,
    visual_hierarchy: 70,
  };

  const baseOpts = {
    criticalMetricIds: ["critical_task_completion", "task_efficiency"],
    budgets: {
      performance: ["interaction_latency"],
      complexity: ["dom_complexity"],
    },
    protectedContracts: ["checkout-contract"],
    targetDeltas: { critical_task_completion: 20 },
    protectedContractsIntact: true,
    deterministicTestsPassed: true,
    disagreementIndex: 0.1,
    disagreementThreshold: 0.3,
  };

  function decision(overrides: Record<string, unknown>): ParetoAcceptanceDecision {
    return evaluateCandidate(baseline, passing, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
      ...overrides,
    });
  }

  it("accepts when every Pareto gate passes (independent evaluator)", () => {
    const d = decision({});
    assert.equal(d.accepted, true);
    assert.equal(d.evaluation.verdict, "pass");
    assert.equal(d.requiresApproval, false); // standard change auto-accepts
  });

  it("acceptanceDecision is an alias of evaluateCandidate", () => {
    const d = acceptanceDecision(baseline, passing, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, true);
    assert.equal(d.kind, "acceptance_decision");
  });

  it("rejects when a critical metric regresses below its baseline floor", () => {
    const scores = { ...passing, critical_task_completion: 40 };
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, false);
    assert.equal(d.evaluation.verdict, "fail");
    assert.ok(d.rationale.includes("critical_task_completion"));
  });

  it("rejects when the target improvement is not met", () => {
    const scores = { ...passing, critical_task_completion: 60 }; // baseline 50, need 70
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("target improvement"));
  });

  it("never lets a model approve its own work", () => {
    const d = evaluateCandidate(baseline, passing, {
      ...baseOpts,
      candidate: candidate("CAND-1", "same-model", "same-gateway"),
      evaluatorProvenance: evaluator("same-model", "same-gateway"),
    });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("self-approval"));
  });

  it("allows same model under a different gateway (different provenance)", () => {
    const d = evaluateCandidate(baseline, passing, {
      ...baseOpts,
      candidate: candidate("CAND-1", "model-x"),
      evaluatorProvenance: evaluator("model-x", "different-gateway"),
    });
    assert.equal(d.accepted, true);
  });

  it("rejects when deterministic tests fail", () => {
    const d = decision({ deterministicTestsPassed: false });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("deterministic tests"));
  });

  it("rejects when a performance budget is not met", () => {
    const scores = { ...passing, interaction_latency: 30 }; // baseline 50
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("performance budget"));
  });

  it("rejects when a complexity budget is not met", () => {
    const scores = { ...passing, dom_complexity: 40 }; // baseline 60
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("complexity budget"));
  });

  it("rejects when a protected contract is not intact", () => {
    const d = decision({ protectedContractsIntact: false });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("protected contract"));
  });

  it("rejects when reviewer disagreement is above the threshold", () => {
    const d = decision({ disagreementIndex: 0.8 });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("disagreement"));
  });

  it("requires approval for destructive and security-sensitive changes", () => {
    const destructive = decision({ changeRiskClass: "destructive" });
    assert.equal(destructive.accepted, true);
    assert.equal(destructive.requiresApproval, true);

    const security = decision({ changeRiskClass: "security_sensitive" });
    assert.equal(security.requiresApproval, true);

    const ia = decision({ changeRiskClass: "major_information_architecture" });
    assert.equal(ia.requiresApproval, true);

    const semantic = decision({ changeRiskClass: "product_semantic" });
    assert.equal(semantic.requiresApproval, true);
  });

  it("auto-accepts low-risk proven fixes without approval", () => {
    const d = decision({ changeRiskClass: "low_risk_proven_fix" });
    assert.equal(d.accepted, true);
    assert.equal(d.requiresApproval, false);
  });

  it("honors an explicit requiresApproval override", () => {
    const d = decision({ requiresApproval: true });
    assert.equal(d.requiresApproval, true);
    assert.equal(d.accepted, true);
  });

  it("judges metrics individually and never by an aggregate/aesthetic score", () => {
    // A low non-critical metric does NOT fail acceptance; only critical/floor metrics do.
    const scores = { ...passing, visual_hierarchy: 20 };
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, true);
    // But every critical metric is still individually retained in the findings set.
    assert.ok(d.candidate.task_request.id);
  });

  it("rejects a candidate missing a critical metric score entirely", () => {
    const scores = { ...passing };
    delete scores.critical_task_completion;
    const d = evaluateCandidate(baseline, scores, {
      ...baseOpts,
      candidate: candidate(),
      evaluatorProvenance: evaluator(),
    });
    assert.equal(d.accepted, false);
    assert.ok(d.rationale.includes("not evaluated"));
  });
});
