/**
 * Blackhole telemetry — deterministic snapshot mergeable into the runtime
 * telemetry export (B-105) and emitted to the ledger.
 */
import type { BlackholeManagerState } from "./types.ts";

export interface BlackholeTelemetry {
  enabled: boolean;
  version: string;
  provider: BlackholeManagerState["provider"];
  sessions: number;
  activeSessions: number;
  entries: number;
  compactions: number;
  promotionCandidates: number;
  promoted: number;
  memoryWorkers: BlackholeManagerState["memoryWorkersRun"];
}

export function blackholeTelemetry(state: BlackholeManagerState): BlackholeTelemetry {
  return {
    enabled: state.enabled,
    version: state.version,
    provider: state.provider,
    sessions: state.sessions,
    activeSessions: state.activeSessions,
    entries: state.entries,
    compactions: state.compactions,
    promotionCandidates: state.promotionCandidates,
    promoted: state.promoted,
    memoryWorkers: { ...state.memoryWorkersRun },
  };
}

export function formatBlackholeTelemetry(t: BlackholeTelemetry): string {
  const lines = [
    `blackhole ${t.enabled ? "ENABLED" : "disabled"} (provider=${t.provider} version=${t.version})`,
    `  sessions=${t.sessions} active=${t.activeSessions} entries=${t.entries} compactions=${t.compactions}`,
    `  promotions: candidates=${t.promotionCandidates} promoted=${t.promoted}`,
    `  memory workers: observer=${t.memoryWorkers.observer} reflector=${t.memoryWorkers.reflector} dropper=${t.memoryWorkers.dropper}`,
  ];
  return lines.join("\n");
}
