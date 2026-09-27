import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BlackholeManager } from "../../src/blackhole/BlackholeManager.ts";
import type { MissionSnapshotFile } from "../../src/orchestration/missionSnapshot.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const execFileAsync = promisify(execFile);

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
    { cwd: root },
  );
}

test("runtime starts the supervisor, repairs blocked missions before open returns, and stops it on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-supervised-reopen-"));
  const workDir = join(root, ".pi-eng");
  const starts: MissionSupervisor[] = [];
  const stops: MissionSupervisor[] = [];
  const repairs: string[] = [];
  const originalStart = MissionSupervisor.prototype.start;
  const originalStop = MissionSupervisor.prototype.stop;
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  try {
    await initGit(root);
    const first = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const mission = first.missionStore!.createMission({
      title: "resume on reopen",
      goal: "recover durable work",
      user_request: "recover durable work",
      repository: root,
      base_ref: await first.git!.headCommit(),
      risk_profile: "low",
      workflow_class: "engineering",
    });
    first.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
    first.missionStore!.transitionMission(mission.mission_id, "BLOCKED");
    await first.close();

    MissionSupervisor.prototype.start = function () {
      starts.push(this);
      return originalStart.call(this);
    };
    MissionSupervisor.prototype.stop = function () {
      stops.push(this);
      return originalStop.call(this);
    };
    Orchestrator.prototype.repairBlockedMission = async (missionId: string) => {
      repairs.push(missionId);
      return mission;
    };

    const reopened = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    assert.deepEqual(
      repairs,
      [mission.mission_id],
      "startup reconciliation must dispatch supported repair before open returns",
    );
    assert.equal(starts.length, 1, "runtime owns one supervisor interval");
    await reopened.close();
    assert.deepEqual(stops, starts, "runtime close must stop the exact supervisor it started");
  } finally {
    MissionSupervisor.prototype.start = originalStart;
    MissionSupervisor.prototype.stop = originalStop;
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot preserves the complete actionable stop payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-actionable-stop-"));
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "stopped recovery",
      goal: "retain exact recovery evidence",
      user_request: "retain exact recovery evidence",
      repository: root,
      base_ref: "",
      risk_profile: "high",
      workflow_class: "engineering",
    });
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    runtime.missionStore!.stopMission(mission.mission_id, {
      reason: "repeated recovery fingerprint exhausted",
      attemptedRecoveries: ["recovery-1", "recovery-2"],
      preservedWork: ["refs/pi-engineering/candidate", "/tmp/preserved-worktree"],
      resumeCondition: "provide new material evidence",
    });

    const snapshot = await runtime.publishMissionSnapshot();
    const stop = snapshot?.missions[0]?.stop;
    assert.ok(stop);
    assert.match(stop.stoppedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      { ...stop, stoppedAt: "<timestamp>" },
      {
        reason: "repeated recovery fingerprint exhausted",
        attemptedRecoveries: ["recovery-1", "recovery-2"],
        preservedWork: ["refs/pi-engineering/candidate", "/tmp/preserved-worktree"],
        resumeCondition: "provide new material evidence",
        stoppedAt: "<timestamp>",
      },
    );
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("periodic supervisor ticks consume orphan recovery, normalize BLOCKED, and republish status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-periodic-supervisor-"));
  const activities: string[] = [];
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      worker: new FakeWorkerExecutor({}),
      onMissionActivity: (event) => activities.push(`${event.missionId}:${event.state}`),
    });
    const mission = runtime.missionStore!.createMission({
      title: "periodic orphan",
      goal: "repair after startup",
      user_request: "repair after startup",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(mission.mission_id, "READY");
    runtime.missionStore!.transitionMission(mission.mission_id, "EXECUTING");
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    activities.length = 0;
    const repaired: string[] = [];
    Orchestrator.prototype.repairBlockedMission = async (missionId: string) => {
      repaired.push(missionId);
      return runtime.missionStore!.getMission(missionId)!;
    };

    await runtime.missionSupervisor!.tick(mission.mission_id);

    assert.deepEqual(repaired, [mission.mission_id]);
    assert.equal(runtime.missionStore!.getMission(mission.mission_id)?.status, "BLOCKED");
    assert.ok(activities.some((entry) => entry.startsWith(`${mission.mission_id}:`)));
    const snapshot = await runtime.publishMissionSnapshot();
    assert.equal(snapshot?.missions[0]?.status, "BLOCKED");
    await runtime.close();
  } finally {
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    await rm(root, { recursive: true, force: true });
  }
});

test("startup settles one failed repair durably and continues repairing other missions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-startup-independent-"));
  const workDir = join(root, ".pi-eng");
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  try {
    const first = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const createBlocked = (title: string) => {
      const mission = first.missionStore!.createMission({
        title,
        goal: title,
        user_request: title,
        repository: root,
        base_ref: "",
        risk_profile: "low",
        workflow_class: "engineering",
      });
      first.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
      first.missionStore!.transitionMission(mission.mission_id, "BLOCKED");
      return mission;
    };
    const broken = createBlocked("broken repair");
    const healthy = createBlocked("healthy repair");
    await first.close();
    const calls: string[] = [];
    Orchestrator.prototype.repairBlockedMission = async (missionId: string) => {
      calls.push(missionId);
      if (missionId === broken.mission_id) throw new Error("one mission repair failed");
      return healthy;
    };

    const reopened = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });

    assert.deepEqual(new Set(calls), new Set([broken.mission_id, healthy.mission_id]));
    assert.match(reopened.missionStore!.listMissionStops(broken.mission_id).at(-1)?.reason ?? "", /repair failed/i);
    assert.ok(reopened.missionStore!.listFailureClassifications(broken.mission_id).length > 0);
    assert.ok(reopened.missionSupervisor, "one mission failure must not prevent periodic supervision");
    await reopened.close();
  } finally {
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    await rm(root, { recursive: true, force: true });
  }
});

test("fallible initialization completes before the supervisor starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-supervisor-init-order-"));
  const originalOpen = BlackholeManager.open;
  const originalStart = MissionSupervisor.prototype.start;
  let starts = 0;
  try {
    BlackholeManager.open = async () => {
      throw new Error("blackhole init failed");
    };
    MissionSupervisor.prototype.start = function () {
      starts++;
      return originalStart.call(this);
    };
    await assert.rejects(
      EngineeringRuntime.open({
        cwd: root,
        worker: new FakeWorkerExecutor({}),
        blackhole: { config: { enabled: true } },
      }),
      /blackhole init failed/,
    );
    assert.equal(starts, 0, "no supervisor interval may survive failed initialization");
  } finally {
    BlackholeManager.open = originalOpen;
    MissionSupervisor.prototype.start = originalStart;
    await rm(root, { recursive: true, force: true });
  }
});

test("custom tools are bound before startup recovery can dispatch a repair worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-repair-tool-order-"));
  const workDir = join(root, ".pi-eng");
  const originalSetTools = PiWorkerExecutor.prototype.setCustomTools;
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  let toolsBound = false;
  try {
    const first = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const mission = first.missionStore!.createMission({
      title: "tool-bound repair",
      goal: "repair with tools",
      user_request: "repair with tools",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    first.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
    first.missionStore!.transitionMission(mission.mission_id, "BLOCKED");
    await first.close();
    PiWorkerExecutor.prototype.setCustomTools = function (tools) {
      toolsBound = true;
      return originalSetTools.call(this, tools);
    };
    Orchestrator.prototype.repairBlockedMission = async () => {
      assert.equal(toolsBound, true, "repair dispatch must see the runtime's semantic tools");
      return mission;
    };

    const reopened = await EngineeringRuntime.open({ cwd: root, workDir });
    await reopened.close();
  } finally {
    PiWorkerExecutor.prototype.setCustomTools = originalSetTools;
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent opens for one repository share a single live runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-single-flight-"));
  const nested = join(root, "src");
  try {
    await mkdir(nested);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      {
        cwd: root,
      },
    );
    const [fromRoot, fromNested] = await Promise.all([
      EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) }),
      EngineeringRuntime.open({ cwd: nested, worker: new FakeWorkerExecutor({}) }),
    ]);

    assert.strictEqual(fromNested, fromRoot, "same-root callers must not receive split in-memory mission views");
    const mission = fromRoot.missionStore!.createMission({
      title: "single flight",
      goal: "share one mission view",
      user_request: "share one mission view",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    assert.equal(fromNested.missionStore!.getMission(mission.mission_id)?.title, "single flight");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sequential opens for one repository keep sharing the live mission view", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-sequential-open-"));
  const nested = join(root, "src");
  try {
    await mkdir(nested);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const fromRoot = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const fromNested = await EngineeringRuntime.open({ cwd: nested, worker: new FakeWorkerExecutor({}) });

    assert.notStrictEqual(fromNested, fromRoot, "later opens must refresh dynamic runtime configuration");
    assert.strictEqual(fromNested.missionStore, fromRoot.missionStore, "later opens must reuse the live mission state");
    const mission = fromRoot.missionStore!.createMission({
      title: "sequential view",
      goal: "keep one live mission view",
      user_request: "keep one live mission view",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    assert.equal(fromNested.missionStore!.getMission(mission.mission_id)?.title, "sequential view");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime exposes bounded redacted mission activity updates for persistent surfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-live-surface-"));
  const updates: Array<{
    missionId: string;
    phase: string;
    summary: string;
    activeWorkers: number;
    lastHeartbeatAt?: string;
  }> = [];
  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      worker: new FakeWorkerExecutor({}),
      onMissionActivity: (event) => updates.push(event),
    });
    const mission = runtime.missionStore!.createMission({
      title: "surface",
      goal: "show bounded activity",
      user_request: "show bounded activity",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    runtime.missionObservability!.workerStarted(mission.mission_id, "wk-1");
    const secret = `sk-${"s".repeat(32)}`;
    runtime.missionObservability!.activity(mission.mission_id, {
      type: "running_command",
      summary: `Running a very long command with ${secret} ${"detail ".repeat(80)}`,
      workerId: "wk-1",
    });
    runtime.missionObservability!.heartbeat(mission.mission_id, "wk-1", { elapsedMs: 15_000 });
    await runtime.missionObservability!.flush();
    await runtime.publishMissionSnapshot();

    const latest = updates.at(-1);
    assert.ok(latest, "every projection change should reach the persistent UI hook");
    assert.equal(latest.missionId, mission.mission_id);
    assert.equal(latest.activeWorkers, 1);
    assert.ok(latest.lastHeartbeatAt, "heartbeats must remain visible even when percentage does not move");
    assert.ok(latest.summary.length <= 240, `surface summary was not bounded: ${latest.summary.length}`);
    assert.doesNotMatch(latest.summary, /sk-ssss|\n|\r/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot replacement never exposes truncated JSON to concurrent readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-atomic-snapshot-"));
  const workDir = join(root, ".pi-eng");
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "atomic",
      goal: "x".repeat(2_000_000),
      user_request: "publish atomically",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    await runtime.publishMissionSnapshot();

    const path = join(workDir, "orchestration-snapshot.json");
    let reading = true;
    const parseFailures: unknown[] = [];
    const reader = (async () => {
      while (reading) {
        try {
          JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          parseFailures.push(error);
        }
      }
    })();
    await Promise.all(Array.from({ length: 20 }, () => runtime.publishMissionSnapshot()));
    reading = false;
    await reader;

    assert.deepEqual(parseFailures, [], "readers must see the old or new snapshot, never a partial write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime republishes a serialized live snapshot on worker activity and heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-live-snapshot-"));
  const workDir = join(root, ".pi-eng");
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "live",
      goal: "show detail",
      user_request: "show detail",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    runtime.missionObservability!.workerStarted(mission.mission_id, "wk-1");
    runtime.missionObservability!.activity(mission.mission_id, {
      type: "running_command",
      summary: "Running tool: bash",
      workerId: "wk-1",
    });
    runtime.missionObservability!.activity(mission.mission_id, {
      type: "typechecking",
      summary: "Finished tool: typecheck",
      workerId: "wk-1",
      meaningfulProgress: true,
    });
    runtime.missionObservability!.heartbeat(mission.mission_id, "wk-1", { elapsedMs: 15_000 });

    const path = join(workDir, "orchestration-snapshot.json");
    let snapshot: MissionSnapshotFile | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        snapshot = JSON.parse(await readFile(path, "utf8")) as MissionSnapshotFile;
        if (snapshot.missions[0]?.observability?.currentActivity?.summary === "Finished tool: typecheck") break;
      } catch {
        // Snapshot publication is asynchronous; retry briefly.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(snapshot?.missions[0]?.observability?.currentActivity?.summary, "Finished tool: typecheck");
    assert.ok(snapshot?.missions[0]?.observability?.lastHeartbeatAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime diagnoses a failed snapshot write and retries on the next activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-live-snapshot-retry-"));
  const workDir = join(root, ".pi-eng");
  const diagnostics: string[] = [];
  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
      onMissionSnapshotError: (message) => diagnostics.push(message),
    });
    const mission = runtime.missionStore!.createMission({
      title: "retry",
      goal: "show write failures",
      user_request: "show write failures",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    await runtime.publishMissionSnapshot();
    const path = join(workDir, "orchestration-snapshot.json");
    await rm(path, { force: true });
    await mkdir(path);

    runtime.missionObservability!.activity(mission.mission_id, {
      type: "tool_invocation",
      summary: "First update",
    });
    for (let i = 0; i < 50 && diagnostics.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(diagnostics, ["Mission snapshot publication failed; live mission detail may be stale."]);

    await rm(path, { recursive: true, force: true });
    runtime.missionObservability!.activity(mission.mission_id, {
      type: "tool_invocation",
      summary: "Retry update",
    });
    let snapshot: MissionSnapshotFile | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        snapshot = JSON.parse(await readFile(path, "utf8")) as MissionSnapshotFile;
        if (snapshot.missions[0]?.observability?.currentActivity?.summary === "Retry update") break;
      } catch {
        // The retry is triggered asynchronously by the observability change.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(snapshot?.missions[0]?.observability?.currentActivity?.summary, "Retry update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
