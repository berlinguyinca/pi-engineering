/**
 * Versioned runtime directories, atomic current/previous activation, health
 * checks and automatic rollback (spec §10, §31-§37, Phase 2). Real symlinks,
 * real version trees, a real Pi session.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { InstallLayout, versionId } from "../../src/update/installLayout.ts";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";
import type { FixtureMode } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let seq = 0;
function fresh() {
  const key = `__rt_versions_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-versions-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const layout = new InstallLayout(join(root, "install"));
  return { key, b, root, layout };
}

async function installFixture(
  layout: InstallLayout,
  key: string,
  version: string,
  value: string,
  mode: FixtureMode = "ok",
): Promise<string> {
  const id = versionId(version, `${value.toLowerCase()}000000000000`.slice(0, 12));
  const dir = layout.versionDir(id);
  writeFixtureRuntime(dir, key, { value, version, mode });
  await layout.writeMeta(dir, {
    id,
    version,
    commit: `${value.toLowerCase()}000000000000`.slice(0, 12),
    channel: "main",
    source: "test",
    installedAt: new Date(Date.now() + seq++).toISOString(),
    runtimeApi: 1,
  });
  return dir;
}

async function session(root: string, layout: InstallLayout, packageRoot: string) {
  const ext = new EngineeringHostExtension({
    installRoot: layout.root,
    packageRoot,
    entry: "runtime.ts",
    baseline: false,
    autoUpdateCheck: false,
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(() => pi.close());
  return { ext, pi, host: ext.host as NonNullable<typeof ext.host> };
}

test("pointer switches are single atomic renames: a reader never sees a missing pointer", async () => {
  const { layout, key } = fresh();
  const a = await installFixture(layout, key, "0.2.0", "A");
  const b = await installFixture(layout, key, "0.2.1", "B");
  await layout.setPointer("current", a);
  let missing = 0;
  let reads = 0;
  let done = false;
  const reader = (async () => {
    while (!done) {
      reads++;
      if (layout.readPointer("current") === null) missing++;
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 300; i++) await layout.setPointer("current", i % 2 ? a : b);
  done = true;
  await reader;
  assert.ok(reads > 10);
  assert.equal(missing, 0);
  assert.ok(lstatSync(layout.pointerPath("current")).isSymbolicLink());
  assert.ok(!readlinkSync(layout.pointerPath("current")).startsWith("/"), "relative link target");
  await assert.rejects(layout.setPointer("current", "/etc"), /outside/);
  assert.throws(() => layout.versionDir("../escape"), /invalid version id/);
});

test("starts from the installed current version; activation makes the old one previous", async () => {
  const { layout, key, b, root } = fresh();
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const a = await installFixture(layout, key, "0.2.0", "A");
  await layout.setPointer("current", a);
  const { ext, pi, host } = await session(root, layout, pkg);
  assert.equal(host.activeGeneration()?.source.label.startsWith("installed:"), true);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "A");

  const v2 = await installFixture(layout, key, "0.2.1", "B");
  const result = await (await ext.activateInstalled(v2, "update")).promise;
  assert.equal(result.ok, true, result.failure);
  assert.equal(layout.readPointer("current"), v2);
  assert.equal(layout.readPointer("previous"), a);
  assert.ok(existsSync(a), "previous known-good version retained");
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B");
  // Reload re-reads the current pointer, not the checkout.
  await pi.run("/engineering reload");
  assert.equal(host.lastHandover?.ok, true);
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "B");
});

test("a candidate failing health rolls back: pointers and runtime restored (§35)", async () => {
  const { layout, key, b, root } = fresh();
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const a = await installFixture(layout, key, "0.2.0", "A");
  const v2 = await installFixture(layout, key, "0.2.1", "B");
  await layout.activate(a);
  await layout.activate(v2);
  const { ext, pi, host } = await session(root, layout, pkg);
  const bad = await installFixture(layout, key, "0.2.2", "BAD", "throw-start");
  const result = await (await ext.activateInstalled(bad, "update")).promise;
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(layout.readPointer("current"), v2, "current restored");
  assert.equal(layout.readPointer("previous"), a, "previous restored");
  assert.equal((await host.health()).healthy, true);
  b.values.length = 0;
  await pi.emit({ type: "agent_settled" });
  assert.deepEqual(b.values, ["B"]);
  assert.ok(ext.telemetry.recent().some((e) => e.event === "runtime.health.failed"));
});

test("startup: a broken current version falls back to previous and repairs the pointer (§30)", async () => {
  const { layout, key, b, root } = fresh();
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const good = await installFixture(layout, key, "0.2.0", "GOOD");
  const broken = await installFixture(layout, key, "0.2.1", "BROKEN", "throw-create");
  await layout.activate(good);
  await layout.activate(broken);
  const { host, pi } = await session(root, layout, pkg);
  assert.equal(host.activeGeneration()?.source.root, good);
  assert.equal(layout.readPointer("current"), good, "current repaired to what actually runs");
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "GOOD");
});

test("startup: with no installed version the package checkout runs", async () => {
  const { layout, key, b, root } = fresh();
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const { host, pi } = await session(root, layout, pkg);
  assert.equal(host.activeGeneration()?.source.label, "package");
  await pi.emit({ type: "agent_settled" });
  assert.equal(b.values.at(-1), "PKG");
});
