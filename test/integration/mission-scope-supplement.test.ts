/**
 * #629 (2/2) — the recovery door for a mission that blocked because its
 * workspace could not be resolved.
 *
 * Such a mission has no tasks and no work to preserve: every automatic retry
 * re-reads the same wording and re-hits the same refusal. Two things made the
 * block a dead end, and both are pinned here with real runtime, real store and
 * real resolver:
 *
 * 1. Nothing could resume it. A mission may only be resumed from a durable stop,
 *    and the scope block wrote none — so even `/mission resume` had nothing to
 *    resume from. The block now records one, naming the condition that clears it.
 * 2. Nothing accepted the remedy the resolver's own error asks for ("state scope
 *    explicitly"). `/mission scope <id> writable: /path` (and the tool's `scope`
 *    action) now does — but only after the statement is PROVEN to resolve, so a
 *    mission never resumes into the dead end it just left.
 *
 * The hand-back to supervision after the amendment is the existing
 * `/mission resume` path, already covered by
 * test/integration/extension-mission-tool-resume.test.ts; running a full mission
 * to completion here would need the whole scripted role roster of
 * test/integration/vertical-slice.test.ts and proves nothing about this door.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { WorkspaceManifestResolver } from "../../src/orchestration/workspaceManifest.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);
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

function missionTool(): Tool {
  const tools = new Map<string, Tool>();
  const pi = {
    on: () => {},
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
  const tool = tools.get("mission");
  assert.ok(tool, "the mission tool is registered");
  return tool;
}

const context = (cwd: string) => ({
  cwd,
  mode: "tui",
  hasUI: false,
  signal: undefined,
  model: undefined,
  modelRegistry: undefined,
  getContextUsage: () => undefined,
  isIdle: () => true,
  ui: { notify: () => {}, custom: () => ({ close: () => {} }), setFooter: () => {}, onTerminalInput: () => () => {} },
});

async function makeCheckout(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
    { cwd: dir },
  );
}

/**
 * A workspace PARENT is the real trap: it is not a checkout, so nothing the
 * request says can name a writable repository, and the launch directory is
 * deliberately never used in its place. One runtime, one blocked mission,
 * shared by the cases that read it.
 */
let parent: string;
let app: string;
let runtime: EngineeringRuntime;
let blockedId: string;
let requestBefore: string;

before(async () => {
  parent = await mkdtemp(join(tmpdir(), "pi-eng-629-parent-"));
  app = join(parent, "app");
  await makeCheckout(app);
  runtime = await EngineeringRuntime.open({ cwd: parent, worker: new FakeWorkerExecutor({}) });
  const started = await missionTool().execute(
    "call-start",
    { action: "run", request: "Fix the login bug so the form submits again." },
    undefined,
    undefined,
    context(parent),
  );
  const blocked = (runtime.missionStore?.listMissions() ?? []).find((mission) => mission.status === "BLOCKED");
  assert.ok(blocked, `expected a mission blocked on scope (tool said: ${started.content[0]?.text ?? ""})`);
  blockedId = blocked.mission_id;
  requestBefore = blocked.user_request;
});

after(async () => {
  await runtime?.close();
  await rm(parent, { recursive: true, force: true });
});

test("a scope block records the durable stop that makes it resumable", () => {
  const stops = runtime.missionStore?.listMissionStops(blockedId) ?? [];
  assert.equal(stops.length, 1, "a scope block must record exactly one durable stop");
  assert.match(stops[0]?.reason ?? "", /workspace scope could not be resolved/);
  assert.match(stops[0]?.resumeCondition ?? "", /writable: \/path/, "the stop names the remedy that clears it");
});

test("a scope statement that does not resolve is refused and changes nothing", async () => {
  await assert.rejects(
    () => runtime.supplementMissionScope(blockedId, "writable: /definitely/not/here"),
    /did not resolve; the mission stays blocked/,
    "an unresolvable supplement must not resume the mission",
  );
  const after = runtime.missionStore?.getMission(blockedId);
  assert.equal(after?.status, "BLOCKED", "still blocked");
  assert.equal(after?.user_request, requestBefore, "the refused supplement left the request alone");
});

test("the statement the resolver asks for is the one the door accepts", async () => {
  const statement = `writable: ${app}`;
  // The door's gate is the real resolver, run against the mission's repository:
  // the amendment must grant a writable workspace before anything is recorded.
  const resolved = await new WorkspaceManifestResolver().resolve(`${requestBefore}\n\n${statement}`, parent);
  assert.ok(
    resolved.authorizedRoots.some((root) => root.access !== "read" && root.canonicalPath === app),
    "the amended request grants the checkout as writable",
  );

  // What the door then records, and what the recovery path resolves against.
  runtime.missionStore?.recordScopeSupplement(blockedId, statement);
  await runtime.missionStore?.flush();
  assert.deepEqual(
    (runtime.missionStore?.listScopeSupplements(blockedId) ?? []).map((entry) => entry.text),
    [statement],
    "the statement is recorded once, verbatim",
  );
  assert.equal(
    runtime.missionStore?.effectiveRequest(blockedId),
    `${requestBefore}\n\n${statement}`,
    "the effective request is the user's request plus the operator's statement",
  );
});

test("the user's request stays immutable, and a supplement cannot be smuggled in empty", () => {
  // #629 changed how scope is recovered, not who owns the mandate: a model may
  // still not rewrite the request it was given.
  assert.throws(
    () => runtime.missionStore?.updateMission(blockedId, { user_request: "rewrite the mandate" } as never),
    /unsupported mission update field/,
  );
  assert.throws(() => runtime.missionStore?.recordScopeSupplement(blockedId, "   "), /must not be empty/);
  assert.throws(
    () => runtime.missionStore?.recordScopeSupplement("MSN-not-real", "writable: /repo"),
    /unknown mission/,
  );
  assert.equal(runtime.missionStore?.getMission(blockedId)?.user_request, requestBefore, "request untouched");
});
