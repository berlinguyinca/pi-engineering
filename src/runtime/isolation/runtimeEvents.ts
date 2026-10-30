/**
 * Structured runtime events (spec §28/§29).
 *
 * Every concurrency/recovery decision is recorded as one structured line in the
 * session's debug log (`sessions/<id>/runtime.jsonl`) and kept in a bounded
 * in-memory ring for status/doctor views. Nothing here reaches the normal UI:
 * recovery is routine, and routine recovery must not produce warnings.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { emitTelemetry } from "../../telemetry/sink.ts";
import { rotateWithoutOverwrite } from "../rotateFile.ts";

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
  | "lease.contended_summary"
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
const CONTENTION_LIMIT = 200;

/** Process-wide ring, kept on globalThis so an in-process reload keeps history. */
interface RuntimeEventState {
  ring: RuntimeEvent[];
  logFile: string | null;
  listeners: Set<RuntimeEventSink>;
  /** Contention counters per `resource|holder` within the current reporting window. */
  contention: Map<string, { resource: unknown; holder_session: unknown; count: number }>;
  lastContentionSummaryMs: number;
  /** Repeats suppressed since the last summary line. */
  suppressedSinceSummary: number;
}

/** runtime.jsonl size cap before it rotates to `.1` (PI_RUNTIME_LOG_MAX_BYTES). */
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How often suppressed lease contention is summarised (PI_RUNTIME_CONTENTION_SUMMARY_MS). */
const DEFAULT_CONTENTION_SUMMARY_MS = 5 * 60_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const STATE_KEY = Symbol.for("pi-engineering.runtime-events");

function state(): RuntimeEventState {
  const holder = globalThis as unknown as Record<symbol, RuntimeEventState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = {
      ring: [],
      logFile: null,
      listeners: new Set(),
      contention: new Map(),
      lastContentionSummaryMs: Date.now(),
      suppressedSinceSummary: 0,
    };
    holder[STATE_KEY] = current;
    const created = current;
    process.once("exit", () => flushContentionSummary(created));
  }
  return current;
}

/** Direct structured diagnostics to a session debug log. */
export function setRuntimeEventLog(file: string | null): void {
  const s = state();
  if (s.logFile !== file) flushContentionSummary(s);
  s.logFile = file;
}

export function onRuntimeEvent(listener: RuntimeEventSink): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/**
 * Rotation renames to `<file>.<timestamp>.<n>` and never overwrites an earlier
 * generation, so two processes sharing one runtime.jsonl cannot lose history.
 */
function appendLog(file: string, record: RuntimeEvent): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    const max = envNumber("PI_RUNTIME_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES);
    try {
      if (statSync(file).size + line.length > max) rotateWithoutOverwrite(file);
    } catch {
      // No file yet.
    }
    appendFileSync(file, line, "utf8");
  } catch {
    // Diagnostics are observers; a full disk must not break the runtime.
  }
}

/** Flush the reporting window and discard its counters, even without a log sink. */
function flushContentionSummary(s: RuntimeEventState): void {
  if (s.suppressedSinceSummary > 0 && s.logFile) {
    appendLog(s.logFile, {
      event: "lease.contended_summary",
      at: new Date().toISOString(),
      contentions: [...s.contention.values()],
    });
  }
  s.contention.clear();
  s.suppressedSinceSummary = 0;
  s.lastContentionSummaryMs = Date.now();
}

/**
 * Log a resource/holder once per reporting window, then summarize repeats.
 * Flush early at the pair limit so long-running sessions with changing
 * resources cannot accumulate unbounded counters or summary lines.
 */
function throttleContention(s: RuntimeEventState, fields: Record<string, unknown>): RuntimeEvent | null {
  const key = `${String(fields.resource)}|${String(fields.holder_session)}`;
  if (!s.contention.has(key) && s.contention.size >= CONTENTION_LIMIT) flushContentionSummary(s);
  const entry = s.contention.get(key);
  const now = Date.now();
  if (entry) {
    entry.count++;
    s.suppressedSinceSummary++;
  } else s.contention.set(key, { resource: fields.resource, holder_session: fields.holder_session, count: 1 });
  const due =
    now - s.lastContentionSummaryMs >= envNumber("PI_RUNTIME_CONTENTION_SUMMARY_MS", DEFAULT_CONTENTION_SUMMARY_MS);
  if (due) {
    flushContentionSummary(s);
  }
  return entry ? null : { event: "lease.contended", at: new Date().toISOString(), ...fields };
}

export function emitRuntimeEvent(event: RuntimeEventName, fields: Record<string, unknown> = {}): RuntimeEvent {
  const s = state();
  if (event === "lease.contended") {
    const first = throttleContention(s, fields);
    if (!first) return { event, at: new Date().toISOString(), ...fields };
  }
  const record: RuntimeEvent = { event, at: new Date().toISOString(), ...fields };
  s.ring.push(record);
  if (s.ring.length > RING_LIMIT) s.ring.splice(0, s.ring.length - RING_LIMIT);
  if (s.logFile && event !== "session.heartbeat") {
    appendLog(s.logFile, record);
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
