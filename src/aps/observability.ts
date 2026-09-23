/**
 * APS Phase 6 — observability (Grafana-ready aggregates) and TUI notices.
 *
 * Accumulates APS events (loop candidate, loop prevented, recovery, escalation)
 * into the counters/gauges the spec's Grafana panels require:
 *
 *   - loop rate by model
 *   - recovery success rate
 *   - no-progress turns per session
 *   - loops by tool / context-utilization bucket
 *   - compaction frequency
 *   - escalation frequency
 *
 * All aggregation is deterministic and side-effect free; `snapshot()` returns a
 * plain object safe to export to a metrics endpoint or Grafana.
 */

import type { EscalationEvent } from "./escalation.ts";
import type { ApsRecoveryAction } from "./recovery.ts";
import type { AgentLoopEvent, AgentLoopPreventedEvent, SemanticStrategyFamily } from "./types.ts";

export type ContextUtilizationBucket = "<0.5" | "0.5-0.75" | "0.75-0.9" | ">=0.9";

function bucketFor(utilization: number | null): ContextUtilizationBucket {
  if (utilization === null) return "<0.5";
  if (utilization < 0.5) return "<0.5";
  if (utilization < 0.75) return "0.5-0.75";
  if (utilization < 0.9) return "0.75-0.9";
  return ">=0.9";
}

export interface ApsSnapshot {
  totals: {
    loopCandidates: number;
    loopsPrevented: number;
    recoveries: number;
    compactions: number;
    replans: number;
    modelEscalations: number;
    humanEscalations: number;
  };
  loopRateByModel: Record<string, number>;
  recoverySuccessRate: number | null;
  noProgressTurnsBySession: Record<string, number>;
  loopsByTool: Record<string, number>;
  loopsByContextUtilizationBucket: Record<ContextUtilizationBucket, number>;
  compactionFrequency: number;
  escalationFrequency: number;
}

export function emptySnapshot(): ApsSnapshot {
  return {
    totals: {
      loopCandidates: 0,
      loopsPrevented: 0,
      recoveries: 0,
      compactions: 0,
      replans: 0,
      modelEscalations: 0,
      humanEscalations: 0,
    },
    loopRateByModel: {},
    recoverySuccessRate: null,
    noProgressTurnsBySession: {},
    loopsByTool: {},
    loopsByContextUtilizationBucket: { "<0.5": 0, "0.5-0.75": 0, "0.75-0.9": 0, ">=0.9": 0 },
    compactionFrequency: 0,
    escalationFrequency: 0,
  };
}

export class ApsObservability {
  private s = emptySnapshot();
  private preventedCount = 0;
  private recoveredAfterPrevention = 0;

  recordCandidate(event: AgentLoopEvent): void {
    this.s.totals.loopCandidates += 1;
    const modelKey = event.model?.id ?? "unknown";
    this.s.loopRateByModel[modelKey] = (this.s.loopRateByModel[modelKey] ?? 0) + 1;
    const turns = event.metrics.noProgressTurns;
    if (turns > (this.s.noProgressTurnsBySession[event.sessionId] ?? 0)) {
      this.s.noProgressTurnsBySession[event.sessionId] = turns;
    }
    this.s.loopsByTool[event.tool] = (this.s.loopsByTool[event.tool] ?? 0) + 1;
    this.s.loopsByContextUtilizationBucket[bucketFor(event.contextUtilization ?? null)] += 1;
  }

  recordPrevented(event: AgentLoopPreventedEvent): void {
    this.s.totals.loopsPrevented += 1;
    this.preventedCount += 1;
    this.recordCandidate(event);
  }

  recordRecovery(action: ApsRecoveryAction): void {
    this.s.totals.recoveries += 1;
    if (action === "compact") this.s.totals.compactions += 1;
    if (action === "replan") this.s.totals.replans += 1;
    this.s.compactionFrequency = this.s.totals.compactions;
  }

  /** Mark that a prevented run subsequently progressed (recovery succeeded). */
  recordRecoveryOutcome(success: boolean): void {
    if (success) this.recoveredAfterPrevention += 1;
    this.s.recoverySuccessRate =
      this.preventedCount === 0 ? null : Math.min(1, this.recoveredAfterPrevention / this.preventedCount);
  }

  recordEscalation(event: EscalationEvent): void {
    this.s.escalationFrequency += 1;
    if (event.toModel === null) this.s.totals.humanEscalations += 1;
    else this.s.totals.modelEscalations += 1;
  }

  snapshot(): ApsSnapshot {
    return this.s;
  }
}

/**
 * A human-readable single-line notice for the Pi TUI (rendered through the same
 * sink as guard telemetry). Keeps the event surface minimal — never raw JSON.
 */
export function apsNotice(event: AgentLoopEvent | AgentLoopPreventedEvent | EscalationEvent): string {
  if (event.type === "agent.escalation") {
    return `APS escalation · ${event.role} · ${event.toModel ? `→ ${event.toModel}` : "→ human"}`;
  }
  if (event.type === "agent.loop_prevented") {
    return `APS loop prevented · ${event.role} · ${event.family} · ${event.metrics.noProgressTurns} identical turns`;
  }
  const fam = event.family as SemanticStrategyFamily;
  return `APS loop candidate · ${event.role} · ${fam} · ${event.metrics.noProgressTurns} turns`;
}
