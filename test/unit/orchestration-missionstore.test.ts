import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function store(): MissionStore {
  return MissionStore.open(JsonlEventStore.inMemory());
}

describe("MissionStore", () => {
  it("creates and transitions a mission through its lifecycle", async () => {
    const s = store();
    const m = s.createMission({
      title: "Add health endpoint",
      goal: "Add a health endpoint",
      user_request: "Add a health endpoint",
      repository: ".",
      base_ref: "abc123",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    assert.equal(m.status, "NEW");
    s.transitionMission(m.mission_id, "CLASSIFYING");
    s.transitionMission(m.mission_id, "PLANNING");
    s.transitionMission(m.mission_id, "READY");
    s.transitionMission(m.mission_id, "EXECUTING");
    s.transitionMission(m.mission_id, "INTEGRATING");
    s.transitionMission(m.mission_id, "VALIDATING");
    s.transitionMission(m.mission_id, "REVIEWING");
    s.transitionMission(m.mission_id, "FINAL_VALIDATION");
    const done = s.completeMission(m.mission_id);
    assert.equal(done.status, "COMPLETE");
    assert.ok(done.completed_at);
  });

  it("rejects illegal transitions", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    assert.throws(() => s.transitionMission(m.mission_id, "COMPLETE"));
  });

  it("persists acceptance criteria and constraints", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      constraints: ["do not touch schema"],
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    s.addAcceptanceCriterion(m.mission_id, "existing tests pass");
    s.addAcceptanceCriterion(m.mission_id, "endpoint responds 200");
    s.setCriterionStatus(m.mission_id, 0, "passed", "test-run://t1");
    const got = s.getMission(m.mission_id)!;
    assert.equal(got.constraints[0], "do not touch schema");
    assert.equal(got.acceptance_criteria.length, 2);
    assert.equal(got.acceptance_criteria[0]!.status, "passed");
  });

  it("creates tasks with write domains and dependency edges", () => {
    const s = store();
    const m = s.createMission({
      title: "backend+frontend",
      goal: "Add backend and frontend support for feature X",
      user_request: "Add backend and frontend support for feature X",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const a = s.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "backend",
      write_domains: ["src/server/**"],
    });
    const b = s.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "frontend",
      write_domains: ["src/web/**"],
      depends_on: [a.task_id],
    });
    assert.equal(a.status, "PENDING");
    assert.equal(b.depends_on[0], a.task_id);
    assert.equal(s.listTasks(m.mission_id).length, 2);
    assert.equal(s.getMission(m.mission_id)!.task_ids.length, 2);
  });

  it("replays from events (restart recovery)", async () => {
    const backend = JsonlEventStore.inMemory();
    const s1 = MissionStore.open(backend);
    const m = s1.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    s1.transitionMission(m.mission_id, "CLASSIFYING");
    s1.transitionMission(m.mission_id, "PLANNING");
    s1.transitionMission(m.mission_id, "READY");
    s1.transitionMission(m.mission_id, "EXECUTING");
    const t = s1.createTask({ mission_id: m.mission_id, kind: "process", role: "validator", objective: "validate" });
    s1.transitionTask(t.task_id, "READY");
    s1.transitionTask(t.task_id, "RUNNING");
    await s1.flush();

    // Simulate a restart: a fresh store over the same events.
    const s2 = MissionStore.open(backend);
    const restored = s2.getMission(m.mission_id)!;
    assert.equal(restored.status, "EXECUTING");
    const task = s2.getTask(t.task_id)!;
    assert.equal(task.status, "RUNNING");
  });

  it("records and resolves review findings", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const f = s.addFinding({
      mission_id: m.mission_id,
      task_id: null,
      severity: "blocking",
      category: "correctness",
      file: "src/auth/service.ts",
      line: 42,
      summary: "missing null check",
      evidence: "observed NPE",
      recommended_action: "add guard",
    });
    assert.equal(f.status, "open");
    assert.equal(s.listFindings(m.mission_id).length, 1);
    s.resolveFinding(f.finding_id);
    assert.equal(s.listFindings(m.mission_id)[0]!.status, "resolved");
  });
});
