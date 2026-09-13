import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoadmapEngine } from "../../src/roadmap/RoadmapEngine.ts";
import { runRoadmapCheck } from "../../src/roadmap/cli.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const SIMPLE = `roadmap:
  id: demo
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

const INVALID = `roadmap:
  id: demo
  version: "1.0"
  codename: demo
milestones:
  - id: M01
    name: Foundation
    required: true
    depends_on: [M99]
    scope: { paths: ["src/"] }
    acceptance: []
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

interface Setup {
  root: string;
  cleanup: () => Promise<void>;
  paths: { roadmapPath: string; evidenceFile: string; manualEvidencePath: string };
}

async function setupRepo(roadmap = SIMPLE): Promise<Setup> {
  const { root, cleanup } = await makeFixtureRepo();
  await mkdir(join(root, "docs", "roadmap"), { recursive: true });
  await writeFile(join(root, "docs", "roadmap", "roadmap.yaml"), roadmap);
  await writeFile(join(root, "docs", "roadmap", "evidence.yaml"), "[]\n");
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

/** Populate global + milestone evidence at HEAD so the roadmap can be complete. */
async function seedCompleteEvidence(setup: Setup): Promise<void> {
  const engine = await RoadmapEngine.open({ repoRoot: setup.root, ...setup.paths });
  const head = await engine.head();
  for (const t of ["unit", "integration", "typecheck", "lint", "package_load"] as const) {
    await engine.store.put({
      id: `__global__:${t}`,
      milestone: "__global__",
      type: t,
      status: "pass",
      commit: head,
      generatedAt: new Date().toISOString(),
      paths: [],
      proof: "test",
      source: "generated",
    });
  }
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
  // Manual dogfood evidence fresh at HEAD.
  await writeFile(
    setup.paths.manualEvidencePath,
    `- id: dogfood-1.0\n  milestone: __global__\n  type: dogfood\n  status: pass\n  commit: ${head}\n  generatedAt: ${new Date().toISOString()}\n  paths: ["src/"]\n  proof: "test"\n  summary: "seed"\n`,
  );
}

test("roadmap check: complete roadmap -> exit 0", async () => {
  const setup = await setupRepo();
  try {
    await seedCompleteEvidence(setup);
    const { exitCode, text } = await runRoadmapCheck({
      repoRoot: setup.root,
      ...setup.paths,
      json: false,
      refresh: false,
    });
    assert.equal(exitCode, 0, text);
  } finally {
    await setup.cleanup();
  }
});

test("roadmap check: missing dogfood evidence -> exit 1 (not complete)", async () => {
  const setup = await setupRepo();
  try {
    const engine = await RoadmapEngine.open({ repoRoot: setup.root, ...setup.paths });
    const head = await engine.head();
    for (const t of ["unit", "integration", "typecheck", "lint", "package_load"] as const) {
      await engine.store.put({
        id: `__global__:${t}`,
        milestone: "__global__",
        type: t,
        status: "pass",
        commit: head,
        generatedAt: new Date().toISOString(),
        paths: [],
        proof: "test",
        source: "generated",
      });
    }
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
    const { exitCode, text } = await runRoadmapCheck({
      repoRoot: setup.root,
      ...setup.paths,
      json: false,
      refresh: false,
    });
    assert.equal(exitCode, 1, text);
  } finally {
    await setup.cleanup();
  }
});

test("roadmap check: invalid roadmap -> exit 2", async () => {
  const setup = await setupRepo(INVALID);
  try {
    const { exitCode, text } = await runRoadmapCheck({
      repoRoot: setup.root,
      ...setup.paths,
      json: false,
      refresh: false,
    });
    assert.equal(exitCode, 2, text);
  } finally {
    await setup.cleanup();
  }
});

test("roadmap check: not a git repo -> exit 3", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-nogit-"));
  try {
    const { exitCode, text } = await runRoadmapCheck({
      repoRoot: root,
      roadmapPath: join(root, "r.yaml"),
      evidenceFile: join(root, "e.jsonl"),
      manualEvidencePath: join(root, "ev.yaml"),
      json: false,
      refresh: false,
    });
    assert.equal(exitCode, 3, text);
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
  }
});

test("autonomous stop: engineer() refuses new work when roadmap is complete", async () => {
  const setup = await setupRepo();
  try {
    const { EngineeringRuntime } = await import("../../src/runtime/EngineeringRuntime.ts");
    const { FakeWorkerExecutor } = await import("../../src/workers/FakeWorkerExecutor.ts");
    const rt = await EngineeringRuntime.open({
      cwd: setup.root,
      worker: new FakeWorkerExecutor({}),
      roadmapComplete: async () => true,
    });
    const report = await rt.engineer("invent some new feature");
    assert.equal(report.outcome, "stopped");
    assert.match(report.scout_summary ?? "", /roadmap complete/i);
    // No implementation/candidate was created.
    assert.equal(report.rounds, 0);
    assert.equal(report.incumbent_candidate, null);
  } finally {
    await setup.cleanup();
  }
});

test("autonomous stop: gate open -> engineer proceeds", async () => {
  const setup = await setupRepo();
  try {
    const { EngineeringRuntime } = await import("../../src/runtime/EngineeringRuntime.ts");
    const { FakeWorkerExecutor } = await import("../../src/workers/FakeWorkerExecutor.ts");
    const rt = await EngineeringRuntime.open({
      cwd: setup.root,
      worker: new FakeWorkerExecutor({}),
      roadmapComplete: async () => false,
    });
    const report = await rt.engineer("something");
    assert.notEqual(report.outcome, "stopped");
  } finally {
    await setup.cleanup();
  }
});

test("roadmap check: JSON output is machine-readable", async () => {
  const setup = await setupRepo();
  try {
    const { exitCode, text } = await runRoadmapCheck({
      repoRoot: setup.root,
      ...setup.paths,
      json: true,
      refresh: false,
    });
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(text) as {
      complete: boolean;
      exitCode: number;
      detail: { milestones: Array<{ state: string }> };
    };
    assert.equal(typeof parsed.complete, "boolean");
    assert.equal(parsed.exitCode, 1);
    assert.ok(Array.isArray(parsed.detail.milestones));
  } finally {
    await setup.cleanup();
  }
});
