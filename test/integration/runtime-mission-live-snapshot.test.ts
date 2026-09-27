import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { MissionSnapshotFile } from "../../src/orchestration/missionSnapshot.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

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
