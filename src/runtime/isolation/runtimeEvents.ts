/**
 * Structured runtime events (spec §28/§29).
 *
 * Every concurrency/recovery decision is recorded as one structured line in the
 * session's debug log (`sessions/<id>/runtime.jsonl`) and kept in a bounded
 * in-memory ring for status/doctor views. Nothing here reaches the normal UI:
 * recovery is routine, and routine recovery must not produce warnings.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { emitTelemetry } from "../../telemetry/sink.ts";

export type RuntimeEventName =
  | "runtime.started"
  | "runtime.bound"
  | "runtime.rebound"
  | "runtime.rebind_failed"
  | "runtime.recovering"
  | "runtime.recovered"
  | "runtime.degraded"
  | "runtime.stopped"
  | "runtime.reload_takeover"
  | "session.registered"
  | "session.heartbeat"
  | "session.orphaned"
  | "session.recovered"
  | "lease.acquired"
  | "lease.released"
  | "lease.expired"
  | "lease.reclaimed"
  | "lease.contended"
  | "event_stream.recovered"
  | "event_stream.corruption_detected"
  | "migration.completed"
  | "migration.skipped"
  | "lock.metadata_quarantined";

export interface RuntimeEvent {
  event: RuntimeEventName;
  at: string;
  session_id?: string;
  worktree_id?: string;
  [field: string]: unknown;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void;

const RING_LIMIT = 200;

/** Process-wide ring, kept on globalThis so an in-process reload keeps history. */
interface RuntimeEventState {
  ring: RuntimeEvent[];
  logFile: string | null;
  listeners: Set<RuntimeEventSink>;
}

const STATE_KEY = Symbol.for("pi-engineering.runtime-events");

function state(): RuntimeEventState {
  const holder = globalThis as unknown as Record<symbol, RuntimeEventState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { ring: [], logFile: null, listeners: new Set() };
    holder[STATE_KEY] = current;
  }
  return current;
}

/** Direct structured diagnostics to a session debug log. */
export function setRuntimeEventLog(file: string | null): void {
  state().logFile = file;
}

export function onRuntimeEvent(listener: RuntimeEventSink): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

export function emitRuntimeEvent(event: RuntimeEventName, fields: Record<string, unknown> = {}): RuntimeEvent {
  const record: RuntimeEvent = { event, at: new Date().toISOString(), ...fields };
  const s = state();
  s.ring.push(record);
  if (s.ring.length > RING_LIMIT) s.ring.splice(0, s.ring.length - RING_LIMIT);
  if (s.logFile && event !== "session.heartbeat") {
    try {
      mkdirSync(dirname(s.logFile), { recursive: true });
      appendFileSync(s.logFile, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Diagnostics are observers; a full disk must not break the runtime.
    }
  }
  // Debug view: opt in to see every runtime decision on the Pi surface.
  if (process.env.PI_ENGINEERING_DEBUG_RUNTIME === "1" && event !== "session.heartbeat") {
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    emitTelemetry({
      level: "info",
      text: `[runtime] ${event} ${detail}`.slice(0, 300),
      key: `runtime:${event}`,
      detail: record,
    });
  }
  for (const listener of s.listeners) {
    try {
      listener(record);
    } catch {
      // Observers never participate.
    }
  }
  return record;
}

export function recentRuntimeEvents(limit = 50): RuntimeEvent[] {
  return state().ring.slice(-limit);
}
