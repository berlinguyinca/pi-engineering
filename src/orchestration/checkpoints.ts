import type { MissionStore } from "./missionStore.ts";
import type { CheckpointHandoffContext, TaskCheckpoint } from "./types.ts";

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
  handoff?: Partial<CheckpointHandoffContext>;
}

const HANDOFF_LIMITS = { text: 2000, short: 500, items: 50, hex: /^[0-9a-f]{64}$/ } as const;

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`checkpoint handoff ${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function boundedList<T>(value: readonly T[] | undefined, field: string): readonly T[] {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > HANDOFF_LIMITS.items) {
    throw new Error(`checkpoint handoff ${field} must be a list of at most ${HANDOFF_LIMITS.items} entries`);
  }
  return list;
}

/** Validate this checkpoint's handoff input and merge it over the previous checkpoint's. Undefined when empty. */
function mergeHandoffContext(
  previous: CheckpointHandoffContext | undefined,
  input: Partial<CheckpointHandoffContext> | undefined,
): CheckpointHandoffContext | undefined {
  if (!previous && !input) return undefined;
  const nextAction =
    input?.nextAction === undefined
      ? (previous?.nextAction ?? null)
      : input.nextAction === null
        ? null
        : boundedText(input.nextAction, "nextAction", HANDOFF_LIMITS.text);
  const entry = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`checkpoint handoff ${field} entries must be objects`);
    }
    return value as Record<string, unknown>;
  };
  // Newest wins: re-adding a key moves it to the end, and history beyond the cap drops its oldest entries.
  const upsert = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    map.set(key, value);
  };
  const tail = <V>(values: Iterable<V>): V[] => [...values].slice(-HANDOFF_LIMITS.items);
  const decisions = new Map((previous?.decisions ?? []).map((d) => [d.id, d] as const));
  for (const raw of boundedList(input?.decisions, "decisions")) {
    const d = entry(raw, "decisions");
    const id = boundedText(d.id, "decision id", 128);
    upsert(decisions, id, {
      id,
      summary: boundedText(d.summary, "decision summary", HANDOFF_LIMITS.short),
      rationale: boundedText(d.rationale, "decision rationale", HANDOFF_LIMITS.text),
    });
  }
  const tests = new Map((previous?.tests ?? []).map((t) => [t.ref, t] as const));
  for (const raw of boundedList(input?.tests, "tests")) {
    const t = entry(raw, "tests");
    if (t.outcome !== "passed" && t.outcome !== "failed" && t.outcome !== "skipped") {
      throw new Error("checkpoint handoff test outcome must be passed, failed or skipped");
    }
    const ref = boundedText(t.ref, "test ref", 256);
    upsert(tests, ref, { ref, outcome: t.outcome });
  }
  // The worktree's untracked files as of this checkpoint: a supplied list replaces, an omitted one leaves it be.
  const untracked = new Map(input?.untracked ? [] : (previous?.untracked ?? []).map((u) => [u.path, u] as const));
  for (const raw of boundedList(input?.untracked, "untracked")) {
    const u = entry(raw, "untracked");
    if (!HANDOFF_LIMITS.hex.test(String(u.sha256))) {
      throw new Error("checkpoint handoff untracked sha256 must be 64 hex");
    }
    const path = boundedText(u.path, "untracked path", 1024);
    upsert(untracked, path, { path, sha256: String(u.sha256) });
  }
  const strings = (field: "unresolvedIssues" | "memoryRefs"): string[] => {
    const added = boundedList(input?.[field], field).map((v) => boundedText(v, field, HANDOFF_LIMITS.short));
    // unresolved issues are the current set (a supplied list, even empty, replaces); memory refs accumulate.
    return field === "unresolvedIssues" && input?.unresolvedIssues
      ? dedupe(added)
      : tail(dedupe([...(previous?.[field] ?? []), ...added]));
  };
  return {
    nextAction,
    decisions: tail(decisions.values()),
    unresolvedIssues: strings("unresolvedIssues"),
    tests: tail(tests.values()),
    memoryRefs: strings("memoryRefs"),
    untracked: tail(untracked.values()),
  };
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
      const handoff = mergeHandoffContext(previous?.handoff, input.handoff);
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
        ...(handoff ? { handoff } : {}),
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
