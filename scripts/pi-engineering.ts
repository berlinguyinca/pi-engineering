#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
/**
 * pi-engineering CLI.
 *
 *   node scripts/pi-engineering.ts roadmap check [--json] [--no-refresh]
 *   node scripts/pi-engineering.ts roadmap status [--json]
 *
 * `roadmap check` exit codes:
 *   0  roadmap 1.0 complete (release gate passes)
 *   1  valid roadmap, not yet complete
 *   2  invalid roadmap definition
 *   3  infrastructure/check error
 */
import { resolve } from "node:path";
import { runExperiment } from "../src/benchmark/ExperimentRunner.ts";
import { formatSummary } from "../src/benchmark/Metrics.ts";
import { generatePlots } from "../src/benchmark/Plots.ts";
import { BlackholeManager } from "../src/blackhole/BlackholeManager.ts";
import { blackholeTelemetry, formatBlackholeTelemetry } from "../src/blackhole/telemetry.ts";
import { Ledger } from "../src/ledger/Ledger.ts";
import { defaultCliPaths, runRoadmapCheck, runRoadmapStatus } from "../src/roadmap/cli.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  if (cmd === "blackhole") {
    const sub = rest.find((a) => !a.startsWith("--"));
    return blackholeCommand(sub ?? "status", rest);
  }
  if (cmd === "benchmark") {
    return benchmarkCommand(rest);
  }
  if (cmd === "cav") {
    return cavCommand(rest);
  }
  if (cmd !== "roadmap") {
    console.error(
      "usage: pi-engineering <roadmap check|roadmap status|blackhole ...|benchmark|cav status|...> [flags]",
    );
    return 2;
  }
  const json = rest.includes("--json");
  const refresh = !rest.includes("--no-refresh");
  const sub = rest.find((a) => !a.startsWith("--"));
  const paths = defaultCliPaths(REPO_ROOT);
  if (sub === "check") {
    const { exitCode, text } = await runRoadmapCheck({ ...paths, repoRoot: REPO_ROOT, json, refresh });
    console.log(text);
    return exitCode;
  }
  if (sub === "status") {
    const { exitCode, text } = await runRoadmapStatus({ ...paths, repoRoot: REPO_ROOT, json, refresh: false });
    console.log(text);
    return exitCode;
  }
  console.error("usage: pi-engineering <roadmap check|roadmap status|blackhole ...|benchmark> [flags]");
  return 2;
}

async function cavCommand(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const sub = rest.find((a) => !a.startsWith("--"));
  const { stepsDir, ledgerFile } = await import("../src/cav/index.ts").then((m) => m.cavPaths(REPO_ROOT));
  const { CavEvidenceLedger, evaluatePhaseGate, groupPhases, loadCavSteps } = await import("../src/cav/index.ts");
  const steps = loadCavSteps(stepsDir);
  const ledger = await CavEvidenceLedger.open(ledgerFile);
  const phases = groupPhases(steps);
  const gates = phases.map((p) => evaluatePhaseGate(p, ledger));
  const verified = steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length;
  const failed = steps.filter((s) => {
    const st = ledger.latestStatus(s.id);
    return st === "SPECIFIED" || st === undefined;
  }).length;
  if (sub === "status") {
    if (json) {
      console.log(
        JSON.stringify(
          { total: steps.length, verified, phases: gates.map((g) => ({ id: g.phase.id, state: g.state })) },
          null,
          2,
        ),
      );
      return 0;
    }
    const lines: string[] = [`CAV — ${steps.length} atomic steps, ${phases.length} phases`];
    lines.push(`  verified: ${verified}/${steps.length}`);
    for (const g of gates) {
      lines.push(`  - ${g.phase.id} ${g.phase.name}: ${g.state} (${g.verifiedSteps}/${g.totalSteps})`);
    }
    console.log(lines.join("\n"));
    return 0;
  }
  if (sub === "check") {
    if (json) {
      console.log(JSON.stringify({ total: steps.length, verified, phases: gates.map((g) => g) }, null, 2));
    } else {
      const lines: string[] = [`CAV check — ${steps.length} atomic steps`];
      lines.push(`  verified: ${verified}/${steps.length}`);
      for (const g of gates) {
        lines.push(`  - ${g.phase.id} ${g.phase.name}: ${g.state}`);
        for (const b of g.blockers) lines.push(`      \u2022 ${b}`);
      }
      console.log(lines.join("\n"));
    }
    return verified === steps.length ? 0 : 1;
  }
  console.error("usage: pi-engineering cav <status|check> [--json]");
  return 2;
}

async function blackholeCommand(sub: string, rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const ledger = await Ledger.create(resolve(REPO_ROOT, ".pi-eng/blackhole-ledger.jsonl"));
  const mgr = await BlackholeManager.open({
    ledger,
    config: rest.includes("--enable") ? { enabled: true } : { enabled: false },
  });
  const t = blackholeTelemetry(mgr.state());
  if (sub === "validate") {
    const { validateBlackholePackage } = await import("../src/blackhole/versioning.ts");
    const { validation } = await validateBlackholePackage({ enabled: true, requestedVersion: mgr.config.version });
    console.log(
      json
        ? JSON.stringify(validation, null, 2)
        : `provider=${validation.provider} ok=${validation.ok}: ${validation.reason}`,
    );
    return validation.ok ? 0 : 1;
  }
  if (sub === "status") {
    console.log(json ? JSON.stringify(t, null, 2) : formatBlackholeTelemetry(t));
    return 0;
  }
  if (sub === "benchmark") {
    return benchmarkCommand(rest);
  }
  console.error("usage: pi-engineering blackhole <status|validate|benchmark> [--enable] [--json]");
  return 2;
}

async function benchmarkCommand(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const result = await runExperiment({
    seed: rest.find((a) => /^--seed=/.test(a)) ? Number(rest.find((a) => /^--seed=/.test(a))!.split("=")[1]) : 42,
  });
  const out = resolve(REPO_ROOT, "docs/evidence/blackhole");
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "raw.jsonl"), result.rawJsonl, "utf8");
  await writeFile(resolve(out, "raw.csv"), result.rawCsv, "utf8");
  const plotsDir = resolve(out, "plots");
  await mkdir(plotsDir, { recursive: true });
  for (const p of generatePlots(result.runs, result.summaries.native, result.summaries.blackhole)) {
    await writeFile(resolve(plotsDir, `${p.name}.svg`), p.svg, "utf8");
  }
  const { renderReport } = await import("../src/benchmark/Report.ts");
  const report = renderReport({
    runs: result.runs,
    native: result.summaries.native,
    blackhole: result.summaries.blackhole,
    plotsDir: "plots",
    rawJsonlFile: "raw.jsonl",
    rawCsvFile: "raw.csv",
    generatedAt: new Date().toISOString(),
  });
  await writeFile(resolve(out, "report.md"), report, "utf8");
  if (json) {
    console.log(JSON.stringify(result.summaries, null, 2));
  } else {
    console.log(formatSummary(result.summaries.native));
    console.log(formatSummary(result.summaries.blackhole));
    console.log(`\nReport + ${12} plots + raw data written to ${out}`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 3;
  });
