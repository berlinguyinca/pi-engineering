import assert from "node:assert/strict";
import { test } from "node:test";
import { runExperiment } from "../../src/benchmark/ExperimentRunner.ts";
import { summarize } from "../../src/benchmark/Metrics.ts";
import { generatePlots } from "../../src/benchmark/Plots.ts";
import { renderReport } from "../../src/benchmark/Report.ts";

test("experiment: paired native-vs-blackhole runs are retained exactly as raw data", async () => {
  const result = await runExperiment({ seed: 42 });
  // Raw data is preserved (JSONL + CSV), no aggregation loss.
  assert.ok(result.rawJsonl.length > 0);
  assert.ok(result.rawCsv.startsWith("taskId,kind,condition"));
  assert.ok(result.runs.length >= 20);
  assert.ok(result.runs.some((r) => r.condition === "native"));
  assert.ok(result.runs.some((r) => r.condition === "blackhole"));
  // Deterministic seed → reproducible.
  const again = await runExperiment({ seed: 42 });
  assert.equal(result.rawJsonl, again.rawJsonl, "same seed reproduces identical raw data");
});

test("experiment: blackhole improves context efficiency and recall over native", async () => {
  const result = await runExperiment({ seed: 7 });
  assert.ok(result.summaries.blackhole.avgContextTokens < result.summaries.native.avgContextTokens);
  assert.ok(result.summaries.blackhole.contextEfficiency > result.summaries.native.contextEfficiency);
  assert.ok(result.summaries.blackhole.recallRate > 0.5);
  assert.equal(result.summaries.native.recallRate, 0);
});

test("summarize: computes derived metrics correctly", async () => {
  const runs = [
    {
      taskId: "a",
      kind: "short",
      condition: "blackhole" as const,
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 10,
      contextTokens: 90,
      toolCalls: 2,
      turns: 1,
      quality: 0.9,
      recallHits: 3,
      recallMisses: 1,
      entries: 2,
      compactions: 0,
    },
  ];
  const s = summarize(runs, "blackhole");
  assert.equal(s.recallRate, 0.75);
  assert.equal(s.runs, 1);
  assert.ok(s.contextEfficiency > 0);
});

test("plots: all 12 required plots are generated as well-formed SVG", async () => {
  const result = await runExperiment({ seed: 42 });
  const plots = generatePlots(result.runs, result.summaries.native, result.summaries.blackhole);
  assert.equal(plots.length, 12);
  for (const p of plots) {
    assert.ok(p.svg.startsWith("<svg"), `${p.name} must be an SVG`);
    assert.ok(p.svg.endsWith("</svg>"), `${p.name} must close the SVG element`);
    assert.ok(p.svg.includes("</svg>"));
  }
  // The 12 required plot titles are present.
  const names = plots.map((p) => p.name);
  assert.ok(names.includes("01-context-tokens"));
  assert.ok(names.includes("12-quality-bar"));
});

test("report: renders a readable markdown report with plots and raw-data links", async () => {
  const result = await runExperiment({ seed: 42 });
  const report = renderReport({
    runs: result.runs,
    native: result.summaries.native,
    blackhole: result.summaries.blackhole,
    plotsDir: "plots",
    rawJsonlFile: "raw.jsonl",
    rawCsvFile: "raw.csv",
    generatedAt: "2026-01-01T00:00:00.000Z",
    compactionResult: { removed: 5, retainedPriority: 0.8, summary: "x" },
  });
  assert.ok(report.includes("# Pi Engineering — Native vs Blackhole A/B Benchmark"));
  assert.ok(report.includes("Context tokens per run"));
  assert.ok(report.includes("raw.jsonl"));
  assert.ok(report.includes("plots/01-context-tokens.svg"));
  assert.ok(report.includes("Compaction-quality degradation"));
  assert.match(report, /blackhole/);
});
