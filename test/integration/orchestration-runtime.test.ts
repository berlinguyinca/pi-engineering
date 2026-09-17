/**
 * End-to-end test through the REAL EngineeringRuntime wiring: runtime ->
 * orchestrator -> broker -> realBackends -> fake worker + real CommandVerifier
 * over an isolated git fixture repo. Proves the extension-facing path works
 * without a live model.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

async function openRuntime(
  root: string,
  reviewFindings: unknown[] = [],
  onRun?: (cwd: string, role: string) => Promise<void> | void,
) {
  const worker: WorkerExecutor = {
    async run(req) {
      await onRun?.(req.cwd ?? root, req.role ?? "");
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} did ${req.task}`,
          claims: [{ claim: "done", evidence: "artifact://test" }],
          evidence_refs: ["artifact://test"],
          new_hypotheses: [],
          proposed_tasks: [],
          details: reviewFindings.length ? { findings: reviewFindings } : {},
        },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 100,
          turns: 1,
          model: "fake",
        },
        toolCalls: 1,
      };
    },
  };
  return EngineeringRuntime.open({
    cwd: root,
    worker,
    verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
  });
}

describe("orchestration via real EngineeringRuntime (acceptance scenarios)", () => {
  const fixtures: Array<{ root: string; cleanup: () => Promise<void> }> = [];

  /**
   * A fixture whose own test suite PASSES at baseline.
   *
   * The shared fixture ships `add()` unimplemented on purpose (the vertical-slice
   * test has an agent implement it), so `npm test` in it fails. A happy-path
   * orchestration scenario asserts validation passes, so it needs a green repo:
   * on a red one the completion gate now correctly refuses to complete — earlier
   * these scenarios only "passed" because a failing validation suite was being
   * ignored (runSingleTask trusted resolution instead of exitStatus).
   */
  async function greenFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const fx = await makeFixtureRepo();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${fx.root}/src/add.js`, "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["-C", fx.root, "add", "-A"]);
    await exec("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
    return fx;
  }

  it("scenario A: 'Add a health endpoint' auto-invokes engineering+validation+review and completes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    assert.ok(rt.orchestrator, "orchestrator must be wired by the runtime");
    assert.ok(rt.missionStore, "mission store must be wired by the runtime");

    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, true);
    assert.equal(result.mission.status, "COMPLETE");
    assert.ok(result.mission.required_gates.includes("validation"));
    assert.ok(result.mission.required_gates.includes("independent_review"));
    const store = rt.missionStore!;
    const tasks = store.listTasks(result.mission.mission_id);
    // implementer + validation + review tasks all SUCCEEDED
    assert.ok(tasks.some((t) => t.kind === "agent" && t.status === "SUCCEEDED"));
    assert.ok(tasks.some((t) => t.kind === "validation" && t.status === "SUCCEEDED"));
    assert.ok(tasks.some((t) => t.kind === "review" && t.status === "SUCCEEDED"));
  });

  it("scenario B: investigation escalates to engineering+review when source changes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    // Pure investigation: no mutation -> completes as investigation.
    const r0 = await rt.orchestrator!.orchestrate("Find out why login fails", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: false,
    });
    assert.equal(r0.mission.workflow_class, "investigation");
    // With a mutation request -> escalates to engineering_review.
    const r1 = await rt.orchestrator!.orchestrate("Find out why login fails", {
      repository: rt.cwd,
      baseRef,
      changedFiles: ["src/auth/service.ts"],
      mutationRequested: true,
    });
    assert.notEqual(r1.mission.workflow_class, "investigation");
    assert.ok(r1.mission.required_gates.includes("independent_review"));
  });

  it("scenario D: a blocking reviewer finding blocks completion and the orchestrator creates repair work", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    // The review backend reports a blocking finding on every pass, so the
    // orchestrator must repair, re-review, and still refuse to complete.
    const rt = await openRuntime(fx.root, [
      {
        severity: "blocking",
        summary: "auth bypass: token not verified",
        category: "security",
        file: "src/a.ts",
        line: 1,
      },
    ]);
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Fix the login bug", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    const store = rt.missionStore!;

    assert.equal(result.completed, false, "a blocking finding must prevent completion");
    assert.notEqual(store.getMission(result.mission.mission_id)!.status, "COMPLETE");
    assert.ok(
      store.listFindings(result.mission.mission_id).some((f) => f.severity === "blocking"),
      "the blocking finding stays on the record",
    );
    // The orchestrator itself created repair work (not the test).
    const repairs = store
      .listTasks(result.mission.mission_id)
      .filter((t) => t.objective.startsWith("Repair review finding"));
    assert.ok(repairs.length >= 1, "the orchestrator must create repair task(s) from the finding");
    assert.ok(
      repairs.every((t) => t.mutates_repo && t.isolation === "worktree"),
      "repairs mutate in isolation",
    );
    // And it re-reviewed after repairing (more than one review task ran).
    const reviews = store.listTasks(result.mission.mission_id).filter((t) => t.kind === "review");
    assert.ok(reviews.length >= 2, `expected a re-review after repair, saw ${reviews.length}`);
  });

  it("a read-only investigation mission never gets a mutating task and still completes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Why is login failing?", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: false,
    });
    const tasks = rt.missionStore!.listTasks(result.mission.mission_id);
    assert.equal(result.mission.workflow_class, "investigation");
    assert.ok(tasks.length > 0);
    assert.equal(
      tasks.filter((t) => t.mutates_repo).length,
      0,
      `investigation must not mutate: ${JSON.stringify(tasks.map((t) => [t.kind, t.mutates_repo]))}`,
    );
    // A mission with no post-execution gates must still reach COMPLETE rather
    // than dead-ending on an illegal transition.
    assert.equal(result.completed, true, result.failureReason ?? "");
    assert.equal(result.mission.status, "COMPLETE");
  });

  it("mission/task/execution state survives runtime restart over the same repo", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt1 = await openRuntime(fx.root);
    const baseRef = await rt1.git!.headCommit();
    const r = await rt1.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt1.cwd,
      baseRef,
      mutationRequested: true,
    });
    await rt1.missionStore!.flush();

    // Reopen a fresh runtime over the same repo -> durable store replayed.
    const rt2 = await openRuntime(fx.root);
    const restored = rt2.missionStore!.getMission(r.mission.mission_id);
    assert.ok(restored);
    assert.equal(restored.status, "COMPLETE");
    assert.equal(
      rt2.missionStore!.listTasks(r.mission.mission_id).length,
      rt1.missionStore!.listTasks(r.mission.mission_id).length,
    );
  });

  it("a mutating mission's change actually lands in the repository (worktree -> merge)", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    // The worker edits the checkout it was given (its own worktree), like a real
    // implementer does. Without harvesting + integration the worktree is torn
    // down and the mission "completes" with an unchanged repository.
    const workerCwd: string[] = [];
    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      workerCwd.push(cwd);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${cwd}/src`, { recursive: true });
      await writeFile(`${cwd}/src/health.ts`, `export const health = () => ({ ok: true });\n`, "utf8");
    });
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });

    const { access } = await import("node:fs/promises");
    let landed = true;
    try {
      await access(`${fx.root}/src/health.ts`);
    } catch {
      landed = false;
    }
    if (!landed) {
      assert.fail(
        `worker change never reached the repo (mission ${result.mission.status}, completed=${result.completed}, ${result.failureReason ?? ""})`,
      );
    }
    assert.ok(landed);
    // The change must have travelled worktree -> harvest -> merge, not been
    // written straight into the main checkout (which would make this test pass
    // vacuously if worktree isolation silently fell back to cwd).
    assert.ok(workerCwd.length >= 1, "implementer should have run");
    assert.notEqual(workerCwd[0], fx.root, "implementer must run in an isolated worktree");
    // And the mission only completed because the change was integrated first.
    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(integ.length >= 1, "an integration step must run for worktree-isolated mutation");
  });

  /** Commit a divergent edit on the same line the worker will touch. */
  async function commitInMain(root: string, content: string, msg: string): Promise<void> {
    await writeFile(`${root}/src/add.js`, content, "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["-C", root, "add", "-A"]);
    await exec("git", ["-C", root, "commit", "-q", "-m", msg]);
  }

  it("a conflicted merge blocks completion and leaves the incumbent tree intact", async () => {
    const fx = await greenFixture();
    const { GitRepo } = await import("../../src/git/GitRepo.ts");
    const probe = await GitRepo.open(fx.root);
    assert.ok(probe);
    const baseRef = await probe.headCommit();

    // Same line, different content on both sides -> a real merge conflict. The
    // incumbent line stays valid JS so the conflict, not a check failure, is
    // what blocks the mission.
    await commitInMain(fx.root, "export function add(a, b) {\n  return a + b; // main\n}\n", "main note");

    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      await writeFile(`${cwd}/src/add.js`, "export function add(a, b) {\n  return a + b; // worker\n}\n", "utf8");
    });

    const result = await rt.orchestrator!.orchestrate("Annotate the add helper", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });

    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(integ.length >= 1, "integration step should have been created");
    assert.ok(
      integ.some((t) => t.status === "FAILED"),
      `a conflicted merge must be recorded as FAILED, got ${integ.map((t) => t.status).join(",")}`,
    );
    assert.equal(result.completed, false, "a conflicted integration must never complete the mission");
    // mergeBranch aborts a conflicted merge, so the incumbent content survives
    // and the worker's line is not applied.
    const mainSrc = await readFile(`${fx.root}/src/add.js`, "utf8");
    assert.ok(mainSrc.includes("// main"), "incumbent content must survive a conflicted merge");
    assert.ok(!mainSrc.includes("// worker"), "conflicted worker change must not be applied");
    assert.ok(!mainSrc.includes("<<<<<<<"), "no conflict markers may be left in the working tree");
  });

  it("integration checks that fail after a clean merge block completion", async () => {
    const fx = await greenFixture();
    const baseRef = await (async () => {
      const { GitRepo } = await import("../../src/git/GitRepo.ts");
      const g = await GitRepo.open(fx.root);
      assert.ok(g);
      return g.headCommit();
    })();

    // Merges cleanly but breaks the repo's own suite: integration must report
    // failure through exitStatus (not throw) and the mission must not complete.
    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      await writeFile(`${cwd}/src/add.js`, "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
    });
    const result = await rt.orchestrator!.orchestrate("Change add to subtract", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "failing integration checks must block completion");
    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(
      integ.some((t) => t.status === "FAILED"),
      `integration must be FAILED, got ${integ.map((t) => t.status).join(",")}`,
    );
  });

  it("publishes the versioned mission snapshot file the PI WEB plugin reads (spec 08)", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    const snap = await rt.publishMissionSnapshot();
    assert.ok(snap);
    assert.equal(snap.contractVersion, 1);
    assert.equal(snap.missions.length, 1);
    // The file exists on disk where the browser plugin reads it.
    const { readFile } = await import("node:fs/promises");
    const onDisk = JSON.parse(await readFile(`${rt.workDir}/orchestration-snapshot.json`, "utf8")) as {
      missions: Array<{ status: string }>;
    };
    assert.equal(onDisk.missions[0]!.status, "COMPLETE");
  });

  after(async () => {
    for (const f of fixtures) await f.cleanup();
  });
});
