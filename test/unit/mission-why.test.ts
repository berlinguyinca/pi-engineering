import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runMissionsCommand } from "../../src/orchestration/missionCancelCli.ts";
import { buildMissionSnapshotFile } from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  buildVerifierStages,
  explainMission,
  formatMissionWhy,
  inheritedFailuresOf,
} from "../../src/orchestration/missionWhy.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function seed(store: MissionStore, missionId = "MSN-why") {
  store.createMission({
    mission_id: missionId,
    title: "why mission",
    goal: "g",
    user_request: "g",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  const task = store.createTask({
    mission_id: missionId,
    kind: "agent",
    role: "implementer",
    objective: "do the thing",
  });
  return { missionId, task };
}

function failTask(store: MissionStore, taskId: string, reason: string) {
  store.transitionTask(taskId, "READY");
  store.transitionTask(taskId, "RUNNING");
  store.transitionTask(taskId, "FAILED", "system", { failure_reason: reason });
}

describe("mission why", () => {
  it("names the custody/lease holder with session and pid", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { missionId, task } = seed(store);
    failTask(
      store,
      task.task_id,
      "repository repo-1 is in the custody of another live session (session f4c3cd60 (pid 2893918))",
    );
    const why = explainMission(store, missionId);
    assert.equal(why.blocking.taskId, task.task_id);
    assert.match(why.custody?.holder ?? "", /session f4c3cd60 \(pid 2893918\)/);
    assert.ok(why.remedies.includes(`/mission resume ${missionId}`));
    assert.match(formatMissionWhy(why), /f4c3cd60/);
  });

  it("shows cooldown scope, remaining time and retry counters on a provider wait", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { missionId, task } = seed(store);
    failTask(store, task.task_id, "HTTP 429 from https://llm.example:8081/v1");
    const now = Date.parse("2026-10-15T10:00:00Z");
    store.classifyFailure({
      classificationId: "FC-1",
      missionId,
      taskId: task.task_id,
      executionId: null,
      category: "PROVIDER_TRANSIENT",
      evidenceRefs: [],
      fingerprint: "fp",
      summary: "HTTP 429 from https://llm.example:8081/v1",
      classifiedAt: new Date(now).toISOString(),
    });
    store.planRecovery({
      recoveryId: "RCV-1",
      missionId,
      classificationId: "FC-1",
      action: "PROBE_AND_BACKOFF",
      expectedMaterialChange:
        "waiting for provider: 3/5 zero-tool-call retries (connection error); next probe at 2026-10-15T10:01:30.000Z",
      operatorGuidance: "Is the gateway down? Release the pin if so.",
      attempt: 2,
      maxAttempts: 6,
      deadline: null,
      nextActionAt: new Date(now + 90_000).toISOString(),
      status: "planned",
      decidedAt: new Date(now).toISOString(),
    });
    const why = explainMission(store, missionId, { now });
    assert.equal(why.cooldown?.scope, "PROVIDER_TRANSIENT");
    assert.equal(why.cooldown?.remainingMs, 90_000);
    assert.equal(why.cooldown?.nextActionAt, new Date(now + 90_000).toISOString());
    assert.deepEqual(
      [why.counters.probeAttempt, why.counters.probeMax, why.counters.zeroToolRetries, why.counters.zeroToolCap],
      [2, 6, 3, 5],
    );
    assert.equal(why.counters.zeroToolClass, "connection error");
    assert.ok(why.remedies.some((r) => r.startsWith("operator question: Is the gateway down")));
    assert.ok(!why.remedies.some((r) => r.includes("--model auto")), "no pin, no --model auto remedy");
    assert.equal(why.modelErrors[0]?.endpoint, "llm.example:8081");
    assert.equal(why.modelErrors[0]?.counts["429"], 1);
    assert.match(formatMissionWhy(why), /1m30s remaining/);
  });

  it("names the stranded branch from a stop's preserved work", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { missionId, task } = seed(store);
    failTask(store, task.task_id, "worker stopped");
    store.addFinding({
      mission_id: missionId,
      task_id: task.task_id,
      severity: "blocking",
      category: "stranded_worker_work",
      file: null,
      line: null,
      summary: "Worker committed work that integration refused",
      evidence: "pi-eng/task-abc",
      recommended_action: "re-adopt",
    });
    assert.deepEqual(explainMission(store, missionId).stranded, ["pi-eng/task-abc"]);
  });

  it("reads inherited failures and verifier stage timings from evidence summaries", () => {
    const evidence = [
      {
        testSummary: {
          stages: [{ name: "test", durationMs: 1200, reused: true }, { name: "lint" }],
          inheritedFailures: ["test/a.test.ts"],
        },
      },
    ];
    assert.deepEqual(inheritedFailuresOf(evidence), ["test/a.test.ts"]);
    assert.deepEqual(buildVerifierStages(evidence), [
      { name: "test", durationMs: 1200, reused: true },
      { name: "lint", durationMs: null, reused: null },
    ]);
  });

  it("shows the persisted execution mode and reason, and releases a pin only when named", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { missionId } = seed(store);
    store.updateMission(missionId, {
      execution_mode: { mode: "single", reason: "auto: question or trivial edit" },
      operator_model_pin: { provider: "p", id: "m", set_at: new Date().toISOString() },
    });
    const why = explainMission(store, missionId);
    assert.deepEqual(why.executionMode, { mode: "single", reason: "auto: question or trivial edit" });
    assert.match(formatMissionWhy(why), /Execution mode: single \(auto: question or trivial edit\)/);
    assert.ok(!why.remedies.some((r) => r.includes("--model auto")));
    store.stopMission(missionId, {
      reason: "pinned model unreachable",
      preservedWork: [],
      attemptedRecoveries: [],
      resumeCondition: "release the operator pin with --model auto or restore the pinned model",
    });
    assert.ok(explainMission(store, missionId).remedies.includes(`/mission resume ${missionId} --model auto`));
  });

  it("types usage and round-trips it through the snapshot", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { missionId, task } = seed(store);
    const ex = store.createExecution({ task_id: task.task_id, mission_id: missionId, backend: "agent", model: "m1" });
    store.setExecutionStatus(ex.execution_id, "RUNNING");
    store.setExecutionStatus(ex.execution_id, "SUCCEEDED", {
      usage: { input: 120, output: 30, streamResumes: 2 },
      exit_status: "succeeded",
    });
    const file = buildMissionSnapshotFile([
      {
        mission: store.getMission(missionId)!,
        tasks: store.listTasks(missionId),
        findings: [],
        executions: store.listExecutions(missionId),
        classifications: [],
      },
    ]);
    const round = JSON.parse(JSON.stringify(file)) as typeof file;
    const usage = round.missions[0]?.tasks[0]?.usage;
    assert.equal(usage?.promptTokens, 120);
    assert.equal(usage?.completionTokens, 30);
    assert.equal(usage?.streamResumes, 2);
    assert.equal(usage?.thinking, "off");
    assert.equal(usage?.role, "implementer");
  });

  it("prints a stable CLI report from a real store file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "why-cli-"));
    try {
      const backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
      const store = MissionStore.open(backend);
      const { missionId, task } = seed(store);
      failTask(store, task.task_id, "boom");
      await store.flush();
      backend.close();
      let text = "";
      const code = await runMissionsCommand(["why", "--store", dir, missionId], {
        write: (t) => {
          text += t;
        },
        error: () => undefined,
        env: { ...process.env, PI_ENGINEERING_STATE_DIR: dir },
      });
      assert.equal(code, 0);
      let jsonText = "";
      await runMissionsCommand(["why", "--store", dir, "--json", missionId], {
        write: (t) => {
          jsonText += t;
        },
        error: () => undefined,
        env: { ...process.env, PI_ENGINEERING_STATE_DIR: dir },
      });
      const parsed = JSON.parse(jsonText) as { missionId: string; blocking: { reason: string }; remedies: string[] };
      assert.equal(parsed.missionId, missionId);
      assert.equal(parsed.blocking.reason, "boom");
      assert.deepEqual(parsed.remedies, [`/mission resume ${missionId}`, `/mission cancel ${missionId}`]);
      const normalized = text.replace(/TSK-\w+/g, "TSK-x");
      assert.equal(
        normalized,
        [
          "Mission MSN-why [NEW] why mission",
          "Blocking task: TSK-x [FAILED] do the thing",
          "Failure: unclassified - boom",
          "Retries: probe 0/0, zero-tool 0/0",
          "Execution mode: not recorded",
          "Usage:",
          "  TSK-x implementer prompt=0 completion=0 attempts=0 resumes=0 thinking=off wall=0s (queued 0s, admitted 0s, inference 0s, tools 0s, verifier 0s)",
          "Remedy:",
          "  /mission resume MSN-why",
          "  /mission cancel MSN-why",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
