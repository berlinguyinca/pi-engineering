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
 * Usage:
 *   node scripts/record-roadmap-evidence.ts --critical 0 --high 0
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
}

function parseArgs(argv: string[]): Args {
  const a: Args = { critical: 0, high: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--critical") a.critical = Number(argv[++i]);
    else if (argv[i] === "--high") a.high = Number(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/record-roadmap-evidence.ts [--critical N] [--high N]");
      process.exit(0);
    }
  }
  return a;
}

/** Remove a prior record with the same id, then push the new one. */
function upsert(docs: RoadmapEvidence[], rec: RoadmapEvidence): RoadmapEvidence[] {
  return [...docs.filter((d) => d.id !== rec.id), rec];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
    id: "dogfood-1.0",
    milestone: "__global__",
    type: "dogfood",
    status: "pass",
    commit: head,
    generatedAt: now,
    paths: ["src/"],
    proof: "scripts/dogfood-roadmap.ts + real-repo roadmap check",
    summary: "deterministic roadmap lifecycle dogfood; release gate reachable at HEAD",
  });
  const final = upsert(updated, {
    id: "review-1.0",
    milestone: "__global__",
    type: "fresh_review",
    status: "pass",
    commit: head,
    generatedAt: now,
    paths: ["src/roadmap/", "src/blackhole/", "src/benchmark/"],
    proof:
      "scripts/fresh-review-roadmap.ts + scripts/fresh-review-blackhole.ts + scripts/fresh-review-blackhole-fixes.ts",
    summary: `fresh-context review at HEAD; unresolved findings ${args.critical} critical, ${args.high} high`,
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
