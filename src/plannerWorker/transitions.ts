/**
 * MODEL_TRANSITION events (spec §12, §22): every role/model change is an
 * explicit, observable, persisted event. Transitions are recorded both for
 * planner/worker role changes and for the interactive Pi session's own model
 * switches (`model_select`), so one log covers all inference boundaries.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelTransitionEvent, PlannerWorkerRole } from "./types.ts";

export class TransitionLog {
  private readonly events: ModelTransitionEvent[] = [];
  private readonly listeners = new Set<(e: ModelTransitionEvent) => void>();
  private readonly path: string | null;
  private writes: Promise<void> = Promise.resolve();
  private readonly lastByKey = new Map<string, string>();

  constructor(opts: { path?: string } = {}) {
    this.path = opts.path ?? null;
  }

  onTransition(listener: (e: ModelTransitionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Last model a lane (role or task) used, for the `from` of the next transition. */
  last(lane: string): string | null {
    return this.lastByKey.get(lane) ?? null;
  }

  /**
   * Record a transition on `lane` (e.g. a task id). No event is emitted when
   * the lane already runs on `to`.
   */
  record(input: {
    lane: string;
    to: string;
    reason: string;
    task: string;
    role: PlannerWorkerRole;
    context: ModelTransitionEvent["context"];
    from?: string | null;
    now?: Date;
  }): ModelTransitionEvent | null {
    const from = input.from !== undefined ? input.from : this.last(input.lane);
    this.lastByKey.set(input.lane, input.to);
    if (from === input.to) return null;
    const event: ModelTransitionEvent = {
      type: "MODEL_TRANSITION",
      seq: this.events.length + 1,
      at: (input.now ?? new Date()).toISOString(),
      from,
      to: input.to,
      reason: input.reason,
      task: input.task,
      role: input.role,
      context: input.context,
    };
    this.events.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // observers never break execution
      }
    }
    if (this.path) {
      const path = this.path;
      this.writes = this.writes
        .then(() => mkdir(dirname(path), { recursive: true }))
        .then(() => appendFile(path, `${JSON.stringify(event)}\n`))
        .catch(() => {});
    }
    return event;
  }

  list(): ModelTransitionEvent[] {
    return [...this.events];
  }

  flush(): Promise<void> {
    return this.writes;
  }
}

/** Read a persisted transition log (JSONL); malformed lines are skipped. */
export async function readTransitions(path: string): Promise<ModelTransitionEvent[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const out: ModelTransitionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ModelTransitionEvent;
      if (e.type === "MODEL_TRANSITION") out.push(e);
    } catch {
      // skip
    }
  }
  return out;
}
