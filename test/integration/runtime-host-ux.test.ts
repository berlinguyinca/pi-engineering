/**
 * Phase 6: /engineering version, /engineering rollback, the panel's
 * Runtime/Update section, automatic update checks, retention, telemetry
 * (spec §14, §36-§38, §44, §45). Real git sources, real Pi sessions.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { buildRows } from "../../src/panel/tree.ts";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { runtimeStatusLines } from "../../src/runtime/host/runtimeStatus.ts";
import { readStateSchema, writeStateSchema } from "../../src/runtime/migrations/schema.ts";
import { readPreferences, writePreferences } from "../../src/update/preferences.ts";
import { createUpdateRepo } from "../support/gitRemote.ts";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";
import { bag } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let seq = 0;
async function world(opts: { autoUpdateCheck?: boolean; beforeStart?: (w: { install: string }) => void } = {}) {
  const key = `__rt_ux_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-ux-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = createUpdateRepo(join(root, "src"), key, {
    version: "0.2.0",
    value: "A",
    stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 },
  });
  const cwd = join(root, "project");
  const state = join(cwd, ".pi-eng");
  mkdirSync(state, { recursive: true });
  writeStateSchema(state, 7);
  writeFileSync(join(state, "missions.json"), JSON.stringify({ schema: 7, missions: ["MSN-1"] }));
  const install = join(root, "install");
  opts.beforeStart?.({ install });
  const ext = new EngineeringHostExtension({
    installRoot: install,
    packageRoot: repo.checkout,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: opts.autoUpdateCheck ?? false,
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)], cwd });
  cleanups.push(() => pi.close());
  const host = ext.host as NonNullable<typeof ext.host>;
  const settle = async () => {
    b.values.length = 0;
    await pi.emit({ type: "agent_settled" });
    return b.values.at(-1);
  };
  const run = async (cmd: string) => {
    await pi.run(cmd);
    const o = ext.lastUpdateOutcome;
    if (o?.status === "handover") await o.done;
    // Background bookkeeping (retention) settles quickly; wait for the lock.
    while (ext.lock.isHeldByLiveProcess()) await new Promise((r) => setTimeout(r, 5));
  };
  return { key, b, root, repo, ext, pi, host, settle, run, state };
}

test("/engineering version and the panel show version, generation, schema, compatibility, previous, last update (§38, §44)", async () => {
  const w = await world();
  w.repo.publish({ version: "0.2.1", value: "B", stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 } });
  await w.run("/engineering update");
  const v1 = w.repo.publish({
    version: "0.2.2",
    value: "C",
    stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 },
  });
  await w.run("/engineering update");
  assert.equal(await w.settle(), "C");
  const text = w.ext.versionText();
  assert.match(text, /Version:\s+0\.2\.2/);
  assert.match(text, new RegExp(`Commit:\\s+${v1.slice(0, 7)}`));
  assert.match(text, /Channel:\s+main/);
  assert.match(text, /Runtime API:\s+1/);
  assert.match(text, /Generation:\s+3/);
  assert.match(text, /State schema:\s+7/);
  assert.match(text, /Pi compatibility: OK/);
  assert.match(text, /Previous:\n0\.2\.1 \/ [0-9a-f]{7}/);
  assert.match(text, /Last update:\n\d+s ago/);
  await w.pi.run("/engineering version");

  const lines = runtimeStatusLines();
  for (const want of [
    "Runtime",
    "Version       0.2.2",
    "Generation    3",
    "Channel       main",
    "Health        healthy",
  ]) {
    assert.ok(lines.includes(want), `panel shows ${want}: ${lines.join(" | ")}`);
  }
  assert.ok(lines.includes("0.2.1         retained"));
  const rows = buildRows(new PanelState().snapshot, new Set(), "session").map((r) => r.label);
  assert.ok(rows.includes("Runtime") && rows.includes("Version       0.2.2"), "Engineering panel Session tab");

  // During a handover the panel shows what it waits for.
  const op = w.host.operations.begin(3, "inference", "assistant message");
  await w.pi.run("/engineering reload");
  const waiting = runtimeStatusLines();
  assert.ok(waiting.includes("◌ waiting for safe point"), waiting.join(" | "));
  assert.ok(waiting.includes("Active:") && waiting.includes("1 active inference request"));
  op.end();
  await w.host.pendingTask()?.promise;
});

test("/engineering rollback: previous version, named version, migration undone from its checkpoint (§27, §36)", async () => {
  const w = await world();
  w.repo.publish({ version: "0.2.1", value: "B", stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 } });
  await w.run("/engineering update");
  w.repo.publish({
    version: "0.3.0",
    value: "C",
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
    migration: { from: 7, to: 8, behaviour: "ok" },
  });
  await w.run("/engineering update");
  assert.equal(await w.settle(), "C");
  assert.equal(readStateSchema(w.state), 8);
  const vB = w.ext.layout.readPointer("previous") as string;
  const vC = w.ext.layout.readPointer("current") as string;

  await w.run("/engineering rollback");
  assert.equal(w.host.lastHandover?.ok, true, w.host.lastHandover?.failure);
  assert.equal(await w.settle(), "B");
  assert.equal(w.ext.layout.readPointer("current"), vB);
  assert.equal(w.ext.layout.readPointer("previous"), vC);
  assert.equal(readStateSchema(w.state), 7, "pre-migration state restored for the older runtime");
  assert.deepEqual(JSON.parse(readFileSync(join(w.state, "missions.json"), "utf8")).missions, ["MSN-1"]);
  const record = w.ext.journal.read();
  assert.ok(record && record !== "corrupt" && record.kind === "rollback" && record.phase === "committed");
  const started = w.ext.telemetry.recent(300).find((e) => e.event === "runtime.rollback.started" && e.transaction_id);
  assert.equal(started?.rollback_version, "0.2.1");

  await w.run("/engineering rollback 0.9.9");
  assert.equal(await w.settle(), "B", "an unknown version is refused; nothing changes");
  assert.equal(w.ext.layout.readPointer("current"), vB);
});

test("automatic update check: on by default, reports availability, installs nothing (§14)", async () => {
  const w = await world({ autoUpdateCheck: true });
  await new Promise((r) => setTimeout(r, 1));
  // The session-start check found nothing new; publish and check again.
  w.repo.publish({ version: "0.2.1", value: "B", stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 } });
  const check = await w.ext.automaticCheck();
  assert.equal(check?.upToDate, false);
  assert.equal(check?.target?.metadata.version, "0.2.1");
  assert.equal(readPreferences(w.ext.layout.preferencesFile).lastAvailable?.version, "0.2.1");
  assert.ok(runtimeStatusLines().includes("Status        available"));
  assert.equal(w.ext.layout.readPointer("current"), null, "automatic installation is disabled by default");
  assert.equal(await w.settle(), "A");
  assert.ok(w.ext.telemetry.recent(100).some((e) => e.event === "runtime.update.available"));
});

test("automatic installation only when explicitly configured", async () => {
  const w = await world({
    autoUpdateCheck: true,
    beforeStart: ({ install }) => {
      mkdirSync(install, { recursive: true });
    },
  });
  await writePreferences(w.ext.layout.preferencesFile, {
    ...readPreferences(w.ext.layout.preferencesFile),
    autoInstall: true,
  });
  w.repo.publish({ version: "0.2.1", value: "B", stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 } });
  await w.ext.automaticCheck();
  assert.equal(await w.settle(), "B");
  assert.ok(existsSync(w.ext.layout.readPointer("current") as string));
});
