#!/usr/bin/env node
/**
 * Native-vs-Blackhole A/B benchmark runner.
 *
 * Runs the deterministic experiment, writes raw JSONL + CSV, generates the 12
 * SVG plots, and renders a markdown report under docs/evidence/blackhole/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runExperiment } from "../src/benchmark/ExperimentRunner.ts";
import { formatSummary } from "../src/benchmark/Metrics.ts";
import { generatePlots } from "../src/benchmark/Plots.ts";
import { renderReport } from "../src/benchmark/Report.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(REPO_ROOT, "docs/evidence/blackhole");

async function main(): Promise<number> {
  await mkdir(OUT, { recursive: true });
  const result = await runExperiment({ seed: 42 });
  const generatedAt = new Date().toISOString();
  const plotsDir = "plots";
  await mkdir(resolve(OUT, plotsDir), { recursive: true });
  await writeFile(resolve(OUT, "raw.jsonl"), result.rawJsonl, "utf8");
  await writeFile(resolve(OUT, "raw.csv"), result.rawCsv, "utf8");

  const plots = generatePlots(result.runs, result.summaries.native, result.summaries.blackhole);
  for (const p of plots) {
    await writeFile(resolve(OUT, plotsDir, `${p.name}.svg`), p.svg, "utf8");
  }

  const report = renderReport({
    runs: result.runs,
    native: result.summaries.native,
    blackhole: result.summaries.blackhole,
    plotsDir,
    rawJsonlFile: "raw.jsonl",
    rawCsvFile: "raw.csv",
    generatedAt,
  });
  await writeFile(resolve(OUT, "report.md"), report, "utf8");

  console.log(`Native:   ${formatSummary(result.summaries.native).replace(/\n/g, "\n  ")}`);
  console.log(`Blackhole:${formatSummary(result.summaries.blackhole).replace(/\n/g, "\n  ")}`);
  console.log(`\nWrote ${plots.length} plots + report + raw data to ${OUT}`);
  return 0;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
