/**
 * Quota exhaustion switches model through the production path: a worker reports `inferenceFailure: "quota"` ->
 * ContextHandoffTrigger (decideQuotaResume over the operator's engineering.yaml `quota_fallbacks`) -> a `recovery` record
 * with cause=quota_exhausted and from/to model -> HandoffDriver (verify -> switch the task's model -> fence the source
 * writer) -> the scheduler's ordinary retry runs the SUCCESSOR on the fallback model from the verified checkpoint ->
 * acknowledged. Everything is entered through Orchestrator.orchestrate().
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { ExecutionBroker } from "../../src/orchestration/broker.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import type { HandoffVerifyDeps } from "../../src/orchestration/handoffProtocol.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildContinuityConfig } from "../../src/runtime/continuityWiring.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { QUOTA_EXHAUSTED_SUMMARY } from "../../src/workers/activity.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Call {
  model: unknown;
  sawFirstWorkersCommit: boolean;
  sessionId: string | undefined;
}

async function harness(yaml: string | null) {
  const fx = await makeFixtureRepo();
  cleanups.push(() => fx.cleanup());
  const agentDir = await mkdtemp(join(tmpdir(), "quota-agent-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  if (yaml !== null) await writeFile(join(agentDir, "engineering.yaml"), yaml);
  const phaseHandoff = await buildContinuityConfig({
    agentDir,
    models: async () => [
      { provider: "gw", id: "primary", contextWindow: 1000 },
      { provider: "gw", id: "fallback", contextWindow: 1000 },
    ],
  });
  const git = (await GitRepo.open(fx.root))!;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const envelopes = new EnvelopeStore({ dir: await mkdtemp(join(tmpdir(), "quota-env-")), source: "pi-h-00000001" });
  const lineage = createLineageEmitter({ store: envelopes }, { host: "pi-h-00000001" })!;
  store.setLineage(lineage);
  const calls: Call[] = [];
  const reports: string[] = [];
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree, signal, onActivity, sessionId, modelRequirements }) => {
        const n = calls.length + 1;
        calls.push({
          model: modelRequirements?.model,
          sawFirstWorkersCommit: existsSync(join(worktree!, "src", "w1.js")),
          sessionId,
        });
        await mkdir(join(worktree!, "src"), { recursive: true });
        await writeFile(join(worktree!, "src", `w${n}.js`), `export const a = ${n};\n`);
        await git.commitAll(worktree!, `work ${n}`);
        if (n === 1) {
          onActivity?.({
            kind: "state",
            summary: QUOTA_EXHAUSTED_SUMMARY,
            meaningfulProgress: false,
            inferenceFailure: "quota",
          });
          // Keep running until the handoff either fences this writer or reports that it is blocked.
          const end = Date.now() + 15_000;
          while (
            Date.now() < end &&
            !signal.aborted &&
            !store.listHandoffRecords().some((h) => h.sourceFencedAt || h.blockedReason)
          ) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
      },
    },
    integration: {
      runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
        for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
        return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
      },
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    git,
    parentSessionId: "sess-parent",
    phaseHandoff,
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
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
  });
  (orchestrator as unknown as { progress: Map<string, (l: string) => void> }).progress = new Map();
  const base = await git.headCommit();
  const run = async () => {
    const result = await orchestrator.orchestrate("build", {
      repository: fx.root,
      baseRef: base,
      mutationRequested: true,
    });
    await orchestrator.settleHandoffs();
    return result.mission.mission_id;
  };
  return { store, backend, orchestrator, calls, reports, run, lineage, envelopes, git, fx };
}

const agentExecutions = (store: MissionStore, missionId: string) =>
  store.listExecutions(missionId).filter((e) => e.backend === "agent");

describe("quota exhaustion switches the model through orchestrate()", () => {
  it("quota -> verify -> switch -> fence -> successor on the fallback model from the verified checkpoint -> acknowledged", async () => {
    const h = await harness("quota_fallbacks:\n  roles:\n    implementer: [gw/fallback]\n");
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    const [fenced, successor, ...extra] = agentExecutions(h.store, missionId);
    assert.equal(extra.length, 0, "exactly one retry, no double spawn");
    assert.ok(record);
    assert.equal(record.kind, "recovery");
    assert.equal(record.cause, "quota_exhausted");
    assert.equal(record.fromModel, "gw/primary");
    assert.equal(record.toModel, "gw/fallback");
    assert.equal(record.state, "acknowledged");
    assert.ok(record.verifiedAt && record.sourceFencedAt);
    assert.ok(Date.parse(record.verifiedAt as string) <= Date.parse(record.sourceFencedAt as string));
    assert.equal(fenced?.model, "gw/primary");
    assert.equal(fenced?.status, "CANCELED");
    assert.match(fenced?.exit_status ?? "", /late_result_rejected:handoff source fenced/);
    assert.equal(successor?.model, "gw/fallback", "the successor runs on the configured fallback");
    assert.equal(successor?.status, "SUCCEEDED");
    assert.equal(record.predecessor.sessionId, fenced?.session_id);
    assert.equal(record.successor?.sessionId, successor?.session_id);
    assert.deepEqual(
      h.calls.map((c) => c.model),
      ["gw/primary", "gw/fallback"],
    );
  });

  it("the successor continues from the verified checkpoint, across models", async () => {
    const h = await harness("quota_fallbacks:\n  default: [gw/fallback]\n");
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(
      h.calls[1]?.sawFirstWorkersCommit,
      true,
      "the fallback worker's tree contains the first worker's commit",
    );
    const task = h.store.listTasks(missionId).find((t) => t.kind === "agent");
    assert.ok(record?.checkpointSha);
    assert.ok(task?.repair_base_candidate_sha?.startsWith(record.checkpointSha as string));
    assert.equal(task?.execution_requirements.model, "gw/fallback");
    assert.equal(task?.status, "SUCCEEDED");
  });

  it("the lineage handoff edge carries the cause and the from/to model", async () => {
    const h = await harness("quota_fallbacks:\n  roles:\n    implementer: [gw/fallback]\n");
    await h.run();
    await h.lineage.idle();
    const events = (await h.envelopes.outbox.pending()).filter((e) => e.entity_type === "lineage");
    const edge = events.find(
      (e) =>
        e.event_type === "edge.add" &&
        (e.payload as { edge_type?: string }).edge_type === "handoff" &&
        (e.payload as { attrs?: { cause?: string } }).attrs?.cause === "quota_exhausted",
    );
    assert.ok(edge, "a handoff edge with the quota cause was emitted");
    const attrs = (edge?.payload as { attrs: Record<string, unknown> }).attrs;
    assert.equal(attrs.from_model, "gw/primary");
    assert.equal(attrs.to_model, "gw/fallback");
  });

  it("with no fallback configured the handoff says so and stays blocked: the source is never fenced, no model is picked", async () => {
    const h = await harness(null);
    const missionId = await h.run();
    const [record, ...more] = h.store.listHandoffRecords(missionId);
    assert.equal(more.length, 0);
    assert.equal(record?.cause, "quota_exhausted");
    assert.equal(record?.state, "prepared");
    assert.match(record?.blockedReason ?? "", /no quota_fallbacks configured for role implementer/);
    assert.equal(record?.toModel, undefined);
    assert.equal(record?.sourceFencedAt, undefined);
    const executions = agentExecutions(h.store, missionId);
    assert.equal(executions.length, 1, "nothing was started on another model");
    assert.notEqual(executions[0]?.status, "CANCELED", "the source was not fenced");
    assert.equal(
      h.store.listTasks(missionId).find((t) => t.kind === "agent")?.execution_requirements.model,
      "gw/primary",
    );
  });

  it("a fallback that is listed but unavailable counts as none: blocked, naming the configured list", async () => {
    const h = await harness("quota_fallbacks:\n  roles:\n    implementer: [gw/not-in-registry]\n");
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(record?.state, "prepared");
    assert.match(
      record?.blockedReason ?? "",
      /none of the configured quota_fallbacks for role implementer is eligible \(gw\/not-in-registry\)/,
    );
    assert.equal(agentExecutions(h.store, missionId).length, 1);
  });
});

describe("a crash in the middle of the switch resumes without a second spawn", () => {
  const passing: HandoffVerifyDeps = {
    hashArtifact: async () => null,
    commitExists: async () => true,
    hashFile: async () => null,
  };
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  const until = async (cond: () => boolean, ms = 15_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  async function rig() {
    const fx = await makeFixtureRepo();
    cleanups.push(() => fx.cleanup());
    const agentDir = await mkdtemp(join(tmpdir(), "quota-agent-"));
    cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
    await writeFile(join(agentDir, "engineering.yaml"), "quota_fallbacks:\n  roles:\n    implementer: [gw/fallback]\n");
    const phaseHandoff = await buildContinuityConfig({
      agentDir,
      models: async () => [
        { provider: "gw", id: "primary", contextWindow: 1000 },
        { provider: "gw", id: "fallback", contextWindow: 1000 },
      ],
    });
    const git = (await GitRepo.open(fx.root))!;
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "q",
      goal: "q",
      user_request: "q",
      repository: fx.root,
      base_ref: await git.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.bindWorkspaceManifest({
      manifestId: "WM-q",
      missionId: mission.mission_id,
      generation: 1,
      authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
      repositories: [
        {
          repoId: "repo-q",
          canonicalRoot: fx.root,
          baseRef: "main",
          baseSha: mission.base_ref,
          writableDomains: ["src/**"],
        },
      ],
      dependencyEdges: [],
      hash: "manifest-q",
      createdAt: "2026-10-29T10:00:00.000Z",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-q",
      kind: "agent",
      role: "implementer",
      objective: "q",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
      deliverables: ["implementation"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 100 },
      execution_requirements: { model: "gw/primary" },
    });
    let activity: ((event: Record<string, unknown>) => void) | undefined;
    const build = (s: MissionStore) =>
      new Orchestrator({
        store: s,
        backends: {
          agent: {
            runAgent: (async (input: { signal: AbortSignal; onActivity?: (e: Record<string, unknown>) => void }) => {
              activity = input.onActivity;
              await waitForAbort(input.signal);
              return { executionId: "e", exitStatus: "succeeded", summary: "x", artifactRefs: [], usage: {} };
            }) as never,
          },
        },
        planner: async () => [],
        git,
        parentSessionId: "sess-parent",
        phaseHandoff,
      });
    const orchestrator = build(store);
    const internals = orchestrator as unknown as {
      broker: ExecutionBroker;
      handoffDriver: { deps: { verifyDeps?: HandoffVerifyDeps } };
    };
    internals.handoffDriver.deps.verifyDeps = passing;
    const handle = await internals.broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      repoId: "repo-q",
      kind: "agent",
      role: "implementer",
      objective: "q",
      mutatesRepo: true,
      writeDomains: task.write_domains,
      isolation: "worktree",
      modelRequirements: task.execution_requirements,
      deliverables: task.deliverables,
      executionBudgetMs: task.execution_budget_ms,
      checkpointPolicy: task.checkpoint_policy,
    });
    const settled = handle.result().catch(() => undefined);
    cleanups.push(async () => {
      await handle.cancel().catch(() => undefined);
      await settled;
    });
    await until(() => activity !== undefined);
    return { store, backend, orchestrator, internals, git, build, mission, task, emit: activity! };
  }

  const switches = (backend: ReturnType<typeof JsonlEventStore.inMemory>) =>
    backend.all().filter((e) => e.type === "task.model_switched");
  const fenceStamps = (backend: ReturnType<typeof JsonlEventStore.inMemory>) =>
    backend
      .all()
      .filter(
        (e) =>
          e.type === "handoff.transitioned" &&
          (e.payload as { handoff?: { sourceFencedAt?: string } }).handoff?.sourceFencedAt,
      );

  it("crash after the model switch but before the fence stamp: the reopened runtime fences once and the switch is not repeated", async () => {
    const r = await rig();
    const real = r.internals.broker.quarantineExecution.bind(r.internals.broker);
    let crashed = false;
    r.internals.broker.quarantineExecution = async (id: string) => {
      if (!crashed) {
        crashed = true;
        throw new Error("crash during fence");
      }
      await real(id);
    };
    r.emit({ kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, meaningfulProgress: false, inferenceFailure: "quota" });
    await until(() => switches(r.backend).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await r.orchestrator.settleHandoffs();
    const [record] = r.store.listHandoffRecords(r.mission.mission_id);
    assert.equal(record?.toModel, "gw/fallback");
    assert.equal(record?.sourceFencedAt, undefined, "the crash left the fence unstamped");
    assert.equal(r.store.getTask(r.task.task_id)?.execution_requirements.model, "gw/fallback", "switch is durable");

    await r.store.flush();
    const reopened = MissionStore.open(r.backend);
    assert.equal(
      reopened.getTask(r.task.task_id)?.execution_requirements.model,
      "gw/fallback",
      "replayed from the journal",
    );
    const resumed = r.build(reopened);
    (
      resumed as unknown as { handoffDriver: { deps: { verifyDeps?: HandoffVerifyDeps } } }
    ).handoffDriver.deps.verifyDeps = passing;
    await resumed.repairBlockedMission(r.mission.mission_id);
    await resumed.settleHandoffs();
    assert.ok(reopened.getHandoffRecord(record?.id as string)?.sourceFencedAt, "fenced on resume");
    await resumed.repairBlockedMission(r.mission.mission_id);
    await resumed.settleHandoffs();
    assert.equal(switches(r.backend).length, 1, "the switch was written once");
    assert.equal(fenceStamps(r.backend).length, 1, "one fence stamp");
    assert.equal(
      reopened.listExecutions(r.mission.mission_id).filter((e) => e.model === "gw/fallback").length,
      0,
      "the driver never spawns: nothing started on the fallback by the resume itself",
    );
  });

  it("crash after the fence: only an execution on the fallback model acknowledges, a same-model retry never does", async () => {
    const r = await rig();
    r.emit({ kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, meaningfulProgress: false, inferenceFailure: "quota" });
    await until(() => r.store.listHandoffRecords(r.mission.mission_id).some((h) => h.sourceFencedAt));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await r.orchestrator.settleHandoffs();
    await r.store.flush();
    const reopened = MissionStore.open(r.backend);
    const [record] = reopened.listHandoffRecords(r.mission.mission_id);
    assert.equal(record?.state, "validated");
    const resumed = r.build(reopened);
    const observe = async (executionId: string) => {
      (resumed as unknown as { observeWorkerActivity(e: unknown): void }).observeWorkerActivity({
        kind: "state",
        summary: "Worker session started",
        meaningfulProgress: false,
        missionId: r.mission.mission_id,
        taskId: r.task.task_id,
        executionId,
      });
      await resumed.settleHandoffs();
    };
    const spawn = (session: string, model: string) => {
      const e = reopened.createExecution({
        task_id: r.task.task_id,
        mission_id: r.mission.mission_id,
        backend: "agent",
        session_id: session,
        model,
      });
      reopened.setExecutionStatus(e.execution_id, "RUNNING", {});
      return e.execution_id;
    };
    await observe(spawn("WKS-decoy", "gw/primary"));
    assert.equal(
      reopened.getHandoffRecord(record?.id as string)?.state,
      "validated",
      "a same-model retry is not the successor",
    );
    await observe(spawn("WKS-real", "gw/fallback"));
    const done = reopened.getHandoffRecord(record?.id as string);
    assert.equal(done?.state, "acknowledged");
    assert.equal(done?.successor?.sessionId, "WKS-real");
    assert.equal(switches(r.backend).length, 1);
    assert.equal(fenceStamps(r.backend).length, 1);
  });
});
