import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { recordSchedulerStatus } from "../../src/orchestration/recoveryNotice.ts";
import type { MissionSchedulerStatusNotice } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/**
 * The scheduler already tells the orchestrator, per notice, whether a mission
 * resumed, is waiting, or is paused. What was missing is the matching
 * observability vocabulary: without RECOVERY_STARTED / _COMPLETED / _FAILED the
 * projection shows a mission that silently sat in recovery for eleven minutes,
 * and the operator's only clue is the wall clock.
 */
function harness() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const reports: string[] = [];
  const obs = new MissionObservability({
    backend,
    store,
    onUpdate: (_id, message) => updates.push(message),
  });
  const mission = store.createMission({
    title: "gateway outage",
    goal: "keep going through a 503",
    user_request: "keep going through a 503",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const id = mission.mission_id;
  const record = (notice: Partial<MissionSchedulerStatusNotice>) =>
    recordSchedulerStatus(
      {
        missionId: id,
        taskId: "task-1",
        status: "RECOVERING_CONTEXT",
        action: "retrying",
        reason: "503 no worker for model",
        attempt: 1,
        terminal: false,
        ...notice,
      },
      obs,
      (_missionId, line) => reports.push(line),
    );
  return { obs, id, record, updates, reports };
}

test("a waiting notice opens a recovery window the projection can read", () => {
  const h = harness();
  h.record({ action: "retrying", attempt: 3 });

  const attempt = h.obs.projection(h.id)?.recovery.at(-1);
  assert.equal(attempt?.attempt, 3, "the notice's attempt number carries through");
  assert.equal(attempt?.action, "retrying");
  assert.equal(attempt?.status, "running", "the window stays open until resumed or paused");
  assert.equal(h.obs.summary(h.id)?.waitingReason, "model_request", "the reason is still classified");
  assert.match(
    h.reports.at(-1) ?? "",
    /\[mission .*\] No active worker while recovery runs: 503 no worker for model; attempt 3/,
    "the operator line the scheduler used to print is unchanged",
  );
});

test("a resumed notice closes the recovery window", () => {
  const h = harness();
  h.record({ action: "retrying" });
  h.record({ action: "resumed", attempt: 2 });

  const attempt = h.obs.projection(h.id)?.recovery.at(-1);
  assert.equal(attempt?.status, "succeeded");
  assert.ok(attempt?.completedAt, "the window has an end, so its length is knowable");
  assert.equal(h.obs.summary(h.id)?.waitingReason, undefined);
  assert.match(h.reports.at(-1) ?? "", /recovery succeeded; worker execution resumed \(attempt 2\)/);
});

test("a paused notice marks recovery failed", () => {
  const h = harness();
  h.record({ action: "retrying" });
  h.record({ action: "paused", status: "PAUSED_INFRASTRUCTURE", reason: "retry window exhausted" });

  const attempt = h.obs.projection(h.id)?.recovery.at(-1);
  assert.equal(attempt?.status, "failed");
  assert.match(
    h.reports.at(-1) ?? "",
    /Recovery stopped with no active worker: retry window exhausted\. Mission is paused and resumable\./,
  );
  // Paused is not resumed: the mission still owes the operator attention.
  assert.notEqual(h.obs.summary(h.id)?.waitingReason, undefined);
});

test("recovery is recorded without pretending it is progress", () => {
  const h = harness();
  const before = h.obs.summary(h.id)?.progress.approximatePercent ?? 0;
  h.record({ action: "retrying", attempt: 4 });
  assert.equal(h.obs.summary(h.id)?.progress.approximatePercent, before, "waiting is not progress");
});
