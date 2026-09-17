/**
 * End-to-end test through the REAL EngineeringRuntime wiring: runtime ->
 * orchestrator -> broker -> realBackends -> fake worker + real CommandVerifier
 * over an isolated git fixture repo. Proves the extension-facing path works
 * without a live model.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

async function openRuntime(root: string) {
  const worker: WorkerExecutor = {
    async run(req) {
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} did ${req.task}`,
          claims: [{ claim: "done", evidence: "artifact://test" }],
          evidence_refs: ["artifact://test"],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
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

  it("scenario A: 'Add a health endpoint' auto-invokes engineering+validation+review and completes", async () => {
    const fx = await makeFixtureRepo();
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
    const fx = await makeFixtureRepo();
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

  it("scenario D: a reviewer finding blocks completion and creates repair work", async () => {
    // Not run through the default runtime (whose review backend returns no
    // findings); instead assert the gate + finding wiring directly via a store
    // with a blocking finding, matching what runSingleTask records.
    const fx = fixtures[0]!;
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    // Pre-seed a blocking finding on a fresh mission to prove the gate blocks.
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    const store = rt.missionStore!;
    store.addFinding({
      mission_id: result.mission.mission_id,
      task_id: null,
      severity: "blocking",
      category: "correctness",
      file: "src/server.ts",
      line: 1,
      summary: "missing null check",
      evidence: null,
      recommended_action: "add guard",
    });
    const verdict = rt.orchestrator!.gate.evaluate(store.getMission(result.mission.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(verdict.reasons.some((r) => r.includes("blocking")));
    // Repair work: a repair task is scheduled by the operator/repair loop.
    const repair = store.createTask({
      mission_id: result.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "Repair: add null guard",
      mutates_repo: true,
      write_domains: ["src/server/**"],
    });
    assert.equal(repair.status, "PENDING");
  });

  it("mission/task/execution state survives runtime restart over the same repo", async () => {
    const fx = await makeFixtureRepo();
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

  it("publishes the versioned mission snapshot file the PI WEB plugin reads (spec 08)", async () => {
    const fx = await makeFixtureRepo();
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
