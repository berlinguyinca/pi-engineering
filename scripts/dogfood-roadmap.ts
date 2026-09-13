#!/usr/bin/env node
/**
 * Roadmap-completion dogfood: run the FULL lifecycle of the verifiable roadmap
 * completion system against a disposable git repository:
 *
 *   incomplete -> verified -> invalidated -> needs-reverification
 *   -> reverified -> status -> failing check -> passing check
 *
 * This is deterministic (no live model): completion is derived from evidence,
 * and the script proves the derived lifecycle. Exit 0 when the final lifecycle
 * ends with a passing check.
 *
 *   node scripts/dogfood-roadmap.ts [--verbose]
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RoadmapEngine } from "../src/roadmap/RoadmapEngine.ts";
import { runRoadmapCheck } from "../src/roadmap/cli.ts";

const exec = promisify(execFile);
const verbose = process.argv.includes("--verbose");

const ROADMAP = `roadmap:
  id: dogfood-demo
  version: "1.0"
  codename: demo
milestones:
  - id: M01
    name: Foundation
    required: true
    depends_on: []
    scope: { paths: ["src/"] }
    acceptance:
      - id: M01-A1
        description: A working add function.
        evidence: { required: [ { type: unit, id: add-works } ] }
    verification: { requires: [unit] }
release_gate:
  require:
    all_required_milestones_verified: true
    tests: { unit: pass, integration: pass }
    typecheck: pass
    lint: pass
    package_load: pass
    fresh_review: { unresolved_critical: 0, unresolved_high: 0 }
backlog: []
waivers: []
`;

function log(step: string, detail = ""): void {
  console.log(`[roadmap-dogfood] ${step}${detail ? `: ${detail}` : ""}`);
}

async function makeRepo(): Promise<{ root: string }> {
  const root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "pi-roadmap-dogfood-"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "t@t"]);
  await exec("git", ["-C", root, "config", "user.name", "t"]);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs", "roadmap"), { recursive: true });
  await writeFile(join(root, "src", "add.js"), "export const add = (a, b) => a + b;\n");
  await writeFile(join(root, "docs", "roadmap", "roadmap.yaml"), ROADMAP);
  await writeFile(join(root, "docs", "roadmap", "evidence.yaml"), "[]\n");
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return { root };
}

async function commit(root: string, message: string): Promise<void> {
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", message]);
}

async function seedGlobals(root: string): Promise<void> {
  const engine = await RoadmapEngine.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
  const head = await engine.head();
  for (const t of ["unit", "integration", "typecheck", "lint", "package_load"] as const) {
    await engine.store.put({
      id: `__global__:${t}`,
      milestone: "__global__",
      type: t,
      status: "pass",
      commit: head,
      generatedAt: new Date().toISOString(),
      paths: ["src/", "test/"],
      proof: "seed",
      source: "generated",
    });
  }
  await engine.store.put({
    id: "M01:M01-A1",
    milestone: "M01",
    criterionId: "M01-A1",
    type: "unit",
    status: "pass",
    commit: head,
    generatedAt: new Date().toISOString(),
    paths: ["src/"],
    proof: "node --test",
    source: "generated",
  });
}

async function recordDogfood(root: string): Promise<void> {
  const engine = await RoadmapEngine.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
  const head = await engine.head();
  // Paths are scoped to src/ (NOT docs/roadmap/) so writing the committed
  // evidence index under docs/roadmap/ does not invalidate its own record.
  await engine.recordManual({
    id: "dogfood-1.0",
    milestone: "__global__",
    type: "dogfood",
    status: "pass",
    commit: head,
    generatedAt: new Date().toISOString(),
    paths: ["src/"],
    proof: "scripts/dogfood-roadmap.ts",
    summary: "deterministic roadmap lifecycle",
  });
  await engine.recordManual({
    id: "review-1.0",
    milestone: "__global__",
    type: "fresh_review",
    status: "pass",
    commit: head,
    generatedAt: new Date().toISOString(),
    paths: ["src/roadmap/"],
    proof: "scripts/fresh-review-roadmap.ts",
    summary: "fresh-context review clean",
  });
  await writeFile(
    join(root, "docs", "roadmap", "evidence.yaml"),
    `- id: dogfood-1.0\n  milestone: __global__\n  type: dogfood\n  status: pass\n  commit: ${head}\n  generatedAt: ${new Date().toISOString()}\n  paths: ["src/"]\n  proof: "scripts/dogfood-roadmap.ts"\n  summary: "deterministic roadmap lifecycle"\n- id: review-1.0\n  milestone: __global__\n  type: fresh_review\n  status: pass\n  commit: ${head}\n  generatedAt: ${new Date().toISOString()}\n  paths: ["src/roadmap/"]\n  proof: "scripts/fresh-review-roadmap.ts"\n  summary: "fresh-context review clean"\n`,
  );
}

/** Seed global + milestone evidence AND dogfood/review evidence at current HEAD, then check. */
async function verify(root: string): Promise<number> {
  await seedGlobals(root);
  await recordDogfood(root);
  const r = await runRoadmapCheck({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
    json: false,
    refresh: false,
  });
  return r.exitCode;
}

async function main(): Promise<number> {
  const { root } = await makeRepo();

  // 1. Incomplete (no evidence yet).
  let r = await runRoadmapCheck({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
    json: false,
    refresh: false,
  });
  log("1. incomplete", `exit ${r.exitCode} (expected 1)`);
  if (r.exitCode !== 1) throw new Error(`expected exit 1 (incomplete), got ${r.exitCode}`);

  // 2. Verify (record evidence + dogfood/review) -> complete.
  const exitVerified = await verify(root);
  log("2. verified (evidence present)", `exit ${exitVerified} (expected 0)`);
  if (exitVerified !== 0) throw new Error(`expected exit 0 (verified), got ${exitVerified}`);

  // 3. Invalidate: change a scoped file -> NEEDS_REVERIFICATION.
  await writeFile(join(root, "src", "add.js"), "export const add = (a, b) => a + b + 1;\n");
  await commit(root, "change scoped source");
  r = await runRoadmapCheck({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
    json: false,
    refresh: false,
  });
  log("3. invalidated (scoped change)", `exit ${r.exitCode} (expected 1) — NEEDS_REVERIFICATION`);
  if (r.exitCode !== 1) throw new Error(`expected exit 1 (invalidated), got ${r.exitCode}`);
  const { RoadmapEngine: E2 } = await import("../src/index.ts");
  const eng2 = await E2.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
  const detailAfterChange = (await eng2.evaluate()).milestones.find((e) => e.milestone.id === "M01");
  if (detailAfterChange?.state !== "NEEDS_REVERIFICATION")
    throw new Error(`expected NEEDS_REVERIFICATION, got ${detailAfterChange?.state}`);

  // 4. Reverify: record fresh evidence at new HEAD.
  const exitReverified = await verify(root);
  log("4. reverified", `exit ${exitReverified} (expected 0)`);
  if (exitReverified !== 0) throw new Error(`expected exit 0 (reverified), got ${exitReverified}`);

  // 5. status.
  const { RoadmapEngine: Engine } = await import("../src/index.ts");
  const eng = await Engine.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
  const status = await eng.evaluate();
  log("5. status", `complete=${status.complete}, milestones=${status.milestones.length}`);
  if (!status.complete) throw new Error("expected complete status");

  // 6. Final passing check.
  r = await runRoadmapCheck({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
    json: false,
    refresh: false,
  });
  log("6. final passing check", `exit ${r.exitCode} (expected 0)`);
  if (r.exitCode !== 0) throw new Error(`expected exit 0 (final), got ${r.exitCode}`);

  if (verbose) {
    const jr = await runRoadmapCheck({
      repoRoot: root,
      roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
      evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
      manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
      json: true,
      refresh: false,
    });
    console.log(jr.text);
  }
  await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  log("PASS: roadmap lifecycle dogfood succeeded");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
