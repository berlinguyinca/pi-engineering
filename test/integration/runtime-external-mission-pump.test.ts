import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
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

/** Install a controllable runSubmittedMission stub: records ids and gates each start. */
function installRunStub(
  started: string[],
  pending: Array<{ id: string; release: () => void }>,
  original: typeof Orchestrator.prototype.runSubmittedMission,
): void {
  Orchestrator.prototype.runSubmittedMission = function (missionId: string) {
    started.push(missionId);
    const store = this.store;
    return new Promise((resolve) => {
      pending.push({
        id: missionId,
        release: () => {
          store.transitionMission(missionId, "CLASSIFYING");
          resolve({ started: true, result: {} as never });
        },
      });
    });
  };
}

function pump(rt: EngineeringRuntime, now = new Date()): void {
  (rt as unknown as { pumpExternalMissions(now?: Date): void }).pumpExternalMissions(now);
}

function setEnv(auto: string | undefined, max: string | undefined): () => void {
  const prevAuto = process.env.PI_AUTOSPEC_ENABLED;
  const prevMax = process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS;
  if (auto === undefined) delete process.env.PI_AUTOSPEC_ENABLED;
  else process.env.PI_AUTOSPEC_ENABLED = auto;
  if (max === undefined) delete process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS;
  else process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS = max;
  return () => {
    if (prevAuto === undefined) delete process.env.PI_AUTOSPEC_ENABLED;
    else process.env.PI_AUTOSPEC_ENABLED = prevAuto;
    if (prevMax === undefined) delete process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS;
    else process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS = prevMax;
  };
}

async function openRuntime(root: string, workDir: string): Promise<EngineeringRuntime> {
  await initGit(root);
  const rt = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
  rt.missionSupervisor!.stop();
  return rt;
}

test("flag off (PI_AUTOSPEC_ENABLED unset) -> zero runSubmittedMission calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-off-"));
  const restore = setEnv(undefined, "1");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    rt.missionStore!.createMission({
      mission_id: "MSN-ext-a",
      title: "external a",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    pump(rt, new Date(Date.now() + 10 * 60_000));
    assert.equal(started.length, 0);
    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("two expired-receipt NEW external missions with max 1 start oldest first and stay at 1 while pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-max1-"));
  const restore = setEnv("1", "1");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    const store = rt.missionStore!;
    const a = store.createMission({
      mission_id: "MSN-ext-a",
      title: "external a",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const b = store.createMission({
      mission_id: "MSN-ext-b",
      title: "external b",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const foreign = new MissionOwnership(store, { ownerId: "other", leaseMs: 300_000 });
    await foreign.acquire(a.mission_id);
    await foreign.acquire(b.mission_id);

    const future = new Date(Date.now() + 10 * 60_000);
    pump(rt, future);
    assert.deepEqual(started, ["MSN-ext-a"]);

    // Second pump while the first start is still pending must not start more.
    pump(rt, future);
    assert.equal(started.length, 1);
    assert.deepEqual(started, ["MSN-ext-a"]);

    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("after resolving first and awaiting setImmediate, pump starts the second mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-second-"));
  const restore = setEnv("1", "1");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    const store = rt.missionStore!;
    const a = store.createMission({
      mission_id: "MSN-ext-a",
      title: "external a",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const b = store.createMission({
      mission_id: "MSN-ext-b",
      title: "external b",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const foreign = new MissionOwnership(store, { ownerId: "other", leaseMs: 300_000 });
    await foreign.acquire(a.mission_id);
    await foreign.acquire(b.mission_id);

    const future = new Date(Date.now() + 10 * 60_000);
    pump(rt, future);
    assert.deepEqual(started, ["MSN-ext-a"]);
    for (const p of pending) p.release();
    await new Promise<void>((resolve) => setImmediate(resolve));

    pump(rt, future);
    assert.deepEqual(started, ["MSN-ext-a", "MSN-ext-b"]);
    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("with max 2 and 'a' pending, pump does not start 'a' twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-nodup-"));
  // Start at max 1 so only 'a' is issued on the first pump and left pending.
  const restore = setEnv("1", "1");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    const store = rt.missionStore!;
    const a = store.createMission({
      mission_id: "MSN-ext-a",
      title: "external a",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const b = store.createMission({
      mission_id: "MSN-ext-b",
      title: "external b",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const foreign = new MissionOwnership(store, { ownerId: "other", leaseMs: 300_000 });
    await foreign.acquire(a.mission_id);
    await foreign.acquire(b.mission_id);

    const future = new Date(Date.now() + 10 * 60_000);
    pump(rt, future);
    assert.deepEqual(started, ["MSN-ext-a"]);

    // Raise the ceiling to 2 while 'a' is still NEW and pending in
    // runningExternal. selectExternalMissionsToStart picks the oldest eligible
    // up to capacity, so it returns 'a' again; the pump must skip it via the
    // runningExternal guard rather than issuing a duplicate start.
    process.env.PI_ENGINEERING_MAX_EXTERNAL_MISSIONS = "2";
    pump(rt, future);
    assert.equal(started.filter((id) => id === "MSN-ext-a").length, 1);
    assert.equal(started.filter((id) => id === "MSN-ext-b").length, 0);
    assert.equal(started.length, 1);
    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a mission with a live foreign lease is never started", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-live-"));
  const restore = setEnv("1", "2");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    const store = rt.missionStore!;
    const c = store.createMission({
      mission_id: "MSN-ext-c",
      title: "external c",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    // Live foreign lease (real now): renewBy is ~5 minutes in the future.
    const foreign = new MissionOwnership(store, { ownerId: "other", leaseMs: 300_000 });
    await foreign.acquire(c.mission_id);

    pump(rt, new Date());
    assert.equal(started.length, 0);
    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("pump after await rt.close() makes zero calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-pump-closed-"));
  const restore = setEnv("1", "1");
  const started: string[] = [];
  const pending: Array<{ id: string; release: () => void }> = [];
  const original = Orchestrator.prototype.runSubmittedMission;
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    installRunStub(started, pending, original);
    rt.missionStore!.createMission({
      mission_id: "MSN-ext-a",
      title: "external a",
      goal: "start an external mission",
      user_request: "start an external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    await rt.close();
    pump(rt, new Date(Date.now() + 10 * 60_000));
    assert.equal(started.length, 0);
    for (const p of pending) p.release();
  } finally {
    await rt.close();
    Orchestrator.prototype.runSubmittedMission = original;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
