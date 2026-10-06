/**
 * Installed versions and their dependency trees: no installed version may
 * depend on another version's node_modules, and retention must never leave a
 * kept version with a dangling node_modules link.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { UpdateJournal } from "../../src/update/journal.ts";
import { applyRetention } from "../../src/update/retention.ts";
import { provisionDependencies } from "../../src/update/validate.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeLock(dir: string): void {
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/x": { version: "1" } } }));
}

test("provisionDependencies gives the candidate its OWN dependency tree, independent of the running one", async () => {
  const root = tmp("rt-deps-");
  const running = join(root, "running");
  const staged = join(root, "staged");
  mkdirSync(join(running, "node_modules", "x", "lib"), { recursive: true });
  writeFileSync(join(running, "node_modules", "x", "package.json"), '{"name":"x"}');
  writeFileSync(join(running, "node_modules", "x", "lib", "index.js"), "export default 1;\n");
  mkdirSync(join(running, "node_modules", ".bin"), { recursive: true });
  symlinkSync("../x/lib/index.js", join(running, "node_modules", ".bin", "x"));
  mkdirSync(staged, { recursive: true });
  writeLock(running);
  writeLock(staged);

  const step = await provisionDependencies(staged, running, { allowInstall: false });
  assert.equal(step.status, "passed", step.detail);
  const nm = join(staged, "node_modules");
  assert.equal(lstatSync(nm).isSymbolicLink(), false, "never a link into another version's tree");
  assert.equal(lstatSync(join(nm, ".bin", "x")).isSymbolicLink(), true, "relative links inside the tree are kept");

  // The running version goes away (retention, rollback cleanup): the candidate still resolves.
  rmSync(running, { recursive: true, force: true });
  assert.equal(readFileSync(join(nm, "x", "lib", "index.js"), "utf8"), "export default 1;\n");
  assert.equal(readFileSync(join(nm, ".bin", "x"), "utf8"), "export default 1;\n");
});

test("retention never deletes the version whose node_modules a kept version links to (legacy installs)", async () => {
  const root = tmp("rt-retention-links-");
  const layout = new InstallLayout(root);
  let prev: string | null = null;
  const ids = ["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4"];
  for (const [i, id] of ids.entries()) {
    const dir = layout.versionDir(id);
    mkdirSync(dir, { recursive: true });
    await layout.writeMeta(dir, {
      id,
      version: id,
      commit: null,
      channel: "main",
      source: "t",
      installedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      runtimeApi: 1,
    });
    if (prev === null) {
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "x", "package.json"), '{"name":"x"}');
      await layout.setPointer("current", dir);
    } else {
      // What older provisionDependencies did: link to realpath(running/node_modules).
      symlinkSync(realpathSync(join(prev, "node_modules")), join(dir, "node_modules"), "dir");
      await layout.activate(dir);
    }
    prev = dir;
  }
  const current = layout.readPointer("current") as string;
  const previous = layout.readPointer("previous") as string;
  await applyRetention(layout, new UpdateJournal(layout.journalFile), { running: current, keepVersions: 3 });
  assert.equal(existsSync(join(current, "node_modules", "x", "package.json")), true, "current still resolves");
  assert.equal(existsSync(join(previous, "node_modules", "x", "package.json")), true, "previous still resolves");
  for (const v of layout.listVersions()) {
    assert.equal(existsSync(join(v.dir, "node_modules")), true, `${v.id} kept without a dangling node_modules link`);
  }
});

test("retention keeps a version a LIVE process's generation snapshot links its dependencies to", async () => {
  const root = tmp("rt-retention-live-");
  const layout = new InstallLayout(root);
  const ids = ["0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4", "0.2.5"];
  for (const [i, id] of ids.entries()) {
    const dir = layout.versionDir(id);
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    await layout.writeMeta(dir, {
      id,
      version: id,
      commit: null,
      channel: "main",
      source: "t",
      installedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      runtimeApi: 1,
    });
  }
  await layout.setPointer("previous", layout.versionDir("0.2.4"));
  await layout.setPointer("current", layout.versionDir("0.2.5"));
  // This (live) process runs a generation snapshotted from 0.2.0; a dead one ran 0.2.1.
  const live = join(root, "generations", `${process.pid}-aaaaaa`, "g1-x");
  mkdirSync(live, { recursive: true });
  symlinkSync(realpathSync(join(layout.versionDir("0.2.0"), "node_modules")), join(live, "node_modules"), "dir");
  const dead = join(root, "generations", "2147483646-bbbbbb", "g1-y");
  mkdirSync(dead, { recursive: true });
  symlinkSync(realpathSync(join(layout.versionDir("0.2.1"), "node_modules")), join(dead, "node_modules"), "dir");

  const removed = await applyRetention(layout, new UpdateJournal(layout.journalFile), { keepVersions: 3 });
  assert.equal(existsSync(join(live, "node_modules", "x")), true, "the live generation keeps its dependencies");
  assert.deepEqual(
    removed.versions.map((d) => d.split("/").pop()),
    ["0.2.1", "0.2.2"],
    "0.2.0 stays for the live process; the dead process's 0.2.1 goes",
  );
});
