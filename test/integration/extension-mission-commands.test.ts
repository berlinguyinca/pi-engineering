import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import extension, * as extensionModule from "../../extensions/index.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { EngineeringRuntime, type RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);
type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };

function loadCommands(): Map<string, Command> {
  const commands = new Map<string, Command>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: Command) => commands.set(name, options),
    registerTool: () => {},
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
  return commands;
}

function commandContext(cwd: string) {
  const notices: Array<{ text: string; level: string }> = [];
  return {
    notices,
    ctx: {
      cwd,
      mode: "tui",
      signal: undefined,
      model: undefined,
      modelRegistry: undefined,
      getContextUsage: () => undefined,
      isIdle: () => true,
      ui: {
        notify: (text: string, level: string) => notices.push({ text, level }),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
    },
  };
}

test("/mission resume parses before a new request and is idempotent through repairBlockedMission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-resume-"));
  const repaired: string[] = [];
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  const originalOrchestrate = Orchestrator.prototype.orchestrate;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "manual recovery",
      goal: "resume exact mission",
      user_request: "resume exact mission",
      repository: root,
      base_ref: await runtime.git!.headCommit(),
      risk_profile: "low",
      workflow_class: "engineering",
    });
    runtime.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(mission.mission_id, "BLOCKED");
    runtime.missionStore!.stopMission(mission.mission_id, {
      reason: "manual evidence required",
      attemptedRecoveries: ["recovery-1"],
      preservedWork: ["candidate/ref"],
      resumeCondition: "credentials are refreshed",
    });

    Orchestrator.prototype.repairBlockedMission = async (missionId: string) => {
      repaired.push(missionId);
      return mission;
    };
    Orchestrator.prototype.orchestrate = (async () => {
      throw new Error("resume was incorrectly parsed as a new mission request");
    }) as typeof Orchestrator.prototype.orchestrate;

    const command = loadCommands().get("mission");
    assert.ok(command);
    const { ctx, notices } = commandContext(root);
    await command.handler(`resume ${mission.mission_id}`, ctx);
    await command.handler(`resume ${mission.mission_id}`, ctx);

    assert.deepEqual(repaired, [mission.mission_id, mission.mission_id]);
    assert.equal(runtime.missionStore!.listMissionResumptions(mission.mission_id).length, 1);
    assert.match(notices.at(-1)?.text ?? "", /Recovery .*manual recovery.*BLOCKED/i);
    await runtime.close();
  } finally {
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    Orchestrator.prototype.orchestrate = originalOrchestrate;
    await rm(root, { recursive: true, force: true });
  }
});

test("/mission-status renders acceptance-first progress and actionable stop detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-status-"));
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "visible stop",
      goal: "explain stalled work",
      user_request: "explain stalled work",
      repository: root,
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering",
    });
    runtime.missionStore!.addAcceptanceCriterion(mission.mission_id, "first", undefined, "AC-1");
    runtime.missionStore!.addAcceptanceCriterion(mission.mission_id, "second", undefined, "AC-2");
    runtime.missionObservability!.missionCreated(mission.mission_id, mission.title);
    runtime.missionStore!.stopMission(mission.mission_id, {
      reason: "repeated recovery fingerprint exhausted",
      attemptedRecoveries: ["recovery-1", "recovery-2"],
      preservedWork: ["candidate/ref"],
      resumeCondition: "provide new material evidence",
    });
    await runtime.publishMissionSnapshot();

    const command = loadCommands().get("mission-status");
    assert.ok(command);
    const { ctx, notices } = commandContext(root);
    await command.handler("", ctx);
    const text = notices.at(-1)?.text ?? "";
    assert.match(text, /acceptance 0\/2 \(0%\)/i);
    assert.match(text, /workflow .*%/i);
    assert.match(text, /health/i);
    assert.match(text, /repo/i);
    assert.match(text, /last progress/i);
    assert.match(text, /recovery .*2/i);
    assert.match(text, /next: provide new material evidence/i);
    assert.match(text, /preserved: candidate\/ref/i);
    assert.match(text, /stop: repeated recovery fingerprint exhausted/i);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent mission surfaces always pair a static percentage or zero workers with an actionable explanation", () => {
  const format = (extensionModule as Record<string, unknown>).formatMissionActivity;
  assert.equal(typeof format, "function", "the persistent panel and footer need one shared detailed formatter");
  const event = {
    missionId: "mission-1",
    title: "stalled mission",
    phase: "EXECUTING",
    state: "BLOCKED",
    health: "failed",
    approximatePercent: 0,
    acceptanceCoverage: { completed: 0, total: 14, approximatePercent: 0 },
    workflowProgress: { completed: 8, total: 10, approximatePercent: 80 },
    summary: "Agent failed",
    activeWorkers: 0,
    waitingWorkers: 0,
    failedWorkers: 1,
    lastMeaningfulProgressAt: "2026-09-27T12:00:00.000Z",
    action: "STOP",
    reason: "repeated recovery fingerprint exhausted",
    recovery: { attempt: 2, maxAttempts: 2 },
    nextAction: "provide new material evidence",
    nextActionAt: null,
    owner: null,
    repository: "repo-1",
    task: "task-4",
    preservedWork: ["candidate/ref"],
  } satisfies RuntimeMissionActivityEvent;
  const rendered = (format as (value: RuntimeMissionActivityEvent) => { phase: string; detail: string })(event);
  const visible = `${rendered.phase} ${rendered.detail}`;
  assert.match(visible, /acceptance 0\/14 \(0%\)/i);
  assert.match(visible, /workflow 8\/10 \(80%\)/i);
  assert.match(visible, /recovery 2\/2/i);
  assert.match(visible, /next provide new material evidence/i);
  assert.match(visible, /preserved candidate\/ref/i);
  assert.doesNotMatch(visible, /^Agent failed · workers 0 active$/);
});
