/**
 * record-roadmap-evidence.ts
 *
 * The process step that records the two model-dependent evidence records the
 * release gate requires — `dogfood` and `fresh_review` — into the COMMITTED
 * index `docs/roadmap/evidence.yaml`, bound to the current HEAD commit.
 *
 * This is the tool that closes the loop the spec (§29, AC-12) requires: the
 * repo's own roadmap cannot pass its release gate until real dogfood +
 * fresh-review evidence for THIS repo is recorded, not just a synthetic demo.
 *
 * The records are scoped to paths that EXCLUDE docs/roadmap/, so committing
 * this index afterwards does not invalidate its own records.
 *
 * ── Why `--paths` is required rather than defaulted ─────────────────────────
 *
 * The gate tests freshness by asking whether anything under a record's `paths`
 * changed since its commit. Narrow paths therefore produce a record that stays
 * "fresh" indefinitely while covering almost none of the work it claims to
 * cover — a green gate that means nothing, which is strictly worse than the red
 * one it replaced. This script used to hardcode `src/roadmap/`, `src/blackhole/`,
 * `src/benchmark/` and `services/` for the review record, so recording evidence
 * for a change to, say, `src/gateway/` produced exactly that false pass.
 *
 * Paths are now an explicit argument with no default: state what was actually
 * reviewed, or the script refuses to write.
 *
 * Usage:
 *   node scripts/record-roadmap-evidence.ts \
 *     --paths src/,extensions/,test/ \
 *     --critical 0 --high 0 \
 *     --id-suffix gateway-wait \
 *     --dogfood-proof "scripts/dogfood-gateway-wait.ts" \
 *     --review-proof "scripts/fresh-review-gateway-wait.ts gateway" \
 *     --summary "..."
 *
 * Deterministic checks (unit/integration/typecheck/lint/package_load) are NOT
 * recorded here; `roadmap check` (refresh) generates those at HEAD.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RoadmapEvidence } from "../src/roadmap/types.ts";

const exec = promisify(execFile);

interface Args {
  critical: number;
  high: number;
  /** Scope the gate re-checks for freshness. No default, on purpose. */
  paths: string[];
  /** Distinguishes these records from earlier ones; ids must be stable. */
  idSuffix: string;
  dogfoodProof: string;
  reviewProof: string;
  summary: string;
}

const USAGE = `Usage: node scripts/record-roadmap-evidence.ts --paths <p1,p2,...> [options]

  --paths <list>          REQUIRED. Comma-separated paths the evidence covers.
                          These are what the gate re-checks for freshness, so
                          they must span everything that was reviewed. Narrow
                          paths make a record that passes forever while
                          covering nothing.
  --id-suffix <name>      Record id suffix (default: "1.0").
  --critical N            Unresolved critical findings (default 0).
  --high N                Unresolved high findings (default 0).
  --dogfood-proof <text>  What was run for the dogfood record.
  --review-proof <text>   What was run for the fresh-review record.
  --summary <text>        Shared human summary.`;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    critical: 0,
    high: 0,
    paths: [],
    idSuffix: "1.0",
    dogfoodProof: "",
    reviewProof: "",
    summary: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--critical") a.critical = Number(argv[++i]);
    else if (flag === "--high") a.high = Number(argv[++i]);
    else if (flag === "--paths") {
      a.paths = (argv[++i] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (flag === "--id-suffix") a.idSuffix = argv[++i] ?? a.idSuffix;
    else if (flag === "--dogfood-proof") a.dogfoodProof = argv[++i] ?? "";
    else if (flag === "--review-proof") a.reviewProof = argv[++i] ?? "";
    else if (flag === "--summary") a.summary = argv[++i] ?? "";
    else if (flag === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return a;
}

/**
 * Reject a scope that cannot honestly cover a change.
 *
 * `docs/roadmap/` is excluded deliberately (committing the index must not
 * invalidate its own records); anything else that narrow is the false-pass this
 * argument exists to prevent.
 */
function validatePaths(paths: string[]): string | undefined {
  if (paths.length === 0) return "--paths is required; state what the evidence actually covers";
  const inert = paths.filter((p) => p.startsWith("docs/"));
  if (inert.length === paths.length) {
    return `every path is under docs/ (${paths.join(", ")}); a record scoped only to documentation can never go stale`;
  }
  return undefined;
}

/** Remove a prior record with the same id, then push the new one. */
function upsert(docs: RoadmapEvidence[], rec: RoadmapEvidence): RoadmapEvidence[] {
  return [...docs.filter((d) => d.id !== rec.id), rec];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pathProblem = validatePaths(args.paths);
  if (pathProblem) {
    console.error(`record-roadmap-evidence: ${pathProblem}`);
    console.error(USAGE);
    process.exit(2);
  }
  const root = process.cwd();
  const manualPath = join(root, "docs", "roadmap", "evidence.yaml");
  const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
  const head = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    console.error(`record-roadmap-evidence: invalid HEAD commit '${head}'`);
    process.exit(3);
  }

  let docs: RoadmapEvidence[] = [];
  try {
    const raw = await readFile(manualPath, "utf8");
    const parsed = parseYaml(raw);
    if (Array.isArray(parsed)) docs = parsed as RoadmapEvidence[];
  } catch {
    docs = [];
  }

  const now = new Date().toISOString();
  const updated = upsert(docs, {
    id: `dogfood-${args.idSuffix}`,
    milestone: "__global__",
    type: "dogfood",
    status: "pass",
    commit: head,
    generatedAt: now,
    paths: args.paths,
    proof: args.dogfoodProof || "scripts/dogfood-roadmap.ts + real-repo roadmap check",
    summary: args.summary || "deterministic dogfood; release gate reachable at HEAD",
  });
  const final = upsert(updated, {
    id: `review-${args.idSuffix}`,
    milestone: "__global__",
    type: "fresh_review",
    status: "pass",
    commit: head,
    generatedAt: now,
    paths: args.paths,
    proof: args.reviewProof || "fresh-context review worker",
    summary:
      args.summary || `fresh-context review at HEAD; unresolved findings ${args.critical} critical, ${args.high} high`,
    findings: { critical: args.critical, high: args.high },
  });

  await writeFile(manualPath, `${stringifyYaml(final, { indent: 2 })}\n`);
  console.log(`record-roadmap-evidence: wrote ${final.length} manual record(s) bound to ${head}`);
  for (const r of final) {
    console.log(`  - ${r.id} (${r.type}, ${r.status}, commit ${r.commit})`);
  }
}

main().catch((err) => {
  console.error("record-roadmap-evidence:", err);
  process.exit(1);
});
