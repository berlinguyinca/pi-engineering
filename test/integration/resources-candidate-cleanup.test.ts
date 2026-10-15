/**
 * Issue #143: candidate worktrees and branches are owned resources. Rejection
 * releases them through the ResourceRegistry (journaled), a failed removal is
 * retained and visible as a ledger finding, and a branch the registry does not
 * own is never deleted.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const runFile = promisify(execFile);
const GOAL = "Implement add(a, b) to return the sum of a and b";

const scout = () => ({
  status: "completed" as const,
  summary: "Change src/add.js.",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
  details: {},
});
const reviewer = () => ({ status: "completed" as const, summary: "clean", details: { findings: [] } });
const nothing = () => ({
  status: "completed" as const,
  summary: "did nothing",
  claims: [],
  details: {},
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
});

async function branches(root: string): Promise<string[]> {
  const r = await runFile("git", ["-C", root, "branch", "--list", "pi-eng-*", "--format=%(refname:short)"]);
  return r.stdout.split("\n").filter(Boolean);
}

test("a rejected candidate leaves 0 owned branches and releases every record", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({ scout, implementer: nothing, reviewer });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer(GOAL);
    assert.notEqual(report.outcome, "promoted");
    assert.deepEqual(await branches(fixture.root), []);
    const owned = await rt.resourceRegistry.listOwned(report.work_item.id);
    assert.ok(owned.length >= 1, "candidates are registered as owned resources");
    assert.ok(
      owned.every((r) => r.state === "released"),
      JSON.stringify(owned.map((r) => r.state)),
    );
    await rt.close();
  } finally {
    await fixture.cleanup();
  }
});

test("a failed removal leaves the record retained and records 1 ledger finding", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let calls = 0;
    const worker = new FakeWorkerExecutor({
      scout,
      reviewer,
      implementer: async (req) => {
        // Lock only the first candidate's worktree so its removal must fail.
        if (++calls === 1) await runFile("git", ["-C", fixture.root, "worktree", "lock", req.cwd]);
        return nothing();
      },
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer(GOAL);
    const owned = await rt.resourceRegistry.listOwned(report.work_item.id);
    const retained = owned.filter((r) => r.state === "retained");
    assert.equal(retained.length, 1, JSON.stringify(owned.map((r) => r.state)));
    assert.match(retained[0]!.retainedReason ?? "", /worktree remove failed|locked/i);
    const findings = rt.ledger
      .listEntities("finding")
      .filter((f) => f.work_item_id === report.work_item.id && /cleanup|release/i.test(f.claim));
    assert.equal(findings.length, 1, findings.map((f) => f.claim).join("\n"));
    assert.equal(findings[0]!.status, "open");
    const unlocked = retained[0]!.locator;
    await runFile("git", ["-C", fixture.root, "worktree", "unlock", unlocked]).catch(() => {});
    await rt.close();
  } finally {
    await fixture.cleanup();
  }
});

test("a branch absent from the ResourceRegistry survives the rejection path", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({ scout, implementer: nothing, reviewer });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer(GOAL);
    await runFile("git", ["-C", fixture.root, "branch", "pi-eng-foreign-branch"]);
    await rt.releaseCandidate({ id: "CAND-unregistered", branch: "pi-eng-foreign-branch" }, report.work_item);
    assert.deepEqual(await branches(fixture.root), ["pi-eng-foreign-branch"]);
    await rt.close();
  } finally {
    await fixture.cleanup();
  }
});

test("EngineeringRuntime no longer swallows deleteBranch errors", async () => {
  const source = await readFile(join(import.meta.dirname, "../../src/runtime/EngineeringRuntime.ts"), "utf8");
  assert.doesNotMatch(source, /deleteBranch\([^)]*\)\.catch\(\(\) => \{\}\)/);
});
