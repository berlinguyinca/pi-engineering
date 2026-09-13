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
  id: refresh-demo
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

/** Trivial passing/failing commands so refreshEvidence runs without the real suite. */
function overrides(passing: boolean): Record<string, { command: string[]; paths: string[] }> {
  const code = passing ? "process.exit(0)" : "process.exit(1)";
  const cmd = ["node", "-e", code];
  return {
    unit: { command: cmd, paths: [] },
    integration: { command: cmd, paths: [] },
    typecheck: { command: cmd, paths: [] },
    lint: { command: cmd, paths: [] },
    package_load: { command: cmd, paths: [] },
    roadmap_test: { command: cmd, paths: [] },
  };
}

async function setup(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
  paths: { roadmapPath: string; evidenceFile: string; manualEvidencePath: string };
}> {
  const { root, cleanup } = await makeFixtureRepo();
  await mkdir(join(root, "docs", "roadmap"), { recursive: true });
  await writeFile(join(root, "docs", "roadmap", "roadmap.yaml"), ROADMAP);
  await writeFile(join(root, "docs", "roadmap", "evidence.yaml"), "[]\n");
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "roadmap"]);
  return {
    root,
    cleanup,
    paths: {
      roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
      evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
      manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
    },
  };
}

test("refresh: check(refresh:true) runs check commands and derives VERIFIED from passing results", async () => {
  const { root, cleanup, paths } = await setup();
  try {
    const engine = await RoadmapEngine.open({ repoRoot: root, ...paths, checksOverride: overrides(true) });
    const result = await engine.check({ refresh: true });
    const globalUnit = engine.store.get("__global__:unit");
    assert.equal(globalUnit?.status, "pass");
    assert.equal(result.detail.milestones.find((e) => e.milestone.id === "M01")?.state, "VERIFIED");
  } finally {
    await cleanup();
  }
});

test("refresh: a failing check command yields fail evidence and NOT verified", async () => {
  const { root, cleanup, paths } = await setup();
  try {
    const engine = await RoadmapEngine.open({ repoRoot: root, ...paths, checksOverride: overrides(false) });
    const result = await engine.check({ refresh: true });
    assert.equal(engine.store.get("__global__:unit")?.status, "fail");
    assert.notEqual(result.detail.milestones.find((e) => e.milestone.id === "M01")?.state, "VERIFIED");
  } finally {
    await cleanup();
  }
});
