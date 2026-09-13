import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_EVIDENCE_TYPES } from "../../src/roadmap/RoadmapEngine.ts";
import { parseRoadmap } from "../../src/roadmap/schema.ts";

const ALLOWED = new Set(ALL_EVIDENCE_TYPES);

function validYaml(): string {
  return `roadmap:
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
        evidence: { required: [ { type: unit, id: e1 } ] }
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
}

test("schema: a valid roadmap parses without issues", () => {
  const { roadmap, issues } = parseRoadmap(validYaml(), ALLOWED);
  assert.equal(issues.length, 0);
  assert.ok(roadmap);
  assert.equal(roadmap?.roadmap.version, "1.0");
  assert.equal(roadmap?.milestones.length, 1);
  assert.equal(roadmap?.milestones[0]?.id, "M01");
});

test("schema: duplicate milestone id is an issue", () => {
  const yaml = validYaml().replace(
    "milestones:\n",
    "milestones:\n  - id: M01\n    name: Dup\n    required: false\n    depends_on: []\n    scope: { paths: [] }\n    acceptance: []\n    verification: { requires: [] }\n",
  );
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("duplicate milestone id")));
});

test("schema: dependency cycle is an issue", () => {
  const yaml = `roadmap:
  id: demo
  version: "1.0"
  codename: demo
milestones:
  - id: A
    name: A
    required: true
    depends_on: [B]
    scope: { paths: [] }
    acceptance: []
    verification: { requires: [] }
  - id: B
    name: B
    required: true
    depends_on: [A]
    scope: { paths: [] }
    acceptance: []
    verification: { requires: [] }
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
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("cycle")));
});

test("schema: unknown dependency is an issue", () => {
  const yaml = validYaml().replace("depends_on: []", "depends_on: [M99]");
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("unknown dependency")));
});

test("schema: required milestone cannot be silently deferred", () => {
  const yaml = validYaml().replace(
    "verification: { requires: [unit] }",
    "verification: { requires: [unit] }\n    deferred_reason: later",
  );
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("cannot be silently deferred")));
});

test("schema: non-required milestone can be deferred", () => {
  const yaml = validYaml()
    .replace("required: true", "required: false")
    .replace(
      "verification: { requires: [unit] }",
      "verification: { requires: [unit] }\n    deferred_reason: out of scope",
    );
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(issues.length, 0);
  assert.ok(roadmap);
  assert.equal(roadmap.milestones[0]?.deferredReason, "out of scope");
});

test("schema: unknown evidence type is an issue", () => {
  const yaml = validYaml().replace("type: unit, id: e1", "type: nope, id: e1");
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("unknown evidence type")));
});

test("schema: invalid YAML is an issue", () => {
  const { roadmap, issues } = parseRoadmap("not: [valid", ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.message.includes("YAML parse error")));
});

test("schema: duplicate waiver ids are rejected", () => {
  const yaml = validYaml().replace(
    "waivers: []",
    "waivers:\n  - id: w1\n    milestone: M01\n  - id: w1\n    milestone: M01",
  );
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.path.includes("waiver") && i.message.includes("duplicate")));
});

test("schema: waiver referencing an unknown milestone is rejected", () => {
  const yaml = validYaml().replace("waivers: []", "waivers:\n  - id: w1\n    milestone: M99");
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.path.includes("w1") && i.message.includes("unknown milestone")));
});

test("schema: release-gate gate values must be 'pass'", () => {
  const yaml = validYaml().replace("typecheck: pass", "typecheck: fail");
  const { roadmap, issues } = parseRoadmap(yaml, ALLOWED);
  assert.equal(roadmap, null);
  assert.ok(issues.some((i) => i.path.includes("typecheck") && i.message.includes("'pass'")));
});
