/**
 * Runtime introspection (spec §25): what this Pi session is bound to, how
 * healthy its runtime is, and who else is working in the same worktree.
 */
import { RuntimeSession } from "./RuntimeSession.ts";
import { type RuntimeEvent, recentRuntimeEvents } from "./runtimeEvents.ts";

export interface RuntimeStatusReport {
  sessionId: string;
  startedAt: string;
  health: string;
  healthReason: string | null;
  repository: string | null;
  worktree: string | null;
  worktreeId: string | null;
  bindingKind: string | null;
  eventWriter: "session-local" | "memory" | "unbound";
  concurrentSessions: number | null;
  lastHeartbeatAgoMs: number | null;
  registry: string | null;
  lastReconciliation: {
    orphanedSessions: number;
    reclaimedLeases: number;
    repairedStreams: number;
  } | null;
  recentEvents: RuntimeEvent[];
}

export function runtimeStatus(options: { session?: RuntimeSession; events?: number } = {}): RuntimeStatusReport {
  const session = options.session ?? RuntimeSession.current();
  const binding = session.binding;
  const registry = session.registry();
  let concurrentSessions: number | null = null;
  if (registry && binding?.worktreeId) {
    try {
      concurrentSessions = registry
        .list({ worktreeId: binding.worktreeId })
        .filter((record) => registry.assess(record).verdict !== "dead").length;
    } catch {
      concurrentSessions = null;
    }
  }
  const reconciliation = session.lastReconciliation;
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    health: session.health.state,
    healthReason: session.health.reason,
    repository: binding?.repoName ?? null,
    worktree: binding?.worktreePath ?? null,
    worktreeId: binding?.worktreeId ?? null,
    bindingKind: binding?.kind ?? null,
    eventWriter: !binding ? "unbound" : binding.kind === "memory" ? "memory" : "session-local",
    concurrentSessions,
    lastHeartbeatAgoMs: session.lastHeartbeatMs === null ? null : Math.max(0, Date.now() - session.lastHeartbeatMs),
    registry: registry?.file ?? null,
    lastReconciliation: reconciliation
      ? {
          orphanedSessions: reconciliation.orphanedSessions.length,
          reclaimedLeases: reconciliation.reclaimedLeases.length,
          repairedStreams: reconciliation.repairedStreams.length,
        }
      : null,
    recentEvents: recentRuntimeEvents(options.events ?? 0),
  };
}

function short(id: string | null): string {
  return id ? `${id.slice(0, 8)}…` : "—";
}

function ago(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 1_000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatRuntimeStatus(report: RuntimeStatusReport): string {
  const lines = [
    `Repository: ${report.repository ?? "—"}`,
    `Worktree: ${report.worktree ?? "— (unbound)"}`,
    `Worktree ID: ${short(report.worktreeId)}`,
    `Session: ${short(report.sessionId)}`,
    `Runtime: ${report.health}${report.healthReason ? ` (${report.healthReason})` : ""}`,
    `Event writer: ${report.eventWriter}${report.bindingKind && report.bindingKind !== "worktree" ? ` [${report.bindingKind}]` : ""}`,
    `Concurrent sessions: ${report.concurrentSessions ?? "unknown"}`,
    `Last heartbeat: ${ago(report.lastHeartbeatAgoMs)}`,
  ];
  const recovery = report.lastReconciliation;
  if (recovery && recovery.orphanedSessions + recovery.reclaimedLeases + recovery.repairedStreams > 0) {
    lines.push(
      `Startup recovery: ${recovery.orphanedSessions} stale session(s), ${recovery.reclaimedLeases} lease(s), ${recovery.repairedStreams} stream(s) repaired`,
    );
  }
  if (report.recentEvents.length > 0) {
    lines.push("", "Recent runtime events:");
    for (const event of report.recentEvents) {
      const { event: name, at, ...rest } = event;
      const detail = Object.entries(rest)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ");
      lines.push(`  ${at.slice(11, 19)} ${name} ${detail}`.slice(0, 240));
    }
  }
  return lines.join("\n");
}
