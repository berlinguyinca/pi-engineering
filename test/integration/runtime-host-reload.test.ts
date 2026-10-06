/**
 * `/engineering reload` inside a REAL Pi session (spec §6, §7, §48-§50, §52, §58).
 *
 * The Host is installed as a Pi extension. The runtime generations are real
 * fixture packages on disk that the Host snapshots and imports. Events and
 * commands go through Pi's own ExtensionRunner and slash-command dispatch.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { StaleGenerationError } from "../../src/runtime/host/contract.ts";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { RuntimeBusyError } from "../../src/runtime/host/host.ts";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let seq = 0;
async function setup(value = "A") {
  const key = `__rt_reload_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-reload-"));
  const source = join(root, "source");
  writeFixtureRuntime(source, key, { value });
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(async () => {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { key, root, source, ext, pi, host: ext.host as NonNullable<typeof ext.host>, b };
}

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

test("idle reload: same Pi session, new generation, commands operational, one listener set (§50)", async () => {
  const { pi, host, b, ext } = await setup();
  assert.equal(host.activeGeneration()?.generation, 1);
  const handlersBefore = pi.piHandlerCount("agent_settled");
  const session = pi.session;

  await pi.run("/engineering reload");

  assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  assert.equal(host.activeGeneration()?.generation, 2);
  assert.equal(pi.session, session, "same conversation/session object");
  assert.equal(pi.piHandlerCount("agent_settled"), handlersBefore, "Pi holds exactly one listener set");
  assert.equal(pi.piCommands().filter((c) => c === "probe").length, 1);
  assert.equal(pi.piCommands().filter((c) => c === "engineering").length, 1);
  await pi.run("/probe");
  assert.equal(b.values.at(-1), "cmd:A");
  assert.ok(b.values.includes("session_start:A"), "new generation replayed session_start mid-session");
  assert.match(ext.versionText(), /Generation:\s+2/);
  assert.ok(ext.telemetry.recent().some((e) => e.event === "runtime.reload.completed"));
});

test("ESM: changed source is genuinely loaded after reload (§7, §49)", async () => {
  const { pi, host, b, source, key } = await setup("A");
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "A");
  writeFixtureRuntime(source, key, { value: "B" });
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B", "the dependency module, not only the entry, is fresh");
  await pi.run("/probe");
  assert.equal(b.values.at(-1), "cmd:B");
});

test("reload 5 times, trigger agent_settled once: exactly one lifecycle reaction (§48, §58)", async () => {
  const { pi, host, b } = await setup();
  const listeners = pi.piHandlerCount("agent_settled");
  const timersAtGen1 = timers();
  for (let i = 0; i < 5; i++) {
    await pi.run("/engineering reload");
    assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  }
  assert.equal(host.activeGeneration()?.generation, 6);
  b.reactions = 0;
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.reactions, 1, "one lifecycle reaction");
  assert.equal(b.stale, 0, "no stale generation reacted");
  assert.equal(pi.piHandlerCount("agent_settled"), listeners, "no leaked listeners");
  assert.equal(pi.piCommands().filter((c) => c === "probe").length, 1, "no duplicated commands");
  assert.equal(timers(), timersAtGen1, "no leaked timers/intervals (old generations' were disposed)");
  assert.equal(b.stops, 5, "every old generation was stopped");
});

test("broken candidate: start() throws → previous runtime restored and healthy (§35, §52)", async () => {
  const { pi, host, b, source, key, ext } = await setup("A");
  writeFixtureRuntime(source, key, { value: "BROKEN", mode: "throw-start" });
  await pi.run("/engineering reload");
  const result = host.lastHandover;
  assert.equal(result?.ok, false);
  assert.equal(result?.rolledBack, true);
  assert.equal(result?.failedStage, "health_check");
  assert.match(result?.failure ?? "", /start\(\) failed/);
  const health = await host.health();
  assert.equal(health.healthy, true);
  b.values.length = 0;
  await pi.emit({ type: "agent_settled" });
  assert.deepEqual(b.values, ["A"], "the previous code (from its immutable copy) runs again");
  assert.ok(ext.telemetry.recent().some((e) => e.event === "runtime.rollback.completed"));
  // The session continues: a fixed candidate reloads normally.
  writeFixtureRuntime(source, key, { value: "C" });
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.ok, true);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "C");
});

test("unhealthy candidate is rolled back; a candidate that fails to import never touches the runtime (§47)", async () => {
  const { pi, host, b, source, key } = await setup("A");
  writeFixtureRuntime(source, key, { value: "SICK", mode: "unhealthy" });
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.rolledBack, true);
  const genAfterRollback = host.activeGeneration()?.generation;
  const stops = b.stops;
  writeFileSync(join(source, "dep.ts"), "export const VALUE: string = ;\n");
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.ok, false);
  assert.equal(host.lastHandover?.untouched, true);
  assert.equal(host.lastHandover?.failedStage, "loading");
  assert.equal(host.activeGeneration()?.generation, genAfterRollback, "current generation untouched");
  assert.equal(b.stops, stops, "old generation never stopped");
  writeFixtureRuntime(source, key, { value: "OLD", runtimeApi: 99 });
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.untouched, true);
  assert.match(host.lastHandover?.failure ?? "", /runtime API 99 is not supported/);
});

test("generation fencing: a retired generation's actions and callbacks cannot touch the current one (§5)", async () => {
  const { pi, host } = await setup();
  const gen1 = host.activeGeneration()?.generation as number;
  const staleApi = host.bridge.createGenerationApi(999);
  // 999 was never live: everything it tries is fenced.
  (staleApi as unknown as { sendMessage(m: unknown): void }).sendMessage({ customType: "x", content: "y" });
  await assert.rejects(
    (staleApi as unknown as { setModel(m: unknown): Promise<boolean> }).setModel({}),
    StaleGenerationError,
  );
  staleApi.on("agent_settled", () => assert.fail("a stale generation's late handler ran"));
  assert.equal(host.bridge.fencedCalls(999), 3);
  await pi.run("/engineering reload");
  assert.equal(host.isGenerationActive(gen1), false);
  assert.equal(host.isGenerationActive(gen1 + 1), true);
  await pi.emit({ type: "agent_settled" });
});

test("only one runtime mutation at a time (§28)", async () => {
  const { host, b, ext } = await setup();
  let release: () => void = () => {};
  b.stopGate = new Promise<void>((r) => {
    release = r;
  });
  const first = host.begin({
    kind: "reload",
    source: { root: ext.config.packageRoot, entry: "runtime.ts", version: "x", commit: null, label: "t" },
  });
  assert.throws(
    () =>
      host.begin({
        kind: "reload",
        source: { root: ext.config.packageRoot, entry: "runtime.ts", version: "x", commit: null, label: "t" },
      }),
    RuntimeBusyError,
  );
  release();
  b.stopGate = undefined;
  assert.equal((await first.promise).ok, true);
});

test("safe point: reload waits for active operations, reports them, and is cancellable (§19, §22, §23)", async () => {
  const { pi, host, b } = await setup();
  const op = host.operations.begin(1, "verification", "npm test");
  await pi.run("/engineering reload");
  const task = host.pendingTask();
  assert.ok(task, "the reload is pending, not finished");
  assert.equal(task.phase, "waiting_safe_point");
  assert.deepEqual(host.operations.summarize(task.blocking), ["1 verification command"]);
  await pi.run("/engineering cancel");
  const cancelled = await task.promise;
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.untouched, true);
  assert.equal(host.activeGeneration()?.generation, 1);
  assert.equal(b.stops, 0);

  await pi.run("/engineering reload");
  const second = host.pendingTask();
  assert.ok(second);
  setTimeout(() => op.end(), 20);
  const done = await second.promise;
  assert.equal(done.ok, true);
  assert.equal(done.waitedForSafePoint, true);
  assert.ok(host.telemetry.recent().some((e) => e.event === "runtime.safe_point.reached"));
});

test("a handover cancelled before quiesce leaves no candidate snapshot behind", async () => {
  const { pi, host, ext } = await setup();
  const before = new Set(readdirSync(ext.generationsDir));
  const op = host.operations.begin(1, "verification", "npm test");
  await pi.run("/engineering reload");
  const task = host.pendingTask();
  assert.ok(task);
  const created = readdirSync(ext.generationsDir).filter((name) => !before.has(name));
  assert.equal(created.length, 1, "the candidate was snapshotted");
  await pi.run("/engineering cancel");
  assert.equal((await task.promise).phase, "cancelled");
  op.end();
  assert.equal(existsSync(join(ext.generationsDir, created[0] as string)), false, "the cancelled candidate is removed");
  await host.pruneSnapshots();
  assert.deepEqual(
    readdirSync(ext.generationsDir)
      .filter((name) => !before.has(name))
      .sort(),
    [],
    "nothing the cancelled handover created is left",
  );
});

test("work arriving during handover is queued and resumes on the new generation (§21)", async () => {
  const { pi, host, b, source, key } = await setup("A");
  b.missions.push("MSN-1");
  writeFixtureRuntime(source, key, { value: "B" });
  let release: () => void = () => {};
  b.stopGate = new Promise<void>((r) => {
    release = r;
  });
  const reload = pi.run("/engineering reload");
  while (host.pendingTask()?.phase !== "stopping") await new Promise((r) => setTimeout(r, 2));
  const queuedCommand = pi.run("/probe");
  const queuedEvent = pi.emit({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!b.values.includes("cmd:A") && !b.values.includes("cmd:B"), "nothing ran mid-handover");
  release();
  b.stopGate = undefined;
  await reload;
  await Promise.all([queuedCommand, queuedEvent]);
  assert.ok(b.values.includes("cmd:B"), "queued command ran on the new generation");
  assert.equal(b.values.filter((v) => v === "A").length, 0, "queued event reached only the new generation");
  assert.equal(b.values.at(-1) === "B" || b.values.includes("B"), true);
  const restored = b.restored.at(-1) as { activeMissionIds: string[] };
  assert.deepEqual(restored.activeMissionIds, ["MSN-1"], "transient snapshot handed to the new generation");
});

test("a running event handler holds the safe point (no handover mid-reaction)", async () => {
  const { pi, host, b } = await setup();
  let release: () => void = () => {};
  b.settleGate = new Promise<void>((r) => {
    release = r;
  });
  const reaction = pi.emit({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 5));
  await pi.run("/engineering reload");
  const task = host.pendingTask();
  assert.ok(task, "handover waits for the handler");
  assert.deepEqual(host.operations.summarize(task.blocking), ["1 event handler"]);
  b.settleGate = undefined;
  release();
  await reaction;
  assert.equal((await task.promise).ok, true);
});

test("a commit hook failure rolls back without leaving the candidate running beside the old code", async () => {
  const { pi, host, b, source, key } = await setup("A");
  writeFixtureRuntime(source, key, { value: "B" });
  const stops = b.stops;
  const result = await host.handover({
    kind: "reload",
    source: { root: source, entry: "runtime.ts", version: "x", commit: null, label: "t" },
    hooks: {
      onCommit: async () => {
        throw new Error("journal disk full");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(b.stops, stops + 2, "old generation and the uncommitted candidate both stopped");
  b.values.length = 0;
  b.reactions = 0;
  await pi.emit({ type: "agent_settled" });
  assert.deepEqual(b.values, ["A"], "exactly one generation (the restored one) reacts");
});

test("failing phase hooks: before the switch nothing is touched; during rollback the outcome still stands", async () => {
  const { host, b, source } = await setup("A");
  const stops = b.stops;
  const early = await host.handover({
    kind: "reload",
    source: { root: source, entry: "runtime.ts", version: "x", commit: null, label: "t" },
    hooks: {
      onPhase: (p) => {
        if (p === "waiting_safe_point") throw new Error("EACCES journal");
      },
    },
  });
  assert.equal(early.untouched, true);
  assert.equal(b.stops, stops);
  const late = await host.handover({
    kind: "reload",
    source: { root: source, entry: "runtime.ts", version: "x", commit: null, label: "t" },
    hooks: {
      onPhase: (p) => {
        if (p === "health_check" || p === "rolling_back" || p === "rolled_back") throw new Error("EIO journal");
      },
    },
  });
  assert.equal(late.ok, false);
  assert.equal(late.rolledBack, true, "rolled back even though the journal could not record it");
  assert.equal((await host.health()).healthy, true);
});
