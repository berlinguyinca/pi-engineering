import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

/**
 * End-to-end test of the complete vertical slice, driven by a deterministic
 * fake worker executor so it runs without a model endpoint:
 *
 *   inspect repo -> ledger -> fresh scout -> bounded scout result -> task
 *   context -> implement (real edits in an isolated worktree) -> deterministic
 *   verification -> fresh review -> promote -> captured evidence.
 */
test("vertical slice: scout -> implement -> verify -> review -> promote", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      scout: () => ({
        status: "completed",
        summary: "Change src/add.js to implement add(a,b). Test is test/add.test.js.",
        claims: [{ claim: "add lives in src/add.js", evidence: "symbol://add" }],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: ["implement add"],
        details: {},
      }),
      implementer: async (req) => {
        // The implementer genuinely edits the isolated worktree.
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "Implemented add.", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => ({
        status: "completed",
        summary: "No material findings.",
        claims: [],
        details: { findings: [] },
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });

    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer("Implement add(a, b) to return the sum of a and b");

    // Promoted with an incumbent.
    assert.equal(report.outcome, "promoted");
    assert.ok(report.incumbent_candidate, "an incumbent candidate should be promoted");
    const incumbent = report.incumbent_candidate!;

    // A candidate diff was captured with the change.
    assert.ok(incumbent.diff?.includes("add.js"), "candidate diff should mention add.js");
    assert.ok(incumbent.changed_files.includes("src/add.js"));

    // Deterministic verification evidence was recorded.
    assert.ok(report.evidence_ids.length >= 1, "verification evidence should be recorded");
    assert.ok(report.verification?.passed, "verification should pass");

    // The work item is COMPLETED and the incumbent is recorded.
    assert.equal(report.work_item.status, "COMPLETED");
    assert.equal(rt.ledger.getWorkItem(report.work_item.id)?.incumbent_candidate_id, incumbent.id);

    // Promotion performs the controlled, evidence-gated merge: the verified
    // change now lives on the incumbent branch (INV-003 means the worker never
    // wrote there directly; the runtime merged the isolated candidate).
    const mainContent = await readFile(join(fixture.root, "src", "add.js"), "utf-8");
    assert.ok(mainContent.includes("a + b"), "promotion should merge the verified change into the working tree");

    // The scout's claim was recorded as an unverified hypothesis (never a fact).
    const hypotheses = rt.ledger.listEntities("hypothesis");
    assert.ok(hypotheses.some((h) => h.claim.includes("add lives in src/add.js")));
    assert.equal(hypotheses[0]?.status, "verified"); // evidence-backed claim

    // A fresh independent review ran.
    assert.ok(report.review_summary?.length, "review should have run");
  } finally {
    await fixture.cleanup();
  }
});

test("vertical slice: material review findings trigger a fix round (risk-proportional)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let reviewCalls = 0;
    const worker = new FakeWorkerExecutor({
      scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "implemented", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => {
        reviewCalls++;
        // First review finds a material issue; the fix round's review is clean.
        const findings =
          reviewCalls === 1
            ? [{ severity: "high", claim: "Missing edge-case handling for negative inputs", evidence: "diff://src/add.js" }]
            : [];
        return {
          status: "completed",
          summary: reviewCalls === 1 ? "Found material issue." : "No material findings.",
          claims: [],
          details: { findings },
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        };
      },
    });

    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer("Implement add(a, b) to return the sum of a and b");

    assert.equal(report.outcome, "promoted");
    assert.equal(report.rounds, 2, "a fix round should follow the first review");
    assert.ok(report.incumbent_candidate);
    // Child candidate lineage: incumbent has a parent.
    assert.ok(report.incumbent_candidate!.parent_id, "fix candidate should be a child of the first candidate");
  } finally {
    await fixture.cleanup();
  }
});

test("clean-room challenge produces an independent assessment", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      "clean-room-challenger": () => ({
        status: "completed",
        summary: "Alternative: implement add in src/add.js with a simple return.",
        claims: [],
        details: { assessment: "Independent approach confirmed; low risk." },
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
    const wi = await rt.ledger.createWorkItem("Implement add", "high", ["."], { type: "system" });
    const res = await rt.challenge(wi, "Implement add(a,b) returning a+b", "");
    assert.ok(res?.summary.includes("Alternative"));
    assert.equal(res?.assessment, "Independent approach confirmed; low risk.");
  } finally {
    await fixture.cleanup();
  }
});

function writeFile(p: string, content: string): Promise<void> {
  return import("node:fs/promises").then((fs) => fs.mkdir(p.split("/").slice(0, -1).join("/"), { recursive: true }).then(() => fs.writeFile(p, content)));
}
