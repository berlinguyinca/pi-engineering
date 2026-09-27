import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { CompletionGate } from "../../src/orchestration/completionGate.ts";
import {
  buildCandidateEvidenceIdentity,
  hashCandidateEvidenceIdentity,
  normalizeReviewSeverity,
  taskCoverageFingerprint,
} from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function mission(requiredGates: string[], risk = "medium") {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const m = store.createMission({
    title: "x",
    goal: "x",
    user_request: "x",
    repository: ".",
    base_ref: "",
    risk_profile: risk as never,
    workflow_class: "engineering_review",
  });
  store.updateMission(m.mission_id, { required_gates: requiredGates as never[] });
  return { store, m, backend };
}

function successfulEvidenceExecution(
  store: MissionStore,
  missionId: string,
  kind: "validation" | "review",
  repoId: string,
  baseSha: string,
) {
  const task = store.createTask({
    mission_id: missionId,
    kind,
    role: kind === "review" ? "independent-reviewer" : "validator",
    objective: kind,
    repo_id: repoId,
    acceptance_ids: kind === "review" ? [repoId === "repo-r" ? "AC-R" : "AC-1"] : [],
  });
  store.transitionTask(task.task_id, "READY");
  const execution = store.createExecution({
    task_id: task.task_id,
    backend: kind,
    mission_id: missionId,
    repo_id: repoId,
    base_sha: baseSha,
  });
  store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
  store.setExecutionStatus(execution.execution_id, "RUNNING");
  store.setExecutionStatus(execution.execution_id, "SUCCEEDED");
  store.transitionTask(task.task_id, "SUCCEEDED");
  return { taskId: task.task_id, executionId: execution.execution_id };
}

describe("CompletionGate (spec 07)", () => {
  it("blocks completion when validation gate is unmet", () => {
    const { store, m } = mission(["validation"]);
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.ok(v.missing_gates.includes("validation"));
  });

  it("blocks completion when a blocking finding is unresolved", () => {
    const { store, m } = mission(["validation", "independent_review"]);
    store.addFinding({
      mission_id: m.mission_id,
      task_id: null,
      severity: "blocking",
      category: "correctness",
      file: "a.ts",
      line: 1,
      summary: "bug",
      evidence: null,
      recommended_action: "fix",
    });
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.equal(v.unresolved_findings, 1);
  });

  it("blocks completion while a task is running", () => {
    const { store, m } = mission(["validation"]);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    store.transitionTask(t.task_id, "READY");
    store.transitionTask(t.task_id, "RUNNING");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.equal(v.running_tasks, 1);
  });

  it("does not accept historical successful executions as gate evidence", () => {
    const { store, m } = mission(["validation", "independent_review"]);
    // Validation execution succeeded.
    const vtask = store.createTask({
      mission_id: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    store.transitionTask(vtask.task_id, "READY");
    store.transitionTask(vtask.task_id, "RUNNING");
    store.transitionTask(vtask.task_id, "SUCCEEDED");
    const vex = store.createExecution({ task_id: vtask.task_id, backend: "validation", mission_id: m.mission_id });
    store.setExecutionStatus(vex.execution_id, "SUCCEEDED");
    // Review execution succeeded.
    const rtask = store.createTask({ mission_id: m.mission_id, kind: "review", role: "reviewer", objective: "review" });
    store.transitionTask(rtask.task_id, "READY");
    store.transitionTask(rtask.task_id, "RUNNING");
    store.transitionTask(rtask.task_id, "SUCCEEDED");
    const rex = store.createExecution({ task_id: rtask.task_id, backend: "review", mission_id: m.mission_id });
    store.setExecutionStatus(rex.execution_id, "SUCCEEDED");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false, JSON.stringify(v));
  });

  it("blocks when a task failed", () => {
    const { store, m } = mission(["validation"]);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    store.transitionTask(t.task_id, "READY");
    store.transitionTask(t.task_id, "RUNNING");
    store.transitionTask(t.task_id, "FAILED");
    const gate = new CompletionGate(store);
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
  });

  it("does not let an unrelated successful implementation supersede a failed implementation", () => {
    const { store, m } = mission([]);
    const failed = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement the API endpoint",
    });
    store.transitionTask(failed.task_id, "READY");
    store.transitionTask(failed.task_id, "RUNNING");
    store.transitionTask(failed.task_id, "FAILED");

    const unrelated = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "update the CLI output",
    });
    store.transitionTask(unrelated.task_id, "READY");
    store.transitionTask(unrelated.task_id, "RUNNING");
    store.transitionTask(unrelated.task_id, "SUCCEEDED");

    const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false, "unrelated implementation work is not retry evidence");
    assert.ok(v.reasons.includes("1 task(s) failed"), JSON.stringify(v.reasons));
  });

  it("does not supersede historical gate failures without exact current evidence", () => {
    for (const kind of ["integration", "validation", "review"] as const) {
      const { store, m } = mission([]);
      for (const status of ["FAILED", "SUCCEEDED"] as const) {
        const task = store.createTask({
          mission_id: m.mission_id,
          kind,
          role: `${kind}-runner`,
          objective: `run ${kind}`,
        });
        store.transitionTask(task.task_id, "READY");
        store.transitionTask(task.task_id, "RUNNING");
        store.transitionTask(task.task_id, status);
      }

      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false, `${kind}: ${JSON.stringify(v.reasons)}`);
    }
  });

  describe("recovered timed-out work (MSN-4IhxSO)", () => {
    type Store = ReturnType<typeof mission>["store"];
    type RecoveredMerge = { task_id: string; branch: string; ref: string };

    function settled(store: Store, missionId: string, kind: string, role: string, status: "SUCCEEDED" | "FAILED") {
      const t = store.createTask({ mission_id: missionId, kind: kind as never, role, objective: kind });
      store.transitionTask(t.task_id, "READY");
      store.transitionTask(t.task_id, "RUNNING");
      store.transitionTask(t.task_id, status);
      return t;
    }
    function execution(
      store: Store,
      missionId: string,
      kind: "integration" | "validation" | "review",
      status: "SUCCEEDED" | "FAILED",
      extra: Record<string, unknown> = {},
    ) {
      const t = settled(store, missionId, kind, kind === "integration" ? "integrator" : kind, status);
      const ex = store.createExecution({ task_id: t.task_id, backend: kind, mission_id: missionId });
      store.setExecutionStatus(ex.execution_id, status, extra as never);
    }
    const merge = (t: { task_id: string }): RecoveredMerge => ({
      task_id: t.task_id,
      branch: `pi-eng-orch-${t.task_id}`,
      ref: "4d57c63",
    });
    /** A timed-out implementer, as the broker leaves it. */
    function timedOut(store: Store, missionId: string) {
      return settled(store, missionId, "agent", "implementer", "FAILED");
    }

    it("does not supersede recovered work from historical success counts alone", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED", { reviewed_recovered: [t.task_id] });
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false, JSON.stringify(v.reasons));
      assert.deepEqual(v.superseded_by_recovery, []);
    });

    it("does not read integration prose: a summary naming the branch is not evidence", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", {
        summary: `integrated pi-eng-orch-${t.task_id}; checks: pass`,
      });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED", { reviewed_recovered: [t.task_id] });
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false);
      assert.ok(
        v.reasons.some((r) => r.includes("task(s) failed")),
        JSON.stringify(v.reasons),
      );
    });

    it("a succeeded integration that merged OTHER work does not supersede an unrecovered task", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const recovered = timedOut(store, m.mission_id);
      const unrecovered = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(recovered)] });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED", {
        reviewed_recovered: [recovered.task_id, unrecovered.task_id],
      });
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false);
      assert.ok(v.reasons.includes("2 task(s) failed"), JSON.stringify(v.reasons));
      void unrecovered;
    });

    it("a FAILED integration's recovered merge is not evidence", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "FAILED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "integration", "SUCCEEDED");
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "SUCCEEDED", { reviewed_recovered: [t.task_id] });
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false, JSON.stringify(v.reasons));
    });

    it("requires validation AND review to have passed AFTER the integration that merged it", () => {
      for (const after of [["validation"], ["review"], []] as const) {
        const { store, m } = mission(["validation", "independent_review"]);
        const t = timedOut(store, m.mission_id);
        // Evidence from BEFORE the recovered merge does not cover it.
        execution(store, m.mission_id, "validation", "SUCCEEDED");
        execution(store, m.mission_id, "review", "SUCCEEDED", { reviewed_recovered: [t.task_id] });
        execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
        for (const k of after) {
          execution(store, m.mission_id, k, "SUCCEEDED", k === "review" ? { reviewed_recovered: [t.task_id] } : {});
        }
        const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
        assert.equal(v.can_complete, false, `after=${after.join("+") || "none"}: ${JSON.stringify(v.reasons)}`);
      }
    });

    it("only a review that was told to check the recovered task's objective counts", () => {
      // A green build and a generic review can both miss that a timed-out
      // worker finished 2 of 5 steps. The review must have run with the explicit
      // completeness note for THIS task.
      for (const covered of [undefined, ["TSK-someone-else"]]) {
        const { store, m } = mission(["validation", "independent_review"]);
        const t = timedOut(store, m.mission_id);
        execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
        execution(store, m.mission_id, "validation", "SUCCEEDED");
        execution(store, m.mission_id, "review", "SUCCEEDED", covered ? { reviewed_recovered: covered } : {});
        const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
        assert.equal(v.can_complete, false, `covered=${JSON.stringify(covered)}`);
        assert.deepEqual(v.superseded_by_recovery, []);
      }
    });

    it("a FAILED review that carried the note is not evidence", () => {
      const { store, m } = mission(["validation", "independent_review"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "validation", "SUCCEEDED");
      execution(store, m.mission_id, "review", "FAILED", { reviewed_recovered: [t.task_id] });
      execution(store, m.mission_id, "review", "SUCCEEDED");
      const v = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
      assert.equal(v.can_complete, false, JSON.stringify(v.reasons));
    });

    it("the store hands out copies of the recovery arrays", () => {
      const { store, m } = mission(["validation"]);
      const t = timedOut(store, m.mission_id);
      execution(store, m.mission_id, "integration", "SUCCEEDED", { recovered_merged: [merge(t)] });
      execution(store, m.mission_id, "review", "SUCCEEDED", { reviewed_recovered: [t.task_id] });
      const [integ, review] = store.listExecutions(m.mission_id);
      integ!.recovered_merged!.push(merge({ task_id: "TSK-injected" }));
      integ!.recovered_merged![0]!.task_id = "TSK-mutated";
      review!.reviewed_recovered!.push("TSK-injected");
      const again = store.listExecutions(m.mission_id);
      assert.deepEqual(again[0]!.recovered_merged, [merge(t)]);
      assert.deepEqual(again[1]!.reviewed_recovered, [t.task_id]);
      const one = store.getExecution(again[0]!.execution_id)!;
      one.recovered_merged![0]!.ref = "mutated";
      assert.deepEqual(store.getExecution(again[0]!.execution_id)!.recovered_merged, [merge(t)]);
    });
  });

  it("a generic reviewer cannot satisfy a security_review gate (spec 07)", () => {
    const { store, m } = mission(["validation", "independent_review", "security_review"], "high");
    const gate = new CompletionGate(store);
    // A generic review + validation succeeded, but no SECURITY review did.
    const v = gate.evaluate(store.getMission(m.mission_id)!);
    assert.equal(v.can_complete, false);
    assert.ok(v.missing_gates.includes("security_review"), JSON.stringify(v.missing_gates));
  });
});

describe("revision-bound completion evidence", () => {
  function currentEvidenceMission(olderGateKind?: "validation" | "review") {
    const { store, m, backend } = mission(["validation", "independent_review"]);
    const acceptance = store.addAcceptanceCriterion(m.mission_id, "current candidate is verified", undefined, "AC-1");
    const olderGate = olderGateKind
      ? store.createTask({
          mission_id: m.mission_id,
          kind: olderGateKind,
          role: olderGateKind === "review" ? "independent-reviewer" : "validator",
          objective: `older-created ${olderGateKind}`,
          repo_id: "repo-1",
          acceptance_ids: ["AC-1"],
        })
      : undefined;
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
    const validationRun = successfulEvidenceExecution(store, m.mission_id, "validation", "repo-1", "base-a");
    const reviewRun = successfulEvidenceExecution(store, m.mission_id, "review", "repo-1", "base-a");
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
      acceptanceResults: [],
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
      acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "reviewed against criterion" }],
      recordedAt: new Date().toISOString(),
    });
    store.setCriterionStatus(m.mission_id, 0, "passed", hashCandidateEvidenceIdentity(identity));
    return { store, backend, mission: store.getMission(acceptance.mission_id)!, identity, validationRun, olderGate };
  }

  async function failOlderCreatedGateAfterGreen(kind: "validation" | "review") {
    const fixture = currentEvidenceMission(kind);
    const task = fixture.olderGate!;
    fixture.store.transitionTask(task.task_id, "READY");
    const execution = fixture.store.createExecution({
      task_id: task.task_id,
      backend: kind,
      mission_id: fixture.mission.mission_id,
      repo_id: fixture.identity.repoId,
      base_sha: fixture.identity.baseSha,
    });
    fixture.store.transitionTask(task.task_id, "RUNNING", "system", {
      assigned_execution_id: execution.execution_id,
    });
    fixture.store.setExecutionStatus(execution.execution_id, "RUNNING");
    fixture.store.setExecutionStatus(execution.execution_id, "FAILED");
    fixture.store.transitionTask(task.task_id, "FAILED");
    return fixture;
  }

  it("hashes canonical identity JSON independent of set ordering", () => {
    const a = buildCandidateEvidenceIdentity({
      workspaceManifestHash: "manifest-a",
      missionGeneration: 3,
      repoId: "repo-1",
      baseSha: "base-a",
      candidateSha: "candidate-a",
      diffHash: "diff-a",
      acceptanceIds: ["AC-2", "AC-1"],
      artifactHashes: ["sha256:b", "sha256:a"],
    });
    const b = buildCandidateEvidenceIdentity({
      ...a,
      acceptanceIds: ["AC-1", "AC-2"],
      artifactHashes: ["sha256:a", "sha256:b"],
    });
    assert.equal(hashCandidateEvidenceIdentity(a), hashCandidateEvidenceIdentity(b));
  });

  it("accepts only validation and review evidence for the exact current candidate", () => {
    const { store, mission } = currentEvidenceMission();
    const verdict = new CompletionGate(store).evaluate(mission);
    assert.equal(verdict.can_complete, true, JSON.stringify(verdict.reasons));
  });

  for (const kind of ["validation", "review"] as const) {
    it(`orders ${kind} attempts by authoritative execution start across live and JSONL replay`, async () => {
      const { store, backend, mission } = await failOlderCreatedGateAfterGreen(kind);
      const live = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
      assert.equal(live.can_complete, false, JSON.stringify(live));
      assert.match(live.reasons.join("; "), new RegExp(`${kind}|failed`, "i"));

      await store.flush();
      const replayed = MissionStore.open(backend);
      const replay = new CompletionGate(replayed).evaluate(replayed.getMission(mission.mission_id)!);
      assert.equal(replay.can_complete, false, JSON.stringify(replay));
      assert.match(replay.reasons.join("; "), new RegExp(`${kind}|failed`, "i"));
    });
  }

  for (const kind of ["validation", "review"] as const) {
    it(`durably invalidates ${kind} evidence before repository resolution can fail`, async () => {
      const { store, backend, mission, identity } = currentEvidenceMission();
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind,
        role: kind === "review" ? "independent-reviewer" : "validator",
        objective: "fail during repository setup",
        repo_id: identity.repoId,
        acceptance_ids: ["AC-1"],
      });
      const before = store.listEvidenceInvalidations(mission.mission_id).length;
      const neverRun = async () => {
        throw new Error("backend must not run");
      };
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => {
          throw new Error("repository setup failed");
        },
        backends: {
          validation: { runValidation: neverRun },
          review: { runReview: neverRun },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: identity.repoId,
        kind,
        role: task.role,
        objective: task.objective,
      });
      const invalidations = store.listEvidenceInvalidations(mission.mission_id);
      assert.equal(invalidations.length, before + 1);
      assert.equal(invalidations.at(-1)?.scope, kind === "review" ? "review" : "all");
      await assert.rejects(handle.result(), /repository setup failed/);
      await store.flush();
      const replayed = MissionStore.open(backend);
      assert.equal(replayed.listEvidenceInvalidations(mission.mission_id).length, before + 1);
    });
  }

  it("rejects evidence whose settled execution has stale candidate generation", () => {
    const { store, mission, identity } = currentEvidenceMission();
    const original = store.listValidationEvidence(mission.mission_id)[0]!;
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "validation",
      role: "validator",
      objective: "stale generation",
      repo_id: identity.repoId,
      candidate_generation: 2,
    });
    store.transitionTask(task.task_id, "READY");
    const execution = store.createExecution({
      task_id: task.task_id,
      backend: "validation",
      mission_id: mission.mission_id,
      repo_id: identity.repoId,
      base_sha: identity.baseSha,
      candidate_generation: 1,
    });
    store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
    store.setExecutionStatus(execution.execution_id, "RUNNING");
    store.setExecutionStatus(execution.execution_id, "SUCCEEDED");
    store.transitionTask(task.task_id, "SUCCEEDED");
    assert.throws(
      () =>
        store.recordValidationEvidence({
          ...original,
          evidenceId: "VE-stale-generation",
          taskId: task.task_id,
          executionId: execution.execution_id,
        }),
      /candidate generation|authoritative/i,
    );
  });

  it("rejects evidence from an execution that is no longer the task assignment", () => {
    const { store, mission, identity } = currentEvidenceMission();
    const original = store.listValidationEvidence(mission.mission_id)[0]!;
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "validation",
      role: "validator",
      objective: "stale assignment",
      repo_id: identity.repoId,
    });
    store.transitionTask(task.task_id, "READY");
    const stale = store.createExecution({
      task_id: task.task_id,
      backend: "validation",
      mission_id: mission.mission_id,
      repo_id: identity.repoId,
      base_sha: identity.baseSha,
    });
    const assigned = store.createExecution({
      task_id: task.task_id,
      backend: "validation",
      mission_id: mission.mission_id,
      repo_id: identity.repoId,
      base_sha: identity.baseSha,
    });
    store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: assigned.execution_id });
    store.setExecutionStatus(stale.execution_id, "RUNNING");
    store.setExecutionStatus(stale.execution_id, "SUCCEEDED");
    store.transitionTask(task.task_id, "SUCCEEDED");
    assert.throws(
      () =>
        store.recordValidationEvidence({
          ...original,
          evidenceId: "VE-stale-assignment",
          taskId: task.task_id,
          executionId: stale.execution_id,
        }),
      /assigned execution|authoritative/i,
    );
  });

  it("blocks when a later authoritative validation attempt fails after earlier green evidence", () => {
    const { store, mission, identity } = currentEvidenceMission();
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "validation",
      role: "validator",
      objective: "later validation",
      repo_id: identity.repoId,
    });
    store.transitionTask(task.task_id, "READY");
    const execution = store.createExecution({
      task_id: task.task_id,
      backend: "validation",
      mission_id: mission.mission_id,
      repo_id: identity.repoId,
      base_sha: identity.baseSha,
    });
    store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
    store.setExecutionStatus(execution.execution_id, "RUNNING");
    store.setExecutionStatus(execution.execution_id, "FAILED");
    store.transitionTask(task.task_id, "FAILED");
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false, JSON.stringify(verdict));
    assert.match(verdict.reasons.join("; "), /validation|failed/i);
  });

  it("does not let a historical execution be republished with a fresh evidence timestamp", () => {
    const { store, mission } = currentEvidenceMission();
    const review = store.listReviewEvidence(mission.mission_id)[0]!;
    assert.throws(
      () =>
        store.recordReviewEvidence({
          ...review,
          evidenceId: "RE-republished-history",
          recordedAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      /historical execution|already recorded|duplicate/i,
    );
  });

  it("anchors supersession freshness to execution end time rather than a later evidence record time", () => {
    const { store, mission, identity } = currentEvidenceMission();
    const oldValidation = successfulEvidenceExecution(store, mission.mission_id, "validation", "repo-1", "base-a");
    const oldReview = successfulEvidenceExecution(store, mission.mission_id, "review", "repo-1", "base-a");
    const failed = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "repair exact behavior",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["src/repair.ts"],
    });
    store.transitionTask(failed.task_id, "READY");
    store.transitionTask(failed.task_id, "RUNNING");
    store.transitionTask(failed.task_id, "FAILED");
    const replacement = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: failed.objective,
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["src/repair.ts"],
    });
    store.transitionTask(replacement.task_id, "READY");
    store.transitionTask(replacement.task_id, "RUNNING");
    store.transitionTask(replacement.task_id, "SUCCEEDED");
    store.supersedeTask({
      supersessionId: "TS-delayed-evidence",
      missionId: mission.mission_id,
      failedTaskId: failed.task_id,
      replacementTaskIds: [replacement.task_id],
      repoId: "repo-1",
      acceptanceIds: ["AC-1"],
      coverageFingerprint: taskCoverageFingerprint(failed),
      reason: "repair",
      createdAt: new Date().toISOString(),
    });
    const identityHash = hashCandidateEvidenceIdentity(identity);
    store.recordCandidate(mission.mission_id, identity, "delayed historical publication", oldValidation);
    store.recordValidationEvidence({
      evidenceId: "VE-delayed-history",
      missionId: mission.mission_id,
      taskId: oldValidation.taskId,
      executionId: oldValidation.executionId,
      identity,
      identityHash,
      command: "npm test",
      profile: "default",
      exitCode: 0,
      testSummary: { passed: 1 },
      noTargets: false,
      accessible: true,
      acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "historical" }],
      recordedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.recordReviewEvidence({
      evidenceId: "RE-delayed-history",
      missionId: mission.mission_id,
      taskId: oldReview.taskId,
      executionId: oldReview.executionId,
      identity,
      identityHash,
      reviewerSessionId: "delayed-review",
      model: "model-a",
      provider: "provider-a",
      verdict: "approve",
      independenceMode: "independent",
      findings: [],
      outputValid: true,
      accessible: true,
      acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "historical" }],
      recordedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false, JSON.stringify(verdict));
    assert.match(verdict.reasons.join("; "), /supersession|replacement/i);
  });

  it("rejects generic green evidence without explicit per-acceptance results", () => {
    const { store, mission } = currentEvidenceMission();
    const review = store.listReviewEvidence(mission.mission_id)[0]!;
    const rerun = successfulEvidenceExecution(store, mission.mission_id, "review", "repo-1", "base-a");
    store.invalidateEvidence({
      invalidationId: "EI-self-attestation",
      missionId: mission.mission_id,
      identity: review.identity,
      reason: "replace explicit result",
      invalidatedAt: new Date().toISOString(),
    });
    store.recordReviewEvidence({
      ...review,
      evidenceId: "RE-generic",
      taskId: rerun.taskId,
      executionId: rerun.executionId,
      acceptanceResults: [],
    });
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /explicit current passing result/i);
  });

  it("quarantines forged replay evidence and fails the gate closed", async () => {
    const { store, backend, mission, identity } = currentEvidenceMission();
    await store.flush();
    await backend.append({
      event_id: "forged-candidate",
      timestamp: new Date().toISOString(),
      type: "candidate.changed",
      project_id: null,
      run_id: mission.mission_id,
      worker_id: null,
      payload: {
        actor: "system",
        candidate: {
          missionId: mission.mission_id,
          identity: { ...identity, candidateSha: "forged" },
          identityHash: hashCandidateEvidenceIdentity(identity),
          reason: "forged replay",
          recordedAt: new Date().toISOString(),
        },
      },
    });
    const replayed = MissionStore.open(backend);
    const verdict = new CompletionGate(replayed).evaluate(replayed.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /quarantined evidence|malformed candidate evidence hash/i);
  });

  it("fails closed for a mission with more than one authorized repository", () => {
    const { store, mission } = currentEvidenceMission();
    const manifest = store.getWorkspaceManifest(mission.mission_id)!;
    store.bindWorkspaceManifest({
      ...manifest,
      hash: "manifest-two-repos",
      repositories: [
        ...manifest.repositories,
        { repoId: "repo-2", canonicalRoot: "/repo-2", baseRef: "main", baseSha: "base-2", writableDomains: ["**"] },
      ],
    });
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /head-vector/i);
  });

  for (const [field, stale] of [
    ["missionGeneration", 7],
    ["candidateSha", "candidate-b"],
    ["diffHash", "diff-b"],
  ] as const) {
    it(`fails closed when ${field} does not match the current candidate`, () => {
      const { store, mission, identity, validationRun } = currentEvidenceMission();
      const record = () =>
        store.recordCandidate(
          mission.mission_id,
          buildCandidateEvidenceIdentity({ ...identity, [field]: stale }),
          "candidate change",
          validationRun,
        );
      if (field === "missionGeneration") {
        assert.throws(record, /generation/i);
        return;
      }
      const rerun = successfulEvidenceExecution(
        store,
        mission.mission_id,
        "validation",
        identity.repoId,
        identity.baseSha,
      );
      store.recordCandidate(
        mission.mission_id,
        buildCandidateEvidenceIdentity({ ...identity, [field]: stale }),
        "candidate change",
        rerun,
      );
      const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
      assert.equal(verdict.can_complete, false);
      assert.match(verdict.reasons.join("; "), /current validation evidence|current review evidence|acceptance/i);
    });
  }

  for (const [field, stale] of [
    ["workspaceManifestHash", "manifest-b"],
    ["repoId", "repo-2"],
  ] as const) {
    it(`rejects ${field} from stale validation and review evidence`, () => {
      const { store, mission, identity } = currentEvidenceMission();
      const wrong = buildCandidateEvidenceIdentity({ ...identity, [field]: stale });
      const identityHash = hashCandidateEvidenceIdentity(wrong);
      const validation = store.listValidationEvidence(mission.mission_id)[0]!;
      const review = store.listReviewEvidence(mission.mission_id)[0]!;
      store.invalidateEvidence({
        invalidationId: `EI-${field}`,
        missionId: mission.mission_id,
        identity,
        reason: "replace evidence",
        invalidatedAt: new Date().toISOString(),
      });
      assert.throws(() =>
        store.recordValidationEvidence({
          ...validation,
          evidenceId: `VE-${field}`,
          identity: wrong,
          identityHash,
          recordedAt: new Date(Date.now() + 1_000).toISOString(),
        }),
      );
      assert.throws(() =>
        store.recordReviewEvidence({
          ...review,
          evidenceId: `RE-${field}`,
          identity: wrong,
          identityHash,
          recordedAt: new Date(Date.now() + 1_000).toISOString(),
        }),
      );
      const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
      assert.equal(verdict.can_complete, false);
      assert.match(verdict.reasons.join("; "), /current validation evidence|current review evidence/i);
    });
  }

  it("rejects no-target validation", () => {
    const { store, mission } = currentEvidenceMission();
    const evidence = store.listValidationEvidence(mission.mission_id)[0]!;
    const rerun = successfulEvidenceExecution(store, mission.mission_id, "validation", "repo-1", "base-a");
    store.invalidateEvidence({
      invalidationId: "EI-old-validation",
      missionId: mission.mission_id,
      identity: evidence.identity,
      reason: "validation rerun",
      invalidatedAt: new Date().toISOString(),
    });
    store.recordValidationEvidence({
      ...evidence,
      evidenceId: "VE-no-target",
      taskId: rerun.taskId,
      executionId: rerun.executionId,
      noTargets: true,
    });
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /no-target|validation/i);
  });

  for (const status of ["pending", "failed"] as const) {
    it(`rejects a ${status} material acceptance criterion`, () => {
      const { store, mission } = currentEvidenceMission();
      if (status === "failed") store.setCriterionStatus(mission.mission_id, 0, "failed", "failed-check");
      else {
        const raw = store.getMission(mission.mission_id)!;
        store.addAcceptanceCriterion(raw.mission_id, "still pending", undefined, "AC-2");
      }
      const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
      assert.equal(verdict.can_complete, false);
      assert.match(verdict.reasons.join("; "), /acceptance/i);
    });
  }

  for (const status of ["BLOCKED", "CANCELED", "SKIPPED"] as const) {
    it(`rejects an unresolved ${status} task`, () => {
      const { store, mission } = currentEvidenceMission();
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: status,
      });
      if (status === "BLOCKED") {
        store.transitionTask(task.task_id, "READY");
        store.transitionTask(task.task_id, "RUNNING");
        store.transitionTask(task.task_id, "BLOCKED");
      } else if (status === "CANCELED") {
        store.transitionTask(task.task_id, "CANCELED");
      } else {
        store.transitionTask(task.task_id, "SKIPPED");
      }
      const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
      assert.equal(verdict.can_complete, false);
      assert.match(verdict.reasons.join("; "), new RegExp(status, "i"));
    });
  }

  it("rejects an active execution without a current fence", () => {
    const { store, mission } = currentEvidenceMission();
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "late writer",
    });
    const execution = store.createExecution({
      task_id: task.task_id,
      mission_id: mission.mission_id,
      backend: "agent",
    });
    store.setExecutionStatus(execution.execution_id, "RUNNING");
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /active execution|fenc/i);
  });

  it("rejects supersession whose replacement is not successful current coverage", () => {
    const { store, mission } = currentEvidenceMission();
    const failed = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "old",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
    });
    store.transitionTask(failed.task_id, "READY");
    store.transitionTask(failed.task_id, "RUNNING");
    store.transitionTask(failed.task_id, "FAILED");
    const replacement = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: failed.objective,
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      execution_requirements: { coverageFingerprint: taskCoverageFingerprint(failed) },
    });
    store.supersedeTask({
      supersessionId: "TS-1",
      missionId: mission.mission_id,
      failedTaskId: failed.task_id,
      replacementTaskIds: [replacement.task_id],
      repoId: "repo-1",
      acceptanceIds: ["AC-1"],
      coverageFingerprint: taskCoverageFingerprint(failed),
      reason: "repair",
      createdAt: new Date().toISOString(),
    });
    const verdict = new CompletionGate(store).evaluate(store.getMission(mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.match(verdict.reasons.join("; "), /supersession|replacement/i);
  });
});

describe("strict reviewer evidence", () => {
  it("normalizes only the specified severities", () => {
    for (const severity of ["blocker", "critical", "high"] as const)
      assert.equal(normalizeReviewSeverity(severity), "blocking");
    assert.equal(normalizeReviewSeverity("medium"), "major");
    for (const severity of ["low", "info"] as const) assert.equal(normalizeReviewSeverity(severity), "minor");
    assert.throws(() => normalizeReviewSeverity("warning"), /unsupported review severity/i);
  });

  for (const defect of ["malformed", "inaccessible", "request_changes"] as const) {
    it(`fails the review gate for ${defect} reviewer evidence`, () => {
      const fixture = (() => {
        const { store, mission } = currentEvidenceMissionForReview();
        return { store, mission };
      })();
      const review = fixture.store.listReviewEvidence(fixture.mission.mission_id)[0]!;
      const rerun = successfulEvidenceExecution(
        fixture.store,
        fixture.mission.mission_id,
        "review",
        "repo-r",
        "base-r",
      );
      fixture.store.invalidateEvidence({
        invalidationId: `EI-${defect}`,
        missionId: fixture.mission.mission_id,
        identity: review.identity,
        reason: "review replaced",
        invalidatedAt: new Date().toISOString(),
      });
      fixture.store.recordReviewEvidence({
        ...review,
        evidenceId: `RE-${defect}`,
        taskId: rerun.taskId,
        executionId: rerun.executionId,
        ...(defect === "malformed" ? { outputValid: false } : {}),
        ...(defect === "inaccessible" ? { accessible: false } : {}),
        ...(defect === "request_changes" ? { verdict: "request_changes" as const } : {}),
      });
      const verdict = new CompletionGate(fixture.store).evaluate(fixture.store.getMission(fixture.mission.mission_id)!);
      assert.equal(verdict.can_complete, false);
      assert.match(verdict.reasons.join("; "), /review/i);
    });
  }
});

function currentEvidenceMissionForReview() {
  const { store, m } = mission(["validation", "independent_review"]);
  store.addAcceptanceCriterion(m.mission_id, "verified", undefined, "AC-R");
  const manifest = {
    manifestId: "WM-R",
    missionId: m.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "launch_cwd" as const, access: "write" as const }],
    repositories: [
      { repoId: "repo-r", canonicalRoot: "/repo", baseRef: "main", baseSha: "base-r", writableDomains: ["**"] },
    ],
    dependencyEdges: [],
    hash: "manifest-r",
    createdAt: new Date().toISOString(),
  };
  store.bindWorkspaceManifest(manifest);
  const identity = buildCandidateEvidenceIdentity({
    workspaceManifestHash: manifest.hash,
    missionGeneration: 0,
    repoId: "repo-r",
    baseSha: "base-r",
    candidateSha: "candidate-r",
    diffHash: "diff-r",
    acceptanceIds: ["AC-R"],
    artifactHashes: [],
  });
  const identityHash = hashCandidateEvidenceIdentity(identity);
  const validationRun = successfulEvidenceExecution(store, m.mission_id, "validation", "repo-r", "base-r");
  const reviewRun = successfulEvidenceExecution(store, m.mission_id, "review", "repo-r", "base-r");
  store.recordCandidate(m.mission_id, identity, "integration", validationRun);
  store.recordValidationEvidence({
    evidenceId: "VE-R",
    missionId: m.mission_id,
    taskId: validationRun.taskId,
    executionId: validationRun.executionId,
    identity,
    identityHash,
    command: "npm test",
    profile: "default",
    exitCode: 0,
    testSummary: { passed: 1 },
    noTargets: false,
    accessible: true,
    acceptanceResults: [],
    recordedAt: new Date().toISOString(),
  });
  store.recordReviewEvidence({
    evidenceId: "RE-R",
    missionId: m.mission_id,
    taskId: reviewRun.taskId,
    executionId: reviewRun.executionId,
    identity,
    identityHash,
    reviewerSessionId: "session-r",
    model: "model-r",
    provider: "provider-r",
    verdict: "approve",
    independenceMode: "same_model_reduced",
    findings: [],
    outputValid: true,
    accessible: true,
    acceptanceResults: [{ acceptanceId: "AC-R", status: "passed", detail: "reviewed against criterion" }],
    recordedAt: new Date().toISOString(),
  });
  store.setCriterionStatus(m.mission_id, 0, "passed", identityHash);
  return { store, mission: store.getMission(m.mission_id)! };
}
