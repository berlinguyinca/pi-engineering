/**
 * The runtime-ops view reads durable state and must never invent it. These tests build a real orchestration
 * store (the same event-sourced store the runtime writes), then assert the four read endpoints and — the
 * part that matters most — what happens when a source is absent: a reason, not an empty list.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { RuntimeOpsView, resolveOrchestrationFile, resolveRuntimeOpsConfig } from "../../src/lifecycle/runtimeOpsService.ts";
import { runRuntimeOpsCli } from "../../src/lifecycle/runtimeOpsCli.ts";

let root = "";
let storeFile = "";

before(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-runtime-ops-"));
  storeFile = join(root, "orchestration.jsonl");
  writeFileSync(storeFile, "");
  const backend = await JsonlEventStore.open(storeFile);
  const store = MissionStore.open(backend);
  store.createMission({
    mission_id: "MSN-OPS",
    title: "Prove the operational view",
    goal: "read-only status over durable stores",
    user_request: "show me what is running",
    repository: root,
    base_ref: "HEAD",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  store.addAcceptanceCriterion("MSN-OPS", "status answers without a writer lock", "artifact://proof");
  store.createTask({ task_id: "TASK-DOC", mission_id: "MSN-OPS", kind: "agent", role: "implementer", objective: "Write the plan document", deliverables: ["docs/specs/PLAN/PLAN.md"] });
  store.createTask({ task_id: "TASK-CODE", mission_id: "MSN-OPS", kind: "agent", role: "verifier", objective: "Run the gates", depends_on: ["TASK-DOC"] });
  // A document the doc task says it produced, citing a file that does not exist.
  mkdirSync(join(root, "docs", "specs", "PLAN"), { recursive: true });
  writeFileSync(join(root, "docs", "specs", "PLAN", "PLAN.md"), "The gate lives in src/nope/missing.ts:1-3 and must fail.\n");
  writeFileSync(join(root, "ops.json"), JSON.stringify({ orchestrationStore: storeFile }));
  // Appends are queued on the backend's write chain; let them land before a read-only reader replays.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

after(() => rmSync(root, { recursive: true, force: true }));

function view(): RuntimeOpsView {
  return RuntimeOpsView.open(resolveRuntimeOpsConfig({ repoRoot: root, env: { PI_ENGINEERING_STATE_DIR: join(root, "state") }, configPath: join(root, "ops.json"), cwd: root }));
}

test("the configured store is discovered and opened read-only", async () => {
  const config = resolveRuntimeOpsConfig({ repoRoot: root, env: {}, configPath: join(root, "ops.json"), cwd: root }).config;
  const found = resolveOrchestrationFile({ ...config, orchestrationStore: storeFile });
  assert.equal(found.file, storeFile);
  // Opening it must not require the writer lock: the view is opened while nothing else holds it, and the
  // same code path is what a live session would hit.
  const report = await view().tasks({});
  assert.equal(report.tasks.length, 2);
});

test("tasks are projected with their dependencies, attempts and artifact counts", async () => {
  const report = await view().tasks({});
  const doc = report.tasks.find((task) => task.taskId === "TASK-DOC");
  const code = report.tasks.find((task) => task.taskId === "TASK-CODE");
  assert.ok(doc !== undefined && code !== undefined);
  assert.equal(doc!.objective, "Write the plan document");
  assert.deepEqual(code!.dependsOn, ["TASK-DOC"]);
  assert.equal(report.total, 2);
  const filtered = await view().tasks({ missionId: "MSN-OPS", statuses: ["pending"] });
  assert.equal(filtered.tasks.length, 2, "both tasks are still pending");
  assert.equal((await view().tasks({ statuses: ["SUCCEEDED"] })).tasks.length, 0);
});

test("task detail carries acceptance criteria and reports the documents a task left", async () => {
  const detail = await view().taskDetail("TASK-DOC");
  assert.equal(detail.found, true);
  assert.equal(detail.mission?.available, true);
  if (detail.mission?.available !== true) throw new Error("unreachable");
  assert.equal(detail.mission.data.acceptanceCriteria.length, 1);
  assert.equal(detail.mission.data.acceptanceCriteria[0]!.status, "pending");
  assert.equal(detail.citationDrift?.status, "checked");
  assert.deepEqual(detail.citationDrift?.documents, ["docs/specs/PLAN/PLAN.md"]);
});

test("citation drift is reported for the documents a task produced, and named as unchecked when there are none", async () => {
  const withDocs = await view().taskDetail("TASK-DOC", { atRef: "worktree" });
  assert.equal(withDocs.citationDrift?.status, "checked");
  assert.equal(withDocs.citationDrift?.report?.checked, 1);
  // src/nope/missing.ts does not exist: the view must say so rather than call the document clean.
  assert.equal(withDocs.citationDrift?.report?.unresolved.length, 1);
  assert.match(withDocs.citationDrift?.summary ?? "", /1 unresolved/);

  const withoutDocs = await view().taskDetail("TASK-CODE");
  assert.equal(withoutDocs.citationDrift?.status, "not_applicable");
  assert.match(withoutDocs.citationDrift?.reason ?? "", /no docs\/specs document/u);
});

test("an unknown task id says so and names the near matches", async () => {
  const detail = await view().taskDetail("TASK-ZZZ");
  assert.equal(detail.found, false);
  assert.match(detail.reason ?? "", /no task TASK-ZZZ/u);
  assert.match(detail.reason ?? "", /TASK-DOC/u);
});

test("a missing store yields a reason, never an empty answer", async () => {
  const orphan = mkdtempSync(join(tmpdir(), "pi-runtime-ops-empty-"));
  try {
    const empty = RuntimeOpsView.open(resolveRuntimeOpsConfig({ repoRoot: orphan, env: { PI_ENGINEERING_STATE_DIR: join(orphan, "state") }, configPath: null, cwd: orphan }));
    const status = await empty.runtimeStatus();
    assert.equal(status.missions.available, false);
    assert.match(status.missions.reason, /no orchestration store/u);
    assert.equal(status.activity.available, false);
    const health = await empty.health();
    assert.equal(health.ok, false, "the state root does not exist yet, so health is not clean");
    const storeCheck = health.checks.find((check) => check.name === "orchestrationStore");
    assert.equal(storeCheck?.ok, true, "no store because nothing has run is a known state, not a failure");
    assert.match(storeCheck?.detail ?? "", /no orchestration store/u);
    assert.equal(health.checks.find((check) => check.name === "orchestrationReadable")?.ok, true);
    // "Nothing has run yet" is a known state: the task list is empty, and health says why.
    assert.equal((await empty.tasks({})).tasks.length, 0);
  } finally {
    rmSync(orphan, { recursive: true, force: true });
  }
});

test("a malformed config is reported and the defaults still answer", async () => {
  const broken = join(root, "broken.json");
  writeFileSync(broken, "{ not json");
  const resolution = resolveRuntimeOpsConfig({ repoRoot: root, env: { PI_ENGINEERING_STATE_DIR: join(root, "state") }, configPath: broken, cwd: root });
  assert.equal(resolution.source, "arg");
  assert.equal(resolution.problems.length, 1);
  assert.match(resolution.problems[0] ?? "", /not valid JSON/u);
  const report = await RuntimeOpsView.open(resolution).health();
  assert.equal(report.checks.some((check) => check.name === "configProblem"), true);
});

test("the CLI answers status and task, and its exit code means what it says", async () => {
  let out = "";
  let err = "";
  const io = { write: (value: string) => (out += value), error: (value: string) => (err += value), cwd: root, repoRoot: root };
  const env = { PI_ENGINEERING_STATE_DIR: join(root, "state"), PI_ENGINEERING_RUNTIME_OPS: "" };
  assert.equal(await runRuntimeOpsCli(["tasks", "--store", storeFile, "--json"], env, io), 0);
  const parsed = JSON.parse(out) as { tasks: { taskId: string }[] };
  assert.equal(parsed.tasks.length, 2);

  out = "";
  // TASK-DOC has an unresolved citation, so `task` exits 1: it found a problem, it did not fail.
  assert.equal(await runRuntimeOpsCli(["task", "TASK-DOC", "--store", storeFile, "--at-ref", "worktree", "--json"], env, io), 1);
  assert.equal((JSON.parse(out) as { citationDrift: { status: string } }).citationDrift.status, "checked");

  out = "";
  assert.equal(await runRuntimeOpsCli(["task", "TASK-CODE", "--store", storeFile, "--json"], env, io), 0, "no citations to check is not a failure");

  out = "";
  assert.equal(await runRuntimeOpsCli(["nonsense"], env, io), 2);
  assert.match(err, /unknown runtime-ops verb nonsense/u);
});
