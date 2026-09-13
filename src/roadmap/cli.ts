/**
 * `pi-engineering roadmap ...` CLI (spec §32). Deterministic exit codes:
 *   0 complete | 1 valid but not complete | 2 invalid roadmap/usage | 3 infra error.
 */
import { resolve } from "node:path";
import { RoadmapEngine, RoadmapError } from "./RoadmapEngine.ts";
import type { RoadmapCheckExitCode, RoadmapCheckResult } from "./types.ts";

export interface RoadmapCliOptions {
  repoRoot: string;
  roadmapPath: string;
  evidenceFile: string;
  manualEvidencePath: string;
  json: boolean;
  refresh: boolean;
}

export interface RoadmapCliResult {
  exitCode: RoadmapCheckExitCode;
  text: string;
}

function printHuman(result: RoadmapCheckResult, kind: "check" | "status"): string {
  const lines: string[] = [`Roadmap ${result.roadmap} — ${kind}`];
  lines.push(`  complete: ${result.complete}`);
  lines.push(`  verified: ${result.verified}/${result.required} required milestones`);
  lines.push(`  release gate: ${result.releaseGate}`);
  for (const m of result.detail.milestones) {
    const flag = m.milestone.required ? "" : " (optional)";
    lines.push(`  - ${m.milestone.id} ${m.milestone.name}${flag}: ${m.state}`);
    for (const b of m.blockers) lines.push(`      \u2022 ${b}`);
  }
  for (const b of result.detail.releaseGate.blockers) lines.push(`  gate: ${b}`);
  return lines.join("\n");
}

export async function runRoadmapCheck(opts: RoadmapCliOptions): Promise<RoadmapCliResult> {
  let engine: RoadmapEngine;
  try {
    engine = await RoadmapEngine.open({
      repoRoot: opts.repoRoot,
      roadmapPath: opts.roadmapPath,
      evidenceFile: opts.evidenceFile,
      manualEvidencePath: opts.manualEvidencePath,
    });
  } catch (err) {
    const code = (err instanceof RoadmapError ? err.exitCode : 3) as RoadmapCheckExitCode;
    return { exitCode: code, text: opts.json ? JSON.stringify({ error: String(err), exitCode: code }) : String(err) };
  }
  const result = await engine.check({ refresh: opts.refresh });
  const text = opts.json ? JSON.stringify(result, null, 2) : printHuman(result, "check");
  return { exitCode: result.exitCode as RoadmapCheckExitCode, text };
}

export async function runRoadmapStatus(opts: RoadmapCliOptions): Promise<RoadmapCliResult> {
  let engine: RoadmapEngine;
  try {
    engine = await RoadmapEngine.open({
      repoRoot: opts.repoRoot,
      roadmapPath: opts.roadmapPath,
      evidenceFile: opts.evidenceFile,
      manualEvidencePath: opts.manualEvidencePath,
    });
  } catch (err) {
    const code = (err instanceof RoadmapError ? err.exitCode : 3) as RoadmapCheckExitCode;
    return { exitCode: code, text: opts.json ? JSON.stringify({ error: String(err), exitCode: code }) : String(err) };
  }
  const detail = await engine.evaluate();
  const result: RoadmapCheckResult = {
    roadmap: `${detail.roadmapId}@${detail.version}`,
    complete: detail.complete,
    verified: detail.milestones.filter((e) => e.milestone.required && e.state === "VERIFIED").length,
    required: detail.milestones.filter((m) => m.milestone.required).length,
    blockingMilestones: detail.milestones
      .filter((e) => e.milestone.required && e.state !== "VERIFIED")
      .map((e) => e.milestone.id),
    releaseGate: detail.releaseGate.pass ? "PASS" : "FAIL",
    exitCode: detail.complete ? 0 : 1,
    detail,
  };
  const text = opts.json ? JSON.stringify(result, null, 2) : printHuman(result, "status");
  return { exitCode: result.exitCode as RoadmapCheckExitCode, text };
}

export function defaultCliPaths(repoRoot: string): {
  roadmapPath: string;
  evidenceFile: string;
  manualEvidencePath: string;
} {
  return {
    roadmapPath: resolve(repoRoot, "docs/roadmap/roadmap.yaml"),
    evidenceFile: resolve(repoRoot, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: resolve(repoRoot, "docs/roadmap/evidence.yaml"),
  };
}
