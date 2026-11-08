/**
 * Task workflow: materialize (plan prose -> checked task list + contract drafts) and handoff-check (did a
 * finished task prove it). The interesting assertions are the failure shapes — a duplicate id, a dependency
 * on a task nobody defined, a cycle, a contract that would not authorize anything — because those are the
 * things a plan review reads past and a worker discovers by deadlocking.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { checkHandoffTrail, materializeTasks, parsePlanFile } from "../../src/lifecycle/taskWorkflowService.ts";
import { runTaskWorkflowCli } from "../../src/lifecycle/taskWorkflowCli.ts";

let root = "";

const PLAN = `# Plan

## Task T1: Lay the groundwork
- **Depends on**: none

## Task T2: Build the view
- **Depends on**: T1, TMISSING

## Task T3: Verify the view
- **Depends on**: T2

## Task T2: Build the view (written twice)
- **Depends on**: T1

## Task T4: Close out
- **Depends on**: T5

## Task T5: Gate
- **Depends on**: T4
`;

const TEMPLATE = {
  mode: "implementation",
  policyRevision: 1,
  readRoots: ["."],
  writeRoots: ["src/runtime/ops"],
  allowedHosts: [],
  externalEffects: [],
  acceptanceCriteria: ["typecheck exits 0"],
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-task-workflow-"));
  writeFileSync(join(root, "PLAN.md"), PLAN);
  writeFileSync(join(root, "template.json"), JSON.stringify(TEMPLATE));
  // A trail whose plan orders two tasks but whose records cover one, with a stale hash stamp.
  const trail = join(root, "trail");
  mkdirSync(join(trail, "manifests"), { recursive: true });
  mkdirSync(join(trail, "templates"), { recursive: true });
  mkdirSync(join(trail, "A", "out"), { recursive: true });
  mkdirSync(join(trail, "A", "out2"), { recursive: true });
  writeFileSync(join(trail, "manifests", "tasks.json"), JSON.stringify({ tasks: [{ id: "A" }, { id: "B" }] }));
  writeFileSync(join(trail, "templates", "handoff.schema.json"), JSON.stringify({ type: "object" }));
  writeFileSync(join(trail, "A", "out", "A.handoff.json"), JSON.stringify({ taskId: "A", handoffHash: "stamped-value", evidence: [] }));
  writeFileSync(join(trail, "A", "out2", "A.handoff.json"), JSON.stringify({ taskId: "A", handoffHash: "newer-stamp", evidence: [] }));
  // A generation directory the reader does not rank must be surfaced, never quietly skipped.
  mkdirSync(join(trail, "A", "out-rewritten-by-hand"), { recursive: true });
  mkdirSync(join(root, "templates-only", "templates"), { recursive: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a plan heading opens a task and a Depends on line closes its edges", () => {
  const parsed = parsePlanFile(join(root, "PLAN.md"));
  assert.equal(parsed.tasks.length, 6);
  assert.deepEqual(parsed.tasks[1]!.dependsOn, ["T1", "TMISSING"]);
  assert.deepEqual(parsed.tasks[0]!.dependsOn, [], "none is not a dependency");
});

test("materialize reports duplicates, unknown dependencies and cycles instead of dispatching them", () => {
  const report = materializeTasks({ planFile: join(root, "PLAN.md"), repoRoot: root, trailDir: null, specsDir: null, template: null });
  assert.equal(report.tasks.length, 5, "the repeated heading is one task");
  assert.deepEqual(report.duplicates.map((entry) => entry.id), ["T2"]);
  assert.match(report.duplicates[0]!.sources.join(" "), /PLAN\.md:6.*PLAN\.md:12/u);
  assert.deepEqual(report.unknownDependencies, [{ taskId: "T2", dependency: "TMISSING" }]);
  // T4 -> T5 -> T4 and T2 appears twice in the file but is one node; the cycle must be a concrete path.
  assert.ok(report.cycles.some((cycle) => cycle.includes("T4 -> T5 -> T4")), report.cycles.join(" | "));
  assert.equal(report.ok, false);
  assert.equal(report.contracts.length, 0);
  assert.match(report.contractReason ?? "", /no contract template/u);
});

test("contract drafts are validated and hashed, and only valid drafts are written", () => {
  const report = materializeTasks({ planFile: join(root, "PLAN.md"), repoRoot: root, trailDir: null, specsDir: null, template: TEMPLATE });
  assert.equal(report.contracts.length, 5);
  assert.equal(report.contracts.every((draft) => draft.ok), true);
  assert.match(report.contracts[0]!.hash ?? "", /^[0-9a-f]{16,}$/u);
  assert.equal(report.contracts.find((draft) => draft.taskId === "T2")!.contract!.objective, "Build the view");

  const broken = materializeTasks({ planFile: join(root, "PLAN.md"), repoRoot: root, trailDir: null, specsDir: null, template: { ...TEMPLATE, mode: "wing-it" } });
  assert.equal(broken.ok, false);
  assert.equal(broken.contracts.every((draft) => !draft.ok), true);
  assert.match(broken.contracts[0]!.error ?? "", /mode must be one of/u);

  const writeDir = join(root, "out");
  const written = materializeTasks({ planFile: join(root, "PLAN.md"), repoRoot: root, trailDir: null, specsDir: null, template: { ...TEMPLATE, mode: "wing-it" }, writeDir });
  assert.ok(written.written?.some((file) => file.endsWith("tasks.json")), "the manifest is always written");
  assert.equal(written.written?.some((file) => file.endsWith(".contract.json")), false, "an invalid contract must never reach a worker");

  const good = materializeTasks({ planFile: join(root, "PLAN.md"), repoRoot: root, trailDir: null, specsDir: null, template: TEMPLATE, writeDir });
  assert.ok(good.written?.some((file) => file.endsWith("T1.contract.json")));
  assert.equal(JSON.parse(readFileSync(join(writeDir, "T1.contract.json"), "utf8")).taskId, "T1");
});

test("a trail manifest wins over prose and a specs directory sweeps every trail in it", () => {
  const fromTrail = materializeTasks({ trailDir: join(root, "trail"), repoRoot: root, planFile: null, specsDir: null, template: null });
  assert.deepEqual(fromTrail.tasks.map((task) => task.id), ["A", "B"]);
  const sweep = materializeTasks({ specsDir: root, repoRoot: root, planFile: null, trailDir: null, template: null });
  assert.ok(sweep.inputs.some((input) => input.endsWith(join("trail", "manifests", "tasks.json"))), sweep.inputs.join(" "));
});

test("handoff-check reads order from the manifest and reports every record problem it can see", () => {
  const report = checkHandoffTrail({ trail: join(root, "trail"), repoRoot: root, rev: "HEAD", checkCommitted: false, checkLive: false });
  assert.equal(report.planned, 2, "the plan ordered two tasks");
  assert.equal(report.canonical, 1, "only the newest generation of A is canonical");
  assert.equal(report.superseded, 1);
  const kinds = report.issues.map((issue) => issue.kind);
  assert.ok(kinds.includes("missing-record"), kinds.join(","));
  assert.ok(kinds.includes("hash-mismatch"), kinds.join(","));
  assert.deepEqual(report.unreadGenerations, ["A/out-rewritten-by-hand"]);
  assert.equal(report.ok, false);
});

test("handoff-check refuses to guess when the trail is not a trail", () => {
  const missing = checkHandoffTrail({ trail: join(root, "not-a-trail"), repoRoot: root, checkCommitted: false, checkLive: false });
  assert.match(missing.reason ?? "", /not a directory/u);
  const noManifest = checkHandoffTrail({ trail: join(root, "templates-only"), repoRoot: root, checkCommitted: false, checkLive: false });
  assert.match(noManifest.reason ?? "", /manifests\/tasks\.json is missing/u);
});

test("the task CLI carries the same answers and exit codes", async () => {
  let out = "";
  let err = "";
  const io = { write: (value: string) => (out += value), error: (value: string) => (err += value), cwd: root, repoRoot: root };
  assert.equal(await runTaskWorkflowCli(["materialize", "--plan", "PLAN.md", "--json"], io), 1, "the plan has duplicates and a cycle");
  assert.equal((JSON.parse(out) as { duplicates: unknown[] }).duplicates.length, 1);

  out = "";
  assert.equal(await runTaskWorkflowCli(["materialize", "--trail", "trail", "--template", "template.json", "--json"], io), 0);
  const ok = JSON.parse(out) as { contracts: { hash?: string }[]; written?: string[] };
  assert.equal(ok.contracts.length, 2);
  assert.ok(ok.written === undefined, "read-only unless --write-dir is passed");

  out = "";
  assert.equal(await runTaskWorkflowCli(["handoff-check", "--trail", "trail", "--no-committed", "--no-live", "--json"], io), 1);
  assert.equal((JSON.parse(out) as { planned: number }).planned, 2);

  out = "";
  assert.equal(await runTaskWorkflowCli(["handoff-check"], io), 2);
  assert.match(err, /handoff-check needs --trail/u);
  out = "";
  assert.equal(await runTaskWorkflowCli(["whoosh"], io), 2);
});

