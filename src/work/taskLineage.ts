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
 * Edges to commit/pr/plan/evidence nodes come from an optional {@link TaskRefsSource} (taskRefs.ts) and only from ids
 * read from durable data; see {@link emitTaskRefEdges} for the edge kinds. Commons nodes (commit, pr, artifact) are
 * only ENSURED (no label/state/attrs), so a task never overwrites what GitHub sync or a Mission said about them.
 *
 * Fire-and-forget: `scheduleSync` defers to a macrotask, coalesces, and swallows every error, so emission can neither
 * fail nor slow the task that triggered it. Absent emitter = nothing happens.
 */

import { planNode } from "../orchestration/planReview.ts";
import type { LineageEmitter, LineageState } from "../runtime/herdr/lineage.ts";
import { lineageNodeId } from "../runtime/herdr/lineage.ts";
import type { TaskRefs, TaskRefsSource } from "./taskRefs.ts";
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
 * task -> commit (`produced`), task -> pr (`issue_link`, the edge github/sync.ts already draws for task subjects),
 * task -> plan (`dependency`: the task rests on that plan revision, whose node the Mission side owns), and
 * task -> evidence artifact (`produced`) with evidence -> commit (`validated`, bound by `attrs.commit`) for PASSED
 * evidence only. Failed evidence is a node in state `failed` with no validated edge. All edge kinds are in the Herdr
 * contract's closed vocabulary. `seen` makes a repeat a no-op.
 */
export function emitTaskRefEdges(
  lineage: LineageEmitter,
  taskNode: string,
  taskId: string,
  refs: TaskRefs,
  seen: Map<string, string>,
): void {
  const scope = { task_id: taskId };
  const once = (key: string, sig: string, fn: () => void): void => {
    if (seen.get(key) === sig) return;
    seen.set(key, sig);
    fn();
  };
  for (const sha of refs.commits) {
    const commit = lineageNodeId("commit", sha);
    once(`edge:produced:${taskNode}:${commit}`, "1", () =>
      lineage.edgeAdd("produced", taskNode, commit, `task-commit:${sha}`, { commit: sha, source: "ledger" }, scope),
    );
  }
  for (const pr of refs.prs) {
    once(`edge:issue_link:${taskNode}:${pr}`, "1", () =>
      lineage.edgeAdd("issue_link", taskNode, pr, `task-pr:${pr}`, { provenance: "ledger", source: "ledger" }, scope),
    );
  }
  for (const plan of refs.plans) {
    const node = planNode(plan.missionId, plan.revision);
    once(`edge:dependency:${taskNode}:${node}`, plan.digest ?? "", () =>
      lineage.edgeAdd(
        "dependency",
        taskNode,
        node,
        `task-plan:${plan.digest ?? plan.revision}`,
        {
          ...(plan.digest ? { plan_digest: plan.digest } : {}),
          ...(plan.artifact
            ? { plan_artifact_id: plan.artifact.id, plan_artifact_version: plan.artifact.version }
            : {}),
        },
        scope,
      ),
    );
  }
  for (const ev of refs.evidence) {
    const node = lineageNodeId("artifact", `evidence/${ev.id}`);
    once(`node:${node}`, `${ev.passed}|${ev.commit ?? ""}`, () => {
      lineage.nodeUpsert(
        node,
        {
          label: ev.type,
          state: ev.passed ? "done" : "failed",
          attrs: { kind: "verification", type: ev.type, ...(ev.commit ? { commit: ev.commit } : {}) },
        },
        `task-evidence:${ev.passed ? "passed" : "failed"}`,
        scope,
      );
      lineage.edgeAdd("produced", taskNode, node, `task-evidence:${ev.id}`, { source: "ledger" }, scope);
      const commit = ev.commit ? lineageNodeId("commit", ev.commit) : undefined;
      if (ev.passed && commit && ev.commit) {
        lineage.edgeAdd(
          "validated",
          node,
          commit,
          `task-validated:${ev.id}`,
          { commit: ev.commit, check: ev.type },
          scope,
        );
      }
    });
  }
}

/**
 * Emit what changed since the last call for `graph`. `seen` holds the last emitted signature per node, so an
 * unchanged task adds nothing; the signature is also the transition discriminator, so a retry dedupes in the outbox.
 */
export function emitWorkTaskLineage(
  lineage: LineageEmitter | null | undefined,
  graph: WorkGraph,
  seen: Map<string, string> = new Map(),
  refsOf?: TaskRefsSource,
): void {
  if (!lineage) return;
  for (const task of graph.tasks) {
    const node = workTaskNodeId(task.id);
    if (!node) continue;
    const sig = `${task.state}|${task.raw_status}|${task.verification_status}`;
    const changed = seen.get(node) !== sig;
    seen.set(node, sig);
    if (changed)
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
    // Refs are re-read while the task is live (a commit can land without a state change); `seen` dedupes the edges.
    if (refsOf && (changed || (task.state !== "done" && task.state !== "cancelled"))) {
      try {
        const refs = refsOf(task);
        if (refs) emitTaskRefEdges(lineage, node, task.id, refs, seen);
      } catch {
        // observational only
      }
    }
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
  private readonly refsOf: TaskRefsSource | undefined;

  constructor(
    source: WorkGraphSource,
    lineage: LineageEmitter | null | undefined,
    defer: (fn: () => void) => void = (fn) => void setImmediate(fn),
    refsOf?: TaskRefsSource,
  ) {
    this.source = source;
    this.lineage = lineage;
    this.defer = defer;
    this.refsOf = refsOf;
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
      emitWorkTaskLineage(this.lineage, this.source.graph(), this.seen, this.refsOf);
    } catch {
      // observational only
    }
  }
}
