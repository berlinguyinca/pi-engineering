import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import extension, * as extensionModule from "../../extensions/index.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { EngineeringRuntime, type RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);
type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function loadHarness(): { commands: Map<string, Command>; handlers: Map<string, Handler[]> } {
  const commands = new Map<string, Command>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
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
  return { commands, handlers };
}

function loadCommands(): Map<string, Command> {
  return loadHarness().commands;
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
    await Promise.all([
      command.handler(`resume ${mission.mission_id}`, ctx),
      command.handler(`resume ${mission.mission_id}`, ctx),
    ]);

    assert.deepEqual(repaired, [mission.mission_id]);
    assert.equal(runtime.missionStore!.listMissionResumptions(mission.mission_id).length, 1);
    assert.match(notices.at(-1)?.text ?? "", /Recovery .*manual recovery.*BLOCKED/i);
    await runtime.close();
  } finally {
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    Orchestrator.prototype.orchestrate = originalOrchestrate;
    await rm(root, { recursive: true, force: true });
  }
});

test("/mission resume requires a current stop, normalizes executing state, and rejects terminal or unstopped missions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-resume-contract-"));
  const originalRepair = Orchestrator.prototype.repairBlockedMission;
  const repairedStatuses: string[] = [];
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    runtime.missionSupervisor?.stop();
    const create = (title: string) =>
      runtime.missionStore!.createMission({
        title,
        goal: title,
        user_request: title,
        repository: root,
        base_ref: "",
        risk_profile: "low",
        workflow_class: "engineering",
      });
    const stopped = create("stopped executing");
    runtime.missionStore!.transitionMission(stopped.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(stopped.mission_id, "READY");
    runtime.missionStore!.transitionMission(stopped.mission_id, "EXECUTING");
    runtime.missionStore!.stopMission(stopped.mission_id, {
      reason: "worker vanished",
      attemptedRecoveries: ["R-1"],
      preservedWork: ["candidate/ref"],
      resumeCondition: "worker capacity returns",
    });
    const unstopped = create("not stopped");
    const terminal = create("terminal");
    runtime.missionStore!.transitionMission(terminal.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(terminal.mission_id, "CANCELED");
    Orchestrator.prototype.repairBlockedMission = async (missionId: string) => {
      repairedStatuses.push(runtime.missionStore!.getMission(missionId)!.status);
      return runtime.missionStore!.getMission(missionId)!;
    };

    const command = loadCommands().get("mission")!;
    const { ctx, notices } = commandContext(root);
    await command.handler(`resume ${stopped.mission_id}`, ctx);
    await command.handler(`resume ${unstopped.mission_id}`, ctx);
    await command.handler(`resume ${terminal.mission_id}`, ctx);

    assert.ok(repairedStatuses.length >= 1);
    assert.ok(repairedStatuses.every((status) => status === "BLOCKED"));
    assert.equal(runtime.missionStore!.listMissionResumptions(stopped.mission_id).length, 1);
    assert.match(notices.at(-2)?.text ?? "", /no current durable stop/i);
    assert.match(notices.at(-1)?.text ?? "", /terminal/i);
    assert.ok(
      runtime.missionStore!.listMissionStops(stopped.mission_id).length >= 2,
      "failed material recovery stays stopped",
    );
    await runtime.close();
  } finally {
    Orchestrator.prototype.repairBlockedMission = originalRepair;
    await rm(root, { recursive: true, force: true });
  }
});

test("/mission rejects every malformed resume prefix without creating a new mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-resume-syntax-"));
  const originalOrchestrate = Orchestrator.prototype.orchestrate;
  let orchestrated = 0;
  try {
    Orchestrator.prototype.orchestrate = (async () => {
      orchestrated++;
      throw new Error("malformed resume reached orchestration");
    }) as typeof Orchestrator.prototype.orchestrate;
    const command = loadCommands().get("mission")!;
    const { ctx, notices } = commandContext(root);
    for (const input of ["resume", "resume MSN-1 extra", "resume:MSN-1", "resume=MSN-1"]) {
      await command.handler(input, ctx);
    }
    assert.equal(orchestrated, 0);
    assert.equal(notices.length, 4);
    assert.ok(notices.every((notice) => /\/mission resume <missionId>/.test(notice.text)));
  } finally {
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

test("/mission-status labels legacy acceptance unavailable and derives truthful workflow progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-legacy-status-"));
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "legacy mission",
      goal: "legacy mission",
      user_request: "legacy mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const done = runtime.missionStore!.createTask({
      mission_id: mission.mission_id,
      kind: "process",
      role: "planner",
      objective: "done",
    });
    runtime.missionStore!.transitionTask(done.task_id, "READY");
    runtime.missionStore!.transitionTask(done.task_id, "SUCCEEDED");
    runtime.missionStore!.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "pending",
    });
    runtime.missionStore!.transitionMission(mission.mission_id, "CLASSIFYING");
    runtime.missionStore!.transitionMission(mission.mission_id, "CANCELED");
    const command = loadCommands().get("mission-status")!;
    const { ctx, notices } = commandContext(root);
    await command.handler("", ctx);
    const text = notices.at(-1)?.text ?? "";
    assert.match(text, /acceptance unavailable \(legacy\)/i);
    assert.match(text, /workflow 1\/2 \(50%\)/i);
    assert.doesNotMatch(text, /acceptance 0\/0 \(0%\)/i);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session shutdown closes the runtime and stops its mission supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-shutdown-"));
  const originalStop = MissionSupervisor.prototype.stop;
  let stops = 0;
  const previous = new Map<string, string | undefined>();
  const optionalProviderKeys = Object.keys(process.env).filter((key) =>
    /METABOLOMICS|OPENVIKING|INFERWEAVE|PI_GATEWAY_HEALTH/.test(key),
  );
  for (const key of optionalProviderKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    MissionSupervisor.prototype.stop = function () {
      stops++;
      return originalStop.call(this);
    };
    const { handlers } = loadHarness();
    const { ctx } = commandContext(root);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    assert.ok(stops > 0, "session shutdown must stop the cached runtime's supervisor");
  } finally {
    MissionSupervisor.prototype.stop = originalStop;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("session shutdown surfaces close failures and retains the cached runtime for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-shutdown-retry-"));
  const originalClose = EngineeringRuntime.prototype.close;
  let failClose = true;
  try {
    EngineeringRuntime.prototype.close = async function () {
      if (failClose) {
        failClose = false;
        throw new Error("injected cached runtime close failure");
      }
      return originalClose.call(this);
    };
    const { commands, handlers } = loadHarness();
    const { ctx, notices } = commandContext(root);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

    await assert.rejects(async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }, /cached runtime close failure/i);

    await commands.get("mission-status")!.handler("", ctx);
    assert.match(notices.at(-1)?.text ?? "", /No missions yet/i, "failed close must retain usable cache ownership");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  } finally {
    EngineeringRuntime.prototype.close = originalClose;
    await rm(root, { recursive: true, force: true });
  }
});

test("an open superseded by session shutdown cannot repopulate the cache and the next command reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-shutdown-open-race-"));
  const originalOpen = EngineeringRuntime.open;
  let entered!: () => void;
  let release!: () => void;
  const openEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const openGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayFirst = true;
  try {
    EngineeringRuntime.open = async (options) => {
      if (delayFirst) {
        delayFirst = false;
        entered();
        await openGate;
      }
      return originalOpen.call(EngineeringRuntime, options);
    };
    const { commands, handlers } = loadHarness();
    const firstContext = commandContext(root);
    const openingCommand = commands.get("mission-status")!.handler("", firstContext.ctx);
    await openEntered;
    const shutdown = (async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, firstContext.ctx);
    })();
    release();

    await assert.rejects(Promise.resolve(openingCommand), /superseded by session shutdown/i);
    await shutdown;

    const nextContext = commandContext(root);
    await commands.get("mission-status")!.handler("", nextContext.ctx);
    assert.match(nextContext.notices.at(-1)?.text ?? "", /No missions yet/i);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, nextContext.ctx);
  } finally {
    EngineeringRuntime.open = originalOpen;
    release();
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
