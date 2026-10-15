import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RoadmapEngine } from "../../src/roadmap/RoadmapEngine.ts";
import { runRoadmapStructural } from "../../src/roadmap/cli.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

function roadmap(realMission: boolean): string {
  return `roadmap:
  id: dogfood-mission-demo
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
    real_mission_dogfood: ${realMission}
backlog: []
waivers: []
`;
}

async function commit(root: string, message: string): Promise<string> {
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", message]);
  return (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

async function setup(realMission: boolean) {
  const { root, cleanup } = await makeFixtureRepo();
  await mkdir(join(root, "docs", "roadmap"), { recursive: true });
  await writeFile(join(root, "docs", "roadmap", "roadmap.yaml"), roadmap(realMission));
  await writeFile(join(root, "docs", "roadmap", "evidence.yaml"), "[]\n");
  const head = await commit(root, "add roadmap");
  return { root, cleanup, head };
}

async function openEngine(root: string): Promise<RoadmapEngine> {
  return RoadmapEngine.open({
    repoRoot: root,
    roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
    evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
    manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
  });
}

async function putUnit(engine: RoadmapEngine, milestone: string, paths: string[]): Promise<void> {
  await engine.store.put({
    id: `${milestone}:${milestone}-A1`,
    milestone,
    criterionId: `${milestone}-A1`,
    type: "unit",
    status: "pass",
    commit: await engine.head(),
    generatedAt: new Date().toISOString(),
    paths,
    proof: "test",
    source: "generated",
  });
}

async function writeRecord(root: string, sha: string, statuses: string[]): Promise<void> {
  await mkdir(join(root, "docs", "roadmap", "dogfood"), { recursive: true });
  await writeFile(
    join(root, "docs", "roadmap", "dogfood", `${sha}.json`),
    JSON.stringify({
      kind: "dogfood_mission",
      sha,
      missions: statuses.map((status, i) => ({ goal: `g${i}`, missionId: `m${i}`, status })),
      ranAt: new Date().toISOString(),
    }),
  );
}

function stateOf(detail: { milestones: Array<{ milestone: { id: string }; state: string }> }, id: string): string {
  return detail.milestones.find((e) => e.milestone.id === id)?.state ?? "(missing)";
}

test("dogfood_mission: VERIFIED without a record is demoted to IMPLEMENTED with a reason", async () => {
  const { root, cleanup } = await setup(true);
  try {
    const engine = await openEngine(root);
    await putUnit(engine, "M01", ["src/"]);
    const detail = await engine.evaluate();
    assert.equal(stateOf(detail, "M01"), "IMPLEMENTED");
    const m01 = detail.milestones.find((e) => e.milestone.id === "M01");
    assert.match(m01?.blockers.join("\n") ?? "", /demoted to IMPLEMENTED: no passing dogfood_mission/);
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: a passing record at or after the latest scope change keeps VERIFIED", async () => {
  const { root, cleanup, head } = await setup(true);
  try {
    await writeRecord(root, head, ["COMPLETE", "COMPLETE"]);
    // Committing the record itself must not count as a scope change.
    await commit(root, "record dogfood");
    const engine = await openEngine(root);
    await putUnit(engine, "M01", ["src/"]);
    await putUnit(engine, "M02", ["docs/"]);
    const detail = await engine.evaluate();
    assert.equal(stateOf(detail, "M01"), "VERIFIED");
    assert.equal(stateOf(detail, "M02"), "VERIFIED");
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: a record with a non-COMPLETE mission does not count", async () => {
  const { root, cleanup, head } = await setup(true);
  try {
    await writeRecord(root, head, ["COMPLETE", "BLOCKED"]);
    const engine = await openEngine(root);
    await putUnit(engine, "M01", ["src/"]);
    assert.equal(stateOf(await engine.evaluate(), "M01"), "IMPLEMENTED");
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: freshness is per milestone scope, not global", async () => {
  const { root, cleanup, head } = await setup(true);
  try {
    await writeRecord(root, head, ["COMPLETE"]);
    await commit(root, "record dogfood");
    // Change only M02's scope after the record was pinned.
    await writeFile(join(root, "docs", "guide.md"), "changed\n");
    await commit(root, "docs change");
    const engine = await openEngine(root);
    await putUnit(engine, "M01", ["src/"]);
    await putUnit(engine, "M02", ["docs/"]);
    const detail = await engine.evaluate();
    assert.equal(stateOf(detail, "M01"), "VERIFIED", "src/ unchanged since the record");
    assert.equal(stateOf(detail, "M02"), "IMPLEMENTED", "docs/ changed after the record");
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: a record pinned to a later SHA covers an earlier scope change", async () => {
  const { root, cleanup } = await setup(true);
  try {
    await writeFile(join(root, "docs", "guide.md"), "changed\n");
    const later = await commit(root, "docs change");
    await writeRecord(root, later, ["COMPLETE"]);
    const engine = await openEngine(root);
    await putUnit(engine, "M02", ["docs/"]);
    assert.equal(stateOf(await engine.evaluate(), "M02"), "VERIFIED");
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: demotion is off unless the roadmap opts in", async () => {
  const { root, cleanup } = await setup(false);
  try {
    const engine = await openEngine(root);
    await putUnit(engine, "M01", ["src/"]);
    assert.equal(stateOf(await engine.evaluate(), "M01"), "VERIFIED");
  } finally {
    await cleanup();
  }
});

test("dogfood_mission: --structural ignores the demotion rule", async () => {
  const { root, cleanup } = await setup(true);
  try {
    const result = await runRoadmapStructural({
      repoRoot: root,
      roadmapPath: join(root, "docs/roadmap/roadmap.yaml"),
      evidenceFile: join(root, ".pi-eng/roadmap/evidence.jsonl"),
      manualEvidencePath: join(root, "docs/roadmap/evidence.yaml"),
      json: false,
      refresh: false,
    });
    assert.equal(result.exitCode, 0, result.text);
  } finally {
    await cleanup();
  }
});
