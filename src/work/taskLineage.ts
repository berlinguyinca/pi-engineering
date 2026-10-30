/**
 * Ledger-native task -> Herdr lineage (Missionless Execution Fabric).
 *
 * Only AutoSpec DAG tasks reached the graph before (`integrations/autospec/dagLineage.ts`). This projects the generic
 * work read model (`ledgerProjection.ts`) through the SAME LineageEmitter and outbox: a `task:<id>` node per task and
 * an `attempt:<run id>` node per run, linked by a `delegation` edge task -> attempt.
 *
 * Edge choice: `delegation` (delegator -> delegate) rather than `spawn`. Herdr reads incoming `spawn` edges on agents
 * to decide whether an agent is primary or a helper, and a task is not an agent. A Ledger run IS one worker run, so the
 * delegate is the `attempt`, whose id is the Ledger run id; no agent node is invented.
 *
 * The node id is `task:<WorkTask.id>` whatever the source, so a legacy Mission projected as a task keeps one id.
 * Edges to pr/commit/plan nodes are NOT built here: the work read model holds no such ids, and an edge is only emitted
 * from ids read from durable data.
 *
 * Fire-and-forget: `scheduleSync` defers to a macrotask, coalesces, and swallows every error, so emission can neither
 * fail nor slow the task that triggered it. Absent emitter = nothing happens.
 */

import type { LineageEmitter, LineageState } from "../runtime/herdr/lineage.ts";
import { lineageNodeId } from "../runtime/herdr/lineage.ts";
import type { RunHealth, WorkGraph, WorkTaskState } from "./types.ts";

const TASK_STATE: Record<WorkTaskState, LineageState> = {
  open: "pending",
  working: "running",
  needs_input: "blocked",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

const RUN_STATE: Record<RunHealth, LineageState> = {
  active: "running",
  waiting: "pending",
  stalled: "blocked",
  unknown: "blocked",
  recovering: "running",
  failed: "failed",
  finished: "done",
};

/** The one node id of a work task, shared by every source. */
export const workTaskNodeId = (taskId: string): string | undefined => lineageNodeId("task", taskId);

/**
 * Emit what changed since the last call for `graph`. `seen` holds the last emitted signature per node, so an
 * unchanged task adds nothing; the signature is also the transition discriminator, so a retry dedupes in the outbox.
 */
export function emitWorkTaskLineage(
  lineage: LineageEmitter | null | undefined,
  graph: WorkGraph,
  seen: Map<string, string> = new Map(),
): void {
  if (!lineage) return;
  for (const task of graph.tasks) {
    const node = workTaskNodeId(task.id);
    if (!node) continue;
    const sig = `${task.state}|${task.raw_status}|${task.verification_status}`;
    if (seen.get(node) === sig) continue;
    seen.set(node, sig);
    lineage.nodeUpsert(
      node,
      {
        label: task.title.slice(0, 120),
        state: TASK_STATE[task.state] ?? "blocked",
        attrs: {
          source: task.source,
          raw_status: task.raw_status,
          verification_status: task.verification_status,
          ...(task.parent_id ? { parent_id: task.parent_id } : {}),
        },
      },
      `task:${sig}`,
      { task_id: task.id },
    );
  }
  for (const run of graph.runs) {
    const attempt = lineageNodeId("attempt", run.id);
    const task = workTaskNodeId(run.task_id);
    if (!attempt || !task) continue;
    const sig = `${run.health}|${run.outcome ?? ""}`;
    if (seen.get(attempt) === sig) continue;
    seen.set(attempt, sig);
    const scope = { task_id: run.task_id };
    lineage.nodeUpsert(
      attempt,
      {
        state: RUN_STATE[run.health] ?? "blocked",
        attrs: {
          task_id: run.task_id,
          source: run.source,
          ...(run.model ? { model: run.model } : {}),
          ...(run.session_id ? { session_id: run.session_id } : {}),
        },
      },
      `run:${sig}`,
      scope,
    );
    lineage.edgeAdd("delegation", task, attempt, `run:${run.id}`, { source: run.source }, scope);
  }
}

/** Anything that can produce the generic work graph (LedgerWorkProjection satisfies it). */
export interface WorkGraphSource {
  graph(): WorkGraph;
}

/** Deferred, coalescing, error-swallowing projector for one Ledger. */
export class TaskLineageProjector {
  private readonly seen = new Map<string, string>();
  private pending = false;

  private readonly source: WorkGraphSource;
  private readonly lineage: LineageEmitter | null | undefined;
  private readonly defer: (fn: () => void) => void;

  constructor(
    source: WorkGraphSource,
    lineage: LineageEmitter | null | undefined,
    defer: (fn: () => void) => void = (fn) => void setImmediate(fn),
  ) {
    this.source = source;
    this.lineage = lineage;
    this.defer = defer;
  }

  /** Never throws, never awaited, never runs synchronously with the caller. */
  scheduleSync(): void {
    if (!this.lineage || this.pending) return;
    this.pending = true;
    try {
      this.defer(() => {
        this.pending = false;
        this.syncNow();
      });
    } catch {
      this.pending = false;
    }
  }

  syncNow(): void {
    try {
      emitWorkTaskLineage(this.lineage, this.source.graph(), this.seen);
    } catch {
      // observational only
    }
  }
}
