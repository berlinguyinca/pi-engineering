/**
 * A phase boundary under context pressure runs the SAME verify -> fence -> acknowledge path as a worker handoff.
 * The predecessor is the orchestrating session, which has no execution; the boundary therefore writes a real
 * orchestrator checkpoint (CheckpointManager.persistPhaseBoundary, scope "orchestrator"). "Fence" here means the
 * PREVIOUS phase's worker authority only (stragglers still RUNNING from before the boundary); the orchestrator never
 * fences itself or the mission lease, so the mission keeps running through the handoff. Entered via orchestrate().
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import type { HandoffVerifyDeps } from "../../src/orchestration/handoffProtocol.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(opts: { verifyDeps?: HandoffVerifyDeps; pressure?: boolean } = {}) {
  const fx = await makeFixtureRepo();
  cleanups.push(() => fx.cleanup());
  const git = (await GitRepo.open(fx.root))!;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree }) => {
        await mkdir(join(worktree!, "src"), { recursive: true });
        await writeFile(join(worktree!, "src", "w.js"), "export const a = 1;\n");
        await git.commitAll(worktree!, "work");
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "ok",
          artifactRefs: [],
          usage: { contextTokens: opts.pressure === false ? 100 : 800, model: "gw/primary" },
        };
      },
    },
    integration: {
      runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
        for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
        return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
      },
    },
    validation: {
      candidateScoped: true,
      runValidation: async () => ({
        executionId: "validation",
        exitStatus: "succeeded",
        summary: "valid",
        artifactRefs: [],
        usage: {},
        validationEvidence: {
          command: "test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    review: {
      candidateScoped: true,
      runReview: async ({ acceptanceCriteria }) => ({
        executionId: "review",
        exitStatus: "succeeded",
        summary: "approved",
        artifactRefs: [],
        usage: {},
        findings: [],
        reviewEvidence: {
          reviewerSessionId: "review-phase",
          model: "test",
          provider: "test",
          verdict: "approve",
          independenceMode: "independent",
          findings: [],
          outputValid: true,
          accessible: true,
          acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
            acceptanceId: criterion.acceptanceId,
            status: "passed" as const,
            detail: "checked",
          })),
        },
      }),
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    git,
    parentSessionId: "sess-parent",
    phaseHandoff: { contextWindowForModel: () => 1000 },
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "build",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: { model: "gw/primary" },
        acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
        deliverables: ["one"],
        max_attempts: 1,
        failure_policy: "block" as const,
      },
    ],
  });
  if (opts.verifyDeps) {
    (
      orchestrator as unknown as { handoffDriver: { deps: { verifyDeps?: HandoffVerifyDeps } } }
    ).handoffDriver.deps.verifyDeps = opts.verifyDeps;
  }
  const reports: string[] = [];
  const result = await orchestrator.orchestrate("build", {
    repository: fx.root,
    baseRef: await git.headCommit(),
    mutationRequested: true,
    onProgress: (line) => reports.push(line),
  });
  await orchestrator.settleHandoffs();
  return { store, backend, result, reports, missionId: result.mission.mission_id };
}

describe("phase_transition handoff through orchestrate()", () => {
  it("writes an orchestrator checkpoint, verifies it, fences the previous phase and acknowledges", async () => {
    const h = await harness();
    const handoffLine = h.reports.findIndex((l) => l.includes("phase_transition handoff"));
    assert.ok(handoffLine >= 0, h.reports.join(" | "));
    assert.ok(
      h.reports.slice(handoffLine + 1).some((l) => /\] phase \w+ /.test(l)),
      "the orchestrator kept running into the next phase after its own handoff",
    );
    const records = h.store.listHandoffRecords(h.missionId).filter((r) => r.kind === "phase_transition");
    assert.ok(records.length >= 1, `a phase handoff was emitted: ${h.reports.join(" | ")}`);
    for (const record of records) {
      assert.equal(record.cause, "context_pressure");
      assert.equal(record.predecessor.sessionId, "sess-parent");
      assert.equal(record.state, "acknowledged", `driven to the end: ${JSON.stringify(record)}`);
      assert.ok(record.verifiedAt && record.sourceFencedAt);
      assert.ok(Date.parse(record.verifiedAt as string) <= Date.parse(record.sourceFencedAt as string));
      assert.deepEqual(record.successor, { sessionId: "sess-parent", generation: record.predecessor.generation + 1 });
    }
    const checkpoints = h.store.listOrchestratorCheckpoints(h.missionId);
    assert.equal(checkpoints.length, records.length, "one real checkpoint per boundary");
    for (const cp of checkpoints) {
      assert.equal(cp.scope, "orchestrator");
      assert.equal(cp.sessionId, "sess-parent");
      assert.ok(cp.candidateSha);
      assert.ok(cp.handoff?.decisions[0]?.id.startsWith("phase:"));
      assert.ok(records.some((r) => cp.candidateSha?.startsWith(r.checkpointSha as string)));
    }
    assert.ok(
      h.store.listTaskCheckpoints(h.missionId).every((c) => c.scope === undefined),
      "worker-level checkpoint reads never see the orchestrator's",
    );
    // Nothing of the orchestrator's own was fenced: no execution was rejected, the mission lease is still held or released normally.
    assert.equal(
      h.store.listExecutions(h.missionId).filter((e) => e.exit_status?.startsWith("late_result_rejected")).length,
      0,
    );
    assert.ok(h.reports.some((l) => l.includes("phase_transition handoff")));
  });

  it("a checkpoint that fails verification leaves the record prepared and the mission running", async () => {
    const h = await harness({
      verifyDeps: { hashArtifact: async () => null, commitExists: async () => false, hashFile: async () => null },
    });
    assert.ok(
      h.reports
        .slice(h.reports.findIndex((l) => l.includes("phase_transition handoff")) + 1)
        .some((l) => /\] phase \w+ /.test(l)),
      "a rejected phase handoff never stops the orchestrator",
    );
    const records = h.store.listHandoffRecords(h.missionId).filter((r) => r.kind === "phase_transition");
    assert.ok(records.length >= 1);
    for (const record of records) {
      assert.equal(record.state, "prepared");
      assert.equal(record.verifiedAt, undefined);
      assert.equal(record.sourceFencedAt, undefined);
    }
    assert.ok(h.reports.some((l) => l.includes("REJECTED, source untouched")));
  });

  it("below the pressure threshold no phase handoff and no orchestrator checkpoint is written", async () => {
    const h = await harness({ pressure: false });
    assert.equal(h.store.listHandoffRecords(h.missionId).filter((r) => r.kind === "phase_transition").length, 0);
    assert.equal(h.store.listOrchestratorCheckpoints(h.missionId).length, 0);
  });
});

describe("what the phase fence covers", () => {
  it("revokes only previous-phase executions still RUNNING; a worker started after the boundary and the orchestrator are untouched", async () => {
    const fx = await makeFixtureRepo();
    cleanups.push(() => fx.cleanup());
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      git,
      parentSessionId: "sess-parent",
      phaseHandoff: { contextWindowForModel: () => 1000 },
      planner: async () => [],
    });
    const mission = store.createMission({
      title: "p",
      goal: "p",
      user_request: "p",
      repository: fx.root,
      base_ref: await git.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.bindWorkspaceManifest({
      manifestId: "WM-p",
      missionId: mission.mission_id,
      generation: 1,
      authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
      repositories: [
        {
          repoId: "repo-p",
          canonicalRoot: fx.root,
          baseRef: "main",
          baseSha: mission.base_ref,
          writableDomains: ["src/**"],
        },
      ],
      dependencyEdges: [],
      hash: "manifest-p",
      createdAt: "2026-10-29T10:00:00.000Z",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-p",
      kind: "agent",
      role: "implementer",
      objective: "p",
      deliverables: ["d"],
    });
    const run = (session: string, status: "RUNNING" | "SUCCEEDED", usage: Record<string, unknown> = {}) => {
      const e = store.createExecution({
        task_id: task.task_id,
        mission_id: mission.mission_id,
        backend: "agent",
        session_id: session,
        model: "gw/primary",
      });
      store.setExecutionStatus(e.execution_id, "RUNNING", {});
      if (status === "SUCCEEDED") store.setExecutionStatus(e.execution_id, "SUCCEEDED", { usage });
      return e.execution_id;
    };
    const sleep = () => new Promise((r) => setTimeout(r, 8));
    const phase = (orchestrator as unknown as { phase(m: unknown, p: string): void }).phase.bind(orchestrator);
    phase(store.getMission(mission.mission_id), "classified");
    await sleep();
    const earlierPhase = run("WKS-classified", "RUNNING");
    await sleep();
    phase(store.getMission(mission.mission_id), "executing");
    // Pressure data only appears now, so classified -> executing emits nothing and only executing -> repairing does.
    run("WKS-done", "SUCCEEDED", { contextTokens: 800 });
    await sleep();
    const straggler = run("WKS-straggler", "RUNNING");
    await sleep();
    phase(store.getMission(mission.mission_id), "repairing");
    await orchestrator.settleHandoffs();
    const later = run("WKS-next-phase", "RUNNING");
    await orchestrator.settleHandoffs();

    const [record] = store.listHandoffRecords(mission.mission_id);
    assert.equal(record?.kind, "phase_transition");
    assert.equal(record?.state, "acknowledged");
    assert.equal(
      store.getExecution(straggler)?.status,
      "CANCELED",
      "the previous phase's straggler lost its authority",
    );
    assert.match(store.getExecution(straggler)?.exit_status ?? "", /late_result_rejected:handoff source fenced/);
    assert.equal(store.getExecution(later)?.status, "RUNNING", "a worker the next phase started is not fenced");
    assert.equal(
      store.getExecution(earlierPhase)?.status,
      "RUNNING",
      "an execution of a phase before the finished one is not this boundary's to fence",
    );
    assert.equal(store.getMission(mission.mission_id)?.status !== "CANCELED", true);
  });
});

describe("restart and legacy records", () => {
  async function bare() {
    const fx = await makeFixtureRepo();
    cleanups.push(() => fx.cleanup());
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const build = (s: MissionStore) =>
      new Orchestrator({
        store: s,
        backends: {},
        git,
        parentSessionId: "sess-parent",
        phaseHandoff: { contextWindowForModel: () => 1000 },
        planner: async () => [],
      });
    const mission = store.createMission({
      title: "p",
      goal: "p",
      user_request: "p",
      repository: fx.root,
      base_ref: await git.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-p",
      kind: "agent",
      role: "implementer",
      objective: "p",
      deliverables: ["d"],
    });
    const run = (session: string, status: "RUNNING" | "SUCCEEDED", usage: Record<string, unknown> = {}) => {
      const e = store.createExecution({
        task_id: task.task_id,
        mission_id: mission.mission_id,
        backend: "agent",
        session_id: session,
        model: "gw/primary",
      });
      store.setExecutionStatus(e.execution_id, "RUNNING", {});
      if (status === "SUCCEEDED") store.setExecutionStatus(e.execution_id, "SUCCEEDED", { usage });
      return e.execution_id;
    };
    return { store, build, mission, task, run, git };
  }

  it("after a restart (no phase timeline) the first phase() calls fence nothing", async () => {
    const b = await bare();
    b.run("WKS-done", "SUCCEEDED", { contextTokens: 800 });
    const current = b.run("WKS-current", "RUNNING");
    await new Promise((r) => setTimeout(r, 8));
    const restarted = b.build(b.store);
    const phase = (restarted as unknown as { phase(m: unknown, p: string): void }).phase.bind(restarted);
    phase(b.store.getMission(b.mission.mission_id), "executing");
    phase(b.store.getMission(b.mission.mission_id), "repairing");
    await restarted.settleHandoffs();
    assert.equal(b.store.getExecution(current)?.status, "RUNNING", "a worker of unknown phase is never quarantined");
  });

  it("an old phase_transition record without an orchestrator checkpoint is aborted once, quietly, not retried", async () => {
    const b = await bare();
    const old = b.store.addHandoffRecord({
      id: "ho-old-phase",
      kind: "phase_transition",
      state: "prepared",
      missionId: b.mission.mission_id,
      predecessor: { sessionId: "sess-parent", generation: 0 },
      checkpointSha: "c".repeat(40),
      createdAt: new Date().toISOString(),
      cause: "context_pressure",
    });
    const o = b.build(b.store);
    const lines: string[] = [];
    (o as unknown as { progress: Map<string, (l: string) => void> }).progress.set(b.mission.mission_id, (l) =>
      lines.push(l),
    );
    await o.repairBlockedMission(b.mission.mission_id);
    await o.settleHandoffs();
    await o.repairBlockedMission(b.mission.mission_id);
    await o.settleHandoffs();
    const after = b.store.getHandoffRecord(old.id);
    assert.equal(after?.state, "aborted");
    assert.match(after?.blockedReason ?? "", /predates/);
    assert.equal(lines.filter((l) => l.includes("ho-old-phase")).length, 1, "reported once, not on every call");
  });

  it("a record cannot be driven by another boundary's checkpoint that merely shares the SHA and session", async () => {
    const b = await bare();
    b.run("WKS-done", "SUCCEEDED", { contextTokens: 800 });
    const o = b.build(b.store);
    const manager = (
      o as unknown as { checkpointManager: { persistPhaseBoundary(i: unknown): { candidateSha: string } } }
    ).checkpointManager;
    const cp = manager.persistPhaseBoundary({
      missionId: b.mission.mission_id,
      fromPhase: "executing",
      toPhase: "repairing",
      sessionId: "sess-parent",
      reason: "r",
    });
    const forged = b.store.addHandoffRecord({
      id: "ho-forged",
      kind: "phase_transition",
      state: "prepared",
      missionId: b.mission.mission_id,
      predecessor: { sessionId: "sess-parent", generation: 0 },
      checkpointSha: cp.candidateSha,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      fromPhase: "executing",
      toPhase: "complete",
    });
    const result = await (
      o as unknown as { handoffDriver: { drive(id: string): Promise<{ status: string }> } }
    ).handoffDriver.drive(forged.id);
    assert.equal(result.status, "skipped");
    assert.equal(b.store.getHandoffRecord(forged.id)?.state, "aborted");
    assert.equal(b.store.getHandoffRecord(forged.id)?.verifiedAt, undefined);
  });
});
