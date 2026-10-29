/**
 * The `mission` tool's `resume` action runs the same operator recovery as
 * `/mission resume <id>` (EngineeringRuntime.resumeBlockedMission), through the
 * services the live extension resolves for the calling cwd.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);
type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

function loadHarness(): { tools: Map<string, Tool>; handlers: Map<string, Handler[]> } {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (api: unknown) => void)(pi);
  return { tools, handlers };
}

function context(cwd: string) {
  return {
    cwd,
    mode: "tui",
    hasUI: false,
    signal: undefined,
    model: undefined,
    modelRegistry: undefined,
    getContextUsage: () => undefined,
    isIdle: () => true,
    ui: { notify: () => {}, custom: () => ({ close: () => {} }), setFooter: () => {}, onTerminalInput: () => () => {} },
  };
}

test("mission tool resume reaches EngineeringRuntime.resumeBlockedMission instead of deferring to the slash command", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-mission-tool-resume-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const base = {
      repository: root,
      base_ref: await runtime.git!.headCommit(),
      risk_profile: "low" as const,
      workflow_class: "engineering" as const,
    };
    const unstopped = runtime.missionStore!.createMission({
      ...base,
      title: "still running",
      goal: "no durable stop",
      user_request: "no durable stop",
    });
    // A fresh mission starts WAITING_FOR_USER, which the tool now refuses to
    // resume (033ec7c). Move it to a non-waiting status so this case still
    // exercises the "no durable stop" path; the refusal has its own case below.
    const waiting = runtime.missionStore!.createMission({
      ...base,
      title: "waiting for the user",
      goal: "waits",
      user_request: "waits",
    });
    // The supervisor's open-time tick stops any live mission with no worker, task
    // or named wait (WAITING_FOR_USER, 033ec7c refuses to resume that). A mission
    // parked on a provider probe has a named wait and no durable stop.
    runtime.missionStore!.transitionMission(unstopped.mission_id, "CLASSIFYING");
    runtime.missionStore!.classifyFailure({
      classificationId: "FC-probe-wait",
      missionId: unstopped.mission_id,
      taskId: null,
      executionId: null,
      category: "PROVIDER_TRANSIENT",
      evidenceRefs: [],
      fingerprint: "sha256:probe-wait",
      summary: "provider unavailable; probing",
      classifiedAt: new Date().toISOString(),
    });
    runtime.missionStore!.planRecovery({
      recoveryId: "RCV-probe-wait",
      missionId: unstopped.mission_id,
      classificationId: "FC-probe-wait",
      action: "PROBE_AND_BACKOFF",
      expectedMaterialChange: "provider recovers",
      attempt: 1,
      maxAttempts: 3,
      deadline: null,
      nextActionAt: new Date().toISOString(),
      status: "planned",
      decidedAt: new Date().toISOString(),
    });
    const terminal = runtime.missionStore!.createMission({
      ...base,
      title: "already done",
      goal: "terminal",
      user_request: "terminal",
    });
    runtime.missionStore!.transitionMission(terminal.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(terminal.mission_id, "CANCELED");
    await runtime.missionStore!.flush();

    const { tools, handlers } = loadHarness();
    const mission = tools.get("mission");
    assert.ok(mission, "the mission tool is registered");
    const ctx = context(root);

    const resumeUnstopped = await mission.execute(
      "call-1",
      { action: "resume", missionId: unstopped.mission_id },
      undefined,
      undefined,
      ctx,
    );
    const unstoppedText = resumeUnstopped.content.map((part) => part.text).join("\n");
    assert.doesNotMatch(unstoppedText, /not available through the tool/, "resume is wired in resolveServices");
    assert.match(unstoppedText, /Resume failed: mission .* has no current durable stop to resume/);
    assert.equal(resumeUnstopped.details.missionId, unstopped.mission_id);

    // The refusal added by 033ec7c: a stop waiting on the user is the user's call.
    const resumeWaiting = await mission.execute(
      "call-1b",
      { action: "resume", missionId: waiting.mission_id },
      undefined,
      undefined,
      ctx,
    );
    const waitingText = resumeWaiting.content.map((part) => part.text).join("\n");
    assert.match(waitingText, /Resume refused: the mission is waiting for the user \(status WAITING_FOR_USER\)/);
    assert.equal(runtime.missionStore!.listMissionResumptions(waiting.mission_id).length, 0);

    const resumeTerminal = await mission.execute(
      "call-2",
      { action: "resume", missionId: terminal.mission_id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      resumeTerminal.content.map((part) => part.text).join("\n"),
      /Resume failed: mission .* is terminal \(CANCELED\) and cannot be resumed/,
    );
    assert.equal(runtime.missionStore!.listMissionResumptions(unstopped.mission_id).length, 0);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mission tool resume cannot spend an exhausted recovery budget, however often the model calls it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-mission-tool-exhausted-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const store = runtime.missionStore!;
    const created = store.createMission({
      repository: root,
      base_ref: await runtime.git!.headCommit(),
      risk_profile: "low",
      workflow_class: "engineering",
      title: "exhausted",
      goal: "exhausted",
      user_request: "exhausted",
    });
    store.transitionMission(created.mission_id, "CLASSIFYING");
    store.transitionMission(created.mission_id, "BLOCKED");
    store.classifyFailure({
      classificationId: "FC-exhausted",
      missionId: created.mission_id,
      taskId: null,
      executionId: null,
      category: "VALIDATION_FAILED",
      evidenceRefs: [],
      fingerprint: "sha256:exhausted",
      summary: "validation keeps failing",
      classifiedAt: new Date().toISOString(),
    });
    const decision = store.planRecovery({
      recoveryId: "RCV-exhausted",
      missionId: created.mission_id,
      classificationId: "FC-exhausted",
      action: "STOP",
      expectedMaterialChange: "budget exhausted",
      attempt: 3,
      maxAttempts: 2,
      deadline: null,
      nextActionAt: new Date().toISOString(),
      status: "planned",
      decidedAt: new Date().toISOString(),
    });
    store.transitionRecovery(decision.recoveryId, "exhausted");
    store.stopMission(created.mission_id, {
      reason: "validation keeps failing",
      preservedWork: [],
      attemptedRecoveries: [decision.recoveryId],
      resumeCondition: "operator decision",
    });
    await store.flush();

    const { tools, handlers } = loadHarness();
    const mission = tools.get("mission");
    assert.ok(mission);
    const ctx = context(root);
    for (let call = 0; call < 5; call++) {
      const result = await mission.execute(
        `call-${call}`,
        { action: "resume", missionId: created.mission_id },
        undefined,
        undefined,
        ctx,
      );
      assert.match(
        result.content.map((part) => part.text).join("\n"),
        /recovery budget .* exhausted; only the operator can resume it/,
      );
    }
    assert.equal(store.listMissionResumptions(created.mission_id).length, 0, "no resumption was created");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#427 mission tool answers from durable replay instead of Unknown mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-mission-tool-durable-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const { tools } = loadHarness();
    const mission = tools.get("mission");
    assert.ok(mission, "the mission tool is registered");

    // A mission written to the durable namespace but unknown to this live
    // session's in-memory registry — the #427 amnesia shape.
    const { MissionStore } = await import("../../src/orchestration/missionStore.ts");
    const { SessionEventStore } = await import("../../src/runtime/isolation/SessionEventStore.ts");
    const { resolveWorktreeIdentity } = await import("../../src/runtime/isolation/WorktreeIdentity.ts");
    const { resolveStateRoot, worktreeRuntimeDir } = await import("../../src/runtime/isolation/stateDir.ts");
    const identity = await resolveWorktreeIdentity(root);
    const eventsDir = join(worktreeRuntimeDir(resolveStateRoot(process.env), identity.worktreeId), "events");
    const other = SessionEventStore.open({
      eventsDir,
      sessionId: "other-session-427",
      worktreeId: identity.worktreeId,
    });
    const otherStore = MissionStore.open(other);
    otherStore.createMission({
      mission_id: "MSN-427durable",
      title: "written by another session",
      goal: "durable only",
      user_request: "durable only",
      repository: root,
      base_ref: "main",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    await otherStore.flush();
    other.close();

    const status = await mission.execute(
      "call-9",
      { action: "status", missionId: "MSN-427durable" },
      undefined,
      undefined,
      context(root),
    );
    const statusText = status.content.map((part) => part.text).join("\n");
    assert.doesNotMatch(statusText, /Unknown mission/, "a durable-known mission is never reported Unknown");
    assert.match(statusText, /MSN-427durable/);

    const unknown = await mission.execute(
      "call-10",
      { action: "status", missionId: "MSN-never-existed" },
      undefined,
      undefined,
      context(root),
    );
    assert.match(
      unknown.content.map((part) => part.text).join("\n"),
      /Unknown mission MSN-never-existed/,
      "the truly unknown stays Unknown",
    );

    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
