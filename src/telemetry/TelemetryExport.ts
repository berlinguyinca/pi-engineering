/**
 * Local observability export (core-scoped portion of backlog B-105).
 *
 * A hosted control plane / Go control plane are genuinely out of scope for a
 * standalone TypeScript package — they require external hosting and separate
 * infrastructure that the project constraint keeps OUT of core. What core CAN
 * provide is a deterministic, machine-readable telemetry export seam: a compact
 * snapshot a control plane or dashboard can consume. `exportTelemetry` is pure
 * and dependency-free.
 */
export interface TelemetrySnapshot {
  generatedAt: string;
  runtime: {
    workers: Record<string, number>;
    toolCalls: number;
    verifyStages: number;
    evidence: number;
    blockedOrFailedWorkers: number;
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    turns: number;
  };
  /** Optional per-run ledger-derived summary (caller supplies). */
  runs?: Array<{ id: string; outcome: string }>;
}

/** Deterministic, JSON-serializable snapshot (timestamps via injected clock). */
export function exportTelemetry(
  runtime: TelemetrySnapshot["runtime"],
  opts: { runs?: Array<{ id: string; outcome: string }>; now?: () => string } = {},
): TelemetrySnapshot {
  return {
    generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
    runtime: { ...runtime },
    runs: opts.runs,
  };
}

/** Render a telemetry snapshot as a compact human/machine table (for a dashboard). */
export function formatTelemetry(snapshot: TelemetrySnapshot): string {
  const r = snapshot.runtime;
  const lines = [
    `telemetry @ ${snapshot.generatedAt}`,
    `  workers: ${
      Object.entries(r.workers)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    `  toolCalls=${r.toolCalls} verifyStages=${r.verifyStages} evidence=${r.evidence} blockedOrFailed=${r.blockedOrFailedWorkers}`,
    `  tokens in=${r.inputTokens} out=${r.outputTokens} ctx=${r.contextTokens} turns=${r.turns}`,
  ];
  if (snapshot.runs && snapshot.runs.length > 0) {
    lines.push(`  runs: ${snapshot.runs.map((x) => `${x.id}:${x.outcome}`).join(", ")}`);
  }
  return lines.join("\n");
}
