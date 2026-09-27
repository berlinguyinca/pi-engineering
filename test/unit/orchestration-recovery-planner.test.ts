import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  FailureClassifier,
  type FailureEvidence,
  RecoveryPlanner,
  failureFingerprint,
} from "../../src/orchestration/recovery.ts";
import type { FailureCategory, RecoveryAction, RecoveryDecision } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const baseEvidence = (summary: string): FailureEvidence => ({
  missionId: "MSN-recovery",
  taskId: "TSK-failed",
  executionId: "EXE-failed",
  summary,
  evidenceRefs: ["artifact:b", "artifact:a"],
});

describe("FailureClassifier", () => {
  const cases: Array<[string, Partial<FailureEvidence>, FailureCategory, RecoveryAction]> = [
    ["workspace scope mismatch", {}, "WORKSPACE_SCOPE_MISMATCH", "REBUILD_WORKSPACE_MANIFEST"],
    ["candidate evidence unavailable", {}, "EVIDENCE_UNAVAILABLE", "RECONSTRUCT_EVIDENCE"],
    ["task execution budget exhausted", {}, "TASK_BUDGET_EXHAUSTED", "CHECKPOINT_SPLIT_AND_REPLACE"],
    ["provider returned 503 temporarily", { providerStatus: 503 }, "PROVIDER_TRANSIENT", "PROBE_AND_BACKOFF"],
    ["provider rejected invalid credentials", { providerStatus: 401 }, "PROVIDER_PERMANENT", "STOP"],
    ["worker output failed schema validation", {}, "INVALID_WORKER_OUTPUT", "REPAIR_WORKER_OUTPUT"],
    ["validation suite failed", {}, "VALIDATION_FAILED", "CREATE_REPAIR_TASKS"],
    ["review requested changes", {}, "REVIEW_FAILED", "CREATE_REPAIR_TASKS"],
    ["implementation defect in handler", {}, "IMPLEMENTATION_DEFECT", "CREATE_REPAIR_TASKS"],
    ["merge conflict in candidate", {}, "MERGE_CONFLICT", "REBUILD_INTEGRATION_CANDIDATE"],
    ["authorization or credential required", {}, "AUTHORIZATION_OR_CREDENTIAL", "STOP"],
    ["requirement is ambiguous", {}, "REQUIREMENT_AMBIGUITY", "WAIT_FOR_REQUIREMENT"],
    ["orphaned execution has no owner", {}, "ORPHANED_EXECUTION", "FENCE_RECONCILE_AND_RESUME"],
    ["dependency graph is deadlocked", {}, "DEADLOCKED_DAG", "REPAIR_BLOCKED_MISSION"],
    ["durable persistence write failed", {}, "PERSISTENCE_FAILURE", "PAUSE_FOR_PERSISTENCE"],
  ];

  for (const [summary, overrides, category, action] of cases) {
    it(`${category} defaults to ${action}`, () => {
      const classification = new FailureClassifier().classify({ ...baseEvidence(summary), ...overrides });
      assert.equal(classification.category, category);
      assert.equal(RecoveryPlanner.defaultAction(category), action);
      assert.match(classification.fingerprint, /^sha256:[0-9a-f]{64}$/);
    });
  }

  it("distinguishes permanent provider refusal from transient provider outage", () => {
    const classifier = new FailureClassifier();
    assert.equal(
      classifier.classify({ ...baseEvidence("provider error"), providerStatus: 429 }).category,
      "PROVIDER_TRANSIENT",
    );
    assert.equal(
      classifier.classify({ ...baseEvidence("provider error"), providerStatus: 403 }).category,
      "PROVIDER_PERMANENT",
    );
  });

  it("treats auth, model, configuration, and unknown provider failures as permanent", () => {
    const classifier = new FailureClassifier();
    for (const evidence of [
      { summary: "provider invalid api key", providerCode: "invalid_api_key" },
      { summary: "provider model does not exist", providerCode: "model_not_found" },
      { summary: "provider configuration is invalid", providerCode: "invalid_configuration" },
      { summary: "provider returned an unrecognized refusal", providerCode: "mystery_failure" },
    ]) {
      assert.equal(
        classifier.classify({ ...baseEvidence(evidence.summary), ...evidence }).category,
        "PROVIDER_PERMANENT",
      );
    }
    assert.equal(
      classifier.classify({ ...baseEvidence("connection reset"), providerCode: "ECONNRESET" }).category,
      "PROVIDER_TRANSIENT",
    );
  });

  it("canonicalizes evidence order but changes when material evidence changes", () => {
    const first = failureFingerprint({ ...baseEvidence("Validation failed"), category: "VALIDATION_FAILED" });
    const reordered = failureFingerprint({
      ...baseEvidence(" validation   failed "),
      category: "VALIDATION_FAILED",
      evidenceRefs: ["artifact:a", "artifact:b"],
      executionId: "EXE-restarted",
    });
    const changed = failureFingerprint({
      ...baseEvidence("Validation failed"),
      category: "VALIDATION_FAILED",
      evidenceRefs: ["artifact:a", "artifact:c"],
    });
    assert.equal(first, reordered);
    assert.notEqual(first, changed);
  });
});

describe("RecoveryPlanner", () => {
  const classification = new FailureClassifier().classify(baseEvidence("validation suite failed"));
  const decision = (fingerprint: string, attempt: number): RecoveryDecision => ({
    recoveryId: `RCV-${attempt}`,
    missionId: classification.missionId,
    classificationId: classification.classificationId,
    action: "CREATE_REPAIR_TASKS",
    expectedMaterialChange: "repair candidate",
    attempt,
    maxAttempts: 2,
    deadline: "2026-09-27T01:00:00.000Z",
    nextActionAt: "2026-09-27T00:00:00.000Z",
    status: "failed",
    decidedAt: "2026-09-27T00:00:00.000Z",
    failureFingerprint: fingerprint,
  });

  it("bounds an identical fingerprint across durable restart history", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 });
    const history = [decision(classification.fingerprint, 1), decision(classification.fingerprint, 2)];
    const exhausted = planner.decide({ classification, history, now: Date.parse("2026-09-27T00:00:10.000Z") });
    assert.equal(exhausted.action, "STOP");
    assert.equal(exhausted.attempt, 3);
    assert.match(exhausted.expectedMaterialChange, /identical failure fingerprint exhausted/i);
  });

  it("allows the next strategy when material evidence changes", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 });
    const history = [decision(classification.fingerprint, 1), decision(classification.fingerprint, 2)];
    const changed = new FailureClassifier().classify({
      ...baseEvidence("validation suite failed"),
      evidenceRefs: ["artifact:new"],
    });
    const next = planner.decide({ classification: changed, history, now: Date.parse("2026-09-27T00:00:10.000Z") });
    assert.equal(next.action, "CREATE_REPAIR_TASKS");
    assert.equal(next.attempt, 1);
  });

  it("shares one mission ceiling and preserves the earliest durable deadline", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 2, strategyMaxAttempts: 2, decisionTtlMs: 60_000 });
    const first = decision("sha256:first", 1);
    const second = decision("sha256:second", 1);
    second.deadline = "2026-09-27T00:00:05.000Z";
    const stopped = planner.decide({
      classification,
      history: [first, second],
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(stopped.action, "STOP");
    assert.equal(stopped.deadline, second.deadline);
    assert.match(stopped.expectedMaterialChange, /mission recovery ceiling|deadline exhausted/i);
  });

  it("replays fingerprint attempts and deadline from the durable store after restart", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    store.createMission({
      mission_id: classification.missionId,
      title: "restart",
      goal: "restart",
      user_request: "restart",
      repository: ".",
      base_ref: "base",
      risk_profile: "medium",
      workflow_class: "engineering",
    });
    store.classifyFailure(classification);
    for (const entry of [decision(classification.fingerprint, 1), decision(classification.fingerprint, 2)]) {
      store.planRecovery(entry);
      store.transitionRecovery(entry.recoveryId, "failed");
    }
    await store.flush();

    const reopened = MissionStore.open(backend);
    const replayed = new RecoveryPlanner({ missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 }).decide({
      classification: reopened.getFailureClassification(classification.classificationId)!,
      history: reopened.listRecoveryDecisions(classification.missionId),
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(replayed.action, "STOP");
    assert.equal(replayed.deadline, "2026-09-27T01:00:00.000Z");
    assert.match(replayed.expectedMaterialChange, /identical failure fingerprint exhausted/i);
  });
});
