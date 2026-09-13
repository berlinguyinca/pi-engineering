/**
 * Benchmark metrics — capture + derived metrics for the native-vs-Blackhole A/B
 * comparison. Pure and dependency-free. Metrics are recorded per run and
 * retained as raw data; derived metrics power the report and plots.
 */

export type Condition = "native" | "blackhole";

export interface RunMetrics {
  taskId: string;
  kind: string; // short | medium | long | repeated
  condition: Condition;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  toolCalls: number;
  turns: number;
  /** 0..1 quality score (verified-clean ratio). */
  quality: number;
  /** Blackhole-specific: recall hits/misses and session-memory size. */
  recallHits: number;
  recallMisses: number;
  entries: number;
  compactions: number;
}

export interface ConditionSummary {
  condition: Condition;
  runs: number;
  avgDurationMs: number;
  avgContextTokens: number;
  avgInputTokens: number;
  avgToolCalls: number;
  avgTurns: number;
  avgQuality: number;
  avgRecallHits: number;
  recallRate: number; // hits / (hits + misses)
  /** Context efficiency: tokens per unit of completed work (quality-weighted). */
  contextEfficiency: number;
  /** Autonomy: tool calls per completed run. */
  autonomy: number;
}

export function summarize(runs: RunMetrics[], condition: Condition): ConditionSummary {
  const r = runs.filter((x) => x.condition === condition);
  const n = r.length || 1;
  const avg = (fn: (m: RunMetrics) => number) => r.reduce((a, m) => a + fn(m), 0) / n;
  const hits = r.reduce((a, m) => a + m.recallHits, 0);
  const misses = r.reduce((a, m) => a + m.recallMisses, 0);
  return {
    condition,
    runs: r.length,
    avgDurationMs: avg((m) => m.durationMs),
    avgContextTokens: avg((m) => m.contextTokens),
    avgInputTokens: avg((m) => m.inputTokens),
    avgToolCalls: avg((m) => m.toolCalls),
    avgTurns: avg((m) => m.turns),
    avgQuality: avg((m) => m.quality),
    avgRecallHits: avg((m) => m.recallHits),
    recallRate: hits + misses === 0 ? 0 : hits / (hits + misses),
    // Efficiency = quality per context token (higher is better).
    contextEfficiency: r.length
      ? (r.reduce((a, m) => a + m.quality, 0) / (r.reduce((a, m) => a + m.contextTokens, 0) || 1)) * 1000
      : 0,
    autonomy: avg((m) => m.toolCalls),
  };
}

export function formatSummary(s: ConditionSummary): string {
  return [
    `[${s.condition}] runs=${s.runs}`,
    `  duration ms=${s.avgDurationMs.toFixed(0)} ctx=${s.avgContextTokens.toFixed(0)} in=${s.avgInputTokens.toFixed(0)}`,
    `  toolCalls=${s.avgToolCalls.toFixed(1)} turns=${s.avgTurns.toFixed(1)} quality=${s.avgQuality.toFixed(2)}`,
    s.condition === "blackhole"
      ? `  recall rate=${(s.recallRate * 100).toFixed(1)}% efficiency=${s.contextEfficiency.toFixed(2)}`
      : `  efficiency=${s.contextEfficiency.toFixed(2)}`,
  ].join("\n");
}
