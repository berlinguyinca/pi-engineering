import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  FailureClassifier,
  type FailureEvidence,
  RecoveryPlanner,
  failureFingerprint,
  replacementRecoveryFingerprint,
} from "../../src/orchestration/recovery.ts";
import type {
  FailureCategory,
  RecoveryAction,
  RecoveryDecision,
  TaskCheckpoint,
  WorkspaceManifest,
} from "../../src/orchestration/types.ts";
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

  it("does not read 'authoritative' or 'author' as a credential failure (session review)", () => {
    const classifier = new FailureClassifier();
    for (const summary of [
      "execution EXE-aB3dE9 is no longer authoritative (CANCELED)",
      "backend reported failed: execution EXE-x1 is no longer authoritative (RUNNING)",
    ]) {
      assert.equal(classifier.classify(baseEvidence(summary)).category, "ORPHANED_EXECUTION", summary);
    }
    assert.notEqual(
      classifier.classify(baseEvidence("implementation defect in the author index handler")).category,
      "AUTHORIZATION_OR_CREDENTIAL",
    );
    assert.equal(
      classifier.classify(baseEvidence("authentication failed: 401 Unauthorized")).category,
      "AUTHORIZATION_OR_CREDENTIAL",
    );
    assert.equal(classifier.classify(baseEvidence("git push: auth required")).category, "AUTHORIZATION_OR_CREDENTIAL");
  });

  it("classifies credential failures ahead of loose ownership words (PR #106 review)", () => {
    const classifier = new FailureClassifier();
    for (const summary of [
      "OAuth token expired",
      "oauth: refresh token revoked for github.com",
      "401 unauthorized",
      "HTTP 401 Unauthorized while pushing the orphaned branch",
      "403 Forbidden: orphan ref cleanup requires admin",
      "credential helper failed for the orphan worktree remote",
    ]) {
      assert.equal(classifier.classify(baseEvidence(summary)).category, "AUTHORIZATION_OR_CREDENTIAL", summary);
    }
    for (const summary of [
      "execution EXE-1 is no longer authoritative (CANCELED)",
      "orphaned execution EXE-2 found after restart",
      "stale owner for lease on task TSK-3",
    ]) {
      assert.equal(classifier.classify(baseEvidence(summary)).category, "ORPHANED_EXECUTION", summary);
    }
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

describe("replacement recovery fingerprint", () => {
  const manifest: WorkspaceManifest = {
    manifestId: "WM-exact",
    missionId: "MSN-exact",
    generation: 3,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-exact",
        canonicalRoot: "/repo",
        baseRef: "main",
        baseSha: "base-exact",
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-exact",
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  const checkpoint: TaskCheckpoint = {
    checkpointId: "CHK-exact",
    executionId: "EXE-exact",
    missionId: "MSN-exact",
    taskId: "TSK-original",
    repoId: "repo-exact",
    baseSha: "base-exact",
    candidateSha: "candidate-exact",
    branch: "branch-exact",
    worktree: "/repo-worktree",
    committedChanges: ["src/a.ts"],
    preservedUncommittedChanges: ["src/a.ts"],
    completedDeliverables: ["done"],
    remainingDeliverables: ["remaining"],
    acceptanceIds: ["AC-1"],
    validationEvidenceRefs: ["artifact://validation"],
    artifactRefs: ["artifact://exact"],
    artifactHashes: [`sha256:${"a".repeat(64)}`],
    workerId: "worker",
    sessionId: "session",
    model: "local/local",
    sequence: 4,
    missionGeneration: 5,
    candidateGeneration: 6,
    fencingToken: 7,
    createdAt: "2026-09-27T00:00:01.000Z",
  };
  const base = {
    decision: {
      recoveryId: "RCV-exact",
      missionId: "MSN-exact",
      classificationId: "FC-exact",
      action: "CHECKPOINT_SPLIT_AND_REPLACE" as const,
      expectedMaterialChange: "replace exact work",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-27T00:05:00.000Z",
      nextActionAt: "2026-09-27T00:00:02.000Z",
      status: "planned" as const,
      decidedAt: "2026-09-27T00:00:02.000Z",
      failureFingerprint: "sha256:failure",
      blockedEpisodeId: "BLK-exact",
      resumptionGeneration: 8,
      startingCandidateIdentityHash: "sha256:baseline",
      startingCandidateContent: { candidateSha: "candidate-before", diffHash: "diff-before" },
    },
    lineage: {
      supersessionId: "SUP-exact",
      failedTaskId: "TSK-original",
      repoId: "repo-exact",
      acceptanceIds: ["AC-1"],
      coverageFingerprint: "sha256:coverage",
      replacementTaskIds: ["TSK-replacement", "TSK-replacement-2"],
    },
    replacement: {
      task_id: "TSK-replacement",
      mission_id: "MSN-exact",
      kind: "agent" as const,
      role: "implementer",
      objective: "finish exact replacement",
      depends_on: ["TSK-dependency"],
      priority: 9,
      mutates_repo: true,
      write_domains: ["src/**"],
      isolation: "worktree" as const,
      execution_requirements: { model: "local/local" },
      max_attempts: 1,
      failure_policy: "block" as const,
      repo_id: "repo-exact",
      acceptance_ids: ["AC-1"],
      deliverables: ["remaining"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 2, before_deadline_ms: 1_000 },
      required_output_artifacts: ["patch"],
      candidate_generation: 10,
      repair_base_candidate_sha: undefined as string | undefined,
    },
    manifest,
    checkpoint,
  };
  const change = (target: object, update: Record<string, unknown>): void => {
    Object.assign(target, update);
  };

  for (const [label, mutate] of [
    ["decision identity", (value: typeof base) => change(value.decision, { recoveryId: "RCV-forged" })],
    ["decision mission", (value: typeof base) => change(value.decision, { missionId: "MSN-forged" })],
    ["decision action", (value: typeof base) => change(value.decision, { action: "CREATE_REPAIR_TASKS" })],
    ["blocked episode", (value: typeof base) => change(value.decision, { blockedEpisodeId: "BLK-forged" })],
    ["resumption generation", (value: typeof base) => change(value.decision, { resumptionGeneration: 9 })],
    ["candidate baseline", (value: typeof base) => change(value.decision, { startingCandidateIdentityHash: null })],
    [
      "content baseline",
      (value: typeof base) => change(value.decision.startingCandidateContent!, { diffHash: "forged" }),
    ],
    ["supersession", (value: typeof base) => change(value.lineage, { supersessionId: "SUP-forged" })],
    ["failed task", (value: typeof base) => change(value.lineage, { failedTaskId: "TSK-forged" })],
    ["lineage repository", (value: typeof base) => change(value.lineage, { repoId: "repo-forged" })],
    ["lineage coverage", (value: typeof base) => change(value.lineage, { coverageFingerprint: "forged" })],
    ["ordered replacements", (value: typeof base) => void value.lineage.replacementTaskIds.reverse()],
    ["task identity", (value: typeof base) => change(value.replacement, { task_id: "TSK-forged" })],
    ["mission identity", (value: typeof base) => change(value.replacement, { mission_id: "MSN-forged" })],
    ["kind", (value: typeof base) => change(value.replacement, { kind: "process" })],
    ["role", (value: typeof base) => change(value.replacement, { role: "reviewer" })],
    ["objective", (value: typeof base) => change(value.replacement, { objective: "forged" })],
    ["dependencies", (value: typeof base) => void value.replacement.depends_on.push("TSK-forged")],
    ["priority", (value: typeof base) => change(value.replacement, { priority: 10 })],
    ["mutation mode", (value: typeof base) => change(value.replacement, { mutates_repo: false })],
    ["write domains", (value: typeof base) => void value.replacement.write_domains.push("test/**")],
    ["isolation", (value: typeof base) => change(value.replacement, { isolation: "none" })],
    [
      "execution requirements",
      (value: typeof base) => change(value.replacement, { execution_requirements: { model: "other" } }),
    ],
    ["max attempts", (value: typeof base) => change(value.replacement, { max_attempts: 2 })],
    ["failure policy", (value: typeof base) => change(value.replacement, { failure_policy: "retry" })],
    ["deliverables", (value: typeof base) => void value.replacement.deliverables.push("forged")],
    ["acceptance", (value: typeof base) => void value.replacement.acceptance_ids.push("AC-forged")],
    ["repository", (value: typeof base) => change(value.replacement, { repo_id: "repo-forged" })],
    ["generation", (value: typeof base) => change(value.replacement, { candidate_generation: 11 })],
    ["execution budget", (value: typeof base) => change(value.replacement, { execution_budget_ms: 30_000 })],
    [
      "checkpoint policy",
      (value: typeof base) => change(value.replacement.checkpoint_policy!, { activity_milestone: 3 }),
    ],
    ["required artifacts", (value: typeof base) => void value.replacement.required_output_artifacts.push("report")],
    ["repair base", (value: typeof base) => change(value.replacement, { repair_base_candidate_sha: "repair-base" })],
    ["manifest identity", (value: typeof base) => change(value.manifest, { hash: "manifest-forged" })],
    ["checkpoint sequence", (value: typeof base) => change(value.checkpoint, { sequence: 5 })],
    ["checkpoint content", (value: typeof base) => void value.checkpoint.completedDeliverables.push("forged")],
    ["checkpoint candidate", (value: typeof base) => change(value.checkpoint, { candidateSha: "candidate-forged" })],
    ["checkpoint base", (value: typeof base) => change(value.checkpoint, { baseSha: "base-forged" })],
    ["checkpoint path", (value: typeof base) => change(value.checkpoint, { worktree: "/forged" })],
    ["artifact ref", (value: typeof base) => change(value.checkpoint.artifactRefs, { 0: "artifact://forged" })],
    ["artifact proof deletion", (value: typeof base) => void value.checkpoint.artifactRefs.pop()],
    [
      "artifact hash",
      (value: typeof base) => change(value.checkpoint.artifactHashes, { 0: `sha256:${"b".repeat(64)}` }),
    ],
  ] as const) {
    it(`changes when ${label} changes`, () => {
      const changed = structuredClone(base);
      mutate(changed);
      assert.notEqual(replacementRecoveryFingerprint(base), replacementRecoveryFingerprint(changed));
    });
  }
});
