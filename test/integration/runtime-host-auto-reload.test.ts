/**
 * Automatic hot reload and the `/pie` alias inside a REAL Pi session.
 *
 * The runtime source is a git checkout. A commit landing on it makes the
 * Host hand over to a new generation by itself — the same process and
 * conversation continue — and `/pie <x>` reaches both the Host's own
 * subcommands and the running generation's commands.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" })
    .toString()
    .trim();
}

let seq = 0;
async function setup(opts: { autoReload?: boolean } = {}) {
  const key = `__rt_autoreload_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-autoreload-"));
  const source = join(root, "source");
  writeFixtureRuntime(source, key, { value: "A" });
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "A");
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
    autoReload: opts.autoReload ?? true,
    autoReloadIntervalMs: 25,
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(async () => {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  });
  const commit = (value: string) => {
    writeFixtureRuntime(source, key, { value });
    git(source, "add", "-A");
    git(source, "commit", "-qm", value);
    return git(source, "rev-parse", "HEAD");
  };
  return { key, source, ext, pi, host: ext.host as NonNullable<typeof ext.host>, b, commit };
}

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("auto reload: a commit on the checkout hot-reloads the running Pi; uncommitted edits do not", async () => {
  const { pi, host, b, source, key, ext, commit } = await setup();
  assert.equal(host.activeGeneration()?.generation, 1);
  assert.ok(ext.sourceWatcher?.active, "the watcher runs once the session started");
  const session = pi.session;
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "A");

  // An edit that is not committed is not a reload: nobody finished writing it.
  writeFixtureRuntime(source, key, { value: "DRAFT" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(host.activeGeneration()?.generation, 1);

  const sha = commit("B");
  await until(() => host.activeGeneration()?.generation === 2, "automatic handover");
  assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  assert.equal(host.activeGeneration()?.source.commit, sha, "the new generation is the new commit");
  assert.equal(pi.session, session, "same conversation");
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B", "the new code answers");
  assert.equal(ext.sourceWatcher?.current, sha, "the watcher's baseline moved with the generation");
  assert.ok(ext.telemetry.recent().some((e) => e.event === "runtime.reload.completed"));

  // And again: the watcher survives its own reload.
  const sha2 = commit("C");
  await until(() => host.activeGeneration()?.generation === 3, "second automatic handover");
  assert.equal(host.activeGeneration()?.source.commit, sha2);
});

test("auto reload: off by configuration, the checkout may move without a handover", async () => {
  const { host, ext, commit } = await setup({ autoReload: false });
  assert.equal(ext.sourceWatcher, undefined);
  commit("B");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(host.activeGeneration()?.generation, 1);
});

test("/pie: Host subcommands, the generation's commands, and `update` on a moved checkout", async () => {
  const { pi, host, b, ext, commit } = await setup({ autoReload: false });
  assert.ok(pi.piCommands().includes("pie"));

  await pi.run("/pie version");
  assert.match(ext.versionText(), /Generation:\s+1/);

  await pi.run("/pie probe");
  assert.equal(b.values.at(-1), "cmd:A", "`/pie probe` is `/probe` of the running generation");

  assert.equal(ext.checkoutMoved(), null);
  const sha = commit("B");
  assert.equal(ext.checkoutMoved()?.to, sha);
  await pi.run("/pie update");
  assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  assert.equal(host.activeGeneration()?.generation, 2, "a moved checkout makes `update` a reload");
  await pi.run("/pie probe");
  assert.equal(b.values.at(-1), "cmd:B");
  assert.equal(ext.checkoutMoved(), null);

  assert.ok(ext.pieNames().includes("probe"));
  assert.ok(ext.pieNames().includes("update"));
});

test("auto reload: closing the session disposes the watcher", async () => {
  const { pi, ext } = await setup();
  assert.ok(ext.sourceWatcher?.active);
  await pi.close();
  cleanups.pop();
  assert.equal(ext.sourceWatcher, undefined);
});
