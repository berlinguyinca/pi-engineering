/**
 * Benchmark report generator — writes a human/machine-readable markdown report
 * summarizing the native-vs-Blackhole A/B experiment and embedding the 12 plots.
 */
import { type ConditionSummary, formatSummary } from "./Metrics.ts";
import type { RunMetrics } from "./Metrics.ts";
import { type PlotSpec, generatePlots } from "./Plots.ts";

export interface ReportInput {
  runs: RunMetrics[];
  native: ConditionSummary;
  blackhole: ConditionSummary;
  plotsDir: string;
  rawJsonlFile: string;
  rawCsvFile: string;
  compactionResult?: { removed: number; retainedPriority: number; summary: string };
  generatedAt: string;
}

export function renderReport(input: ReportInput): string {
  const { native, blackhole } = input;
  const improvement = {
    context: pct(native.avgContextTokens, blackhole.avgContextTokens),
    efficiency: pct(native.contextEfficiency, blackhole.contextEfficiency),
    quality: pct(native.avgQuality, blackhole.avgQuality),
    duration: pct(native.avgDurationMs, blackhole.avgDurationMs),
  };
  const plots = generatePlots(input.runs, native, blackhole);
  const methodology = [
    "> METHODOLOGY NOTE: This benchmark runs a **deterministic, model-free simulator** that",
    "> models the observable effect of session memory (recall reduces recomputed context;",
    "> repeated tasks reuse prior memory). It does NOT run live model inference. Its purpose",
    "> is to validate the measurement pipeline (metrics, raw-data retention, plots, report)",
    "> and to make the expected direction of effect visible and reproducible. Real-model",
    "> numbers can be substituted by supplying a `simulate` callback that feeds actual",
    "> worker telemetry into `runExperiment`. The simulator's advantage is a modeling",
    "> assumption, not a measured claim.",
    "",
  ];
  const lines: string[] = [
    "# Pi Engineering — Native vs Blackhole A/B Benchmark",
    "",
    `Generated: ${input.generatedAt}`,
    "",
    ...methodology,
    "## Conditions",
    "",
    "- **native**: engineering runtime without session memory (baseline).",
    "- **blackhole**: runtime with per-session Blackhole memory enabled.",
    "",
    "## Summary",
    "",
    "```",
    formatSummary(native),
    formatSummary(blackhole),
    "```",
    "",
    "## Relative improvement (blackhole over native)",
    "",
    "| Metric | Native | Blackhole | Δ |",
    "| --- | --- | --- | --- |",
    `| context tokens | ${native.avgContextTokens.toFixed(0)} | ${blackhole.avgContextTokens.toFixed(0)} | ${improvement.context}% |`,
    `| context efficiency | ${native.contextEfficiency.toFixed(2)} | ${blackhole.contextEfficiency.toFixed(2)} | ${improvement.efficiency}% |`,
    `| quality | ${native.avgQuality.toFixed(3)} | ${blackhole.avgQuality.toFixed(3)} | ${improvement.quality}% |`,
    `| duration (ms) | ${native.avgDurationMs.toFixed(0)} | ${blackhole.avgDurationMs.toFixed(0)} | ${improvement.duration}% |`,
    `| recall rate | ${(native.recallRate * 100).toFixed(1)}% | ${(blackhole.recallRate * 100).toFixed(1)}% | — |`,
    "",
    "> Δ = percent change from native to blackhole (negative = reduction/improvement for context/duration;",
    "> positive = gain for efficiency/quality).",
    "",
    "## Plots",
    "",
  ];
  for (const p of plots) {
    lines.push(`### ${p.title}`, "", `![${p.title}](${input.plotsDir}/${p.name}.svg)`, "");
  }
  if (input.compactionResult) {
    lines.push(
      "## Compaction-quality degradation",
      "",
      `Removed entries: ${input.compactionResult.removed}`,
      `Retained highest-priority content ratio: ${(input.compactionResult.retainedPriority * 100).toFixed(0)}%`,
      "",
      "> Repeated compaction must preserve highest-priority content (quality degradation bounded).",
      "",
    );
  }
  lines.push(
    "## Raw data",
    "",
    `- JSONL: \`${input.rawJsonlFile}\``,
    `- CSV: \`${input.rawCsvFile}\``,
    "",
    "> Raw data is preserved exactly (no aggregation loss) for re-analysis.",
  );
  return lines.join("\n");
}

function pct(a: number, b: number): string {
  if (a === 0) return "—";
  return (((b - a) / a) * 100).toFixed(1);
}

export type { PlotSpec };
