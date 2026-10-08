/**
 * Structured runtime lifecycle events (spec §45).
 *
 * Owned by the Host, not by a generation: the events describe handovers
 * BETWEEN generations, so they must survive every one of them. Kept in a small
 * ring for the panel and `/engineering version`, and appended to a JSONL file
 * when an install root is known. Writing is best-effort; a full disk never
 * fails an update.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RuntimeEventName =
  | "runtime.update.check"
  | "runtime.update.available"
  | "runtime.update.started"
  | "runtime.update.fetched"
  | "runtime.update.staged"
  | "runtime.update.validated"
  | "runtime.update.refused"
  | "runtime.update.failed"
  | "runtime.safe_point.waiting"
  | "runtime.safe_point.reached"
  | "runtime.safe_point.cancelled"
  | "runtime.quiesce.started"
  | "runtime.quiesce.completed"
  | "runtime.snapshot.created"
  | "runtime.migration.started"
  | "runtime.migration.completed"
  | "runtime.migration.failed"
  | "runtime.activation.started"
  | "runtime.activation.completed"
  | "runtime.generation.loaded"
  | "runtime.generation.started"
  | "runtime.health.passed"
  | "runtime.health.failed"
  | "runtime.update.committed"
  | "runtime.rollback.started"
  | "runtime.rollback.completed"
  | "runtime.rollback.failed"
  | "runtime.reload.started"
  | "runtime.reload.completed"
  | "runtime.crash_recovery.started"
  | "runtime.crash_recovery.completed"
  | "runtime.retention.pruned";

/** The field vocabulary of spec §45. All optional; absent means not applicable. */
export interface RuntimeEventFields {
  transaction_id?: string;
  from_version?: string;
  to_version?: string;
  from_commit?: string | null;
  to_commit?: string | null;
  old_generation?: number;
  new_generation?: number;
  runtime_api?: number;
  state_schema?: number;
  channel?: string;
  mission_ids?: string[];
  duration?: number;
  failure_reason?: string;
  rollback_version?: string;
  [extra: string]: unknown;
}

export interface RuntimeEvent extends RuntimeEventFields {
  event: RuntimeEventName;
  at: string;
}

export class RuntimeTelemetry {
  private readonly ring: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  private readonly file: string | undefined;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(file?: string, capacity = 500, now: () => number = Date.now) {
    this.file = file;
    this.capacity = capacity;
    this.now = now;
  }

  emit(event: RuntimeEventName, fields: RuntimeEventFields = {}): RuntimeEvent {
    const record: RuntimeEvent = { event, at: new Date(this.now()).toISOString(), ...fields };
    this.ring.push(record);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(record)}\n`);
      } catch {
        // Telemetry never fails a handover.
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // A broken listener is not the emitter's problem.
      }
    }
    return record;
  }

  recent(n = 50): RuntimeEvent[] {
    return this.ring.slice(-n);
  }

  last(event: RuntimeEventName): RuntimeEvent | undefined {
    for (let i = this.ring.length - 1; i >= 0; i--) if (this.ring[i]?.event === event) return this.ring[i];
    return undefined;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
