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
