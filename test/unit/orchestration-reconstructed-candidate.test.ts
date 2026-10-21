/**
 * Unit coverage for the #360 reconstruction primitive:
 * `MissionStore.recordReconstructedCandidate`. It records a Git-verified,
 * checkpoint-traceable candidate WITHOUT requiring a SUCCEEDED authoritative
 * execution (the producing execution failed before publishing).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCandidateEvidenceIdentity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { TaskCheckpoint } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const MANIFEST_HASH = "manifest-360";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pr372-durability-"));
}

function seed() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    mission_id: "MSN-360",
    title: "reconstruction",
    goal: "reconstruction",
    user_request: "reconstruction",
    repository: "/workspace/repo",
    base_ref: "base-360",
    risk_profile: "high",
    workflow_class: "engineering",
  });
  store.bindWorkspaceManifest({
    manifestId: `WM-${mission.mission_id}`,
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/workspace/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-360",
        canonicalRoot: "/workspace/repo",
        baseRef: "base-360",
        baseSha: "base-360",
        writableDomains: ["**"],
      },
    ],
    dependencyEdges: [],
    hash: MANIFEST_HASH,
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  const task = store.createTask({
    task_id: "TSK-360",
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "implement",
    repo_id: "repo-360",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["implement"],
  });
  store.transitionTask("TSK-360", "READY");
  const execution = store.createExecution({
    task_id: "TSK-360",
    mission_id: mission.mission_id,
    backend: "agent",
    repo_id: "repo-360",
    base_sha: "base-360",
  });
  store.transitionTask("TSK-360", "RUNNING", "system", { assigned_execution_id: execution.execution_id });
  store.setExecutionStatus(execution.execution_id, "RUNNING");
  // The producing execution FAILED before publishing — no SUCCEEDED execution exists.
  store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "failed" });
  store.transitionTask("TSK-360", "FAILED", "system", { failure_reason: "agent.loop_prevented" });

  const checkpoint: TaskCheckpoint = {
    checkpointId: "TCP-360",
    executionId: execution.execution_id,
    missionId: mission.mission_id,
    taskId: "TSK-360",
    repoId: "repo-360",
    baseSha: "base-360",
    candidateSha: "preserved-360",
    branch: "pi-eng-orch-TSK-360",
    worktree: null,
    committedChanges: ["preserved-360"],
    preservedUncommittedChanges: [],
    completedDeliverables: ["implement"],
    remainingDeliverables: [],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: null,
    sessionId: null,
    model: null,
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T00:00:01.000Z",
  };
  store.checkpointTask(checkpoint);
  return { store, missionId: mission.mission_id };
}

function identity(candidateSha: string) {
  return buildCandidateEvidenceIdentity({
    workspaceManifestHash: MANIFEST_HASH,
    missionGeneration: 0,
    repoId: "repo-360",
    baseSha: "base-360",
    candidateSha,
    diffHash: `sha256:${"1".repeat(64)}`,
    acceptanceIds: [],
    artifactHashes: [],
  });
}

describe("recordReconstructedCandidate (#360)", () => {
  it("records a Git-verified, checkpoint-traceable candidate without a SUCCEEDED execution", () => {
    const { store, missionId } = seed();
    const candidate = store.recordReconstructedCandidate(
      missionId,
      identity("preserved-360"),
      { checkpointId: "TCP-360", branch: "pi-eng-orch-TSK-360" },
      "reconstruct from preserved work",
    );
    assert.equal(candidate.identity.candidateSha, "preserved-360");
    assert.equal(candidate.reconstructedFrom?.checkpointId, "TCP-360");
    assert.equal(candidate.reconstructedFrom?.branch, "pi-eng-orch-TSK-360");
    assert.equal(candidate.reconstructedFrom?.candidateSha, "preserved-360");
    // The checkpoint's (FAILED) execution is the origin, not a SUCCEEDED one.
    assert.equal(candidate.executionId, store.getTaskCheckpoint("TCP-360")!.executionId);
    // Readable back and stable.
    const read = store.getCandidate(missionId);
    assert.ok(read);
    assert.equal(read!.identityHash, candidate.identityHash);
    assert.ok(read!.reconstructedFrom);
  });

  it("deep-copies the reconstructedFrom provenance on read", () => {
    const { store, missionId } = seed();
    const recorded = store.recordReconstructedCandidate(missionId, identity("preserved-360"), {
      checkpointId: "TCP-360",
      branch: null,
    });
    const read = store.getCandidate(missionId)!;
    read.reconstructedFrom!.candidateSha = "tampered";
    assert.notEqual(recorded.reconstructedFrom!.candidateSha, "tampered", "the stored copy is not aliased");
  });

  it("rejects a candidate identity whose sha does not match the source checkpoint", () => {
    const { store, missionId } = seed();
    assert.throws(
      () => store.recordReconstructedCandidate(missionId, identity("other-sha"), { checkpointId: "TCP-360", branch: null }),
      /does not match/,
    );
  });

  it("rejects an unknown source checkpoint", () => {
    const { store, missionId } = seed();
    assert.throws(
      () => store.recordReconstructedCandidate(missionId, identity("preserved-360"), { checkpointId: "TCP-nope", branch: null }),
      /checkpoint not found/,
    );
  });

  it("a later reconstruction from a different checkpoint supersedes the prior candidate", () => {
    const { store, missionId } = seed();
    // A second preserved checkpoint at a different sha (a later worker commit).
    const laterCheckpoint = store.getTaskCheckpoint("TCP-360")!;
    store.checkpointTask({
      ...laterCheckpoint,
      checkpointId: "TCP-360b",
      candidateSha: "preserved-360b",
      committedChanges: ["preserved-360b"],
      sequence: 2,
    });
    const prior = store.recordReconstructedCandidate(missionId, identity("preserved-360"), {
      checkpointId: "TCP-360",
      branch: null,
    });
    const next = store.recordReconstructedCandidate(missionId, identity("preserved-360b"), {
      checkpointId: "TCP-360b",
      branch: null,
    });
    assert.notEqual(prior.identityHash, next.identityHash);
    assert.equal(store.getCandidate(missionId)!.identityHash, next.identityHash);
    assert.equal(store.getCandidate(missionId)!.reconstructedFrom?.checkpointId, "TCP-360b");
  });
});

describe("reconstructed candidate durability (#372)", () => {
  it("survives a close/reopen of a real JSONL backend with reconstructedFrom provenance intact", async () => {
    const dir = tempDir();
    const eventFile = path.join(dir, "events.jsonl");
    try {
      const first = await JsonlEventStore.open(eventFile);
      const store = MissionStore.open(first);
      const mission = store.createMission({
        mission_id: "MSN-372",
        title: "durable reconstruction",
        goal: "durable reconstruction",
        user_request: "durable reconstruction",
        repository: "/workspace/repo",
        base_ref: "base-372",
        risk_profile: "high",
        workflow_class: "engineering",
      });
      store.bindWorkspaceManifest({
        manifestId: `WM-${mission.mission_id}`,
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [{ canonicalPath: "/workspace/repo", source: "existing_manifest", access: "write" }],
        repositories: [
          {
            repoId: "repo-372",
            canonicalRoot: "/workspace/repo",
            baseRef: "base-372",
            baseSha: "base-372",
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: MANIFEST_HASH,
        createdAt: "2026-09-27T00:00:00.000Z",
      });
      const task = store.createTask({
        task_id: "TSK-372",
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "implement",
        repo_id: "repo-372",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
        deliverables: ["implement"],
      });
      store.transitionTask("TSK-372", "READY");
      const execution = store.createExecution({
        task_id: "TSK-372",
        mission_id: mission.mission_id,
        backend: "agent",
        repo_id: "repo-372",
        base_sha: "base-372",
      });
      store.transitionTask("TSK-372", "RUNNING", "system", { assigned_execution_id: execution.execution_id });
      store.setExecutionStatus(execution.execution_id, "RUNNING");
      // The producing execution FAILED before publishing — the #360 premise.
      store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "failed" });
      store.transitionTask("TSK-372", "FAILED", "system", { failure_reason: "agent.loop_prevented" });
      const checkpoint: TaskCheckpoint = {
        checkpointId: "TCP-372",
        executionId: execution.execution_id,
        missionId: mission.mission_id,
        taskId: "TSK-372",
        repoId: "repo-372",
        baseSha: "base-372",
        candidateSha: "preserved-372",
        branch: "pi-eng-orch-TSK-372",
        worktree: null,
        committedChanges: ["preserved-372"],
        preservedUncommittedChanges: [],
        completedDeliverables: ["implement"],
        remainingDeliverables: [],
        acceptanceIds: [],
        validationEvidenceRefs: [],
        artifactRefs: [],
        artifactHashes: [],
        workerId: null,
        sessionId: null,
        model: null,
        sequence: 1,
        missionGeneration: 0,
        candidateGeneration: 0,
        fencingToken: 0,
        createdAt: "2026-09-27T00:00:01.000Z",
      };
      store.checkpointTask(checkpoint);
      const recorded = store.recordReconstructedCandidate(
        mission.mission_id,
        identity372("preserved-372"),
        { checkpointId: "TCP-372", branch: "pi-eng-orch-TSK-372" },
        "reconstruct from preserved work",
      );
      // Drain pending event writes, close the durable backend (releases the
      // file lock), then reopen from the same file to replay. Without the #372
      // replay fix, the reconstructed candidate is quarantined on replay (its
      // source execution is FAILED, not SUCCEEDED) and absent here.
      await store.flush();
      first.close();
      const reopenedBackend = await JsonlEventStore.open(eventFile);
      const reopened = MissionStore.open(reopenedBackend);
      try {
        const candidate = reopened.getCandidate(mission.mission_id);
        assert.ok(candidate, "the reconstructed candidate survives reopen");
        assert.equal(candidate!.identity.candidateSha, "preserved-372");
        assert.equal(candidate!.identityHash, recorded.identityHash);
        assert.ok(candidate!.reconstructedFrom, "reconstructedFrom provenance survives replay");
        assert.equal(candidate!.reconstructedFrom!.checkpointId, "TCP-372");
        assert.equal(candidate!.reconstructedFrom!.candidateSha, "preserved-372");
        assert.equal(candidate!.reconstructedFrom!.branch, "pi-eng-orch-TSK-372");
      } finally {
        reopenedBackend.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function identity372(candidateSha: string) {
  return buildCandidateEvidenceIdentity({
    workspaceManifestHash: MANIFEST_HASH,
    missionGeneration: 0,
    repoId: "repo-372",
    baseSha: "base-372",
    candidateSha,
    diffHash: `sha256:${"1".repeat(64)}`,
    acceptanceIds: [],
    artifactHashes: [],
  });
}
