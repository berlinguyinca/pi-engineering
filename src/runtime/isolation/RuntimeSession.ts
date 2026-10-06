/**
 * The Pi Engineering session: one UUID per Pi process.
 *
 * The identity lives on `globalThis`, so an in-process reload of Pi Engineering
 * (a fresh module graph in the same process) continues the SAME logical session
 * instead of looking like a second one — no false stale ownership, no duplicate
 * event writer, no orphaned runtime state.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type ProcessIdentity, currentProcessIdentity } from "./processIdentity.ts";
import { setRuntimeEventLog } from "./runtimeEvents.ts";
import { resolveStateRoot, sessionRuntimeDir } from "./stateDir.ts";

interface SessionIdentityRecord {
  sessionId: string;
  startedAt: string;
  pid: number;
}

const SESSION_KEY = Symbol.for("pi-engineering.runtime-session");

function sessionHolder(): Record<symbol, SessionIdentityRecord | undefined> {
  return globalThis as unknown as Record<symbol, SessionIdentityRecord | undefined>;
}

/** Stable session identity for this process (survives in-process reloads). */
export function currentSessionIdentity(): SessionIdentityRecord {
  const holder = sessionHolder();
  let record = holder[SESSION_KEY];
  // A forked child inherits globals only through explicit serialization, but be
  // strict anyway: a session identity belongs to exactly one process.
  if (!record || record.pid !== process.pid) {
    record = { sessionId: randomUUID(), startedAt: new Date().toISOString(), pid: process.pid };
    holder[SESSION_KEY] = record;
  }
  return record;
}

export class RuntimeSession {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly process: ProcessIdentity;

  private constructor(record: SessionIdentityRecord) {
    this.sessionId = record.sessionId;
    this.startedAt = record.startedAt;
    this.process = currentProcessIdentity();
  }

  /** The session of this process. Cheap; safe to call from anywhere. */
  static current(): RuntimeSession {
    const session = new RuntimeSession(currentSessionIdentity());
    setRuntimeEventLog(join(session.sessionDir(), "runtime.jsonl"));
    return session;
  }

  stateRoot(): string {
    return resolveStateRoot();
  }

  /** Session scope: unbound/fallback runtime state and the debug log. */
  sessionDir(): string {
    return sessionRuntimeDir(this.stateRoot(), this.sessionId);
  }
}
