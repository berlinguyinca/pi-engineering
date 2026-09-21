import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PERFORMANCE_COMPLEXITY_METRICS,
  TournamentRunner,
  buildEvaluationBattery,
  changeRequiresApproval,
  defaultCanonicalTasks,
  evaluateCandidate,
  gateDisagreement,
  performanceComplexityMetricIds,
  provenanceIdentity,
  tournamentPlan,
} from "../../src/uieng/tournament.ts";
import type { GatedAcceptanceDecision, ParetoGateOptions } from "../../src/uieng/tournament.ts";
import { METRIC_IDS } from "../../src/uieng/rubric.ts";
import { derivedEvaluation } from "../../src/uieng/policy.ts";
import type { ExecutionProvenance, TaskRequest } from "../../src/uieng/schemas.ts";

function taskRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schema_version: 1,
    kind: "task_request",
    id: "WI-TOUR1",
    type: "ui",
    required_capabilities: ["vision"],
    optional_capabilities: [],
    artifacts: [],
    context: "redesign the settings area",
    latency_class: "interactive",
    quality_class: "high",
    reasoning_class: "deep",
    vision: true,
    image_generation: false,
    ...overrides,
  };
}

function provenance(overrides: Partial<ExecutionProvenance> = {}): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: "EXEC-X",
    provider: "test",
    selected_model: "model-a",
    ...overrides,
  };
}

function baseCandidate(provenance: ExecutionProvenance) {
  return {
    schema_version: 1,
    kind: "candidate" as const,
    id: "CAND-1",
    task_request: taskRequest(),
    artifacts: [],
    provenance,
    status: "complete" as const,
  };
}

const evaluator = provenance({ id: "EXEC-EVAL", selected_model: "evaluator-model" });

function gateOptions(candidate: ReturnType<typeof baseCandidate>): ParetoGateOptions {
  return {
    criticalMetricIds: ["critical_task_completion", "semantic_accessibility", "keyboard_navigation"],
    budgets: {},
    protectedContracts: ["constitution", "tokens"],
    targetDeltas: { critical_task_completion: 10 },
    candidate,
    evaluatorProvenance: evaluator,
  };
}

// A full 60-metric score record so the gate can look up any metric.
function fullScores(overrides: Record<string, number> = {}): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const id of METRIC_IDS) scores[id] = 60;
  return { ...scores, ...overrides };
}

describe("tournamentPlan", () => {
  it("returns zero candidates for L0 (no UI impact)", () => {
    const plan = tournamentPlan(taskRequest(), "L0_none");
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.ui_impact_level, "L0_none");
  });

  it("returns multiple isolated candidates for high-impact changes", () => {
    const plan = tournamentPlan(taskRequest(), "L3_system_design_system");
    assert.ok(plan.candidates.length >= 3, `expected multiple candidates, got ${plan.candidates.length}`);
    const provenances = new Set(plan.candidates.map((c) => provenanceIdentity(c.provenance)));
    assert.equal(provenances.size, plan.candidates.length, "every candidate must have distinct provenance");
    assert.equal(plan.baseline_ref, "main");
  });

  it("scales candidate count with impact level", () => {
    const counts = ["L1_micro", "L2_feature_workflow", "L3_system_design_system"].map(
      (l) => tournamentPlan(taskRequest(), l as never).candidates.length,
    );
    assert.deepEqual(counts, [2, 3, 4]);
  });

  it("derives the battery metric ids from the proportional UI policy", () => {
    const plan = tournamentPlan(taskRequest(), "L2_feature_workflow");
    const expected = derivedEvaluation({ level: "L2_feature_workflow" });
    assert.deepEqual(plan.evaluation_battery.metric_ids, expected.metric_ids);
    assert.ok(plan.evaluation_battery.tasks.length > 0);
    assert.ok(plan.evaluation_battery.viewports.length > 0);
    assert.ok(plan.evaluation_battery.scenarios.length > 0);
  });

  it("builds a battery with viewport metric groups", () => {
    const battery = buildEvaluationBattery(derivedEvaluation({ level: "L1_micro" }));
    assert.ok(battery.viewport_metric_groups["desktop"]);
    assert.ok(battery.viewport_metric_groups["desktop"].includes("desktop_layout"));
  });

  it("default canonical task catalog is non-empty and typed", () => {
    const tasks = defaultCanonicalTasks();
    assert.ok(tasks.length >= 3);
    assert.ok(tasks.every((t) => t.goal.length > 0 && t.success_criteria.length > 0));
  });
});

describe("changeRequiresApproval", () => {
  it("flags major IA / product-semantic / destructive / security-sensitive changes", () => {
    assert.equal(changeRequiresApproval("information architecture restructure"), true);
    assert.equal(changeRequiresApproval("security hardening of auth"), true);
    assert.equal(changeRequiresApproval("destructive migration"), true);
    assert.equal(changeRequiresApproval("product semantic rename"), true);
  });

  it("does not flag routine visual tweaks", () => {
    assert.equal(changeRequiresApproval("spacing token adjustment"), false);
    assert.equal(changeRequiresApproval("fix contrast on buttons"), false);
  });
});

describe("provenanceIdentity", () => {
  it("distinguishes different models and matches identical ones", () => {
    const a = provenance({ selected_model: "model-a" });
    const b = provenance({ selected_model: "model-b" });
    assert.notEqual(provenanceIdentity(a), provenanceIdentity(b));
    assert.equal(provenanceIdentity(a), provenanceIdentity(provenance({ selected_model: "model-a" })));
  });
});

describe("evaluateCandidate — Pareto gate", () => {
  it("accepts a low-risk candidate that clears every gate", () => {
    const candidate = baseCandidate(provenance({ id: "EXEC-CAND", selected_model: "candidate-model" }));
    const decision = evaluateCandidate(fullScores({ critical_task_completion: 50 }), fullScores({ critical_task_completion: 70 }), gateOptions(candidate));
    assert.equal(decision.accepted, true);
    assert.equal(decision.requiresApproval, false);
    assert.equal(decision.provenance.selected_model, "evaluator-model");
  });

  it("rejects when the target delta is not met", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 55 }),
      gateOptions(candidate),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.rationale.includes("target_improvement") || decision.rationale.includes("Deltas"));
  });

  it("rejects when a critical metric is below its floor", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 60 }),
      fullScores({ critical_task_completion: 80, semantic_accessibility: 20 }),
      gateOptions(candidate),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.rationale.includes("No critical regression"));
  });

  it("rejects when deterministic tests fail", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70 }),
      { ...gateOptions(candidate), deterministicTestsPass: false },
    );
    assert.equal(decision.accepted, false);
  });

  it("rejects when a protected contract is broken", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70 }),
      { ...gateOptions(candidate), protectedContractsIntact: false },
    );
    assert.equal(decision.accepted, false);
  });

  it("rejects when performance/complexity is over budget", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ render_performance_cost: 40, critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70, render_performance_cost: 30 }),
      gateOptions(candidate),
    );
    assert.equal(decision.accepted, false);
    assert.ok(decision.rationale.includes("Performance/complexity within budgets"));
  });

  it("rejects when reviewer disagreement exceeds the threshold", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70 }),
      { ...gateOptions(candidate), disagreement: 0.7, maxDisagreement: 0.2 },
    );
    assert.equal(decision.accepted, false);
  });

  it("rejects a model that approves its own work", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70 }),
      { ...gateOptions(candidate), evaluatorProvenance: candidate.provenance },
    );
    assert.equal(decision.accepted, false);
  });

  it("requires approval for high-risk changes even when accepted", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 50 }),
      fullScores({ critical_task_completion: 70 }),
      { ...gateOptions(candidate), highRiskChange: true },
    );
    assert.equal(decision.accepted, true);
    assert.equal(decision.requiresApproval, true);
  });

  it("does not decide from a single aggregate score", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    // Even though the candidate's mean is high, a critical metric below its
    // floor must still reject — proving per-metric gating.
    const decision = evaluateCandidate(
      fullScores({ critical_task_completion: 90 }),
      fullScores({ critical_task_completion: 95, keyboard_navigation: 5 }),
      gateOptions(candidate),
    );
    assert.equal(decision.accepted, false);
  });

  it("produces a persisted-ready AcceptanceDecision with findings", () => {
    const candidate = baseCandidate(provenance({ selected_model: "candidate-model" }));
    const decision = evaluateCandidate(fullScores({ critical_task_completion: 50 }), fullScores({ critical_task_completion: 70 }), gateOptions(candidate)) as GatedAcceptanceDecision;
    assert.equal(decision.kind, "acceptance_decision");
    assert.equal(decision.schema_version, 1);
    assert.equal(decision.candidate.id, "CAND-1");
    assert.equal(decision.evaluation.kind, "evaluation_run");
    assert.equal(decision.evaluation.provenance.selected_model, "evaluator-model");
    assert.ok(Array.isArray(decision.findings));
  });
});

describe("performanceComplexityMetricIds", () => {
  it("returns validated, de-duplicated performance/complexity metrics", () => {
    const ids = performanceComplexityMetricIds();
    assert.ok(ids.includes("render_performance_cost"));
    assert.ok(ids.includes("component_complexity"));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(PERFORMANCE_COMPLEXITY_METRICS.length >= ids.length);
    for (const id of ids) assert.ok(METRIC_IDS.includes(id), `${id} must be a known rubric metric`);
  });
});

describe("gateDisagreement", () => {
  it("reuses the review disagreement index", () => {
    assert.equal(gateDisagreement([{ roleId: "visual_critic", score: 0.2 }, { roleId: "deterministic", score: 0.8 }]), 0.6);
    assert.equal(gateDisagreement([{ roleId: "deterministic", score: 0.5 }]), 0);
  });
});

describe("TournamentRunner", () => {
  it("is constructible and references GitRepo + MergeQueue", () => {
    // We only verify the type surface: the runner delegates worktree/merge work
    // to the existing git + queue primitives rather than reimplementing them.
    const runner = new (TournamentRunner as unknown as new (git: unknown, queue: unknown) => TournamentRunner)(
      {},
      {},
    );
    assert.ok(runner instanceof TournamentRunner);
  });
});
