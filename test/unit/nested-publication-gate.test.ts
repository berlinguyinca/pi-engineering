/**
 * Defect-4 focused unit tests: gate acceptance of recorded nested standalone
 * repo publications and findings suppression. The GitRepo-level discovery /
 * recording / durability mechanics are covered in nested-repo-publication.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NestedRepoPublication } from "../../src/git/GitRepo.ts";
import { CompletionGate } from "../../src/orchestration/completionGate.ts";
import { buildCandidateEvidenceIdentity, hashCandidateEvidenceIdentity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  type FindingInput,
  acceptableNestedPublications,
  hasAcceptableNestedPublication,
  isNestedPublicationAcceptable,
  nestedPublicationReference,
  suppressUnmergedWorkFinding,
} from "../../src/orchestration/nestedPublicationGate.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function publication(overrides: Partial<NestedRepoPublication> = {}): NestedRepoPublication {
  return {
    missionId: "MSN-test",
    anchoredRepoId: "repo-1",
    nestedPath: "nested/product",
    remoteUrl: "/tmp/remote.git",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    publishedSha: HEAD_SHA,
    diffStat: " product.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const UNMERGED_WORK_FINDING: FindingInput = {
  mission_id: "MSN-test",
  task_id: null,
  severity: "major",
  category: "integration",
  file: null,
  line: null,
  summary: "Unmerged worker work preserved on branch(es): pi-eng-orch-TSK-1",
  evidence: null,
  recommended_action: "Merge or discard these branches manually; the orchestrator will not re-run them.",
};

function bareMission(requiredGates: string[]) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const m = store.createMission({
    title: "nested publication",
    goal: "x",
    user_request: "x",
    repository: ".",
    base_ref: "",
    risk_profile: "medium" as never,
    workflow_class: "engineering_review",
  });
  store.updateMission(m.mission_id, { required_gates: requiredGates as never[] });
  return { store, m };
}

describe("nested publication gate acceptance", () => {
  it("accepts a publication whose work is on the nested remote (publishedSha == headSha)", () => {
    assert.equal(isNestedPublicationAcceptable(publication()), true);
    assert.equal(hasAcceptableNestedPublication([publication()]), true);
    assert.equal(acceptableNestedPublications([publication()]).length, 1);
  });

  it("rejects a publication whose remote lacks the new head (publishedSha != headSha)", () => {
    const record = publication({ publishedSha: OTHER_SHA });
    assert.equal(isNestedPublicationAcceptable(record), false);
    assert.equal(hasAcceptableNestedPublication([record]), false);
    assert.equal(acceptableNestedPublications([record]).length, 0);
  });

  it("accepts a publication from a nested repo with no remote (publishedSha == null)", () => {
    assert.equal(isNestedPublicationAcceptable(publication({ remoteUrl: null, publishedSha: null })), true);
  });

  it("rejects a publication when the nested HEAD did not advance (headSha == baseSha)", () => {
    assert.equal(isNestedPublicationAcceptable(publication({ headSha: BASE_SHA, publishedSha: BASE_SHA })), false);
  });

  it("rejects when no publication is recorded for the mission", () => {
    assert.equal(hasAcceptableNestedPublication([]), false);
    assert.deepEqual(acceptableNestedPublications([]), []);
  });

  it("reference summarizes the publication for findings and audit", () => {
    const reference = nestedPublicationReference(publication());
    assert.match(reference, /nested\/product/);
    assert.match(reference, /repo-1/);
    assert.match(reference, /a{7}\.\.b{7}/);
  });
});

describe("nested publication findings suppression", () => {
  it("downgrades the unmerged-work finding when an acceptable publication exists", () => {
    const suppressed = suppressUnmergedWorkFinding(UNMERGED_WORK_FINDING, [publication()]);
    assert.notEqual(suppressed, UNMERGED_WORK_FINDING, "suppression must return a new finding");
    assert.equal(suppressed.severity, "minor", "downgraded to the lowest severity");
    assert.ok(suppressed.summary.startsWith("Unmerged worker work preserved"), "original context is retained");
    assert.match(suppressed.summary, /superseded by nested repo nested\/product in repo-1/);
    assert.ok(suppressed.evidence?.includes("nested/product"), "evidence references the publication");
    assert.ok(suppressed.evidence?.includes(HEAD_SHA));
    assert.match(suppressed.recommended_action, /nested standalone repo/);
  });

  it("leaves the finding unchanged when no publication is recorded", () => {
    assert.equal(suppressUnmergedWorkFinding(UNMERGED_WORK_FINDING, []), UNMERGED_WORK_FINDING);
  });

  it("leaves the finding unchanged when the publication is not gate-acceptable", () => {
    const record = publication({ publishedSha: OTHER_SHA });
    assert.equal(suppressUnmergedWorkFinding(UNMERGED_WORK_FINDING, [record]), UNMERGED_WORK_FINDING);
  });

  it("leaves unrelated findings unchanged", () => {
    const other: FindingInput = {
      ...UNMERGED_WORK_FINDING,
      summary: "Integration produced no change: the worker branches held no committed work",
    };
    assert.equal(suppressUnmergedWorkFinding(other, [publication()]), other);
  });

  it("keeps mission and task binding of the downgraded finding", () => {
    const suppressed = suppressUnmergedWorkFinding(UNMERGED_WORK_FINDING, [publication()]);
    assert.equal(suppressed.mission_id, "MSN-test");
    assert.equal(suppressed.task_id, null);
    assert.equal(suppressed.category, "integration");
  });
});

describe("CompletionGate with nested publication evidence (defect-4)", () => {
  it("reports no candidate recorded when no anchored candidate and no nested publication exist", () => {
    const { store, m } = bareMission(["validation", "independent_review"]);
    const verdict = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(verdict.missing_gates.includes("validation"));
    assert.ok(verdict.missing_gates.includes("independent_review"));
    assert.ok(
      verdict.reasons.some((reason) => reason.includes("no candidate is recorded")),
      JSON.stringify(verdict.reasons),
    );
  });

  it("accepts a recorded nested publication (publishedSha == headSha) as candidate evidence", () => {
    const { store, m } = bareMission(["validation", "independent_review"]);
    const gate = new CompletionGate(store, (missionId) => (missionId === m.mission_id ? [publication()] : []));
    const evidence = gate.gather(m.mission_id);
    assert.equal(evidence.validationsPassed, 1, "validation gate satisfied by the publication record");
    assert.equal(evidence.reviewsCompleted, 1, "review gate satisfied by the publication diff stat");
    assert.equal(evidence.validationProblem, undefined, "no 'no candidate recorded' validation problem");
    assert.equal(evidence.reviewProblem, undefined, "no 'no candidate recorded' review problem");
    const verdict = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, true, JSON.stringify(verdict));
    assert.deepEqual(verdict.missing_gates, []);
    assert.ok(!verdict.reasons.some((reason) => reason.includes("no candidate is recorded")), JSON.stringify(verdict));
  });

  it("does not accept a nested publication whose remote lacks the new head", () => {
    const { store, m } = bareMission(["validation", "independent_review"]);
    const gate = new CompletionGate(store, (missionId) =>
      missionId === m.mission_id ? [publication({ publishedSha: OTHER_SHA })] : [],
    );
    const verdict = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(
      verdict.reasons.some((reason) => reason.includes("no candidate is recorded")),
      JSON.stringify(verdict.reasons),
    );
  });

  it("does not let a nested publication satisfy the gate when there is no recorded publication", () => {
    const { store, m } = bareMission(["validation"]);
    const gate = new CompletionGate(store, () => []);
    const verdict = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(verdict.missing_gates.includes("validation"));
  });

  it("leaves a current anchored candidate flow unchanged (nested evidence only applies without one)", () => {
    const { store, m } = bareMission(["validation", "independent_review"]);
    store.addAcceptanceCriterion(m.mission_id, "current candidate is verified", undefined, "AC-1");
    const manifest = {
      manifestId: "WM-1",
      missionId: m.mission_id,
      generation: 1,
      authorizedRoots: [{ canonicalPath: "/repo", source: "launch_cwd" as const, access: "write" as const }],
      repositories: [
        {
          repoId: "repo-1",
          canonicalRoot: "/repo",
          baseRef: "main",
          baseSha: "base-a",
          writableDomains: ["**"],
        },
      ],
      dependencyEdges: [],
      hash: "manifest-a",
      createdAt: new Date().toISOString(),
    };
    store.bindWorkspaceManifest(manifest);
    const evidenceFor = (kind: "validation" | "review") => {
      const task = store.createTask({
        mission_id: m.mission_id,
        kind,
        role: kind === "review" ? "independent-reviewer" : "validator",
        objective: kind,
        repo_id: "repo-1",
        acceptance_ids: ["AC-1"],
      });
      store.transitionTask(task.task_id, "READY");
      const execution = store.createExecution({
        task_id: task.task_id,
        backend: kind,
        mission_id: m.mission_id,
        repo_id: "repo-1",
        base_sha: "base-a",
      });
      store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
      store.setExecutionStatus(execution.execution_id, "RUNNING");
      store.setExecutionStatus(execution.execution_id, "SUCCEEDED");
      store.transitionTask(task.task_id, "SUCCEEDED");
      return { taskId: task.task_id, executionId: execution.execution_id };
    };
    const identity = buildCandidateEvidenceIdentity({
      workspaceManifestHash: manifest.hash,
      missionGeneration: 0,
      repoId: "repo-1",
      baseSha: "base-a",
      candidateSha: "candidate-a",
      diffHash: "diff-a",
      acceptanceIds: ["AC-1"],
      artifactHashes: ["sha256:artifact-a"],
    });
    const acceptanceId = "AC-1";
    const validationRun = evidenceFor("validation");
    const reviewRun = evidenceFor("review");
    store.recordCandidate(m.mission_id, identity, "integration", validationRun);
    store.recordValidationEvidence({
      evidenceId: "VE-1",
      missionId: m.mission_id,
      taskId: validationRun.taskId,
      executionId: validationRun.executionId,
      identity,
      identityHash: hashCandidateEvidenceIdentity(identity),
      command: "npm test",
      profile: "default",
      exitCode: 0,
      testSummary: { passed: 42, failed: 0 },
      noTargets: false,
      accessible: true,
      acceptanceResults: [{ acceptanceId, status: "passed", detail: "validated" }],
      recordedAt: new Date().toISOString(),
    });
    store.recordReviewEvidence({
      evidenceId: "RE-1",
      missionId: m.mission_id,
      taskId: reviewRun.taskId,
      executionId: reviewRun.executionId,
      identity,
      identityHash: hashCandidateEvidenceIdentity(identity),
      reviewerSessionId: "review-session-1",
      model: "model-a",
      provider: "provider-a",
      verdict: "approve",
      independenceMode: "independent",
      findings: [],
      outputValid: true,
      accessible: true,
      acceptanceResults: [{ acceptanceId, status: "passed", detail: "reviewed against criterion" }],
      recordedAt: new Date().toISOString(),
    });
    store.setCriterionStatus(m.mission_id, 0, "passed", hashCandidateEvidenceIdentity(identity));

    const anchoredOnly = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
    assert.equal(anchoredOnly.can_complete, true, JSON.stringify(anchoredOnly));

    // With a current anchored candidate the nested publication must not change
    // the anchored verdict in any way.
    const withNested = new CompletionGate(store, (missionId) =>
      missionId === m.mission_id ? [publication()] : [],
    ).evaluate(store.getMission(m.mission_id)!);
    assert.equal(withNested.can_complete, anchoredOnly.can_complete);
    assert.deepEqual(withNested.reasons, anchoredOnly.reasons);
    assert.deepEqual(withNested.missing_gates, anchoredOnly.missing_gates);
  });
});
