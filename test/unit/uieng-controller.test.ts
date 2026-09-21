import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAction,
  checkStopConditions,
  controlEventFor,
  createQualityState,
  debtCost,
  debtLeverage,
  decideNext,
  evaluationScore,
  idleCapacityForDebt,
  markDebtRemediated,
  recentImprovement,
  recordDecision,
  recordEvaluation,
  rejectDebt,
  remainingBudget,
  revertChange,
  rollbackRefFor,
  surfaceInCooldown,
} from "../../src/uieng/controller.ts";
import type { ControllerAction, DebtItem, UiQualityConfig, UiQualityState } from "../../src/uieng/controller.ts";
import type { EvaluationRun, ExecutionProvenance, TaskRequest } from "../../src/uieng/schemas.ts";
import type { GatedAcceptanceDecision } from "../../src/uieng/tournament.ts";

function taskRequest(): TaskRequest {
  return {
    schema_version: 1,
    kind: "task_request",
    id: "WI-CTRL1",
    type: "ui",
    required_capabilities: ["vision"],
    optional_capabilities: [],
    artifacts: [],
    context: "autonomous quality pass",
    latency_class: "interactive",
    quality_class: "high",
    reasoning_class: "deep",
    vision: true,
    image_generation: false,
  };
}

function provenance(model = "evaluator"): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: `EXEC-${model}`,
    provider: "test",
    selected_model: model,
  };
}

function run(id: string, severities: string[], verdict: "pass" | "fail" | "blocked" = "pass"): EvaluationRun {
  return {
    schema_version: 1,
    kind: "evaluation_run",
    id,
    task_request: taskRequest(),
    provenance: provenance(id),
    findings: severities.map((s, i) => ({
      schema_version: 1,
      kind: "finding",
      id: `FIND-${id}-${i}`,
      rubric: "contrast",
      score: 0,
      confidence: 0.9,
      severity: s as never,
      evidence: [],
      impact: `impact ${i}`,
    })),
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    verdict,
  };
}

function debt(overrides: Partial<DebtItem> = {}): DebtItem {
  return {
    id: "DEBT-A",
    rootCause: "low contrast on primary buttons",
    metricIds: ["contrast"],
    impact: 0.8,
    effort: 0.2,
    risk: 0.1,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    evidenceRefs: ["FIND-1"],
    ...overrides,
  };
}

const CONFIG: UiQualityConfig = {
  totalBudget: 100,
  evaluationCost: 10,
  remediationCost: 5,
  experimentCost: 15,
  surfaceCooldownMs: 60_000,
};

const NOW = Date.UTC(2026, 0, 2, 0, 0, 0);

describe("remainingBudget / debt accounting", () => {
  it("computes remaining budget clamped to zero", () => {
    const s = createQualityState("M-1", { budgetUsed: 40 });
    assert.equal(remainingBudget(s, CONFIG), 60);
    assert.equal(remainingBudget({ ...s, budgetUsed: 999 }, CONFIG), 0);
  });

  it("scales remediation cost by effort", () => {
    assert.equal(debtCost(debt({ effort: 0.2 }), CONFIG), 6);
    assert.equal(debtCost(debt({ effort: 1 }), CONFIG), 10);
  });

  it("computes leverage discounted by risk and effort", () => {
    const high = debt({ impact: 0.9, effort: 0.1, risk: 0.1 });
    const low = debt({ impact: 0.9, effort: 0.9, risk: 0.9 });
    assert.ok(debtLeverage(high) > debtLeverage(low));
  });
});

describe("idleCapacityForDebt", () => {
  it("prioritizes by highest leverage within budget", () => {
    const low = debt({ id: "D1", impact: 0.2, effort: 0.9 });
    const high = debt({ id: "D2", impact: 0.9, effort: 0.1 });
    const s = createQualityState("M-1", { debt: [low, high] });
    const picked = idleCapacityForDebt(s, CONFIG);
    assert.deepEqual(
      picked.map((d) => d.id),
      ["D2", "D1"],
    );
  });

  it("excludes remediated/rejected items", () => {
    const s = createQualityState("M-1", {
      debt: [
        debt({ id: "D1", status: "remediated" }),
        debt({ id: "D2", status: "rejected" }),
        debt({ id: "D3", status: "open", impact: 0.5 }),
      ],
    });
    const picked = idleCapacityForDebt(s, CONFIG);
    assert.deepEqual(
      picked.map((d) => d.id),
      ["D3"],
    );
  });

  it("respects budget exhaustion (skips items that do not fit)", () => {
    const s = createQualityState("M-1", {
      budgetUsed: 99,
      debt: [debt({ id: "D1", effort: 1 }), debt({ id: "D2", effort: 0.2 })],
    });
    // remaining = 1; D1 costs 10, D2 costs 6 -> none fit
    assert.deepEqual(idleCapacityForDebt(s, CONFIG), []);
  });
});

describe("stop conditions", () => {
  it("detects protected change", () => {
    assert.equal(checkStopConditions(createQualityState("M", {}), { protectedChange: true }), "protected_change");
  });

  it("detects purely subjective preference", () => {
    assert.equal(
      checkStopConditions(createQualityState("M", {}), { purelySubjectivePreference: true }),
      "subjective_preference",
    );
  });

  it("detects exhausted budget", () => {
    const s = createQualityState("M", { budgetUsed: 100 });
    assert.equal(checkStopConditions(s, CONFIG), "budget_exhausted");
  });

  it("detects excessive disagreement", () => {
    const s = createQualityState("M", {});
    assert.equal(checkStopConditions(s, CONFIG, { disagreement: 0.8 }), "excessive_disagreement");
  });

  it("detects diminishing returns from recent improvement below threshold", () => {
    // run with findings: first worse, second marginally better than threshold.
    const first = run("RUN-1", ["high", "high"]); // score 0.2
    const second = run("RUN-2", ["high"]); // score 0.2 (no real improvement)
    const s = createQualityState("M", { history: [first, second] });
    assert.equal(recentImprovement(s, CONFIG), 0);
    assert.equal(checkStopConditions(s, CONFIG), "diminishing_returns");
  });

  it("returns null when no stop condition applies", () => {
    const s = createQualityState("M", {});
    assert.equal(checkStopConditions(s, CONFIG), null);
  });
});

describe("decideNext loop transitions", () => {
  it("triggers an evaluation when nothing else applies", () => {
    const s = createQualityState("M", {});
    const action = decideNext(s, CONFIG, {}, NOW);
    assert.equal(action.type, "trigger_evaluation");
    assert.ok(action.event);
  });

  it("continues remediation after a failed gate (open debt within budget)", () => {
    const s = createQualityState("M", { debt: [debt({ id: "D1", impact: 0.9, effort: 0.1 })] });
    const action = decideNext(s, CONFIG, {}, NOW);
    assert.equal(action.type, "continue_remediation");
    if (action.type === "continue_remediation") {
      assert.equal(action.debtItemId, "D1");
      assert.ok(action.rollbackRef);
    }
  });

  it("lands an accepted decision with evidence before stopping", () => {
    const s = createQualityState("M", {});
    const decision = decisionFixture(true);
    const action = decideNext(s, CONFIG, { latestDecision: decision }, NOW);
    assert.equal(action.type, "accept_with_evidence");
    if (action.type === "accept_with_evidence") {
      assert.ok(action.evidence.includes(decision.id));
    }
  });

  it("rejects with evidence", () => {
    const s = createQualityState("M", {});
    const action = decideNext(s, CONFIG, { latestDecision: decisionFixture(false) }, NOW);
    assert.equal(action.type, "reject_with_evidence");
  });

  it("stops on budget exhaustion", () => {
    const s = createQualityState("M", { budgetUsed: 100 });
    const action = decideNext(s, CONFIG, {}, NOW);
    assert.equal(action.type, "stop");
    if (action.type === "stop") assert.equal(action.stopCondition, "budget_exhausted");
  });

  it("creates a bounded experiment when requested and budget allows", () => {
    const s = createQualityState("M", {});
    const action = decideNext(s, CONFIG, { experimentRequested: true }, NOW);
    assert.equal(action.type, "create_experiment");
    if (action.type === "create_experiment") assert.equal(action.budgetCost, 15);
  });

  it("does not create an experiment when disabled", () => {
    const s = createQualityState("M", {});
    const action = decideNext(s, CONFIG, { experimentRequested: true }, NOW);
    assert.equal(action.type, "create_experiment");
    const disabled = decideNext(s, { ...CONFIG, experimentsEnabled: false }, { experimentRequested: true }, NOW);
    assert.equal(disabled.type, "trigger_evaluation");
  });

  it("stops on a per-surface cooldown rather than re-evaluating the same surface", () => {
    const s = createQualityState("M", {
      cooldowns: [{ surface: "settings", cooldownUntil: new Date(NOW + 60_000).toISOString() }],
    });
    const action = decideNext(s, CONFIG, { currentSurface: "settings" }, NOW);
    assert.equal(action.type, "stop");
    if (action.type === "stop") assert.equal(action.stopCondition, "cooldown");
    assert.ok(surfaceInCooldown(s, "settings", NOW));
  });

  it("allows re-evaluation once the cooldown elapses", () => {
    const s = createQualityState("M", {
      cooldowns: [{ surface: "settings", cooldownUntil: new Date(NOW - 1000).toISOString() }],
    });
    assert.equal(surfaceInCooldown(s, "settings", NOW), false);
    const action = decideNext(s, CONFIG, { currentSurface: "settings" }, NOW);
    assert.equal(action.type, "trigger_evaluation");
  });
});

describe("reducers / reversibility", () => {
  it("applyAction consumes budget and preserves history on accept", () => {
    let s = createQualityState("M", {});
    const decision = decisionFixture(true);
    const action = decideNext(s, CONFIG, { latestDecision: decision }, NOW);
    s = applyAction(s, action, CONFIG, NOW);
    assert.equal(s.budgetUsed, 0); // accept/reject cost 0
    assert.ok(s.history.some((h) => h.id === decision.evaluation.id));
  });

  it("applyAction marks debt in_progress and sets rollback ref on remediation", () => {
    let s = createQualityState("M", { debt: [debt({ id: "D1" })] });
    const action = decideNext(s, CONFIG, {}, NOW);
    s = applyAction(s, action, CONFIG, NOW);
    const item = s.qualityDebt.find((d) => d.id === "D1");
    assert.ok(item);
    assert.equal(item?.status, "in_progress");
    assert.ok(item?.rollbackRef);
  });

  it("recordEvaluation appends to history, spends budget, and sets cooldown", () => {
    const s = createQualityState("M", {});
    const next = recordEvaluation(s, run("RUN-1", ["low"]), { config: CONFIG, surface: "home", now: NOW });
    assert.equal(next.history.length, 1);
    assert.equal(next.budgetUsed, 10);
    assert.ok(surfaceInCooldown(next, "home", NOW));
  });

  it("markDebtRemediated and rejectDebt transition status", () => {
    const s = createQualityState("M", { debt: [debt({ id: "D1" })] });
    assert.equal(markDebtRemediated(s, "D1").qualityDebt[0]?.status, "remediated");
    assert.equal(rejectDebt(s, "D1").qualityDebt[0]?.status, "rejected");
  });

  it("revertChange reverts an accepted change with a rollback ref and conditions", () => {
    const accepted = decisionFixture(true);
    const result = revertChange(accepted, ["CLS > 0.1"], { missionId: "M-1", evidence: ["EVID-1"], now: NOW });
    assert.equal(result.reverted, true);
    assert.ok(result.rollbackRef);
    assert.deepEqual(result.conditions, ["CLS > 0.1"]);
    assert.equal(result.event.type, "controller.reverted");
    assert.ok(result.event.rollback_ref);
    assert.ok(result.event.evidence.includes("EVID-1"));
  });

  it("controlEventFor emits a structured event with provenance/evidence", () => {
    const s = createQualityState("M-1", {});
    const action = decideNext(s, CONFIG, { evaluationEvidence: ["EVID-9"] }, NOW);
    const event = controlEventFor(s, action, NOW);
    assert.equal(event.mission_id, "M-1");
    assert.equal(event.action, action.type);
    assert.equal(event.type, "controller.evaluation_triggered");
    assert.ok(event.event_id.startsWith("CTRL-"));
  });

  it("rollbackRefFor is deterministic", () => {
    assert.equal(rollbackRefFor("a", "b"), rollbackRefFor("a", "b"));
    assert.notEqual(rollbackRefFor("a", "b"), rollbackRefFor("a", "c"));
  });

  it("evaluationScore reflects mean finding severity", () => {
    assert.equal(evaluationScore(run("R1", [])), 1);
    assert.ok(Math.abs(evaluationScore(run("R2", ["high"])) - 0.2) < 1e-9);
  });
});

function decisionFixture(accepted: boolean): GatedAcceptanceDecision {
  const evaluation = run("RUN-DEC", accepted ? [] : ["high"], accepted ? "pass" : "fail");
  return {
    schema_version: 1,
    kind: "acceptance_decision",
    id: "ADEC-1",
    candidate: {
      schema_version: 1,
      kind: "candidate",
      id: "CAND-1",
      task_request: taskRequest(),
      artifacts: [],
      provenance: provenance("candidate"),
      status: "complete",
    },
    accepted,
    rationale: accepted ? "All gates passed." : "Gate failed.",
    findings: evaluation.findings,
    evaluation,
    provenance: provenance("evaluator"),
    decided_at: evaluation.finished_at ?? "2026-01-01T00:00:00.000Z",
    requiresApproval: false,
  };
}
