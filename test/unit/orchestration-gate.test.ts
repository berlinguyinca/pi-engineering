import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompletionGate } from "../../src/orchestration/completionGate.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function mission(requiredGates: string[], risk = "medium") {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const m = store.createMission({
    title: "x",
    goal: "x",
    user_request: "x",
    repository: ".",
    base_ref: "",
    risk_profile: risk as never,
    workflow_class: "engineering_review",
  });
  store.updateMission(m.mission_id, { required_gates: requiredGates as never[] });
  return { store, m };
}

describe("CompletionGate (spec 07)", () => {
  it("blocks completion when validation gate is unmet", () => {
    const { store, m } = mission(["validation"]);
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.ok(v.missing_gates.includes("validation"));
  });

  it("blocks completion when a blocking finding is unresolved", () => {
    const { store, m } = mission(["validation", "independent_review"]);
    store.addFinding({
      mission_id: m.mission_id,
      task_id: null,
      severity: "blocking",
      category: "correctness",
      file: "a.ts",
      line: 1,
      summary: "bug",
      evidence: null,
      recommended_action: "fix",
    });
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.equal(v.unresolved_findings, 1);
  });

  it("blocks completion while a task is running", () => {
    const { store, m } = mission(["validation"]);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    store.transitionTask(t.task_id, "READY");
    store.transitionTask(t.task_id, "RUNNING");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.equal(v.running_tasks, 1);
  });

  it("allows completion when all gates are satisfied and no findings", () => {
    const { store, m } = mission(["validation", "independent_review"]);
    // Validation execution succeeded.
    const vtask = store.createTask({
      mission_id: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    store.transitionTask(vtask.task_id, "READY");
    store.transitionTask(vtask.task_id, "RUNNING");
    store.transitionTask(vtask.task_id, "SUCCEEDED");
    const vex = store.createExecution({ task_id: vtask.task_id, backend: "validation", mission_id: m.mission_id });
    store.setExecutionStatus(vex.execution_id, "SUCCEEDED");
    // Review execution succeeded.
    const rtask = store.createTask({ mission_id: m.mission_id, kind: "review", role: "reviewer", objective: "review" });
    store.transitionTask(rtask.task_id, "READY");
    store.transitionTask(rtask.task_id, "RUNNING");
    store.transitionTask(rtask.task_id, "SUCCEEDED");
    const rex = store.createExecution({ task_id: rtask.task_id, backend: "review", mission_id: m.mission_id });
    store.setExecutionStatus(rex.execution_id, "SUCCEEDED");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, true, JSON.stringify(v));
  });

  it("blocks when a task failed", () => {
    const { store, m } = mission(["validation"]);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    store.transitionTask(t.task_id, "READY");
    store.transitionTask(t.task_id, "RUNNING");
    store.transitionTask(t.task_id, "FAILED");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
  });
});
