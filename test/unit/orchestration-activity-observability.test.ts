import assert from "node:assert/strict";
import { test } from "node:test";
import { recordWorkerActivity } from "../../src/orchestration/activityNotice.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { WorkerActivity } from "../../src/workers/WorkerExecutor.ts";

/**
 * A worker's activity stream already reaches observability as sentences, but the
 * loop tracker only ever saw tool signatures. Nine identical reads of the same
 * file — the signature of a worker going in circles — left no trace, and the
 * only clue an operator got was that nothing was moving.
 */
const WORKER = "exec-1";

function harness() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store, onUpdate: () => {} });
  const mission = store.createMission({
    title: "loop watch",
    goal: "prove the loop tracker sees reads",
    user_request: "prove the loop tracker sees reads",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  obs.workerStarted(mission.mission_id, WORKER, { taskId: "task-1", runtime: "pi" });
  // Mirror what observeWorkerActivity does: the activity sentence is recorded
  // by the orchestrator, the loop signals by recordWorkerActivity. Pinning the
  // pair is the only way to see what the operator actually gets.
  const feed = (event: Partial<WorkerActivity> & Pick<WorkerActivity, "kind" | "summary">) => {
    const full: WorkerActivity = { meaningfulProgress: false, ...event };
    const type =
      full.toolName === "read"
        ? "reading_file"
        : full.toolName === "edit" || full.toolName === "write"
          ? "editing_file"
          : full.kind === "tool"
            ? "tool_invocation"
            : "worker_started";
    obs.activity(mission.mission_id, {
      type,
      summary: full.summary,
      workerId: WORKER,
      meaningfulProgress: full.meaningfulProgress,
    });
    recordWorkerActivity(obs, mission.mission_id, WORKER, full);
  };
  return { obs, id: mission.mission_id, feed };
}

const readOf = (path: string): Partial<WorkerActivity> & Pick<WorkerActivity, "kind" | "summary"> => ({
  kind: "tool",
  phase: "started",
  toolName: "read",
  toolTarget: path,
  summary: `read ${path}`,
});

test("an activity flagged meaningful advances lastMeaningfulProgressAt", () => {
  const h = harness();
  const before = h.obs.summary(h.id)?.lastMeaningfulProgressAt ?? null;
  h.feed({ kind: "state", phase: "started", summary: "Worker started", meaningfulProgress: true });
  const after = h.obs.summary(h.id)?.lastMeaningfulProgressAt;
  assert.ok(after, "a meaningful activity leaves a timestamp");
  assert.notEqual(after, before, "the timestamp moved");
});

test("repeated reads of the same path trip the loop tracker", () => {
  const h = harness();
  for (let i = 0; i < 9; i++) h.feed(readOf("src/status/presence.ts"));

  assert.equal(h.obs.hasLoop(h.id, WORKER), true, "nine identical reads is a loop");
  const worker = h.obs.projection(h.id)?.workers.find((w) => w.workerId === WORKER);
  assert.ok((worker?.repeatedFileReads ?? 0) >= 9, "the count the operator reads names the repetition");
  assert.deepEqual(
    h.obs.loopSignals(h.id, WORKER).map((signal) => [signal.kind, signal.detail]),
    [["repeated_file_read", "src/status/presence.ts"]],
    "the signal names the file, not just a number",
  );
});

test("a file change resets the tracker so legitimate repetition is not a loop", () => {
  const h = harness();
  for (let i = 0; i < 9; i++) h.feed(readOf("src/status/presence.ts"));
  assert.equal(h.obs.hasLoop(h.id, WORKER), true);

  h.feed({
    kind: "tool",
    phase: "completed",
    toolName: "edit",
    toolTarget: "src/status/presence.ts",
    summary: "edit src/status/presence.ts",
  });
  assert.equal(h.obs.hasLoop(h.id, WORKER), false, "a worker that changed the file is making progress");
});

test("a failing tool accumulates an error signal", () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    h.feed({
      kind: "tool",
      phase: "failed",
      toolName: "bash",
      toolCommand: "npm_test",
      summary: "bash npm_test failed",
    });
  }
  const worker = h.obs.projection(h.id)?.workers.find((w) => w.workerId === WORKER);
  assert.equal(worker?.repeatedErrors, 8);
  assert.equal(h.obs.hasLoop(h.id, WORKER), true);
});

test("an identical tool call is still recorded as a tool signal", () => {
  const h = harness();
  for (let i = 0; i < 9; i++) {
    h.feed({
      kind: "tool",
      phase: "started",
      toolName: "bash",
      toolCommand: "npm_test",
      invocationSignature: "sig-bash-npm-test",
      summary: "bash npm_test",
    });
  }
  assert.equal(h.obs.hasLoop(h.id, WORKER), true);
  const worker = h.obs.projection(h.id)?.workers.find((w) => w.workerId === WORKER);
  assert.ok((worker?.repeatedToolCalls ?? 0) >= 9);
});

test("an identical completed call with no artifact counts as a repeated cycle", () => {
  const h = harness();
  for (let i = 0; i < 6; i++) {
    h.feed({
      kind: "tool",
      phase: "completed",
      toolName: "bash",
      toolCommand: "npm_test",
      invocationSignature: "sig-bash-npm-test",
      summary: "bash npm_test done",
    });
  }
  const signals = h.obs.loopSignals(h.id, WORKER);
  assert.deepEqual(
    signals.map((signal) => signal.kind),
    ["repeated_cycle"],
    "a cycle that produced nothing new is its own signal family",
  );
  assert.equal(signals[0]?.detail, "sig-bash-npm-test", "the signal names the cycle that repeated");
});

test("a completed call that changed a file is progress, not a cycle", () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    h.feed({
      kind: "tool",
      phase: "completed",
      toolName: "write",
      toolTarget: "src/status/presence.ts",
      invocationSignature: "sig-write-presence",
      summary: "wrote src/status/presence.ts",
    });
  }
  assert.deepEqual(h.obs.loopSignals(h.id, WORKER), [], "an artifact-producing cycle is not a loop");
});

test("loop thresholds are read by signal family, not by activity type", () => {
  const h = harness();
  // loopThresholds.error is 4 and tool_invocation is 6; default is 8. Before the
  // lookup was keyed by signal family, every family silently used 8, so an
  // operator saw nothing for four identical failures.
  for (let i = 0; i < 4; i++) {
    h.feed({
      kind: "tool",
      phase: "failed",
      toolName: "bash",
      toolCommand: "npm_test",
      summary: "bash npm_test failed",
    });
  }
  assert.equal(h.obs.hasLoop(h.id, WORKER), true, "four identical failures is the configured threshold");
});

test("a read whose target the event does not carry is not invented", () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.feed({ kind: "tool", phase: "started", toolName: "read", summary: "read a file" });
  }
  assert.equal(h.obs.hasLoop(h.id, WORKER), false, "no path, no read signal");
});
