import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RoadmapEngine } from "../../src/roadmap/RoadmapEngine.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

const ROADMAP = `roadmap:
  id: invalidation-demo
  version: "1.0"
  codename: demo
milestones:
  - id: M01
    name: Source
    required: true
    depends_on: []
    scope: { paths: ["src/"] }
    acceptance:
      - id: M01-A1
        description: d
        evidence: { required: [ { type: unit, id: e } ] }
    verification: { requires: [unit] }
  - id: M02
    name: Docs
    required: true
    depends_on: []
    scope: { paths: ["docs/"] }
    acceptance:
      - id: M02-A1
        description: d
        evidence: { required: [ { type: unit, id: e } ] }
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

async function commit(root: string, message: string): Promise<void> {
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", message]);
}

async function setup(): Promise<{ root: string; engine: RoadmapEngine; cleanup: () => Promise<void> }> {
  const { root, cleanup } = await makeFixtureRepo();
  await mkdir(join(root, "docs", "roadmap"), { recursive: true });
  await writeFile(join(root, "docs", "roadmap", "roadmap.yaml"), ROADMAP);
  await writeFile(join(root, "docs", "roadmap", "evidence.yaml"), "[]\n");
  // Commit the roadmap so the docs/ scope is clean at HEAD (otherwise the
  // untracked roadmap files would invalidate M02's docs-scoped evidence).
  await commit(root, "add roadmap");
  const engine = await RoadmapEngine.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
  return { root, engine, cleanup };
}

function stateOf(detail: { milestones: Array<{ milestone: { id: string }; state: string }> }, id: string): string {
  return detail.milestones.find((e) => e.milestone.id === id)?.state ?? "(missing)";
}

test("invalidate: relevant change makes evidence stale -> NEEDS_REVERIFICATION", async () => {
  const { root, engine, cleanup } = await setup();
  try {
    const head = await engine.head();
    await engine.store.put({
      id: "M01:unit",
      milestone: "M01",
      type: "unit",
      status: "pass",
      commit: head,
      generatedAt: new Date().toISOString(),
      paths: ["src/"],
      proof: "test",
      source: "generated",
    });
    await engine.store.put({
      id: "M02:unit",
      milestone: "M02",
      type: "unit",
      status: "pass",
      commit: head,
      generatedAt: new Date().toISOString(),
      paths: ["docs/"],
      proof: "test",
      source: "generated",
    });

    let detail = await engine.evaluate();
    assert.equal(stateOf(detail, "M01"), "VERIFIED");
    assert.equal(stateOf(detail, "M02"), "VERIFIED");

    // Change src only. M01 (src scope) must become stale; M02 (docs scope) stays fresh.
    await writeFile(join(root, "src", "add.js"), "export const add = (a, b) => a + b;\n");
    await commit(root, "touch source");

    detail = await engine.evaluate();
    assert.equal(stateOf(detail, "M01"), "NEEDS_REVERIFICATION");
    assert.equal(stateOf(detail, "M02"), "VERIFIED");
  } finally {
    await cleanup();
  }
});

test("invalidate: regenerating evidence at new HEAD re-verifies", async () => {
  const { root, engine, cleanup } = await setup();
  try {
    const head = await engine.head();
    await engine.store.put({
      id: "M01:unit",
      milestone: "M01",
      type: "unit",
      status: "pass",
      commit: head,
      generatedAt: new Date().toISOString(),
      paths: ["src/"],
      proof: "test",
      source: "generated",
    });

    await writeFile(join(root, "src", "add.js"), "export const add = (a, b) => a + b;\n");
    await commit(root, "touch source");
    assert.equal(stateOf(await engine.evaluate(), "M01"), "NEEDS_REVERIFICATION");

    // Re-record evidence at the new HEAD: fresh again.
    const newHead = await engine.head();
    await engine.store.put({
      id: "M01:unit",
      milestone: "M01",
      type: "unit",
      status: "pass",
      commit: newHead,
      generatedAt: new Date().toISOString(),
      paths: ["src/"],
      proof: "test",
      source: "generated",
    });
    assert.equal(stateOf(await engine.evaluate(), "M01"), "VERIFIED");
  } finally {
    await cleanup();
  }
});
