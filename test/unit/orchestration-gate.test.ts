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

  describe("recovered timed-out work (MSN-4IhxSO)", () => {
    type Store = ReturnType<typeof mission>["store"];
    type RecoveredMerge = { task_id: string; branch: string; ref: string };

    function settled(store: Store, missionId: string, kind: string, role: string, status: "SUCCEEDED" | "FAILED") {
      const t = store.createTask({ mission_id: missionId, kind: kind as never, role, objective: kind });
      store.transitionTask(t.task_id, "READY");
      store.transitionTask(t.task_id, "RUNNING");
      store.transitionTask(t.task_id, status);
      return t;
    }
    function execution(
      store: Store,
      missionId: string,
      kind: "integration" | "validation" | "review",
      status: "SUCCEEDED" | "FAILED",
      extra: Record<string, unknown> = {},
    ) {
      const t = settled(store, missionId, kind, kind === "integration" ? "integrator" : kind, status);
      const ex = store.createExecution({ task_id: t.task_id, backend: kind, mission_id: missionId });
      store.setExecutionStatus(ex.execution_id, status, extra as never);
    }
    const merge = (t: { task_id: string }): RecoveredMerge => ({
      task_id: t.task_id,
      branch: `pi-eng-orch-${t.task_id}`,
      ref: "4d57c63",
    });
    /** A timed-out implementer, as the broker leaves it. */
    function timedOut(store: Store, missionId: string) {
      return settled(store, missionId, "agent", "implementer", "FAILED");
    }

    it("supersedes the FAILED status once its recovered ref merged and validation + review passed after", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED");
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, true, JSON.stringify(v.reasons));
    });

    it("does not read integration prose: a summary naming the branch is not evidence", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", {
        summary: `integrated pi-eng-orch-${t.task_id}; checks: pass`,
      });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED");
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false);
      assert.ok(
        v.reasons.some((r) => r.includes("task(s) failed")),
        JSON.stringify(v.reasons),
      );
    });

    it("a succeeded integration that merged OTHER work does not supersede an unrecovered task", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const recovered = timedOut(store, m.mission_id);
      const unrecovered = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(recovered)] });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED");
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false);
      assert.ok(v.reasons.includes("1 task(s) failed"), JSON.stringify(v.reasons));
      void unrecovered;
    });

    it("a FAILED integration's recovered merge is not evidence", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "FAILED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "integration", "SUCCEEDED");
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED");
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false, JSON.stringify(v.reasons));
    });

    it("requires validation AND review to have passed AFTER the integration that merged it", () => {
      for (const after of [["validation"], ["review"], []] as const) {
        const { store, m } = mission(["validation", "independent_review"]);
        const t = timedOut(store, m.mission_id);
        // Evidence from BEFORE the recovered merge does not cover it.
        execution(store, m.mission_id, "validation", "SUCCEEDED");
        execution(store, m.mission_id, "review", "SUCCEEDED");
        execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
        for (const k of after) execution(store, m.mission_id, k, "SUCCEEDED");
        const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
        assert.equal(v.can_complete, false, `after=${after.join("+") || "none"}: ${JSON.stringify(v.reasons)}`);
      }
    });
  });

  it("a generic reviewer cannot satisfy a security_review gate (spec 07)", () => {
    const { store, m } = mission(["validation", "independent_review", "security_review"], "high");
    const gate = new CompletionGate(store);
    // A generic review + validation succeeded, but no SECURITY review did.
    const evidence = {
      missionId: m.mission_id,
      validationsPassed: 1,
      reviewsCompleted: 1,
      securityReviewsCompleted: 0,
      recoveredTasks: [],
      findings: [],
    };
    const v = gate.evaluate(store.getMission(m.mission_id)!, evidence);
    assert.equal(v.can_complete, false);
    assert.ok(v.missing_gates.includes("security_review"), JSON.stringify(v.missing_gates));
    // With a security review the gate is satisfied.
    const v2 = gate.evaluate(store.getMission(m.mission_id)!, { ...evidence, securityReviewsCompleted: 1 });
    assert.equal(v2.can_complete, true, JSON.stringify(v2.reasons));
  });
});
