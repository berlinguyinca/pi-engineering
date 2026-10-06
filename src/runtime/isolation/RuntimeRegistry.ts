/**
 * Machine-local runtime registry (spec §6/§7): which Pi Engineering sessions
 * exist, which process incarnation owns each one, where each is bound, and
 * when each last proved it was alive.
 *
 * Ownership is decided from this registry plus process identity, never from
 * the mere existence of a lock file. Every row carries a `generation_id`; a
 * session that was declared dead cannot quietly resume under its old
 * generation (no resurrection) — it must re-register and re-acquire.
 */
import { randomUUID } from "node:crypto";
import { LeaseManager } from "./LeaseManager.ts";
import { type ProcessIdentity, type ProcessLiveness, assessProcess } from "./processIdentity.ts";
import { type Database, immediate, openDatabase } from "./sqlite.ts";

export type SessionState =
  | "starting"
  | "healthy"
  | "recovering"
  | "rebinding"
  | "stopping"
  | "stopped"
  | "dead"
  | "orphaned";

export const LIVE_STATES: readonly SessionState[] = ["starting", "healthy", "recovering", "rebinding", "stopping"];

export interface SessionRecord {
  sessionId: string;
  pid: number;
  host: string;
  bootId: string | null;
  processStartTime: string | null;
  repoId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  runtimePath: string | null;
  startedAt: string;
  lastHeartbeatMs: number;
  state: SessionState;
  generationId: string;
  metadata: Record<string, unknown>;
  endedAt: string | null;
}

export interface SessionBindingUpdate {
  repoId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  runtimePath: string | null;
}

export type SessionAssessment =
  | { verdict: "live"; liveness: ProcessLiveness }
  | { verdict: "dead"; reason: string }
  | { verdict: "uncertain"; reason: string };

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  boot_id TEXT,
  process_start_time TEXT,
  repo_id TEXT,
  worktree_id TEXT,
  worktree_path TEXT,
  runtime_path TEXT,
  started_at TEXT NOT NULL,
  last_heartbeat_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_worktree ON sessions(worktree_id);
CREATE TABLE IF NOT EXISTS leases (
  resource_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  boot_id TEXT,
  process_start_time TEXT,
  generation_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_by_session ON leases(session_id);
CREATE TABLE IF NOT EXISTS bindings (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  worktree_id TEXT,
  worktree_path TEXT,
  runtime_path TEXT,
  state TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

type Row = Record<string, unknown>;

function toRecord(row: Row): SessionRecord {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.metadata ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    sessionId: String(row.session_id),
    pid: Number(row.pid),
    host: String(row.host),
    bootId: row.boot_id === null || row.boot_id === undefined ? null : String(row.boot_id),
    processStartTime:
      row.process_start_time === null || row.process_start_time === undefined ? null : String(row.process_start_time),
    repoId: row.repo_id === null || row.repo_id === undefined ? null : String(row.repo_id),
    worktreeId: row.worktree_id === null || row.worktree_id === undefined ? null : String(row.worktree_id),
    worktreePath: row.worktree_path === null || row.worktree_path === undefined ? null : String(row.worktree_path),
    runtimePath: row.runtime_path === null || row.runtime_path === undefined ? null : String(row.runtime_path),
    startedAt: String(row.started_at),
    lastHeartbeatMs: Number(row.last_heartbeat_ms),
    state: String(row.state) as SessionState,
    generationId: String(row.generation_id),
    metadata,
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
  };
}

export interface RuntimeRegistryOptions {
  /** A session whose heartbeat is older than this, and whose process cannot be verified, is stale. */
  staleAfterMs?: number;
  journalMode?: "WAL" | "DELETE";
  now?: () => number;
}

export class RuntimeRegistry {
  readonly file: string;
  readonly db: Database;
  readonly leases: LeaseManager;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  private constructor(file: string, db: Database, options: RuntimeRegistryOptions) {
    this.file = file;
    this.db = db;
    this.staleAfterMs = options.staleAfterMs ?? 90_000;
    this.now = options.now ?? Date.now;
    this.leases = new LeaseManager(db, this, { now: this.now });
  }

  static open(file: string, options: RuntimeRegistryOptions = {}): RuntimeRegistry {
    const db = openDatabase(file, { journalMode: options.journalMode });
    try {
      immediate(db, () => {
        db.exec(SCHEMA);
        db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      });
      return new RuntimeRegistry(file, db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  /** Register (or re-register) a session. Always issues a fresh generation. */
  register(input: {
    sessionId: string;
    process: ProcessIdentity;
    startedAt: string;
    binding?: SessionBindingUpdate;
    metadata?: Record<string, unknown>;
    state?: SessionState;
  }): SessionRecord {
    const generationId = randomUUID();
    const now = this.now();
    immediate(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO sessions (session_id, pid, host, boot_id, process_start_time, repo_id, worktree_id, worktree_path,
             runtime_path, started_at, last_heartbeat_ms, state, generation_id, metadata, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(session_id) DO UPDATE SET pid = excluded.pid, host = excluded.host, boot_id = excluded.boot_id,
             process_start_time = excluded.process_start_time,
             repo_id = COALESCE(excluded.repo_id, sessions.repo_id),
             worktree_id = COALESCE(excluded.worktree_id, sessions.worktree_id),
             worktree_path = COALESCE(excluded.worktree_path, sessions.worktree_path),
             runtime_path = COALESCE(excluded.runtime_path, sessions.runtime_path),
             last_heartbeat_ms = excluded.last_heartbeat_ms, state = excluded.state,
             generation_id = excluded.generation_id, metadata = excluded.metadata, ended_at = NULL`,
        )
        .run(
          input.sessionId,
          input.process.pid,
          input.process.host,
          input.process.bootId,
          input.process.processStartTime,
          input.binding?.repoId ?? null,
          input.binding?.worktreeId ?? null,
          input.binding?.worktreePath ?? null,
          input.binding?.runtimePath ?? null,
          input.startedAt,
          now,
          input.state ?? "healthy",
          generationId,
          JSON.stringify(input.metadata ?? {}),
        );
    });
    const record = this.get(input.sessionId);
    if (!record) throw new Error(`registry lost session ${input.sessionId} during registration`);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(filter: { worktreeId?: string; includeEnded?: boolean } = {}): SessionRecord[] {
    const rows = (
      filter.worktreeId
        ? this.db.prepare("SELECT * FROM sessions WHERE worktree_id = ? ORDER BY started_at").all(filter.worktreeId)
        : this.db.prepare("SELECT * FROM sessions ORDER BY started_at").all()
    ) as Row[];
    const records = rows.map(toRecord);
    return filter.includeEnded ? records : records.filter((record) => LIVE_STATES.includes(record.state));
  }

  /**
   * Prove liveness. Returns false when the row no longer carries this
   * generation (declared dead, re-registered elsewhere, or removed): the
   * caller must re-register rather than resurrect the old generation.
   */
  heartbeat(sessionId: string, generationId: string): boolean {
    const now = this.now();
    return immediate(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE sessions SET last_heartbeat_ms = ?,
             state = CASE WHEN state IN ('starting', 'recovering') THEN 'healthy' ELSE state END
           WHERE session_id = ? AND generation_id = ? AND state IN ('starting','healthy','recovering','rebinding','stopping')`,
        )
        .run(now, sessionId, generationId);
      if (Number(result.changes) !== 1) return false;
      this.leases.renewSessionLeasesInTransaction(sessionId, generationId, now);
      return true;
    });
  }

  setState(sessionId: string, generationId: string, state: SessionState): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET state = ? WHERE session_id = ? AND generation_id = ?")
      .run(state, sessionId, generationId);
    return Number(result.changes) === 1;
  }

  setMetadata(sessionId: string, generationId: string, metadata: Record<string, unknown>): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET metadata = ? WHERE session_id = ? AND generation_id = ?")
      .run(JSON.stringify(metadata), sessionId, generationId);
    return Number(result.changes) === 1;
  }

  /**
   * Transactionally move a session's binding: the new attachment and the
   * session pointer change together or not at all. `beforeCommit` runs inside
   * the transaction (e.g. to flush and emit the rebound event); if it throws,
   * nothing changes.
   */
  rebind(sessionId: string, generationId: string, binding: SessionBindingUpdate, beforeCommit?: () => void): boolean {
    const now = this.now();
    return immediate(this.db, () => {
      const current = this.get(sessionId);
      if (!current || current.generationId !== generationId || !LIVE_STATES.includes(current.state)) return false;
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM bindings WHERE session_id = ?")
        .get(sessionId) as Row | undefined;
      const seq = Number(seqRow?.seq ?? 0) + 1;
      this.db
        .prepare(
          "INSERT INTO bindings (session_id, seq, worktree_id, worktree_path, runtime_path, state, at_ms) VALUES (?, ?, ?, ?, ?, 'attached', ?)",
        )
        .run(sessionId, seq, binding.worktreeId, binding.worktreePath, binding.runtimePath, now);
      this.db
        .prepare(
          "UPDATE sessions SET repo_id = ?, worktree_id = ?, worktree_path = ?, runtime_path = ?, state = 'healthy' WHERE session_id = ? AND generation_id = ?",
        )
        .run(binding.repoId, binding.worktreeId, binding.worktreePath, binding.runtimePath, sessionId, generationId);
      beforeCommit?.();
      return true;
    });
  }

  bindingHistory(sessionId: string): Array<{ seq: number; worktreeId: string | null; worktreePath: string | null }> {
    return (
      this.db
        .prepare("SELECT seq, worktree_id, worktree_path FROM bindings WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as Row[]
    ).map((row) => ({
      seq: Number(row.seq),
      worktreeId: row.worktree_id === null ? null : String(row.worktree_id),
      worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    }));
  }

  /** Graceful shutdown: mark stopped and release every lease of this generation. */
  unregister(sessionId: string, generationId: string): boolean {
    return immediate(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE sessions SET state = 'stopped', ended_at = ? WHERE session_id = ? AND generation_id = ? AND ended_at IS NULL",
        )
        .run(new Date(this.now()).toISOString(), sessionId, generationId);
      this.leases.releaseSessionLeasesInTransaction(sessionId);
      return Number(result.changes) === 1;
    });
  }

  /**
   * Decide whether a registered session is still alive. A stale heartbeat
   * alone is not proof of death when the process incarnation verifies.
   */
  assess(record: SessionRecord): SessionAssessment {
    if (!LIVE_STATES.includes(record.state)) return { verdict: "dead", reason: `state_${record.state}` };
    const liveness = assessProcess({
      pid: record.pid,
      host: record.host,
      bootId: record.bootId,
      processStartTime: record.processStartTime,
    });
    if (liveness.state === "dead") return { verdict: "dead", reason: liveness.reason };
    const heartbeatAge = this.now() - record.lastHeartbeatMs;
    if (liveness.state === "alive" && liveness.reason === "incarnation_matches") return { verdict: "live", liveness };
    if (heartbeatAge > this.staleAfterMs) {
      return {
        verdict: "dead",
        reason: liveness.state === "alive" ? "heartbeat_expired" : `heartbeat_expired_${liveness.reason}`,
      };
    }
    return liveness.state === "alive"
      ? { verdict: "live", liveness }
      : { verdict: "uncertain", reason: liveness.reason };
  }

  /** Is the session currently registered and alive? Unknown sessions are not live. */
  isSessionLive(sessionId: string): boolean {
    const record = this.get(sessionId);
    return record ? this.assess(record).verdict !== "dead" : false;
  }

  /**
   * Mark a session dead/orphaned if (and only if) it still carries the
   * generation that was assessed, releasing its leases in the same transaction.
   */
  markDead(record: SessionRecord, state: "dead" | "orphaned"): boolean {
    return immediate(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE sessions SET state = ?, ended_at = COALESCE(ended_at, ?) WHERE session_id = ? AND generation_id = ? AND state IN ('starting','healthy','recovering','rebinding','stopping')",
        )
        .run(state, new Date(this.now()).toISOString(), record.sessionId, record.generationId);
      if (Number(result.changes) !== 1) return false;
      this.leases.releaseSessionLeasesInTransaction(record.sessionId);
      return true;
    });
  }

  /** Remove rows of sessions that ended long ago (bounded registry). */
  prune(olderThanMs = 7 * 24 * 60 * 60_000): number {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    const result = this.db.prepare("DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM bindings WHERE session_id NOT IN (SELECT session_id FROM sessions)").run();
    return Number(result.changes);
  }
}
