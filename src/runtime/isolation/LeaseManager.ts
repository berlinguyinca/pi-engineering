/**
 * Atomic, generation-fenced leases (spec §9).
 *
 * Every acquisition gets a fresh `generation_id`. Renew and release are
 * conditional on that generation, so a stale process can never renew or
 * delete a lease that has since been reclaimed and re-acquired (no ABA, no
 * "old process releases the new lease"). Reclamation requires proof that the
 * holder is gone — dead PID, reused PID (start time mismatch), reboot, a
 * registry row marked dead — or, when the holder cannot be verified at all
 * (another host, no /proc), an expired lease.
 */
import { randomUUID } from "node:crypto";
import type { RuntimeRegistry } from "./RuntimeRegistry.ts";
import { type ProcessIdentity, assessProcess } from "./processIdentity.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";
import { type Database, immediate } from "./sqlite.ts";

export interface LeaseRecord {
  resourceId: string;
  sessionId: string;
  pid: number;
  host: string;
  bootId: string | null;
  processStartTime: string | null;
  generationId: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

export interface LeaseOwner {
  sessionId: string;
  process: ProcessIdentity;
}

export type LeaseAcquisition =
  | { ok: true; lease: LeaseRecord; reentrant: boolean; reclaimed: { sessionId: string; reason: string } | null }
  | { ok: false; holder: LeaseRecord; reason: string };

type Row = Record<string, unknown>;

function toLease(row: Row): LeaseRecord {
  return {
    resourceId: String(row.resource_id),
    sessionId: String(row.session_id),
    pid: Number(row.pid),
    host: String(row.host),
    bootId: row.boot_id === null || row.boot_id === undefined ? null : String(row.boot_id),
    processStartTime:
      row.process_start_time === null || row.process_start_time === undefined ? null : String(row.process_start_time),
    generationId: String(row.generation_id),
    acquiredAtMs: Number(row.acquired_at_ms),
    heartbeatAtMs: Number(row.heartbeat_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

export const DEFAULT_LEASE_TTL_MS = 45_000;

export class LeaseManager {
  private readonly db: Database;
  private readonly registry: RuntimeRegistry;
  private readonly now: () => number;

  constructor(db: Database, registry: RuntimeRegistry, options: { now?: () => number } = {}) {
    this.db = db;
    this.registry = registry;
    this.now = options.now ?? Date.now;
  }

  get(resourceId: string): LeaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM leases WHERE resource_id = ?").get(resourceId) as Row | undefined;
    return row ? toLease(row) : undefined;
  }

  list(filter: { sessionId?: string; prefix?: string } = {}): LeaseRecord[] {
    let rows: Row[];
    if (filter.sessionId) {
      rows = this.db
        .prepare("SELECT * FROM leases WHERE session_id = ? ORDER BY resource_id")
        .all(filter.sessionId) as Row[];
    } else if (filter.prefix) {
      rows = this.db
        .prepare("SELECT * FROM leases WHERE substr(resource_id, 1, ?) = ? ORDER BY resource_id")
        .all(filter.prefix.length, filter.prefix) as Row[];
    } else {
      rows = this.db.prepare("SELECT * FROM leases ORDER BY resource_id").all() as Row[];
    }
    return rows.map(toLease);
  }

  /**
   * Why the current holder may be displaced, or null when it must be
   * respected. Called inside the acquisition transaction.
   */
  private displacementReason(holder: LeaseRecord, now: number): string | null {
    const session = this.registry.get(holder.sessionId);
    if (!session) return "session_unregistered";
    if (session.processStartTime !== holder.processStartTime || session.pid !== holder.pid) {
      // The registry now describes a different incarnation of that session id.
      return "holder_incarnation_superseded";
    }
    const verdict = this.registry.assess(session);
    if (verdict.verdict === "dead") return verdict.reason;
    const liveness = assessProcess({
      pid: holder.pid,
      host: holder.host,
      bootId: holder.bootId,
      processStartTime: holder.processStartTime,
    });
    if (liveness.state === "dead") return liveness.reason;
    if (liveness.state === "alive" && liveness.reason === "incarnation_matches") return null;
    // Unverifiable holder: only an expired lease may be taken.
    return now > holder.expiresAtMs ? "lease_expired" : null;
  }

  acquire(resourceId: string, owner: LeaseOwner, ttlMs = DEFAULT_LEASE_TTL_MS): LeaseAcquisition {
    const now = this.now();
    const outcome = immediate(this.db, (): LeaseAcquisition => {
      const row = this.db.prepare("SELECT * FROM leases WHERE resource_id = ?").get(resourceId) as Row | undefined;
      const current = row ? toLease(row) : undefined;
      if (
        current &&
        current.sessionId === owner.sessionId &&
        current.pid === owner.process.pid &&
        current.processStartTime === owner.process.processStartTime
      ) {
        this.db
          .prepare(
            "UPDATE leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE resource_id = ? AND generation_id = ?",
          )
          .run(now, now + ttlMs, resourceId, current.generationId);
        return {
          ok: true,
          lease: { ...current, heartbeatAtMs: now, expiresAtMs: now + ttlMs },
          reentrant: true,
          reclaimed: null,
        };
      }
      let reclaimed: { sessionId: string; reason: string } | null = null;
      if (current) {
        const reason = this.displacementReason(current, now);
        if (reason === null) return { ok: false, holder: current, reason: "held_by_live_session" };
        reclaimed = { sessionId: current.sessionId, reason };
        this.db
          .prepare("DELETE FROM leases WHERE resource_id = ? AND generation_id = ?")
          .run(resourceId, current.generationId);
      }
      const lease: LeaseRecord = {
        resourceId,
        sessionId: owner.sessionId,
        pid: owner.process.pid,
        host: owner.process.host,
        bootId: owner.process.bootId,
        processStartTime: owner.process.processStartTime,
        generationId: randomUUID(),
        acquiredAtMs: now,
        heartbeatAtMs: now,
        expiresAtMs: now + ttlMs,
      };
      this.db
        .prepare(
          `INSERT INTO leases (resource_id, session_id, pid, host, boot_id, process_start_time, generation_id,
             acquired_at_ms, heartbeat_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          lease.resourceId,
          lease.sessionId,
          lease.pid,
          lease.host,
          lease.bootId,
          lease.processStartTime,
          lease.generationId,
          lease.acquiredAtMs,
          lease.heartbeatAtMs,
          lease.expiresAtMs,
        );
      return { ok: true, lease, reentrant: false, reclaimed };
    });
    if (outcome.ok) {
      if (outcome.reclaimed) {
        emitRuntimeEvent("lease.reclaimed", {
          resource: resourceId,
          previous_session: outcome.reclaimed.sessionId,
          reason: outcome.reclaimed.reason,
          new_session: owner.sessionId,
          generation_id: outcome.lease.generationId,
        });
      } else if (!outcome.reentrant) {
        emitRuntimeEvent("lease.acquired", {
          resource: resourceId,
          session_id: owner.sessionId,
          generation_id: outcome.lease.generationId,
        });
      }
    } else {
      emitRuntimeEvent("lease.contended", {
        resource: resourceId,
        session_id: owner.sessionId,
        holder_session: outcome.holder.sessionId,
        holder_pid: outcome.holder.pid,
      });
    }
    return outcome;
  }

  /** Extend a lease; false when this generation no longer holds it. */
  renew(resourceId: string, generationId: string, ttlMs = DEFAULT_LEASE_TTL_MS): boolean {
    const now = this.now();
    const result = this.db
      .prepare("UPDATE leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE resource_id = ? AND generation_id = ?")
      .run(now, now + ttlMs, resourceId, generationId);
    return Number(result.changes) === 1;
  }

  /** Release only the generation the caller owns. Never touches a newer lease. */
  release(resourceId: string, generationId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM leases WHERE resource_id = ? AND generation_id = ?")
      .run(resourceId, generationId);
    const released = Number(result.changes) === 1;
    if (released) emitRuntimeEvent("lease.released", { resource: resourceId, generation_id: generationId });
    return released;
  }

  /** Heartbeat helper: extend every lease of a session. Caller holds the transaction. */
  renewSessionLeasesInTransaction(
    sessionId: string,
    _generationId: string,
    now: number,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): void {
    this.db
      .prepare("UPDATE leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE session_id = ?")
      .run(now, now + ttlMs, sessionId);
  }

  /** Drop every lease of a session. Caller holds the transaction. */
  releaseSessionLeasesInTransaction(sessionId: string): number {
    const result = this.db.prepare("DELETE FROM leases WHERE session_id = ?").run(sessionId);
    return Number(result.changes);
  }

  /** Remove leases whose holder is provably gone. Returns what was reclaimed. */
  reapStale(): Array<{ resourceId: string; sessionId: string; reason: string }> {
    const now = this.now();
    return immediate(this.db, () => {
      const reaped: Array<{ resourceId: string; sessionId: string; reason: string }> = [];
      for (const lease of (this.db.prepare("SELECT * FROM leases").all() as Row[]).map(toLease)) {
        const reason = this.displacementReason(lease, now);
        if (reason === null) continue;
        this.db
          .prepare("DELETE FROM leases WHERE resource_id = ? AND generation_id = ?")
          .run(lease.resourceId, lease.generationId);
        reaped.push({ resourceId: lease.resourceId, sessionId: lease.sessionId, reason });
      }
      return reaped;
    });
  }
}
