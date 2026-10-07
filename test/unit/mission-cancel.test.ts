import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cancelStaleMission, listMissions } from "../../src/orchestration/missionCancel.ts";
import { runMissionsCommand } from "../../src/orchestration/missionCancelCli.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function createBlocked(store: MissionStore, missionId: string, repoId: string | null): void {
  store.createMission({
    mission_id: missionId,
    title: `mission ${missionId}`,
    goal: "g",
    user_request: "g",
    repository: "/repo",
    base_ref: "base",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  if (repoId) {
    store.bindWorkspaceManifest({
      manifestId: `WM-${missionId}`,
      missionId,
      generation: 1,
      authorizedRoots: [{ canonicalPath: "/repo", source: "launch_cwd", access: "write" }],
      repositories: [{ repoId, canonicalRoot: "/repo", baseRef: "base", baseSha: "base", writableDomains: ["**"] }],
      dependencyEdges: [],
      hash: `manifest-${missionId}`,
      createdAt: "2026-10-07T00:00:00.000Z",
    });
  }
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(missionId, status);
  }
  store.transitionMission(missionId, "BLOCKED");
}

function addOpenWork(store: MissionStore, missionId: string): { taskId: string; recoveryId: string } {
  const task = store.createTask({
    task_id: `TSK-${missionId}`,
    mission_id: missionId,
    kind: "integration",
    role: "integrator",
    objective: "merge",
  });
  store.transitionTask(task.task_id, "READY");
  store.classifyFailure({
    classificationId: `FC-${missionId}`,
    missionId,
    taskId: task.task_id,
    executionId: null,
    category: "REVIEW_FAILED",
    evidenceRefs: [],
    fingerprint: `sha256:${missionId}`,
    summary: "checks: fail",
    classifiedAt: "2026-10-07T00:00:00.000Z",
  });
  const decision = store.planRecovery({
    recoveryId: `RCV-${missionId}`,
    missionId,
    classificationId: `FC-${missionId}`,
    action: "CREATE_REPAIR_TASKS",
    expectedMaterialChange: "repair",
    attempt: 1,
    maxAttempts: 2,
    deadline: "2026-10-07T00:30:00.000Z",
    nextActionAt: "2026-10-07T00:00:00.000Z",
    status: "planned",
    decidedAt: "2026-10-07T00:00:00.000Z",
  });
  store.transitionRecovery(decision.recoveryId, "started");
  return { taskId: task.task_id, recoveryId: decision.recoveryId };
}

describe("offline stale-mission cancellation", () => {
  it("lists, dry-runs and cancels exactly the selected non-terminal missions of one repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-cancel-"));
    try {
      const file = join(dir, "orchestration.jsonl");
      const backend = await JsonlEventStore.open(file);
      const store = MissionStore.open(backend);
      createBlocked(store, "MSN-old", "repo-x");
      await new Promise((done) => setTimeout(done, 5));
      const cutoff = new Date().toISOString();
      await new Promise((done) => setTimeout(done, 5));
      createBlocked(store, "MSN-target", "repo-x");
      const work = addOpenWork(store, "MSN-target");
      createBlocked(store, "MSN-other-repo", "repo-y");
      createBlocked(store, "MSN-unbound", null);
      createBlocked(store, "MSN-terminal", "repo-x");
      store.transitionMission("MSN-terminal", "FAILED");
      await store.flush();

      // The store is single-writer: the CLI refuses while another owner has it open.
      const refused: string[] = [];
      assert.equal(
        await runMissionsCommand(["list", "--store", dir], { write: () => {}, error: (text) => refused.push(text) }),
        3,
      );
      assert.match(refused.join(""), /cannot open/);
      backend.close();

      const out: string[] = [];
      const io = { write: (text: string) => out.push(text), error: (text: string) => out.push(text) };
      const filters = ["--store", dir, "--repo-id", "repo-x", "--created-after", cutoff, "--json"];
      assert.equal(await runMissionsCommand(["list", ...filters], io), 0);
      assert.deepEqual(
        JSON.parse(out.pop()!).map((row: { missionId: string }) => row.missionId),
        ["MSN-target"],
      );

      assert.equal(await runMissionsCommand(["cancel", ...filters], io), 0);
      const dry = JSON.parse(out.pop()!);
      assert.equal(dry.dryRun, true);
      assert.deepEqual(
        dry.missions.map((row: { missionId: string }) => row.missionId),
        ["MSN-target"],
      );

      assert.equal(await runMissionsCommand(["cancel", ...filters, "--yes"], io), 0);
      const applied = JSON.parse(out.pop()!);
      assert.equal(applied.canceled.length, 1);
      assert.equal(applied.canceled[0].missionId, "MSN-target");
      assert.equal(applied.canceled[0].fromStatus, "BLOCKED");

      const reopenedBackend = await JsonlEventStore.open(file);
      try {
        const reopened = MissionStore.open(reopenedBackend);
        assert.equal(reopened.getMission("MSN-target")!.status, "CANCELED");
        assert.equal(reopened.getTask(work.taskId)!.status, "CANCELED");
        assert.equal(reopened.getRecoveryDecision(work.recoveryId)!.status, "failed");
        assert.equal(reopened.getMission("MSN-old")!.status, "BLOCKED");
        assert.equal(reopened.getMission("MSN-other-repo")!.status, "BLOCKED");
        assert.equal(reopened.getMission("MSN-unbound")!.status, "BLOCKED");
        assert.equal(reopened.getMission("MSN-terminal")!.status, "FAILED");
        assert.deepEqual(
          listMissions(reopened, { repoId: "repo-x", createdAfter: cutoff }).map((row) => row.missionId),
          [],
        );
      } finally {
        reopenedBackend.close();
      }

      // An explicit id outside the filters (or terminal) is refused, not silently skipped.
      assert.equal(await runMissionsCommand(["cancel", "--store", dir, "--mission", "MSN-terminal", "--yes"], io), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a mission whose controller lease is still live", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    createBlocked(store, "MSN-owned", "repo-x");
    store.transitionMissionLease("acquired", {
      missionId: "MSN-owned",
      generation: 1,
      ownerId: "runtime-live",
      acquiredAt: "2026-10-07T00:00:00.000Z",
      renewBy: "2026-10-07T00:00:30.000Z",
      fencingToken: 1,
    });
    assert.throws(
      () => cancelStaleMission(store, "MSN-owned", { now: Date.parse("2026-10-07T00:00:10.000Z") }),
      /live controller lease/,
    );
    assert.equal(store.getMission("MSN-owned")!.status, "BLOCKED");
    assert.equal(
      cancelStaleMission(store, "MSN-owned", { now: Date.parse("2026-10-07T00:01:00.000Z") }).status,
      "CANCELED",
    );
  });
});
