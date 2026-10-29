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

  async appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    if (!this.available) throw new Error("checkpoint persistence unavailable");
    return this.inner.appendConditionally(event, condition, onCommit);
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

class BlockingBackend implements EventStoreBackend {
  readonly inner = JsonlEventStore.inMemory();
  private blockNextAppend = false;
  private releaseBlocked!: () => void;
  private appendStarted!: () => void;
  private readonly blocked = new Promise<void>((resolve) => {
    this.releaseBlocked = resolve;
  });
  readonly started = new Promise<void>((resolve) => {
    this.appendStarted = resolve;
  });

  blockNext(): void {
    this.blockNextAppend = true;
  }

  release(): void {
    this.releaseBlocked();
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    if (this.blockNextAppend) {
      this.blockNextAppend = false;
      this.appendStarted();
      await this.blocked;
    }
    return this.inner.append(event);
  }

  async appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    if (this.blockNextAppend) {
      this.blockNextAppend = false;
      this.appendStarted();
      await this.blocked;
    }
    return this.inner.appendConditionally(event, condition, onCommit);
  }

  async appendAll(events: StoredEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
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

  it("publishes no stale checkpoint when its own append is blocked during authority takeover", async () => {
    const backend = new BlockingBackend();
    const { store, mission, task, execution } = setup(backend);
    const manager = new CheckpointManager({ store });
    await manager.persist({
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
    const durableBefore = backend.all().filter((event) => event.type === "task.checkpointed").length;
    backend.blockNext();
    const late = manager.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      snapshot: {
        candidateSha: "candidate-late",
        branch: "mission/task-a",
        worktree: "/worktree/task-a",
        committedChanges: ["src/late.ts"],
        preservedUncommittedChanges: [],
      },
    });
    await backend.started;
    store.assignTaskAuthority(task.task_id, {
      missionId: mission.mission_id,
      generation: 4,
      ownerId: "takeover",
      acquiredAt: "2026-09-26T10:02:00.000Z",
      renewBy: "2026-09-26T10:03:00.000Z",
      fencingToken: 6,
    });
    backend.release();

    await assert.rejects(late, /origin mismatch|stale execution identity/i);
    assert.equal(store.getTaskCheckpoint("TCP-origin")?.candidateSha, "candidate-before");
    assert.equal(backend.all().filter((event) => event.type === "task.checkpointed").length, durableBefore);
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

describe("CheckpointManager handoff context", () => {
  const sha = "b".repeat(64);

  it("carries next action, decisions, unresolved issues, test outcomes, memory refs and untracked hashes", async () => {
    const { store, task, execution } = setup();
    const checkpoint = await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      handoff: {
        nextAction: "run the integration suite",
        decisions: [{ id: "D1", summary: "use a private scope", rationale: "artifact ACLs govern readers" }],
        unresolvedIssues: ["flaky port race in test X"],
        tests: [
          { ref: "unit", outcome: "passed" },
          { ref: "e2e", outcome: "failed" },
        ],
        memoryRefs: ["viking://project/notes/1"],
        untracked: [{ path: "scratch/plot.py", sha256: sha }],
      },
    });
    assert.equal(checkpoint.handoff?.nextAction, "run the integration suite");
    assert.deepEqual(
      checkpoint.handoff?.tests.map((t) => `${t.ref}:${t.outcome}`),
      ["unit:passed", "e2e:failed"],
    );
    assert.equal(store.listTaskCheckpoints(execution.mission_id, task.task_id).at(-1)?.handoff?.decisions[0]?.id, "D1");
  });

  it("merges across checkpoints: decisions accumulate, tests keep the latest outcome per ref", async () => {
    const { store, task, execution } = setup();
    const mgr = new CheckpointManager({ store });
    await mgr.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      handoff: {
        decisions: [{ id: "D1", summary: "a", rationale: "r" }],
        tests: [{ ref: "e2e", outcome: "failed" }],
      },
    });
    const second = await mgr.persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      handoff: {
        decisions: [{ id: "D2", summary: "b", rationale: "r" }],
        tests: [{ ref: "e2e", outcome: "passed" }],
        nextAction: "open the PR",
      },
    });
    assert.deepEqual(
      second.handoff?.decisions.map((d) => d.id),
      ["D1", "D2"],
    );
    assert.deepEqual(second.handoff?.tests, [{ ref: "e2e", outcome: "passed" }]);
    assert.equal(second.handoff?.nextAction, "open the PR");
  });

  it("a checkpoint with no handoff input has no handoff block", async () => {
    const { store, task, execution } = setup();
    const checkpoint = await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
    });
    assert.equal(checkpoint.handoff, undefined);
  });

  it("rejects malformed or unbounded handoff context instead of storing it", async () => {
    const { store, task, execution } = setup();
    const mgr = new CheckpointManager({ store });
    const base = { taskId: task.task_id, executionId: execution.execution_id };
    await assert.rejects(
      mgr.persist({ ...base, handoff: { tests: [{ ref: "u", outcome: "great" as never }] } }),
      /outcome/,
    );
    await assert.rejects(mgr.persist({ ...base, handoff: { untracked: [{ path: "a", sha256: "nothex" }] } }), /sha256/);
    await assert.rejects(mgr.persist({ ...base, handoff: { nextAction: "x".repeat(2001) } }), /nextAction/);
    await assert.rejects(
      mgr.persist({
        ...base,
        handoff: { decisions: Array.from({ length: 51 }, (_, i) => ({ id: `D${i}`, summary: "s", rationale: "r" })) },
      }),
      /decisions/,
    );
  });

  it("the stored checkpoint is a copy: mutating the returned handoff does not alter the store", async () => {
    const { store, task, execution } = setup();
    const checkpoint = await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      handoff: { memoryRefs: ["viking://a"] },
    });
    checkpoint.handoff?.memoryRefs.push("viking://tampered");
    const again = store.listTaskCheckpoints(execution.mission_id, task.task_id).at(-1);
    assert.deepEqual(again?.handoff?.memoryRefs, ["viking://a"]);
  });
});

describe("CheckpointManager handoff context bounds", () => {
  it("never makes a checkpoint fail because history is long: oldest entries are evicted at the cap", async () => {
    const { store, task, execution } = setup();
    const mgr = new CheckpointManager({ store });
    let last = await mgr.persist({ taskId: task.task_id, executionId: execution.execution_id });
    for (let i = 0; i < 52; i++) {
      last = await mgr.persist({
        taskId: task.task_id,
        executionId: execution.execution_id,
        handoff: { memoryRefs: [`viking://m/${i}`], decisions: [{ id: `D${i}`, summary: "s", rationale: "r" }] },
      });
    }
    assert.equal(last.handoff?.memoryRefs.length, 50);
    assert.equal(last.handoff?.memoryRefs[0], "viking://m/2");
    assert.equal(last.handoff?.memoryRefs.at(-1), "viking://m/51");
    assert.equal(last.handoff?.decisions.length, 50);
    assert.equal(last.handoff?.decisions.at(-1)?.id, "D51");
  });

  it("untracked files describe the worktree now: a new list replaces the old one", async () => {
    const { store, task, execution } = setup();
    const mgr = new CheckpointManager({ store });
    const base = { taskId: task.task_id, executionId: execution.execution_id };
    await mgr.persist({ ...base, handoff: { untracked: [{ path: "a.txt", sha256: "c".repeat(64) }] } });
    const next = await mgr.persist({ ...base, handoff: { untracked: [{ path: "b.txt", sha256: "d".repeat(64) }] } });
    assert.deepEqual(
      next.handoff?.untracked.map((u) => u.path),
      ["b.txt"],
    );
    const kept = await mgr.persist({ ...base, handoff: { nextAction: "go" } });
    assert.deepEqual(
      kept.handoff?.untracked.map((u) => u.path),
      ["b.txt"],
      "omitted means unchanged",
    );
  });

  it("a null entry is a validation error, not a TypeError", async () => {
    const { store, task, execution } = setup();
    const mgr = new CheckpointManager({ store });
    await assert.rejects(
      mgr.persist({
        taskId: task.task_id,
        executionId: execution.execution_id,
        handoff: { decisions: [null as never] },
      }),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /decision/.test(error.message),
    );
  });
});
