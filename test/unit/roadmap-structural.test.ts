import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRoadmapStructural } from "../../src/roadmap/cli.ts";

function roadmap(extra = "", dep = "[]"): string {
  return `roadmap:
  id: structural-demo
  version: "1.0"
  codename: demo
milestones:
  - id: M01
    name: Foundation
    required: true
    depends_on: ${dep}
    scope: { paths: ["src/"] }
    acceptance:
      - id: M01-A1
        description: d
        evidence: { required: [ { type: unit, id: e }${extra} ] }
    verification: { requires: [unit] }
release_gate:
  require:
    all_required_milestones_verified: true
    tests: { unit: pass }
    fresh_review: { unresolved_critical: 0, unresolved_high: 0 }
backlog: []
waivers: []
`;
}

const GOOD_RECORD = `- id: review-1
  milestone: __global__
  type: fresh_review
  status: pass
  commit: abc
  generatedAt: 2026-01-01T00:00:00Z
  proof: docs/x.md
  findings: { critical: 0, high: 0 }
`;

async function run(roadmapYaml: string, evidenceYaml: string | null) {
  const root = await mkdtemp(join(tmpdir(), "roadmap-structural-"));
  try {
    await mkdir(join(root, "docs", "roadmap"), { recursive: true });
    const roadmapPath = join(root, "docs/roadmap/roadmap.yaml");
    const manualEvidencePath = join(root, "docs/roadmap/evidence.yaml");
    await writeFile(roadmapPath, roadmapYaml);
    if (evidenceYaml !== null) await writeFile(manualEvidencePath, evidenceYaml);
    // A repo root that is NOT a git repo proves no git/freshness/test work happens.
    return await runRoadmapStructural({
      repoRoot: root,
      roadmapPath,
      evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
      manualEvidencePath,
      json: false,
      refresh: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("structural: valid roadmap with resolving manual evidence exits 0 with a summary", async () => {
  const r = await run(roadmap(", { type: fresh_review, id: review-1 }"), GOOD_RECORD);
  assert.equal(r.exitCode, 0, r.text);
  assert.match(r.text, /structural/i);
  assert.match(r.text, /1 milestone/);
});

test("structural: invalid roadmap definition exits 2", async () => {
  const r = await run("milestones: nope\n", "[]\n");
  assert.equal(r.exitCode, 2);
});

test("structural: dependency cycle exits 2", async () => {
  const r = await run(roadmap("", "[M01]"), "[]\n");
  assert.equal(r.exitCode, 2);
});

test("structural: unresolved manual evidence id exits 2", async () => {
  const r = await run(roadmap(", { type: fresh_review, id: missing }"), GOOD_RECORD);
  assert.equal(r.exitCode, 2);
  assert.match(r.text, /missing/);
});

test("structural: manual record missing required fields exits 2", async () => {
  const r = await run(roadmap(", { type: fresh_review, id: review-1 }"), "- id: review-1\n  type: fresh_review\n");
  assert.equal(r.exitCode, 2);
  assert.match(r.text, /commit/);
});

test("structural: manual record of a generated type exits 2", async () => {
  const r = await run(roadmap(), "- id: u\n  type: unit\n  status: pass\n  commit: a\n  generatedAt: t\n  proof: p\n");
  assert.equal(r.exitCode, 2);
});

test("structural: fresh_review record without findings exits 2", async () => {
  const rec = "- id: review-1\n  type: fresh_review\n  status: pass\n  commit: abc\n  generatedAt: t\n  proof: p\n";
  const r = await run(roadmap(", { type: fresh_review, id: review-1 }"), rec);
  assert.equal(r.exitCode, 2);
  assert.match(r.text, /findings/);
});

test("structural: missing evidence.yaml exits 2", async () => {
  const r = await run(roadmap(), null);
  assert.equal(r.exitCode, 2);
});

test("structural: evidence.yaml that is not a list exits 2", async () => {
  const r = await run(roadmap(), "key: value\n");
  assert.equal(r.exitCode, 2);
});
