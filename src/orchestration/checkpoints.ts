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
  executionId: string;
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

/**
 * Select one current checkpoint per task. Input order is the durable last-event
 * ordinal exposed by MissionStore, and breaks ties between equal timestamps.
 */
export function latestTaskCheckpoints(checkpoints: readonly TaskCheckpoint[]): TaskCheckpoint[] {
  const latestByTask = new Map<string, { checkpoint: TaskCheckpoint; durableEventOrdinal: number }>();
  for (const [durableEventOrdinal, checkpoint] of checkpoints.entries()) {
    const current = latestByTask.get(checkpoint.taskId);
    if (
      !current ||
      checkpointSupersedes(checkpoint, durableEventOrdinal, current.checkpoint, current.durableEventOrdinal)
    ) {
      latestByTask.set(checkpoint.taskId, { checkpoint, durableEventOrdinal });
    }
  }
  return [...latestByTask.values()].map(({ checkpoint }) => checkpoint);
}

function checkpointSupersedes(
  candidate: TaskCheckpoint,
  candidateEventOrdinal: number,
  current: TaskCheckpoint,
  currentEventOrdinal: number,
): boolean {
  if (candidate.checkpointId === current.checkpointId && candidate.sequence !== current.sequence) {
    return candidate.sequence > current.sequence;
  }
  const chronology = candidate.createdAt.localeCompare(current.createdAt);
  return chronology > 0 || (chronology === 0 && candidateEventOrdinal > currentEventOrdinal);
}

function mergeArtifactEvidence(...sources: Array<{ refs: readonly string[]; hashes: readonly string[] }>): {
  refs: string[];
  hashes: string[];
} {
  const byRef = new Map<string, string>();
  for (const source of sources) {
    if (source.refs.length !== source.hashes.length) {
      throw new Error("checkpoint artifact references and content hashes must be aligned");
    }
    for (const [index, ref] of source.refs.entries()) {
      const hash = source.hashes[index]!;
      const prior = byRef.get(ref);
      if (prior && prior !== hash) throw new Error(`checkpoint artifact content changed for ${ref}`);
      byRef.set(ref, hash);
    }
  }
  return { refs: [...byRef.keys()], hashes: [...byRef.values()] };
}

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
    const execution = this.store.getExecution(input.executionId);
    const originatingTask = this.store.getTask(input.taskId);
    if (
      !originatingTask ||
      !execution ||
      execution.task_id !== originatingTask.task_id ||
      execution.mission_id !== originatingTask.mission_id
    ) {
      throw new Error(`checkpoint origin mismatch: execution ${input.executionId} does not own task ${input.taskId}`);
    }
    if (!execution.checkpoint_id || !execution.repo_id || !execution.base_sha) {
      throw new Error(`checkpoint origin mismatch: execution ${input.executionId} lacks repository/base identity`);
    }
    const assertCurrentOrigin = () => {
      this.store.assertExecutionAuthoritative(input.executionId);
      const task = this.store.getTask(input.taskId);
      const repository = this.store
        .getWorkspaceManifest(execution.mission_id)
        ?.repositories.find((candidate) => candidate.repoId === execution.repo_id);
      const mismatches = [
        !task || task.mission_id !== execution.mission_id ? "task" : null,
        task?.assigned_execution_id && task.assigned_execution_id !== execution.execution_id
          ? "execution assignment"
          : null,
        task?.repo_id !== execution.repo_id ? "repository" : null,
        !repository || repository.baseSha !== execution.base_sha ? "base" : null,
        (task?.mission_generation ?? 0) !== (execution.mission_generation ?? 0) ? "mission generation" : null,
        (task?.candidate_generation ?? 0) !== (execution.candidate_generation ?? 0) ? "candidate generation" : null,
        (task?.fencing_token ?? 0) !== (execution.fencing_token ?? 0) ? "fencing token" : null,
      ].filter((value): value is string => value !== null);
      if (mismatches.length > 0) throw new Error(`checkpoint origin mismatch: ${mismatches.join(", ")}`);
      return task!;
    };
    try {
      assertCurrentOrigin();
      const snapshot = input.snapshot ?? (await this.snapshot?.(originatingTask.task_id)) ?? EMPTY_SNAPSHOT;
      const task = assertCurrentOrigin();
      const checkpointId = execution.checkpoint_id;
      const previous = this.latest(task.task_id, checkpointId);
      const usefulSnapshot =
        snapshot.candidateSha !== null ||
        snapshot.branch !== null ||
        snapshot.worktree !== null ||
        snapshot.committedChanges.length > 0 ||
        snapshot.preservedUncommittedChanges.length > 0;
      const preservedSnapshot = usefulSnapshot
        ? snapshot
        : previous
          ? {
              candidateSha: previous.candidateSha,
              branch: previous.branch,
              worktree: previous.worktree,
              committedChanges: previous.committedChanges,
              preservedUncommittedChanges: previous.preservedUncommittedChanges,
            }
          : snapshot;
      const declared = task.deliverables ?? [];
      const completed = dedupe([
        ...(previous?.completedDeliverables ?? []),
        ...(input.completedDeliverables ?? []),
      ]).filter((deliverable) => declared.includes(deliverable));
      const completedSet = new Set(completed);
      const artifactEvidence = mergeArtifactEvidence(
        { refs: previous?.artifactRefs ?? [], hashes: previous?.artifactHashes ?? [] },
        { refs: input.artifactRefs ?? [], hashes: input.artifactHashes ?? [] },
      );
      const checkpoint: TaskCheckpoint = {
        checkpointId,
        executionId: execution.execution_id,
        missionId: task.mission_id,
        taskId: task.task_id,
        repoId: execution.repo_id,
        baseSha: execution.base_sha,
        candidateSha: preservedSnapshot.candidateSha,
        branch: preservedSnapshot.branch,
        worktree: preservedSnapshot.worktree,
        committedChanges: dedupe(preservedSnapshot.committedChanges),
        preservedUncommittedChanges: dedupe(preservedSnapshot.preservedUncommittedChanges),
        completedDeliverables: completed,
        remainingDeliverables: declared.filter((deliverable) => !completedSet.has(deliverable)),
        acceptanceIds: [...(task.acceptance_ids ?? [])],
        validationEvidenceRefs: dedupe([
          ...(previous?.validationEvidenceRefs ?? []),
          ...(input.validationEvidenceRefs ?? []),
        ]),
        artifactRefs: artifactEvidence.refs,
        artifactHashes: artifactEvidence.hashes,
        workerId: input.workerId ?? previous?.workerId ?? null,
        sessionId: input.sessionId ?? previous?.sessionId ?? null,
        model: input.model ?? previous?.model ?? null,
        sequence: (previous?.sequence ?? 0) + 1,
        missionGeneration: execution.mission_generation ?? 0,
        candidateGeneration: execution.candidate_generation ?? 0,
        fencingToken: execution.fencing_token ?? 0,
        createdAt: this.now().toISOString(),
      };
      assertCurrentOrigin();
      return await this.store.publishCheckpointIfAuthoritative(checkpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authoritative|origin mismatch|stale execution identity/i.test(message)) {
        await this.store.recordLateExecution(input.executionId, "checkpoint authority lost", {
          kind: "checkpoint",
          exitStatus: null,
          summary: "Rejected checkpoint from a terminal or stale execution",
          error: message,
          artifactRefs: [...(input.artifactRefs ?? [])],
          findings: [],
          handoffs: [],
          recovery: [],
          gate: null,
        });
      }
      throw error;
    }
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
    return latestTaskCheckpoints(
      this.store
        .listTaskCheckpoints(undefined, taskId)
        .filter((checkpoint) => (checkpointId ? checkpoint.checkpointId === checkpointId : true)),
    )[0];
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
