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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A session on another host: pi-engineering is a clone tracking a remote
 * (`origin`, here a bare repository). A push to that remote must reach the
 * running session without anyone typing anything on that host.
 */
async function setupRemote() {
  const key = `__rt_follow_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-follow-"));
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const source = join(root, "source");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  writeFixtureRuntime(author, key, { value: "A" });
  git(author, "init", "-q", "-b", "main");
  git(author, "add", "-A");
  git(author, "commit", "-qm", "A");
  git(author, "remote", "add", "origin", origin);
  git(author, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, source);
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
    autoReload: true,
    autoReloadIntervalMs: 25,
    followRemote: true,
    followRemoteIntervalMs: 0,
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(async () => {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  });
  const push = (value: string) => {
    writeFixtureRuntime(author, key, { value });
    git(author, "add", "-A");
    git(author, "commit", "-qm", value);
    git(author, "push", "-q", "origin", "main");
    return git(author, "rev-parse", "HEAD");
  };
  return { key, source, ext, pi, host: ext.host as NonNullable<typeof ext.host>, b, push };
}

test("follow remote: a push to the tracked remote fast-forwards the clone and hot-reloads the session", async () => {
  const { pi, host, b, push, source } = await setupRemote();
  assert.equal(host.activeGeneration()?.generation, 1);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "A");

  const sha = push("B");
  await until(() => host.activeGeneration()?.generation === 2, "handover after the remote moved");
  assert.equal(host.lastHandover?.ok, true, host.lastHandover?.failure);
  assert.equal(git(source, "rev-parse", "HEAD"), sha, "the clone was fast-forwarded");
  assert.equal(host.activeGeneration()?.source.commit, sha);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B");
});

test("follow remote: a dirty clone is never pulled over; a local commit ahead of the remote is never touched", async () => {
  const { host, push, source, key } = await setupRemote();
  // Dirty: an edit in the clone's working tree.
  writeFixtureRuntime(source, key, { value: "LOCAL-EDIT" });
  const remoteSha = push("B");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(host.activeGeneration()?.generation, 1, "no handover over uncommitted work");
  assert.notEqual(git(source, "rev-parse", "HEAD"), remoteSha, "the clone did not move");

  // Ahead (diverged): the operator's own commit in the clone.
  git(source, "add", "-A");
  git(source, "commit", "-qm", "local");
  const localSha = git(source, "rev-parse", "HEAD");
  await until(() => host.activeGeneration()?.generation === 2, "a local commit still hot-reloads");
  assert.equal(host.activeGeneration()?.source.commit, localSha);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(git(source, "rev-parse", "HEAD"), localSha, "a diverged clone is never merged or reset");
});

test("/pie: a runtime command goes through the bridge (gated and tracked), not straight to the handler", async () => {
  const { pi, host, b } = await setup({ autoReload: false });
  const bridge = host.bridge as unknown as { runCommand: (n: string, a: string, c: unknown) => Promise<void> };
  const original = bridge.runCommand;
  const seen: string[] = [];
  bridge.runCommand = async (name, args, ctx) => {
    seen.push(`${name}:${args}`);
    return original.call(bridge, name, args, ctx);
  };
  try {
    await pi.run("/pie probe x y");
  } finally {
    bridge.runCommand = original;
  }
  assert.deepEqual(seen, ["probe:x y"]);
  assert.equal(b.values.at(-1), "cmd:A");
});

test("auto reload: a commit seen while the mutation lock is held elsewhere is picked up once it is free", async () => {
  const { host, ext, commit } = await setup();
  const held = ext.lock.acquire("another-process");
  const sha = commit("B");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(host.activeGeneration()?.generation, 1, "no reload under a foreign lock");
  assert.notEqual(ext.sourceWatcher?.current, sha, "the baseline did not advance past the unloaded commit");
  held.release();
  await until(() => host.activeGeneration()?.generation === 2, "reload after the lock was released");
  assert.equal(host.activeGeneration()?.source.commit, sha);
});

test("auto reload: closing the session disposes the watcher", async () => {
  const { pi, ext } = await setup();
  assert.ok(ext.sourceWatcher?.active);
  await pi.close();
  cleanups.pop();
  assert.equal(ext.sourceWatcher, undefined);
});

test("auto reload: a commit does not reload while a tracked file is mid-edit; it does once the tree is clean", async () => {
  const { pi, host, b, source, ext, commit } = await setup();
  assert.equal(host.activeGeneration()?.generation, 1);
  // A tracked file the operator is still editing (unrelated to the commit):
  // the handover would copy it, so the commit must wait.
  const draft = join(source, "package.json");
  const pristine = readFileSync(draft, "utf8");
  writeFileSync(draft, `${pristine}\n`);
  const sha = commit("B");
  // `commit` adds everything, so put the half-edit back on top of the commit.
  writeFileSync(draft, `${pristine}\n\n`);
  assert.deepEqual(git(source, "status", "--porcelain", "-uno").split("\n").filter(Boolean).length, 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(host.activeGeneration()?.generation, 1, "no handover over a half-edited tracked file");
  assert.notEqual(ext.sourceWatcher?.current, sha, "the baseline waits with it");

  git(source, "checkout", "--", "package.json");
  await until(() => host.activeGeneration()?.generation === 2, "handover once the tree is clean");
  assert.equal(host.activeGeneration()?.source.commit, git(source, "rev-parse", "HEAD"));
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B");
});
