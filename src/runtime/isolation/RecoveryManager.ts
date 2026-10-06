/**
 * Startup reconciliation and automatic self-healing (spec §17/§18/§27).
 *
 * Cheap and idempotent, so it runs at every session start and can run again
 * at any time (the doctor's --repair runs the same pass):
 *
 *   - registered sessions whose process is provably gone → orphaned, leases
 *     released, event streams preserved;
 *   - leases whose holder is provably gone → reclaimed;
 *   - a dead session's event stream ending in a torn record (killed mid-write)
 *     → the broken tail is quarantined and truncated, valid history kept;
 *   - ended sessions older than the retention window → pruned.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeRegistry } from "./RuntimeRegistry.ts";
import { endsCleanly, repairTornTail } from "./jsonlFiles.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";

export interface ReconciliationReport {
  orphanedSessions: Array<{ sessionId: string; pid: number; reason: string }>;
  reclaimedLeases: Array<{ resourceId: string; sessionId: string; reason: string }>;
  repairedStreams: Array<{ stream: string; quarantine: string; bytes: number }>;
  prunedSessions: number;
}

/** A stream of an unregistered session is only repaired once it has been quiet this long. */
const UNKNOWN_WRITER_QUIET_MS = 5 * 60_000;

export class RecoveryManager {
  private readonly registry: RuntimeRegistry;
  private readonly selfSessionId: string | null;
  private readonly stateRoot: string | null;

  constructor(registry: RuntimeRegistry, options: { selfSessionId?: string; stateRoot?: string } = {}) {
    this.registry = registry;
    this.selfSessionId = options.selfSessionId ?? null;
    this.stateRoot = options.stateRoot ?? null;
  }

  /** Every namespace directory this machine knows about. */
  namespaceDirs(): string[] {
    const dirs = new Set<string>();
    if (this.stateRoot) {
      for (const scope of ["worktrees", "sessions"]) {
        try {
          for (const name of readdirSync(join(this.stateRoot, scope))) dirs.add(join(this.stateRoot, scope, name));
        } catch {
          // Scope not created yet.
        }
      }
    }
    for (const session of this.registry.list({ includeEnded: true })) {
      if (session.runtimePath) dirs.add(session.runtimePath);
    }
    return [...dirs];
  }

  private writerIsGone(sessionId: string, file: string): boolean {
    if (sessionId === this.selfSessionId) return false;
    const record = this.registry.get(sessionId);
    if (record) return this.registry.assess(record).verdict === "dead";
    try {
      return Date.now() - statSync(file).mtimeMs > UNKNOWN_WRITER_QUIET_MS;
    } catch {
      return false;
    }
  }

  /** Quarantine + truncate torn tails of streams whose writer is gone. */
  repairDeadStreams(): ReconciliationReport["repairedStreams"] {
    const repaired: ReconciliationReport["repairedStreams"] = [];
    for (const dir of this.namespaceDirs()) {
      let names: string[];
      try {
        names = readdirSync(join(dir, "events"));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl") || name.startsWith("legacy-")) continue;
        const file = join(dir, "events", name);
        if (endsCleanly(file)) continue;
        const sessionId = name.slice(0, -".jsonl".length);
        if (!this.writerIsGone(sessionId, file)) continue;
        try {
          const result = repairTornTail(file, join(dir, "recovery"));
          if (!result) continue;
          repaired.push({ stream: file, ...result });
          emitRuntimeEvent("event_stream.corruption_detected", { stream: file, kind: "torn_tail", writer: sessionId });
          emitRuntimeEvent("event_stream.recovered", {
            stream: file,
            quarantine: result.quarantine,
            bytes: result.bytes,
            recovered_by: this.selfSessionId,
          });
        } catch {
          // Degraded, not fatal: readers already ignore incomplete tails.
        }
      }
    }
    return repaired;
  }

  reconcile(): ReconciliationReport {
    const report: ReconciliationReport = {
      orphanedSessions: [],
      reclaimedLeases: [],
      repairedStreams: [],
      prunedSessions: 0,
    };
    for (const session of this.registry.list()) {
      if (session.sessionId === this.selfSessionId) continue;
      const verdict = this.registry.assess(session);
      if (verdict.verdict !== "dead") continue;
      if (this.registry.markDead(session, "orphaned")) {
        report.orphanedSessions.push({ sessionId: session.sessionId, pid: session.pid, reason: verdict.reason });
        emitRuntimeEvent("session.orphaned", {
          session_id: session.sessionId,
          worktree_id: session.worktreeId,
          pid: session.pid,
          reason: verdict.reason,
          recovered_by: this.selfSessionId,
        });
      }
    }
    for (const lease of this.registry.leases.reapStale()) {
      report.reclaimedLeases.push(lease);
      emitRuntimeEvent("lease.expired", {
        resource: lease.resourceId,
        previous_session: lease.sessionId,
        reason: lease.reason,
        recovered_by: this.selfSessionId,
      });
    }
    report.repairedStreams = this.repairDeadStreams();
    report.prunedSessions = this.registry.prune();
    if (report.orphanedSessions.length > 0 || report.reclaimedLeases.length > 0 || report.repairedStreams.length > 0) {
      emitRuntimeEvent("runtime.recovered", {
        session_id: this.selfSessionId,
        orphaned_sessions: report.orphanedSessions.length,
        reclaimed_leases: report.reclaimedLeases.length,
        repaired_streams: report.repairedStreams.length,
      });
    }
    return report;
  }
}
