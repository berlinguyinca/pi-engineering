import { id } from "../core/ids.ts";
import type { MissionStore } from "./missionStore.ts";
import type { TaskCheckpoint } from "./types.ts";

export interface CheckpointSnapshot {
  candidateSha: string | null;
  branch: string | null;
  worktree: string | null;
  committedChanges: string[];
  preservedUncommittedChanges: string[];
}

export interface CheckpointPersistInput {
  taskId: string;
  checkpointId?: string;
  completedDeliverables?: string[];
  artifactRefs?: string[];
  artifactHashes?: string[];
  validationEvidenceRefs?: string[];
  workerId?: string | null;
  sessionId?: string | null;
  model?: string | null;
  snapshot?: CheckpointSnapshot;
}

export interface ReconciledCheckpoint {
  checkpoint: TaskCheckpoint;
  completedDeliverables: string[];
  remainingDeliverables: string[];
}

export interface CheckpointManagerOptions {
  store: MissionStore;
  snapshot?: (taskId: string) => Promise<CheckpointSnapshot>;
  now?: () => Date;
}

const EMPTY_SNAPSHOT: CheckpointSnapshot = {
  candidateSha: null,
  branch: null,
  worktree: null,
  committedChanges: [],
  preservedUncommittedChanges: [],
};

/** Persists recoverable work only. It never changes task or acceptance status. */
export class CheckpointManager {
  private readonly store: MissionStore;
  private readonly snapshot?: CheckpointManagerOptions["snapshot"];
  private readonly now: () => Date;

  constructor(opts: CheckpointManagerOptions) {
    this.store = opts.store;
    this.snapshot = opts.snapshot;
    this.now = opts.now ?? (() => new Date());
  }

  async persist(input: CheckpointPersistInput): Promise<TaskCheckpoint> {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new Error(`unknown task ${input.taskId}`);
    if (!task.repo_id) throw new Error(`checkpoint requires repository binding for task ${input.taskId}`);
    const manifest = this.store.getWorkspaceManifest(task.mission_id);
    const repository = manifest?.repositories.find((candidate) => candidate.repoId === task.repo_id);
    if (manifest && !repository) throw new Error(`unknown repository binding ${task.repo_id}`);
    const previous = this.latest(task.task_id, input.checkpointId);
    const checkpointId = input.checkpointId ?? previous?.checkpointId ?? id("TCP");
    const snapshot = input.snapshot ?? (await this.snapshot?.(task.task_id)) ?? EMPTY_SNAPSHOT;
    const declared = task.deliverables ?? [];
    const completed = dedupe([
      ...(previous?.completedDeliverables ?? []),
      ...(input.completedDeliverables ?? []),
    ]).filter((deliverable) => declared.includes(deliverable));
    const completedSet = new Set(completed);
    const checkpoint: TaskCheckpoint = {
      checkpointId,
      missionId: task.mission_id,
      taskId: task.task_id,
      repoId: task.repo_id,
      baseSha: repository?.baseSha ?? this.store.getMission(task.mission_id)?.base_ref ?? "",
      candidateSha: snapshot.candidateSha,
      branch: snapshot.branch,
      worktree: snapshot.worktree,
      committedChanges: dedupe(snapshot.committedChanges),
      preservedUncommittedChanges: dedupe(snapshot.preservedUncommittedChanges),
      completedDeliverables: completed,
      remainingDeliverables: declared.filter((deliverable) => !completedSet.has(deliverable)),
      acceptanceIds: [...(task.acceptance_ids ?? [])],
      validationEvidenceRefs: dedupe([
        ...(previous?.validationEvidenceRefs ?? []),
        ...(input.validationEvidenceRefs ?? []),
      ]),
      artifactRefs: dedupe([...(previous?.artifactRefs ?? []), ...(input.artifactRefs ?? [])]),
      artifactHashes: dedupe([...(previous?.artifactHashes ?? []), ...(input.artifactHashes ?? [])]),
      workerId: input.workerId ?? previous?.workerId ?? null,
      sessionId: input.sessionId ?? previous?.sessionId ?? null,
      model: input.model ?? previous?.model ?? null,
      sequence: (previous?.sequence ?? 0) + 1,
      missionGeneration: task.mission_generation ?? 0,
      candidateGeneration: task.candidate_generation ?? 0,
      fencingToken: task.fencing_token ?? 0,
      createdAt: this.now().toISOString(),
    };
    return this.store.checkpointTask(checkpoint);
  }

  reconcile(taskId: string): ReconciledCheckpoint | null {
    const checkpoint = this.latest(taskId);
    if (!checkpoint) return null;
    return {
      checkpoint,
      completedDeliverables: [...checkpoint.completedDeliverables],
      remainingDeliverables: [...checkpoint.remainingDeliverables],
    };
  }

  private latest(taskId: string, checkpointId?: string): TaskCheckpoint | undefined {
    return this.store
      .listTaskCheckpoints(undefined, taskId)
      .filter((checkpoint) => (checkpointId ? checkpoint.checkpointId === checkpointId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence)[0];
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
