import type { Actor, Task, WorkItemStatus } from "../core/types.ts";
import type { Ledger, LedgerWriteOptions } from "../ledger/Ledger.ts";
import { LedgerAuthorityStaleError, LedgerRevisionConflictError } from "../ledger/errors.ts";
import { evaluateWorkCompletion } from "../work/completionPolicy.ts";
import { LedgerWorkProjection } from "../work/ledgerProjection.ts";

export interface TransitionVerdict {
  /** The requested status was written. False: completion was refused and the item was recorded as blocked. */
  applied: boolean;
  blockers: string[];
}

export interface LedgerTransitionOptions {
  ledger: Ledger;
  /** This runtime's `authority_generation` (see `claimAuthorityGeneration`). */
  authorityGeneration: number;
  /** `execution.strict_completion`: consult the work read model before marking anything completed. */
  strictCompletion: boolean;
  /** `execution.stale_after_ms`: a run with no heartbeat this long is `unknown` and blocks completion. */
  staleAfterMs?: number;
}

/**
 * The Ledger path's guarded status writer. Every transition is a read-modify-write: it reads the scope's revision,
 * judges the work read model, and writes with `expected_revision` and this runtime's `authority_generation`. A
 * conflicting writer gets one re-read and a re-evaluation (never a blind retry of the stale decision); a second
 * conflict, or a fenced-off generation, surfaces as an error and writes nothing.
 *
 * Transitions on one work item are serialized in-process, so sibling tasks of a parallel wave do not conflict with
 * each other; the guard is there for other processes.
 */
export class LedgerTransitions {
  private readonly ledger: Ledger;
  private readonly generation: number;
  private readonly strict: boolean;
  private readonly projection: LedgerWorkProjection;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: LedgerTransitionOptions) {
    this.ledger = opts.ledger;
    this.generation = opts.authorityGeneration;
    this.strict = opts.strictCompletion;
    this.projection = new LedgerWorkProjection(
      opts.ledger,
      opts.staleAfterMs === undefined ? undefined : { staleAfterMs: opts.staleAfterMs },
    );
  }

  get authorityGeneration(): number {
    return this.generation;
  }

  /** Move a work item to `status`. COMPLETED is refused (item recorded BLOCKED with the reason) when the policy says so. */
  async settleWorkItem(id: string, status: WorkItemStatus, actor: Actor): Promise<TransitionVerdict> {
    return this.fenced(id, `work item ${id} -> ${status}`, async (write) => {
      const wi = this.ledger.getWorkItem(id);
      const stale = wi?.blocked_reason ? { blocked_reason: null } : {};
      if (status === "COMPLETED" && this.strict) {
        const blockers = this.blockersFor(id);
        if (blockers.length > 0) {
          await this.ledger.updateWorkItem(
            id,
            { status: "BLOCKED", blocked_reason: blockers.join("; ") },
            actor,
            write,
          );
          return { applied: false, blockers };
        }
      }
      await this.ledger.updateWorkItem(id, { status, ...stale }, actor, write);
      return { applied: true, blockers: [] };
    });
  }

  /**
   * Move a plan task to `status` inside plan work item `workItemId`. Completion is judged on `evidenceWorkItemId`,
   * the work item that did the task's work (the plan task itself carries no runs or verification of its own).
   */
  async settleTask(
    taskId: string,
    status: Task["status"],
    workItemId: string,
    actor: Actor,
    evidenceWorkItemId?: string,
  ): Promise<TransitionVerdict> {
    return this.fenced(workItemId, `task ${taskId} -> ${status}`, async (write) => {
      if (status === "completed" && this.strict && evidenceWorkItemId) {
        const blockers = this.blockersFor(evidenceWorkItemId);
        if (blockers.length > 0) {
          await this.ledger.emitEvent(
            "task.blocked",
            workItemId,
            actor,
            { task_id: taskId, status: "blocked", reason: blockers.join("; ") },
            write.authority_generation !== undefined ? { authority_generation: write.authority_generation } : undefined,
            write.guard,
          );
          return { applied: false, blockers };
        }
      }
      await this.ledger.setTaskStatus(taskId, status, workItemId, actor, write);
      return { applied: true, blockers: [] };
    });
  }

  private blockersFor(workItemId: string): string[] {
    const graph = this.projection.graph();
    const task = graph.tasks.find((t) => t.id === workItemId);
    if (!task) return [];
    // The transition being decided is what moves an item to done, so the store's current open/blocked state (DEFINED
    // before a first run, PARTIAL/FAILED/our own BLOCKED before a retry) is not evidence against it. Cancelled and
    // needs-input stay blockers. An item that never had a candidate is a plan aggregate: its tasks carry the
    // verification, so "unknown" there means "nothing to verify", not "unverified work".
    const noCandidates = this.ledger.listCandidates(workItemId).length === 0;
    const judged = {
      ...task,
      state: task.state === "open" || task.state === "blocked" ? ("working" as const) : task.state,
      verification_status:
        noCandidates && task.verification_status === "unknown" ? ("not_required" as const) : task.verification_status,
    };
    return evaluateWorkCompletion(judged, graph.runs).blockers;
  }

  private fenced<T>(scope: string, what: string, op: (write: LedgerWriteOptions) => Promise<T>): Promise<T> {
    const prior = this.chains.get(scope) ?? Promise.resolve();
    const run = prior.then(
      () => this.attempt(scope, what, op),
      () => this.attempt(scope, what, op),
    );
    this.chains.set(
      scope,
      run.catch(() => {}),
    );
    return run;
  }

  private async attempt<T>(scope: string, what: string, op: (write: LedgerWriteOptions) => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      const write: LedgerWriteOptions = {
        guard: { expected_revision: this.ledger.revision(scope) },
        authority_generation: this.generation,
      };
      try {
        return await op(write);
      } catch (error) {
        if (error instanceof LedgerRevisionConflictError) {
          // The failed append caught this ledger up with the other writer, so the next pass re-judges fresh state.
          if (tries === 0) continue;
          throw new Error(
            `${what} not applied: ${scope} changed under this runtime twice (expected revision ${error.expectedRevision}, log at ${error.actualRevision})`,
            { cause: error },
          );
        }
        if (error instanceof LedgerAuthorityStaleError) {
          throw new Error(
            `${what} not applied: this runtime (authority generation ${error.authorityGeneration}) was superseded by generation ${error.currentGeneration}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
  }
}
