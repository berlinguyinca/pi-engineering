/**
 * #416 — disk-resume: tasks in flight at an ENOSPC suspend must settle from
 * their last checkpoint with deterministic recovery reasoning, and the outage
 * must never burn the strategy budget (capacity wait, never terminal by
 * count). Covers the three shipped pieces:
 *
 *   1. classifier: ENOSPC/disk signatures -> DISK_SUSPENDED;
 *   2. planner: DISK_SUSPENDED -> FENCE_RECONCILE_AND_RESUME, exhausted
 *      fingerprint -> PROBE_AND_BACKOFF (capacity wait), never STOP;
 *   3. store: durable suspend episodes + the classifyFailure override that
 *      re-diagnoses transient failures of RUNNING-at-suspend tasks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { FailureClassifier, RecoveryPlanner } from "../../src/orchestration/recovery.ts";
import type { FailureClassification, RecoveryDecision } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function newStore(): MissionStore {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  store.createMission({
    mission_id: "MSN-disk",
    title: "disk resume",
    goal: "survive ENOSPC",
    user_request: `survive ENOSPC ${"/tmp/disk-fixture"}`,
    repository: "/tmp/disk-fixture",
    base_ref: "main",
    risk_profile: "high",
    workflow_class: "engineering",
  });
  return store;
}

const classification = (overrides: Partial<FailureClassification> = {}): FailureClassification => ({
  classificationId: "FC-fixture",
  missionId: "MSN-disk",
  taskId: "TSK-running",
  executionId: "EXE-running",
  category: "PROVIDER_TRANSIENT",
  evidenceRefs: [],
  fingerprint: "sha256:fixture",
  summary: "connection reset",
  classifiedAt: "2026-10-25T00:00:00.000Z",
  ...overrides,
});

describe("#416 classifier: disk signatures", () => {
  const classifier = new FailureClassifier();

  it("classifies ENOSPC summaries as DISK_SUSPENDED", () => {
    for (const summary of [
      "ENOSPC: no space left on device, write",
      "checkpoint commit failed: no space left on device",
      "worker died under disk pressure",
      "event append failed: storage pressure on /home",
      "interrupted by disk-suspend episode",
    ]) {
      assert.equal(classifier.classify({ missionId: "MSN-disk", summary }).category, "DISK_SUSPENDED", summary);
    }
  });

  it("does not re-diagnose ordinary failures", () => {
    assert.equal(
      classifier.classify({ missionId: "MSN-disk", summary: "gateway returned 503" }).category,
      "PROVIDER_TRANSIENT",
    );
    assert.equal(
      classifier.classify({ missionId: "MSN-disk", summary: "validation suite failed" }).category,
      "VALIDATION_FAILED",
    );
  });
});

describe("#416 planner: capacity-wait semantics", () => {
  const diskClassification = new FailureClassifier().classify({
    missionId: "MSN-disk",
    taskId: "TSK-running",
    summary: "ENOSPC: no space left on device, write",
  });

  it("resumes checkpointed work through the fence/reconcile primitive", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 10 });
    const first = planner.decide({ classification: diskClassification, history: [], now: 1_000 });
    assert.equal(first.action, "FENCE_RECONCILE_AND_RESUME");
  });

  it("is never terminal by count: exhausted identical fingerprints park on a probe", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 50, strategyMaxAttempts: 2 });
    const decision = (attempt: number): RecoveryDecision => ({
      recoveryId: `RCV-${attempt}`,
      missionId: "MSN-disk",
      classificationId: diskClassification.classificationId,
      action: "FENCE_RECONCILE_AND_RESUME",
      expectedMaterialChange: "fence and reconcile",
      attempt,
      maxAttempts: 2,
      deadline: "2026-10-25T01:00:00.000Z",
      nextActionAt: "2026-10-25T00:00:00.000Z",
      status: "failed",
      decidedAt: "2026-10-25T00:00:00.000Z",
      failureFingerprint: diskClassification.fingerprint,
    });
    const history = [decision(1), decision(2), decision(3), decision(4)];
    const parked = planner.decide({ classification: diskClassification, history, now: 10_000 });
    assert.equal(parked.action, "PROBE_AND_BACKOFF", "a disk outage is waited out, never STOPped");
    assert.equal(parked.operatorGuidance, undefined);
  });
});

describe("#416 store: suspend episodes and the classification override", () => {
  it("marks, merges, resolves and replays the episode", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    store.createMission({
      mission_id: "MSN-disk",
      title: "t",
      goal: "g",
      user_request: "u /tmp/disk-fixture",
      repository: "/tmp/disk-fixture",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering",
    });
    const episode = store.markDiskSuspendEpisode("MSN-disk", {
      taskIds: ["TSK-running", "TSK-other"],
      incidentPath: "/home",
    });
    assert.equal(episode.taskIds.length, 2);
    assert.equal(episode.resolvedAt, null);
    // Fresh-incident re-suspend merges new RUNNING tasks into the open episode.
    const merged = store.markDiskSuspendEpisode("MSN-disk", { taskIds: ["TSK-running", "TSK-third"] });
    assert.equal(merged.episodeId, episode.episodeId);
    assert.deepEqual(merged.taskIds, ["TSK-running", "TSK-other", "TSK-third"]);
    assert.equal(store.getOpenDiskSuspendEpisode("MSN-disk")?.episodeId, episode.episodeId);
    store.resolveDiskSuspendEpisode("MSN-disk");
    assert.equal(store.getOpenDiskSuspendEpisode("MSN-disk"), undefined);
    // Replay reproduces the durable history (two episodes worth of marks + resolution).
    await store.flush();
    const replayed = MissionStore.open(backend);
    const episodes = replayed.listDiskSuspendEpisodes("MSN-disk");
    assert.equal(episodes.length, 1);
    assert.deepEqual(episodes[0]!.taskIds, ["TSK-running", "TSK-other", "TSK-third"]);
    assert.notEqual(episodes[0]!.resolvedAt, null);
  });

  it("re-diagnoses transient failures of RUNNING-at-suspend tasks, id-sparing", () => {
    const store = newStore();
    store.markDiskSuspendEpisode("MSN-disk", { taskIds: ["TSK-running"] });
    const stored = store.classifyFailure(classification({ classificationId: "FC-keep", summary: "connection reset" }));
    assert.equal(stored.classificationId, "FC-keep", "the caller's identity survives");
    assert.equal(stored.category, "DISK_SUSPENDED");
    assert.match(stored.summary, /disk suspend/);
    assert.notEqual(stored.fingerprint, "sha256:fixture", "budget fingerprint re-keyed");
    // Repeating the failure yields the SAME fingerprint: one capacity wait.
    const again = store.classifyFailure(classification({ classificationId: "FC-keep-2", summary: "connection reset" }));
    assert.equal(again.category, "DISK_SUSPENDED");
    assert.equal(again.fingerprint, stored.fingerprint);
  });

  it("never excuses genuine defects or tasks outside the episode", () => {
    const store = newStore();
    store.markDiskSuspendEpisode("MSN-disk", { taskIds: ["TSK-running"] });
    const defect = store.classifyFailure(
      classification({ classificationId: "FC-defect", category: "VALIDATION_FAILED", summary: "tests failed" }),
    );
    assert.equal(defect.category, "VALIDATION_FAILED");
    const stranger = store.classifyFailure(
      classification({ classificationId: "FC-other", taskId: "TSK-elsewhere", summary: "connection reset" }),
    );
    assert.equal(stranger.category, "PROVIDER_TRANSIENT");
  });

  it("stops overriding once the episode is resolved", () => {
    const store = newStore();
    store.markDiskSuspendEpisode("MSN-disk", { taskIds: ["TSK-running"] });
    store.resolveDiskSuspendEpisode("MSN-disk");
    const stored = store.classifyFailure(classification({ classificationId: "FC-post" }));
    assert.equal(stored.category, "PROVIDER_TRANSIENT", "post-recovery failures are judged normally");
  });

  it("replays the overridden category (durable, not computed per process)", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    store.createMission({
      mission_id: "MSN-disk",
      title: "t",
      goal: "g",
      user_request: "u /tmp/disk-fixture",
      repository: "/tmp/disk-fixture",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering",
    });
    store.markDiskSuspendEpisode("MSN-disk", { taskIds: ["TSK-running"] });
    store.classifyFailure(classification({ classificationId: "FC-replay" }));
    await store.flush();
    const replayed = MissionStore.open(backend);
    assert.equal(replayed.getFailureClassification("FC-replay")?.category, "DISK_SUSPENDED");
  });
});
