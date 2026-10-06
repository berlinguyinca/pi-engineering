/**
 * The mission tool's result for a mission that did not complete (session
 * review: a BLOCKED result was three lines with no way forward).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

function blockedMission() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "Add a health endpoint",
    goal: "Add a health endpoint",
    user_request: "Add a health endpoint",
    repository: ".",
    base_ref: "base",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const failed = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "Implement GET /health returning build info",
    mutates_repo: true,
  });
  store.transitionTask(failed.task_id, "READY");
  store.transitionTask(failed.task_id, "RUNNING");
  store.transitionTask(failed.task_id, "FAILED", "system", {
    failure_reason: "backend reported failed: wall-clock timeout after 1800s",
  });
  store.checkpointTask({
    checkpointId: "CHK-1",
    executionId: "EXC-1",
    missionId: mission.mission_id,
    taskId: failed.task_id,
    repoId: "repo-1",
    baseSha: "base-sha",
    candidateSha: "0123456789abcdef",
    branch: "pi-eng-orch-TSK-health",
    worktree: "/tmp/pi-eng-preserved-health",
    committedChanges: ["src/health.ts"],
    preservedUncommittedChanges: [],
    completedDeliverables: ["route"],
    remainingDeliverables: ["build info payload", "tests for /health"],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: "worker",
    sessionId: "session",
    model: "local/local",
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  store.transitionMission(mission.mission_id, "BLOCKED");
  store.stopMission(mission.mission_id, {
    reason: "recovery budget exhausted for the timed-out implementer",
    preservedWork: ["pi-eng-orch-TSK-health"],
    attemptedRecoveries: ["RCV-1"],
    resumeCondition: "provide new material evidence or increase the approved recovery budget",
  });
  return { store, missionId: mission.mission_id };
}

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

function missionTool(services: Record<string, unknown>): Execute {
  const tools = buildCoreTools(async () => ({
    ledger: {} as never,
    artifacts: {} as never,
    broker: null,
    currentWorkItemId: () => null,
    actor: () => ({ type: "user" }),
    ...services,
  }));
  return tools.find((tool) => tool.name === "mission")!.execute as unknown as Execute;
}

test("a BLOCKED run result names preserved work, failed tasks, remaining deliverables and a next step", async () => {
  const { store, missionId } = blockedMission();
  const execute = missionTool({
    orchestrator: {
      store,
      orchestrate: async () => ({
        mission: store.getMission(missionId)!,
        intent: { intent: ["implement"] },
        completed: false,
        failureReason: "task execution budget exhausted after a durable partial checkpoint",
      }),
    },
  });
  const result = await execute("m", { request: "Add a health endpoint" }, undefined, undefined, { cwd: "/repo" });
  const text = result.content[0]!.text;
  assert.match(text, /\[BLOCKED\]/);
  assert.match(text, /pi-eng-orch-TSK-health/, "preserved branch");
  assert.match(text, /0123456/, "preserved checkpoint commit");
  assert.match(text, /wall-clock timeout/, "failed-task reason");
  assert.match(text, /build info payload/, "remaining deliverables");
  assert.match(text, /Next step:.*resume/i, "explicit next step");
  assert.match(text, new RegExp(missionId));
});

test("mission tool status action reports a mission without running anything", async () => {
  const { store, missionId } = blockedMission();
  let orchestrated = false;
  const execute = missionTool({
    orchestrator: {
      store,
      orchestrate: async () => {
        orchestrated = true;
        throw new Error("status must not orchestrate");
      },
    },
  });
  const result = await execute("m", { action: "status", missionId }, undefined, undefined, { cwd: "/repo" });
  assert.equal(orchestrated, false);
  assert.match(result.content[0]!.text, /\[BLOCKED\]/);
  assert.match(result.content[0]!.text, /tests for \/health/);
  assert.equal(result.details.status, "BLOCKED");
});

test("mission tool resume action delegates to the runtime's /mission resume path", async () => {
  const { store, missionId } = blockedMission();
  const resumed: string[] = [];
  const execute = missionTool({
    orchestrator: { store, orchestrate: async () => assert.fail("resume must not start a new mission") },
    resumeMission: async (id: string) => {
      resumed.push(id);
      return store.getMission(id)!;
    },
  });
  const result = await execute("m", { action: "resume", missionId }, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(resumed, [missionId]);
  assert.match(result.content[0]!.text, new RegExp(`Mission ${missionId}`));
});

test("mission tool resume without a runtime resume hook explains the slash command instead of failing silently", async () => {
  const { store, missionId } = blockedMission();
  const execute = missionTool({ orchestrator: { store, orchestrate: async () => assert.fail("no orchestrate") } });
  const result = await execute("m", { action: "resume", missionId }, undefined, undefined, { cwd: "/repo" });
  assert.match(result.content[0]!.text, new RegExp(`/mission resume ${missionId}`));
});

test("mission tool status for an unknown mission says so", async () => {
  const { store } = blockedMission();
  const execute = missionTool({ orchestrator: { store, orchestrate: async () => assert.fail("no orchestrate") } });
  const result = await execute("m", { action: "status", missionId: "MSN-nope" }, undefined, undefined, {
    cwd: "/repo",
  });
  assert.match(result.content[0]!.text, /unknown mission MSN-nope/i);
});
