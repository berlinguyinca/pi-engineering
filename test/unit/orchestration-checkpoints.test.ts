import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { MissionLease, WorkspaceManifest } from "../../src/orchestration/types.ts";
import type { EventStoreBackend, StoredEvent } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

class ToggleBackend implements EventStoreBackend {
  readonly inner = JsonlEventStore.inMemory();
  available = true;

  async append(event: StoredEvent): Promise<StoredEvent> {
    if (!this.available) throw new Error("checkpoint persistence unavailable");
    return this.inner.append(event);
  }

  async appendAll(events: StoredEvent[]): Promise<void> {
    if (!this.available) throw new Error("checkpoint persistence unavailable");
    return this.inner.appendAll(events);
  }

  all(): StoredEvent[] {
    return this.inner.all();
  }

  get(eventId: string): StoredEvent | undefined {
    return this.inner.get(eventId);
  }

  count(): number {
    return this.inner.count();
  }
}

function manifest(missionId: string, baseSha = "base-a"): WorkspaceManifest {
  return {
    manifestId: `WM-${baseSha}`,
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-a",
        canonicalRoot: "/repo",
        baseRef: "main",
        baseSha,
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: `hash-${baseSha}`,
    createdAt: "2026-09-26T10:00:00.000Z",
  };
}

function setup(backend: EventStoreBackend = JsonlEventStore.inMemory()) {
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    mission_id: "MSN-checkpoint-origin",
    title: "checkpoint",
    goal: "checkpoint",
    user_request: "checkpoint",
    repository: "/repo",
    base_ref: "base-a",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest(manifest(mission.mission_id));
  const task = store.createTask({
    task_id: "task-a",
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "implement",
    repo_id: "repo-a",
    acceptance_ids: ["AC-1"],
    deliverables: ["implementation"],
    execution_budget_ms: 60_000,
    checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
    candidate_generation: 2,
    mission_generation: 3,
    fencing_token: 5,
  });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    checkpoint_id: "TCP-origin",
    repo_id: "repo-a",
    base_sha: "base-a",
    candidate_generation: 2,
    mission_generation: 3,
    fencing_token: 5,
  });
  store.setExecutionStatus(execution.execution_id, "RUNNING", {});
  return { store, mission, task, execution };
}

describe("CheckpointManager durability and immutable origin", () => {
  it("rejects when the checkpoint event cannot be durably appended", async () => {
    const backend = new ToggleBackend();
    const { store, task, execution } = setup(backend);
    await store.flush();
    backend.available = false;

    await assert.rejects(
      new CheckpointManager({ store }).persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /checkpoint persistence unavailable/,
    );
    assert.equal(
      backend.all().some((event) => event.type === "task.checkpointed"),
      false,
      "a rejected persist must not exist in durable history",
    );
  });

  it("rejects a checkpoint after the workspace base is rebound", async () => {
    const { store, mission, task, execution } = setup();
    store.bindWorkspaceManifest(manifest(mission.mission_id, "base-b"));

    await assert.rejects(
      new CheckpointManager({ store }).persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /checkpoint origin mismatch.*base/i,
    );
  });

  it("rejects a checkpoint after task authority is replaced", async () => {
    const { store, mission, task, execution } = setup();
    const takeover: MissionLease = {
      missionId: mission.mission_id,
      generation: 4,
      ownerId: "new-owner",
      acquiredAt: "2026-09-26T10:01:00.000Z",
      renewBy: "2026-09-26T10:02:00.000Z",
      fencingToken: 6,
    };
    store.assignTaskAuthority(task.task_id, takeover);

    await assert.rejects(
      new CheckpointManager({ store }).persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /checkpoint origin mismatch.*generation|fencing/i,
    );
  });

  it("rejects a workspace rebind that races snapshot collection", async () => {
    const { store, mission, task, execution } = setup();
    const manager = new CheckpointManager({
      store,
      snapshot: async () => {
        store.bindWorkspaceManifest(manifest(mission.mission_id, "base-b"));
        return {
          candidateSha: "candidate-a",
          branch: "mission/task-a",
          worktree: "/worktree/task-a",
          committedChanges: ["src/committed.ts"],
          preservedUncommittedChanges: [],
        };
      },
    });

    await assert.rejects(
      manager.persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /checkpoint origin mismatch.*base/i,
    );
  });

  it("rejects an authority takeover that races snapshot collection", async () => {
    const { store, mission, task, execution } = setup();
    const manager = new CheckpointManager({
      store,
      snapshot: async () => {
        store.assignTaskAuthority(task.task_id, {
          missionId: mission.mission_id,
          generation: 4,
          ownerId: "new-owner",
          acquiredAt: "2026-09-26T10:01:00.000Z",
          renewBy: "2026-09-26T10:02:00.000Z",
          fencingToken: 6,
        });
        return {
          candidateSha: "candidate-a",
          branch: "mission/task-a",
          worktree: "/worktree/task-a",
          committedChanges: ["src/committed.ts"],
          preservedUncommittedChanges: [],
        };
      },
    });

    await assert.rejects(
      manager.persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /checkpoint origin mismatch.*generation|fencing/i,
    );
  });

  it("rejects a checkpoint that finishes snapshot collection after execution terminalization", async () => {
    const backend = JsonlEventStore.inMemory();
    const { store, mission, task, execution } = setup(backend);
    const first = new CheckpointManager({ store });
    await first.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      snapshot: {
        candidateSha: "candidate-before",
        branch: "mission/task-a",
        worktree: "/worktree/task-a",
        committedChanges: ["src/before.ts"],
        preservedUncommittedChanges: [],
      },
    });
    let releaseSnapshot!: () => void;
    const snapshotBlocked = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const late = new CheckpointManager({
      store,
      snapshot: async () => {
        await snapshotBlocked;
        return {
          candidateSha: "candidate-late",
          branch: "mission/task-a",
          worktree: "/worktree/task-a",
          committedChanges: ["src/late.ts"],
          preservedUncommittedChanges: [],
        };
      },
    });

    const attempted = late.persist({ taskId: task.task_id, executionId: execution.execution_id });
    store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
    releaseSnapshot();

    await assert.rejects(attempted, /no longer authoritative|checkpoint origin mismatch/i);
    assert.equal(store.getTaskCheckpoint("TCP-origin")?.candidateSha, "candidate-before");
    await store.flush();
    const event = backend
      .all()
      .reverse()
      .find((candidate) => candidate.type === "execution.late_result_rejected");
    assert.equal((event?.payload.evidence as { kind?: string } | undefined)?.kind, "checkpoint");
    assert.equal(store.listFindings(mission.mission_id).length, 0);
  });

  it("does not replace useful preserved work with an unavailable empty snapshot", async () => {
    const { store, task, execution } = setup();
    const manager = new CheckpointManager({ store });
    await manager.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      snapshot: {
        candidateSha: "candidate-a",
        branch: "mission/task-a",
        worktree: "/worktree/task-a",
        committedChanges: ["src/committed.ts"],
        preservedUncommittedChanges: ["src/dirty.ts"],
      },
    });
    const preserved = await manager.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      snapshot: {
        candidateSha: null,
        branch: null,
        worktree: null,
        committedChanges: [],
        preservedUncommittedChanges: [],
      },
    });

    assert.equal(preserved.executionId, execution.execution_id);
    assert.equal(preserved.candidateSha, "candidate-a");
    assert.deepEqual(preserved.committedChanges, ["src/committed.ts"]);
    assert.deepEqual(preserved.preservedUncommittedChanges, ["src/dirty.ts"]);
  });
});
