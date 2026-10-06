/**
 * Startup reconciliation and automatic self-healing (spec §17/§18/§27).
 *
 * Cheap and idempotent, so it runs at every session start and can run again
 * at any time (the doctor's --repair runs the same pass):
 *
 *   - registered sessions whose process is provably gone → orphaned, leases
 *     released, event streams preserved;
 *   - leases whose holder is provably gone → reclaimed;
 *   - ended sessions older than the retention window → pruned.
 */
import type { RuntimeRegistry } from "./RuntimeRegistry.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";

export interface ReconciliationReport {
  orphanedSessions: Array<{ sessionId: string; pid: number; reason: string }>;
  reclaimedLeases: Array<{ resourceId: string; sessionId: string; reason: string }>;
  prunedSessions: number;
}

export class RecoveryManager {
  private readonly registry: RuntimeRegistry;
  private readonly selfSessionId: string | null;

  constructor(registry: RuntimeRegistry, options: { selfSessionId?: string } = {}) {
    this.registry = registry;
    this.selfSessionId = options.selfSessionId ?? null;
  }

  reconcile(): ReconciliationReport {
    const report: ReconciliationReport = { orphanedSessions: [], reclaimedLeases: [], prunedSessions: 0 };
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
    report.prunedSessions = this.registry.prune();
    if (report.orphanedSessions.length > 0 || report.reclaimedLeases.length > 0) {
      emitRuntimeEvent("runtime.recovered", {
        session_id: this.selfSessionId,
        orphaned_sessions: report.orphanedSessions.length,
        reclaimed_leases: report.reclaimedLeases.length,
      });
    }
    return report;
  }
}
