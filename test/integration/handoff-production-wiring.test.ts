/**
 * The verified handoff protocol is the production path: a context-pressure trigger fired through the REAL Orchestrator
 * (worker activity -> ContextHandoffTrigger -> broker checkpoint -> HandoffDriver -> executeHandoff -> MissionStore)
 * verifies the checkpoint, fences the source writer, terminates only its registered process groups, and acknowledges
 * only a successor that actually exists. Crash recovery re-enters through the Orchestrator's own mission-drive and first-activity paths on a reopened store.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { GitRepo } from "../../src/git/GitRepo.ts";
import type { ExecutionBroker } from "../../src/orchestration/broker.ts";
import type { HandoffDriver } from "../../src/orchestration/handoffDriver.ts";
import type { HandoffVerifyDeps } from "../../src/orchestration/handoffProtocol.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import type { EventStoreBackend } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { CONTEXT_USAGE_SUMMARY, QUOTA_EXHAUSTED_SUMMARY } from "../../src/workers/activity.ts";
import { sharedProcessQuarantine } from "../../src/workers/processQuarantine.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
const ok = { executionId: "e", exitStatus: "succeeded", summary: "x", artifactRefs: [], usage: {} };
const passingDeps: HandoffVerifyDeps = {
  hashArtifact: async () => null,
  commitExists: async () => true,
  hashFile: async () => null,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function detached(): number {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  cleanups.push(() => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
  });
  return child.pid as number;
}

interface Rig {
  store: MissionStore;
  backend: EventStoreBackend;
  orchestrator: Orchestrator;
  broker: ExecutionBroker;
  driver: HandoffDriver;
  missionId: string;
  taskId: string;
  executionId: () => string;
  childPid: number;
  unrelatedPid: number;
  reports: string[];
  emit: (tokens: number) => void;
  emitRaw: (event: Record<string, unknown>) => void;
  quarantineCalls: string[];
  git: GitRepo;
  root: string;
}

function buildOrchestrator(store: MissionStore, git: GitRepo, runAgent: unknown): Orchestrator {
  return new Orchestrator({
    store,
    backends: { agent: { runAgent: runAgent as never } },
    planner: async () => [],
    git,
    parentSessionId: "sess-parent",
    phaseHandoff: { contextWindowForModel: () => 1000 },
  });
}

async function rig(): Promise<Rig> {
  const fx = await makeFixtureRepo();
  cleanups.push(() => fx.cleanup());
  const git = (await GitRepo.open(fx.root)) as GitRepo;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "wiring",
    goal: "wiring",
    user_request: "wiring",
    repository: fx.root,
    base_ref: await git.headCommit(),
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest({
    manifestId: "WM-w",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-w",
        canonicalRoot: fx.root,
        baseRef: "main",
        baseSha: mission.base_ref,
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-w",
    createdAt: "2026-10-29T10:00:00.000Z",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    repo_id: "repo-w",
    kind: "agent",
    role: "implementer",
    objective: "wiring",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["implementation"],
    execution_budget_ms: 60_000,
    checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 100 },
  });
  const childPid = detached();
  const unrelatedPid = detached();
  let activity: ((event: Record<string, unknown>) => void) | undefined;
  let registered = false;
  const orchestrator = buildOrchestrator(
    store,
    git,
    async (input: {
      signal: AbortSignal;
      onActivity?: (e: Record<string, unknown>) => void;
    }) => {
      sharedProcessQuarantine.track(input.signal, { pid: childPid });
      activity = input.onActivity;
      registered = true;
      await waitForAbort(input.signal);
      return ok;
    },
  );
  const internals = orchestrator as unknown as {
    broker: ExecutionBroker;
    handoffDriver: HandoffDriver;
    progress: Map<string, (l: string) => void>;
  };
  const reports: string[] = [];
  internals.progress.set(mission.mission_id, (line) => reports.push(line));
  const quarantineCalls: string[] = [];
  const realQuarantine = internals.broker.quarantineExecution.bind(internals.broker);
  internals.broker.quarantineExecution = async (id: string) => {
    quarantineCalls.push(id);
    await realQuarantine(id);
  };
  const handle = await internals.broker.execute({
    taskId: task.task_id,
    missionId: mission.mission_id,
    repoId: "repo-w",
    kind: "agent",
    role: "implementer",
    objective: task.objective,
    mutatesRepo: true,
    writeDomains: task.write_domains,
    isolation: "worktree",
    deliverables: task.deliverables,
    executionBudgetMs: task.execution_budget_ms,
    checkpointPolicy: task.checkpoint_policy,
  });
  const settled = handle.result().catch(() => undefined);
  cleanups.push(async () => {
    await handle.cancel().catch(() => undefined);
    await settled;
  });
  await until(() => registered);
  const executionId = () => store.listExecutions(mission.mission_id)[0]?.execution_id as string;
  return {
    store,
    backend,
    orchestrator,
    broker: internals.broker,
    driver: internals.handoffDriver,
    missionId: mission.mission_id,
    taskId: task.task_id,
    executionId,
    childPid,
    unrelatedPid,
    reports,
    quarantineCalls,
    git,
    root: fx.root,
    emitRaw: (event) => activity?.(event),
    emit: (tokens) =>
      activity?.({
        kind: "state",
        summary: CONTEXT_USAGE_SUMMARY,
        meaningfulProgress: false,
        context: { tokens, window: 1000, model: "gw/test" },
      }),
  };
}

const events = (backend: EventStoreBackend, type: string) => backend.all().filter((e) => e.type === type);
const stamps = (backend: EventStoreBackend) =>
  events(backend, "handoff.transitioned").filter(
    (e) => (e.payload as { handoff?: { sourceFencedAt?: string } }).handoff?.sourceFencedAt,
  );

/** Production re-drive entry points: a mission being (re)driven, and the first activity of a new execution. */
async function redrive(o: Orchestrator, missionId: string): Promise<void> {
  await o.repairBlockedMission(missionId);
  await o.settleHandoffs();
}
async function firstActivity(o: Orchestrator, missionId: string, taskId: string, executionId: string): Promise<void> {
  (o as unknown as { observeWorkerActivity(e: unknown): void }).observeWorkerActivity({
    kind: "state",
    summary: "Worker session started",
    meaningfulProgress: false,
    missionId,
    taskId,
    executionId,
  });
  await o.settleHandoffs();
}

async function settleTrigger(r: Rig): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await r.orchestrator.settleHandoffs();
}

describe("a context trigger through the Orchestrator runs the verified protocol", () => {
  it("emergency crossing: checkpoint verified, source writer fenced, only its process group terminated, then the successor acknowledges", async () => {
    const r = await rig();
    assert.equal(alive(r.childPid), true);
    r.emit(950);
    await until(() => r.store.listHandoffRecords(r.missionId).some((h) => h.sourceFencedAt));
    await settleTrigger(r);

    const [record] = r.store.listHandoffRecords(r.missionId);
    assert.ok(record);
    assert.equal(record.kind, "context");
    assert.equal(record.cause, "context_pressure");
    const execution = r.store.getExecution(r.executionId());
    assert.ok(execution?.session_id, "the broker names the worker session");
    assert.equal(record.predecessor.sessionId, execution.session_id, "predecessor is the writer's own session");
    assert.equal(record.state, "validated");
    assert.ok(record.verifiedAt && record.sourceFencedAt);
    assert.ok(Date.parse(record.verifiedAt as string) <= Date.parse(record.sourceFencedAt as string));
    assert.equal(execution.status, "CANCELED", "the source writer lost its authority");
    assert.match(execution.exit_status ?? "", /late_result_rejected:handoff source fenced/);
    await until(() => !alive(r.childPid));
    assert.equal(alive(r.unrelatedPid), true, "a process group nobody registered is never touched");
    assert.ok(r.reports.some((l) => l.includes("verified, source fenced; awaiting the successor")));

    // No successor yet: never acknowledged on its own.
    await redrive(r.orchestrator, r.missionId);
    assert.equal(r.store.getHandoffRecord(record.id)?.state, "validated");

    // The successor execution (same task, another session) attaches; the next drive acknowledges it, nothing else.
    const successor = r.store.createExecution({
      task_id: r.taskId,
      mission_id: r.missionId,
      backend: "agent",
      session_id: "WKS-successor",
    });
    r.store.setExecutionStatus(successor.execution_id, "RUNNING", {});
    await firstActivity(r.orchestrator, r.missionId, r.taskId, successor.execution_id);
    const done = r.store.getHandoffRecord(record.id);
    assert.equal(done?.state, "acknowledged");
    assert.equal(done?.successor?.sessionId, "WKS-successor");
    assert.equal(stamps(r.backend).length >= 1, true);
    assert.equal(
      new Set(
        stamps(r.backend).map((e) => (e.payload as { handoff: { sourceFencedAt: string } }).handoff.sourceFencedAt),
      ).size,
      1,
      "the fence was stamped once",
    );
    assert.equal(events(r.backend, "execution.late_result_rejected").length, 1, "the writer was fenced exactly once");
  });

  it("a duplicate trigger is idempotent: one record, one fence, one process termination", async () => {
    const r = await rig();
    for (let i = 0; i < 6; i++) r.emit(950 + i);
    await until(() => r.store.listHandoffRecords(r.missionId).some((h) => h.sourceFencedAt));
    await settleTrigger(r);
    for (let i = 0; i < 3; i++) await redrive(r.orchestrator, r.missionId);
    r.emit(990);
    await settleTrigger(r);
    assert.equal(r.store.listHandoffRecords(r.missionId).length, 1);
    assert.equal(events(r.backend, "execution.late_result_rejected").length, 1);
    assert.equal(
      new Set(
        stamps(r.backend).map((e) => (e.payload as { handoff: { sourceFencedAt: string } }).handoff.sourceFencedAt),
      ).size,
      1,
    );
    assert.equal(r.quarantineCalls.length, 1, "no second fence after the stamp");
  });

  it("verification failure leaves the source writer, its lease and its processes intact, and a retry can succeed", async () => {
    const r = await rig();
    (r.driver as unknown as { deps: { verifyDeps?: HandoffVerifyDeps } }).deps.verifyDeps = {
      ...passingDeps,
      commitExists: async () => false,
    };
    r.emit(950);
    await until(() => r.store.listHandoffRecords(r.missionId).length === 1);
    await settleTrigger(r);

    const [record] = r.store.listHandoffRecords(r.missionId);
    assert.equal(record?.state, "prepared");
    assert.equal(record?.verifiedAt, undefined);
    assert.equal(record?.sourceFencedAt, undefined);
    const execution = r.store.getExecution(r.executionId());
    assert.equal(execution?.status, "RUNNING", "the source still holds its authority");
    assert.doesNotThrow(() => r.store.assertExecutionAuthoritative(r.executionId()));
    assert.equal(alive(r.childPid), true, "its processes were not terminated");
    assert.equal(r.quarantineCalls.length, 0);
    assert.ok(r.reports.some((l) => l.includes("REJECTED, source untouched") && l.includes("selective_compaction")));

    // Evidence is repaired: the same record is driven again from where it stopped.
    (r.driver as unknown as { deps: { verifyDeps?: HandoffVerifyDeps } }).deps.verifyDeps = passingDeps;
    await redrive(r.orchestrator, r.missionId);
    assert.ok(r.store.getHandoffRecord(record?.id as string)?.sourceFencedAt);
    assert.equal(r.store.getExecution(r.executionId())?.status, "CANCELED");
    await until(() => !alive(r.childPid));
  });

  it("a crash between verify and fence resumes through the entry point and fences once", async () => {
    const r = await rig();
    const real = r.broker.quarantineExecution.bind(r.broker);
    let failNext = true;
    r.broker.quarantineExecution = async (id: string) => {
      if (failNext) {
        failNext = false;
        r.quarantineCalls.push(`crash:${id}`);
        throw new Error("crash during fence");
      }
      await real(id);
    };
    (r.driver as unknown as { deps: { verifyDeps?: HandoffVerifyDeps } }).deps.verifyDeps = passingDeps;
    r.emit(950);
    await until(() => r.store.listHandoffRecords(r.missionId).some((h) => h.verifiedAt));
    await settleTrigger(r);
    let record = r.store.listHandoffRecords(r.missionId)[0];
    assert.ok(record?.verifiedAt, "verified");
    assert.equal(record?.sourceFencedAt, undefined, "the fence did not complete");
    assert.equal(record?.state, "validated");

    // Reopen the durable store (a restarted runtime) and drive through the production entry point.
    await r.store.flush();
    const reopened = MissionStore.open(r.backend);
    const git = r.git;
    const resumed = buildOrchestrator(reopened, git, async () => ok);
    await redrive(resumed, r.missionId);
    record = reopened.getHandoffRecord(record?.id as string);
    assert.ok(record?.sourceFencedAt, "fenced on resume");
    // KNOWN LIMIT, pinned so it cannot be forgotten: process registrations live in the dead runtime's memory, so a
    // restarted runtime can revoke the writer's authority but cannot terminate processes it never registered.
    assert.equal(alive(r.childPid), true, "processes started before a runtime restart are NOT terminated");
    assert.equal(record?.verifiedAt !== undefined, true);
    assert.equal(
      events(r.backend, "execution.late_result_rejected").length,
      1,
      "the writer authority was revoked once even though the fence ran twice",
    );
    await redrive(resumed, r.missionId);
    assert.equal(stamps(r.backend).length, 1, "one fence stamp in the durable history");
  });

  it("a crash between prepare and verify, and between fence and acknowledge, resume without re-fencing", async () => {
    const r = await rig();
    (r.driver as unknown as { deps: { verifyDeps?: HandoffVerifyDeps } }).deps.verifyDeps = passingDeps;
    // Crash before verify: stop the drive from running at all by making the driver unreachable during creation.
    const original = r.driver.drive.bind(r.driver);
    r.driver.drive = async () => ({ status: "skipped", reason: "crashed before the drive started" });
    r.emit(950);
    await until(() => r.store.listHandoffRecords(r.missionId).length === 1);
    await settleTrigger(r);
    const prepared = r.store.listHandoffRecords(r.missionId)[0];
    assert.equal(prepared?.state, "prepared");
    r.driver.drive = original;

    await r.store.flush();
    const reopened = MissionStore.open(r.backend);
    const second = buildOrchestrator(reopened, r.git, async () => ok);
    (
      second as unknown as { handoffDriver: { deps: { verifyDeps?: HandoffVerifyDeps } } }
    ).handoffDriver.deps.verifyDeps = passingDeps;
    await redrive(second, r.missionId);
    const fenced = reopened.getHandoffRecord(prepared?.id as string);
    assert.ok(fenced?.verifiedAt && fenced.sourceFencedAt, "resumed: verified then fenced");
    assert.equal(fenced?.state, "validated");

    // Crash between fence and acknowledge: a third runtime with a successor present acknowledges, fencing nothing again.
    await reopened.flush();
    const again = MissionStore.open(r.backend);
    const successor = again.createExecution({
      task_id: r.taskId,
      mission_id: r.missionId,
      backend: "agent",
      session_id: "WKS-next",
    });
    again.setExecutionStatus(successor.execution_id, "RUNNING", {});
    const third = buildOrchestrator(again, r.git, async () => ok);
    const thirdCalls: string[] = [];
    const thirdBroker = (third as unknown as { broker: ExecutionBroker }).broker;
    thirdBroker.quarantineExecution = async (id: string) => void thirdCalls.push(id);
    await firstActivity(third, r.missionId, r.taskId, successor.execution_id);
    const acknowledged = again.getHandoffRecord(prepared?.id as string);
    assert.equal(acknowledged?.state, "acknowledged");
    assert.equal(acknowledged?.successor?.sessionId, "WKS-next");
    assert.equal(acknowledged?.sourceFencedAt, fenced?.sourceFencedAt, "the original fence stamp is kept");
    assert.deepEqual(thirdCalls, [], "no second fence");
    assert.equal(events(r.backend, "execution.late_result_rejected").length, 1);
  });
});

describe("quota exhaustion is a distinct cause that never picks a model on its own", () => {
  it("with no quota fallback configured the recovery record says so and stays blocked: nothing is fenced", async () => {
    const r = await rig();
    r.emitRaw({
      kind: "state",
      summary: QUOTA_EXHAUSTED_SUMMARY,
      meaningfulProgress: false,
      inferenceFailure: "quota",
    });
    await until(() => r.store.listHandoffRecords(r.missionId).length === 1);
    await settleTrigger(r);
    await redrive(r.orchestrator, r.missionId);
    const [record] = r.store.listHandoffRecords(r.missionId);
    assert.equal(record?.kind, "recovery");
    assert.equal(record?.cause, "quota_exhausted");
    assert.equal(record?.state, "prepared");
    assert.match(record?.blockedReason ?? "", /no quota_fallbacks configured for role implementer/);
    assert.equal(record?.toModel, undefined);
    assert.equal(record?.verifiedAt, undefined);
    assert.equal(record?.sourceFencedAt, undefined);
    assert.equal(r.store.getExecution(r.executionId())?.status, "RUNNING", "the source is untouched");
    assert.equal(r.quarantineCalls.length, 0);
    assert.ok(r.reports.some((l) => l.includes("quota handoff BLOCKED")));
  });
});
