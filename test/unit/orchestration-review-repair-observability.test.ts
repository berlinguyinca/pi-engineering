import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import {
  recordGateVerdict,
  recordRepairRound,
  recordReviewSettlement,
} from "../../src/orchestration/reviewRepairNotice.ts";
import type { ReviewEvidence } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/**
 * Review, repair and gate failure already happen in the orchestrator; what was
 * missing is that observability never heard about them. A mission whose
 * reviewer asked for changes looked, on the strip, exactly like a mission whose
 * reviewer was still thinking.
 */
function harness() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const obs = new MissionObservability({
    backend,
    store,
    onUpdate: (_id, message) => updates.push(message),
  });
  const mission = store.createMission({
    title: "review round",
    goal: "prove review reaches the projection",
    user_request: "prove review reaches the projection",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  return { obs, store, id: mission.mission_id, updates };
}

function reviewEvidence(missionId: string, over: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    evidenceId: "RE-1",
    missionId,
    taskId: "task-review",
    executionId: "exec-review",
    identity: {} as ReviewEvidence["identity"],
    identityHash: "hash-1",
    reviewerSessionId: "review-session-1",
    model: "reviewer-model",
    provider: "provider-a",
    verdict: "request_changes",
    independenceMode: "independent",
    findings: [{ severity: "blocking", summary: "cancelling a mission leaks its worktree", status: "open" }],
    outputValid: true,
    accessible: true,
    recordedAt: new Date(0).toISOString(),
    ...over,
  } as ReviewEvidence;
}

test("a blocking review finding reaches the projection and emits its sentence", () => {
  const h = harness();
  const evidence = reviewEvidence(h.id);
  recordReviewSettlement(h.obs, h.id, "SUCCEEDED", evidence);

  const review = h.obs.projection(h.id)?.review;
  assert.equal(review?.status, "completed");
  assert.equal(review?.reviewerId, "review-session-1", "the reviewer that judged the candidate is named");
  assert.equal(review?.model, "reviewer-model");
  assert.equal(review?.findings.filter((f) => f.severity === "blocking").length, 1);
  // The identity the completion gate itself uses for this finding, so a later
  // repair that resolves it can close the same record instead of orphaning it.
  assert.equal(review?.findings[0]?.findingId, "RE-1:0");
  assert.equal(review?.blockingOpen, 1);
  assert.match(h.updates.join("\n"), /Blocking review finding: cancelling a mission leaks its worktree/);
  assert.equal(
    h.obs.summary(h.id)?.completionStatus,
    "review_blocked",
    "a blocking finding is a completion status, not a detail",
  );
});

test("an approved review closes the window without inventing findings", () => {
  const h = harness();
  recordReviewSettlement(h.obs, h.id, "SUCCEEDED", reviewEvidence(h.id, { verdict: "approve", findings: [] }));
  const review = h.obs.projection(h.id)?.review;
  assert.equal(review?.status, "completed");
  assert.equal(review?.findings.length, 0);
  assert.equal(h.updates.filter((m) => m.includes("Blocking review finding")).length, 0);
});

test("a review task that died is not reported as a completed review", () => {
  const h = harness();
  recordReviewSettlement(h.obs, h.id, "FAILED", reviewEvidence(h.id, { findings: [] }));
  assert.equal(h.obs.projection(h.id)?.review.status, "running", "the review never finished");
});

test("a repair round is opened and closed per finding it settles", () => {
  const h = harness();
  recordReviewSettlement(h.obs, h.id, "SUCCEEDED", reviewEvidence(h.id));

  recordRepairRound(h.obs, h.id, "task-repair", ["RE-1:0"], true);
  assert.equal(h.obs.summary(h.id)?.completionStatus, "repairing", "the mission is visibly mid-repair");

  const review = h.obs.projection(h.id)?.review;
  assert.equal(review?.findings[0]?.repaired, true, "the finding the round settled is closed");
  assert.equal(review?.blockingOpen, 0);
  assert.equal(review?.reReviewPending, true, "a repaired candidate owes a fresh review before completion");
});

test("a repair round that produced nothing stays open", () => {
  const h = harness();
  recordReviewSettlement(h.obs, h.id, "SUCCEEDED", reviewEvidence(h.id));
  recordRepairRound(h.obs, h.id, "task-repair", ["RE-1:0"], false);

  const review = h.obs.projection(h.id)?.review;
  assert.equal(review?.findings[0]?.repaired, false);
  assert.equal(review?.blockingOpen, 1);
  assert.equal(review?.reReviewPending, false, "nothing was repaired, so nothing is owed a re-review");
});

test("a gate that does not pass records its own reasons and is not verified complete", () => {
  const h = harness();
  recordGateVerdict(h.obs, h.id, {
    can_complete: false,
    reasons: ["no current validation evidence", "2 task(s) failed"],
  });

  const summary = h.obs.summary(h.id);
  assert.notEqual(summary?.progress.verifiedComplete, true);
  assert.equal(summary?.completionStatus, "not_ready");
  assert.match(h.updates.join("\n"), /Completion not yet verified \(2 condition\(s\) pending\)/);
});

test("a gate that passes is not reported as failed", () => {
  const h = harness();
  recordGateVerdict(h.obs, h.id, { can_complete: true, reasons: [] });
  assert.notEqual(
    h.obs.summary(h.id)?.completionStatus,
    "verified_complete",
    "passing the gate is the caller's job to record",
  );
  assert.equal(h.updates.filter((m) => m.includes("Completion not yet verified")).length, 0);
});
