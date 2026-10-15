import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  DEFAULT_MISSION_RECOVERY_CEILING,
  DEFAULT_STRATEGY_MAX_ATTEMPTS,
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
import { resolveGatewayResilienceConfig } from "../../src/resilience/config.ts";
import { missionRecoveryBudget } from "../../src/runtime/EngineeringRuntime.ts";

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

  it("classifies gateway capacity signatures as transient instead of stopping (issue #112)", () => {
    const classifier = new FailureClassifier();
    for (const summary of [
      "Worker failed after 5 attempt(s): Connection error.",
      "Worker returned no worker_result. Stream ended without finish_reason",
      "stream ended without a finish_reason",
      "the transport stream failed: connection closed",
      // Nothing matches any known signature: an unrecognized failure is waited
      // out, never stopped.
      "the worker stopped for a reason this build does not recognize",
    ]) {
      assert.equal(classifier.classify(baseEvidence(summary)).category, "PROVIDER_TRANSIENT", summary);
      assert.equal(RecoveryPlanner.defaultAction("PROVIDER_TRANSIENT"), "PROBE_AND_BACKOFF");
    }
  });

  it("never lets a caller-supplied category mask a lost execution lease", () => {
    const classifier = new FailureClassifier();
    for (const category of ["AUTHORIZATION_OR_CREDENTIAL", "PROVIDER_PERMANENT", "VALIDATION_FAILED"] as const) {
      const classification = classifier.classify({
        ...baseEvidence("backend reported failed: execution EXE-9 is no longer authoritative (CANCELED)"),
        category,
      });
      assert.equal(classification.category, "ORPHANED_EXECUTION", category);
      assert.equal(RecoveryPlanner.defaultAction(classification.category), "FENCE_RECONCILE_AND_RESUME");
    }
    // A real credential failure the caller labeled is still a credential failure.
    assert.equal(
      classifier.classify({
        ...baseEvidence("401 Unauthorized while pushing"),
        category: "AUTHORIZATION_OR_CREDENTIAL",
      }).category,
      "AUTHORIZATION_OR_CREDENTIAL",
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

  it("surfaces concrete operator guidance when a non-capacity failure exhausts its budget", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 10, strategyMaxAttempts: 2 });
    const conflict = new FailureClassifier().classify(baseEvidence("merge conflict in candidate"));
    assert.equal(conflict.category, "MERGE_CONFLICT");
    const history = [decision(conflict.fingerprint, 1), decision(conflict.fingerprint, 2)];
    const exhausted = planner.decide({
      classification: conflict,
      history,
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    // Budget reason is preserved for downstream consumers, while the operator
    // gets actionable, conflict-specific guidance (incl. rebase-onto-current-head).
    assert.equal(exhausted.action, "STOP");
    assert.match(exhausted.expectedMaterialChange, /identical failure fingerprint exhausted/i);
    assert.ok(exhausted.operatorGuidance, "expected operator guidance on a budget-exhausted merge conflict");
    assert.match(exhausted.operatorGuidance!, /rebase the preserved branch onto the current main head/i);
  });

  it("does not attach operator guidance when a capacity wait parks instead of stopping", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 10, strategyMaxAttempts: 2 });
    const transient = new FailureClassifier().classify(baseEvidence("gateway returned 503"));
    const history = [decision(transient.fingerprint, 1), decision(transient.fingerprint, 2)];
    const parked = planner.decide({ classification: transient, history, now: Date.parse("2026-09-27T00:00:10.000Z") });
    assert.equal(parked.action, "PROBE_AND_BACKOFF");
    assert.equal(parked.operatorGuidance, undefined);
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

  it("parks a repeated provider-ish fingerprint instead of stopping (issue #112)", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 3, strategyMaxAttempts: 2 });
    const cases: Array<[string, RecoveryAction]> = [
      ["gateway returned 503", "PROBE_AND_BACKOFF"],
      ["provider invalid api key", "PROBE_AND_BACKOFF"],
      ["orphaned execution has no owner", "PROBE_AND_BACKOFF"],
      ["candidate evidence unavailable", "PROBE_AND_BACKOFF"],
      ["durable persistence write failed", "PAUSE_FOR_PERSISTENCE"],
    ];
    for (const [summary, wait] of cases) {
      const repeated = new FailureClassifier().classify(baseEvidence(summary));
      const history = [decision(repeated.fingerprint, 1), decision(repeated.fingerprint, 2)];
      const parked = planner.decide({
        classification: repeated,
        history,
        now: Date.parse("2026-09-27T00:00:10.000Z"),
      });
      assert.equal(parked.action, wait, summary);
      assert.match(parked.expectedMaterialChange, /parks instead of stopping/i, summary);
    }
  });

  it("does not end a mission on the durable outage deadline for a provider-ish failure", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 1_000, strategyMaxAttempts: 100, decisionTtlMs: 60_000 });
    const transient = new FailureClassifier().classify(baseEvidence("gateway returned 503"));
    const history = [decision(transient.fingerprint, 1)];
    history[0]!.deadline = "2026-09-27T00:00:05.000Z";
    const parked = planner.decide({
      classification: transient,
      history,
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(parked.action, "PROBE_AND_BACKOFF");
    assert.equal(parked.deadline, null, "a park past its deadline waits on capacity, not on a clock");
  });

  it("keeps the identical-fingerprint ceiling as a safety net, not a two-shot stop", () => {
    const planner = new RecoveryPlanner();
    const history = [decision(classification.fingerprint, 1), decision(classification.fingerprint, 2)];
    const continuing = planner.decide({
      classification,
      history,
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(continuing.action, "CREATE_REPAIR_TASKS");
    assert.equal(continuing.maxAttempts >= 8, true);
    const exhausted = planner.decide({
      classification,
      history: Array.from({ length: continuing.maxAttempts }, (_, index) =>
        decision(classification.fingerprint, index + 1),
      ),
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(exhausted.action, "STOP");
    assert.match(exhausted.expectedMaterialChange, /identical failure fingerprint exhausted/i);
  });

  it("turns an exhausted non-automatic failure into an operator question", () => {
    const planner = new RecoveryPlanner({ missionCeiling: 2, strategyMaxAttempts: 2 });
    const authorization = new FailureClassifier().classify(baseEvidence("authorization or credential required"));
    const stopped = planner.decide({
      classification: authorization,
      history: [decision(authorization.fingerprint, 1), decision(authorization.fingerprint, 2)],
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(stopped.action, "STOP");
    assert.match(stopped.expectedMaterialChange, /operator question/i);
    const ambiguity = new FailureClassifier().classify(baseEvidence("requirement is ambiguous"));
    const asked = planner.decide({
      classification: ambiguity,
      history: [decision(ambiguity.fingerprint, 1), decision(ambiguity.fingerprint, 2)],
      now: Date.parse("2026-09-27T00:00:10.000Z"),
    });
    assert.equal(asked.action, "STOP");
    assert.match(asked.expectedMaterialChange, /operator question: which requirement/i);
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

describe("mission recovery budget wiring", () => {
  it("resolves one budget so the supervisor and the scheduler cannot disagree", () => {
    const budget = missionRecoveryBudget(resolveGatewayResilienceConfig({}));
    assert.equal(budget.missionCeiling, DEFAULT_MISSION_RECOVERY_CEILING);
    assert.equal(budget.strategyMaxAttempts, DEFAULT_STRATEGY_MAX_ATTEMPTS);
    assert.equal(budget.decisionTtlMs, undefined, "no wall-clock cap unless the policy opts into one");
    const outage = missionRecoveryBudget(resolveGatewayResilienceConfig({ PI_GATEWAY_MAX_OUTAGE: "30m" }));
    assert.equal(outage.decisionTtlMs, 30 * 60_000);
    // Both consumers plan identically from it: the same repeated gateway
    // failure parks on a probe rather than stopping, wherever it is decided.
    const classification = new FailureClassifier().classify(baseEvidence("gateway returned 503"));
    const history = [1, 2].map(
      (attempt): RecoveryDecision => ({
        recoveryId: `RCV-outage-${attempt}`,
        missionId: classification.missionId,
        classificationId: classification.classificationId,
        action: "PROBE_AND_BACKOFF",
        expectedMaterialChange: "observe a healthy provider probe",
        attempt,
        maxAttempts: DEFAULT_STRATEGY_MAX_ATTEMPTS,
        deadline: null,
        nextActionAt: "2026-09-27T00:00:00.000Z",
        status: "failed",
        decidedAt: "2026-09-27T00:00:00.000Z",
        failureFingerprint: classification.fingerprint,
      }),
    );
    for (const planner of [new RecoveryPlanner(budget), new RecoveryPlanner(budget)]) {
      const decision = planner.decide({
        classification,
        history,
        now: Date.parse("2026-09-27T00:00:10.000Z"),
      });
      assert.equal(decision.action, "PROBE_AND_BACKOFF");
      assert.equal(decision.maxAttempts, DEFAULT_STRATEGY_MAX_ATTEMPTS);
    }
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
