import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

describe("mission snapshot publisher (spec 08 §API boundary)", () => {
  it("produces a versioned, JSON-safe snapshot consumed by the PI WEB plugin", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "Add health endpoint",
      goal: "Add /health",
      user_request: "Add a health endpoint",
      repository: ".",
      base_ref: "abc",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "Add /health",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
    });
    store.addFinding({
      mission_id: m.mission_id,
      task_id: t.task_id,
      severity: "blocking",
      category: "correctness",
      file: "src/handler.ts",
      line: 3,
      summary: "crashes on empty body",
      evidence: "review-1",
      recommended_action: "guard body",
    });

    const file = buildMissionSnapshotFile([
      { mission: m, tasks: store.listTasks(m.mission_id), findings: store.listFindings(m.mission_id) },
    ]);

    assert.equal(file.contractVersion, MISSION_SNAPSHOT_CONTRACT_VERSION);
    assert.ok(file.generatedAt);
    assert.equal(file.missions.length, 1);
    const snap = file.missions[0]!;
    assert.equal(snap.id, m.mission_id);
    assert.equal(snap.workflowClass, "engineering_review");
    assert.deepEqual(snap.requiredGates, m.required_gates);
    assert.equal(snap.tasks.length, 1);
    assert.equal(snap.tasks[0]!.objective, "Add /health");
    assert.equal(snap.tasks[0]!.isolation, "worktree");
    assert.equal(snap.findings.length, 1);
    assert.equal(snap.findings[0]!.severity, "blocking");
    assert.equal(snap.findings[0]!.summary, "crashes on empty body");

    // The snapshot must round-trip through JSON (the plugin reads the file).
    const roundTripped = JSON.parse(JSON.stringify(file)) as typeof file;
    assert.equal(roundTripped.contractVersion, MISSION_SNAPSHOT_CONTRACT_VERSION);
    assert.equal(roundTripped.missions[0]!.tasks[0]!.mutatesRepo, true);
  });
});
