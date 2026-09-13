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

    // The scout's claim was recorded as an open hypothesis (INV-006): its
    // "symbol://add" evidence is agent-authored text, not machine evidence, so
    // it must not be silently promoted to a verified fact.
    const hypotheses = rt.ledger.listEntities("hypothesis");
    const h = hypotheses.find((x) => x.claim.includes("add lives in src/add.js"));
    assert.ok(h, "scout claim should be recorded as a hypothesis");
    assert.equal(h!.status, "open");

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

test("worker requests carry the role's hard context-token budget (spec §10.6)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const seen: string[] = [];
    const worker = new FakeWorkerExecutor(
      {
        scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
        implementer: async (req) => {
          await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
          return { status: "completed", summary: "i", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
        },
        reviewer: () => ({ status: "completed", summary: "r", claims: [], details: { findings: [] }, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      },
      undefined,
    );
    // Wrap to capture requests.
    const captured = new Map<string, number>();
    const wrapped = {
      run: async (req: Parameters<typeof worker.run>[0]) => {
        captured.set(req.role, req.maxContextTokens ?? -1);
        seen.push(req.role);
        return worker.run(req);
      },
    } as never;
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker: wrapped, verifier: new CommandVerifier() });
    await rt.engineer("Implement add(a, b) to return a + b");
        assert.equal(captured.get("scout"), 24000);
    assert.equal(captured.get("implementer"), 40000);
    assert.equal(captured.get("reviewer"), 24000);
  } finally {
    await fixture.cleanup();
  }
});

test("high-risk work runs a mandatory clean-room challenger (spec §12.2)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let challenged = false;
    const worker = new FakeWorkerExecutor({
      "clean-room-challenger": () => {
        challenged = true;
        return {
          status: "completed",
          summary: "Independent approach: rewrite add with early bounds checks.",
          claims: [],
          details: { assessment: "Independent approach confirmed; watch for overflow." },
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        };
      },
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "implemented", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => ({ status: "completed", summary: "clean", claims: [], details: { findings: [] }, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    // "security" classifies the goal as high-risk.
    const report = await rt.engineer("Harden add(a, b) against integer overflow for security");
    assert.equal(report.risk, "critical");
    assert.equal(challenged, true, "high-risk work must run a clean-room challenger");
    assert.ok(report.challenge_summary?.includes("Independent approach"));
    const decisions = rt.ledger.listEntities("decision");
    assert.ok(decisions.some((d) => d.claim.includes("clean-room challenge")), "challenge assessment should be recorded as a decision");
  } finally {
    await fixture.cleanup();
  }
});

test("persistent material findings fail the work item (no final-round bypass)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "implemented", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => ({
        status: "completed",
        summary: "always finds a material issue",
        claims: [],
        details: { findings: [{ severity: "high", claim: "edge case not handled", evidence: "diff://src/add.js" }] },
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer("Implement add(a, b) to return a + b");
    assert.equal(report.outcome, "failed", "must not promote with open material findings");
    assert.equal(report.incumbent_candidate, null);
    assert.equal(report.work_item.status, "FAILED");
    const rejected = rt.ledger.listCandidates().filter((c) => c.status === "REJECTED");
    assert.equal(rejected.length, 3, "all rounds should be rejected");
    // Main branch must remain untouched (never merged a rejected candidate).
    const mainContent = await readFile(join(fixture.root, "src", "add.js"), "utf-8");
    assert.ok(mainContent.includes("not implemented"));
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

test("candidate tournament verifies all, selects a deterministic winner, promotes it", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let impl = 0;
    let rev = 0;
    const worker = new FakeWorkerExecutor({
      scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      implementer: async (req) => {
        impl++;
        if (impl === 1) {
          await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`); // correct
        } else if (impl === 2) {
          await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a - b;\n}\n`); // broken (fails test)
        } else {
          await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b + 0;\n}\n`); // correct but sloppier
        }
        return { status: "completed", summary: "i", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => {
        rev++;
        // Only the third (sloppier) candidate gets a material finding.
        const findings = rev === 2 ? [{ severity: "high", claim: "unnecessary +0 noise", evidence: "diff://src/add.js" }] : [];
        return { status: "completed", summary: "r", claims: [], details: { findings }, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.tournament("Implement add(a, b) to return a + b", { n: 3 });
    assert.equal(report.outcome, "promoted");
    assert.equal(report.n_candidates, 3);
    assert.equal(report.entries.length, 3);
    assert.equal(report.incumbent_candidate!.id, report.entries.find((e) => e.winner)!.candidate.id);
    // Winner is the clean first candidate (0 findings, smallest diff), not the sloppy one.
    assert.equal(report.entries[0]!.winner, true);
    const rejected = rt.ledger.listCandidates().filter((c) => c.status === "REJECTED");
    assert.equal(rejected.length, 2, "two losers must be recorded as rejected");
    // Main branch now contains the winner's clean implementation.
    const mainContent = await readFile(join(fixture.root, "src", "add.js"), "utf-8");
    assert.ok(mainContent.includes("return a + b;"), "promoted winner implementation present");
  } finally {
    await fixture.cleanup();
  }
});

test("implementer cannot neutralize its own verification gate by editing the worktree package.json (review HIGH #2)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        // The implementer writes a BROKEN add() AND rewrites the worktree's
        // test script to always pass, trying to neutralize the gate.
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a - b;\n}\n`);
        await writeFile(join(req.cwd, "package.json"), JSON.stringify({ name: "f", version: "0.0.1", type: "module", scripts: { test: "node -e process.exit(0)" } }, null, 2));
        return { status: "completed", summary: "implemented", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      reviewer: () => ({ status: "completed", summary: "clean", claims: [], details: { findings: [] }, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer("Implement add(a, b) to return a + b");
    // The gate profile comes from the MAIN repo (node --test), which runs the
    // real test in the worktree and fails on the broken add(). So the candidate
    // must fail verification even though the worktree test script is neutered.
    assert.equal(report.outcome, "failed", "broken candidate must fail despite gamed worktree package.json");
    assert.equal(report.incumbent_candidate, null);
    const rejected = rt.ledger.listCandidates().filter((c) => c.status === "REJECTED");
    assert.ok(rejected.length >= 1);
  } finally {
    await fixture.cleanup();
  }
});

test("review keeps the full diff out of context behind a lazy artifact reference (milestone)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const capturedTasks: string[] = [];
    const worker = new FakeWorkerExecutor(
      {
        reviewer: () => ({
          status: "completed",
          summary: "clean",
          claims: [],
          details: { findings: [] },
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        }),
      },
      undefined,
    );
    const wrapped = {
      run: async (req: Parameters<typeof worker.run>[0]) => {
        if (req.role === "reviewer") capturedTasks.push(req.task);
        return worker.run(req);
      },
    } as never;
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker: wrapped });
    const wi = await rt.ledger.createWorkItem("review target", "medium", [fixture.root], { type: "system" });
    const cand = await rt.ledger.createCandidate(wi.id, "abc", "b", null, "implementer", "run", null, { type: "system" });
    // ~10k chars, far beyond the 2000-char preview, with a UNIQUE marker at the
    // very end so we can prove the full body is not inlined into the prompt.
    const bigDiff = "export const a = 1;\n".repeat(499) + "// UNIQUE_END_MARKER_9f3x\n";
    await rt.ledger.changeCandidate(cand.id, { diff: bigDiff, changed_files: ["src/a.js"] }, wi.id, { type: "system" });

    await rt.review(wi, cand, "must be correct");

    const task = capturedTasks[0] ?? "";
    assert.ok(!task.includes("UNIQUE_END_MARKER_9f3x"), "the full diff must NOT be inlined into the reviewer prompt");
    assert.ok(task.length < bigDiff.length, `reviewer prompt (${task.length}) should be smaller than the diff (${bigDiff.length})`);
    assert.ok(task.includes("artifact_read"), "reviewer must be instructed to read the diff artifact");
    assert.match(task, /artifact:\/\/candidate\//);

    // The full diff is retrievable lazily from the artifact store.
    const meta = rt.artifacts.list("candidate").find((m) => m.id === cand.id);
    assert.ok(meta, "the full diff should be stored as an artifact");
    assert.equal(await rt.artifacts.readContent(meta!.category, meta!.id), bigDiff);
  } finally {
    await fixture.cleanup();
  }
});

test("a review that fails to complete must not silently promote (INV-007)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let reviewCalls = 0;
    const worker = new FakeWorkerExecutor({
      scout: () => ({ status: "completed", summary: "s", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "implemented", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      // The reviewer times out / exceeds its budget on EVERY attempt: it returns
      // a failed status with no findings (as the real executor does on abort).
      reviewer: () => {
        reviewCalls++;
        return {
          status: "failed",
          summary: "Worker exceeded the hard context-token budget.",
          claims: [],
          details: {},
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        };
      },
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.engineer("Implement add(a, b) to return a + b");
    // No candidate may be promoted without a completed independent review.
    assert.equal(report.outcome, "failed", "must not promote with an incomplete review");
    assert.equal(report.incumbent_candidate, null);
    // The review was retried with fresh sessions but never completed.
    assert.ok(reviewCalls >= 2, "incomplete reviews should be retried with a fresh session");
    // A blocking (critical) finding was recorded.
    const blocking = rt.ledger.listEntities("finding").filter((f) => f.severity === "critical");
    assert.ok(blocking.length >= 1, "a critical finding should be recorded when review cannot complete");
    // Main branch untouched.
    const mainContent = await readFile(join(fixture.root, "src", "add.js"), "utf-8");
    assert.ok(mainContent.includes("not implemented"));
  } finally {
    await fixture.cleanup();
  }
});

test("tournament never promotes a candidate whose review did not complete (INV-007)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return { status: "completed", summary: "i", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] };
      },
      // Every review fails to complete (budget/timeout) on all candidates.
      reviewer: () => ({
        status: "failed",
        summary: "budget",
        claims: [],
        details: {},
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker, verifier: new CommandVerifier() });
    const report = await rt.tournament("Implement add(a, b) to return a + b", { n: 2 });
    assert.equal(report.outcome, "failed", "no winner may be promoted without a completed review");
    assert.equal(report.incumbent_candidate, null);
    assert.ok(report.entries.every((e) => e.reviewCompleted === false));
    assert.ok(report.entries.every((e) => e.winner === false));
  } finally {
    await fixture.cleanup();
  }
});

function writeFile(p: string, content: string): Promise<void> {
  return import("node:fs/promises").then((fs) => fs.mkdir(p.split("/").slice(0, -1).join("/"), { recursive: true }).then(() => fs.writeFile(p, content)));
}
