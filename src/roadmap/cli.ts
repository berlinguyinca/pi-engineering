/**
 * `pi-engineering roadmap ...` CLI (spec §32). Deterministic exit codes:
 *   0 complete | 1 valid but not complete | 2 invalid roadmap/usage | 3 infra error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ALL_EVIDENCE_TYPES, RoadmapEngine, RoadmapError } from "./RoadmapEngine.ts";
import { MANUAL_TYPES } from "./checks.ts";
import { parseRoadmap } from "./schema.ts";
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
  for (const w of result.detail.waivers)
    lines.push(
      `  waiver: ${w.id} -> ${w.milestone}${w.criterion ? `:${w.criterion}` : ""} (${w.reason || "no reason"})`,
    );
  return lines.join("\n");
}

async function openEngine(opts: RoadmapCliOptions): Promise<RoadmapEngine | RoadmapCliResult> {
  try {
    return await RoadmapEngine.open({
      repoRoot: opts.repoRoot,
      roadmapPath: opts.roadmapPath,
      evidenceFile: opts.evidenceFile,
      manualEvidencePath: opts.manualEvidencePath,
    });
  } catch (err) {
    const code = (err instanceof RoadmapError ? err.exitCode : 3) as RoadmapCheckExitCode;
    return { exitCode: code, text: opts.json ? JSON.stringify({ error: String(err), exitCode: code }) : String(err) };
  }
}

function isResult(r: RoadmapEngine | RoadmapCliResult): r is RoadmapCliResult {
  return !(r instanceof RoadmapEngine);
}

export async function runRoadmapCheck(opts: RoadmapCliOptions): Promise<RoadmapCliResult> {
  const opened = await openEngine(opts);
  if (isResult(opened)) return opened;
  const engine = opened;
  const result = await engine.check({ refresh: opts.refresh });
  const text = opts.json ? JSON.stringify(result, null, 2) : printHuman(result, "check");
  return { exitCode: result.exitCode as RoadmapCheckExitCode, text };
}

const MANUAL_REQUIRED_FIELDS = ["id", "type", "status", "commit", "generatedAt", "proof"] as const;

/**
 * `roadmap check --structural`: validate the roadmap definition and the manual
 * evidence index only. Runs no tests, needs no git, computes no freshness.
 * Exit 0 valid | 2 invalid.
 */
export async function runRoadmapStructural(opts: RoadmapCliOptions): Promise<RoadmapCliResult> {
  const problems: string[] = [];
  let roadmapText: string;
  try {
    roadmapText = readFileSync(opts.roadmapPath, "utf-8");
  } catch (err) {
    return finishStructural(opts, [`cannot read roadmap: ${String(err)}`], 0, 0);
  }
  const { roadmap, issues } = parseRoadmap(roadmapText, new Set(ALL_EVIDENCE_TYPES));
  for (const i of issues) problems.push(`roadmap ${i.path}: ${i.message}`);
  const records = new Map<string, Record<string, unknown>>();
  try {
    const docs: unknown = parseYaml(readFileSync(opts.manualEvidencePath, "utf-8"));
    if (!Array.isArray(docs)) problems.push("evidence index must be a YAML list");
    else {
      for (const [n, d] of docs.entries()) {
        const rec = (d ?? {}) as Record<string, unknown>;
        const label = `evidence[${n}]${typeof rec.id === "string" ? ` ${rec.id}` : ""}`;
        for (const f of MANUAL_REQUIRED_FIELDS)
          if (typeof rec[f] !== "string" || rec[f] === "") problems.push(`${label}: missing required field ${f}`);
        if (typeof rec.type === "string" && !MANUAL_TYPES.includes(rec.type as never))
          problems.push(`${label}: manual evidence type must be one of ${MANUAL_TYPES.join(", ")}`);
        if (rec.type === "fresh_review" && (typeof rec.findings !== "object" || rec.findings === null))
          problems.push(`${label}: fresh_review requires findings`);
        if (typeof rec.id === "string") records.set(rec.id, rec);
      }
    }
  } catch (err) {
    problems.push(`cannot read evidence index: ${String(err)}`);
  }
  if (roadmap) {
    for (const m of roadmap.milestones)
      for (const c of m.acceptance)
        for (const ref of c.evidence.required)
          if (MANUAL_TYPES.includes(ref.type) && !records.has(ref.id))
            problems.push(`${m.id}/${c.id}: evidence id ${ref.id} (${ref.type}) not found in evidence index`);
  }
  return finishStructural(opts, problems, roadmap?.milestones.length ?? 0, records.size);
}

function finishStructural(
  opts: RoadmapCliOptions,
  problems: string[],
  milestones: number,
  records: number,
): RoadmapCliResult {
  const exitCode: RoadmapCheckExitCode = problems.length ? 2 : 0;
  if (opts.json)
    return { exitCode, text: JSON.stringify({ structural: true, exitCode, milestones, records, problems }) };
  const lines = [
    `Roadmap structural check: ${problems.length ? "INVALID" : "ok"} (${milestones} milestone(s), ${records} manual record(s))`,
  ];
  for (const p of problems) lines.push(`  - ${p}`);
  return { exitCode, text: lines.join("\n") };
}

export async function runRoadmapStatus(opts: RoadmapCliOptions): Promise<RoadmapCliResult> {
  const opened = await openEngine(opts);
  if (isResult(opened)) return opened;
  const engine = opened;
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
