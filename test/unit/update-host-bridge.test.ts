/**
 * The seam between the legacy `/update` command and the runtime host.
 *
 * The defect this exists to prevent: an installed runtime is a version directory
 * with no version-control metadata, so asking git what to do with it can only
 * answer "not a git checkout" — which an operator was told while a real update
 * was pending. `/update` must ask the host whether it owns the tree instead, so
 * the bridge has to be unambiguous about ownership, and about who may withdraw it.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type RuntimeUpdateBridge, runtimeUpdateBridge, setRuntimeUpdateBridge } from "../../src/update/hostBridge.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";

function stubBridge(ownsRoot: string): RuntimeUpdateBridge & { checkCalls: number; applyCalls: number } {
  const bridge = {
    checkCalls: 0,
    applyCalls: 0,
    owns: (dir: string) => dir === ownsRoot,
    check: async () => {
      bridge.checkCalls += 1;
      return { lines: ["Current:      0.2.0-aaaa", "Available:    0.2.0-bbbb"], pending: true };
    },
    apply: async () => {
      bridge.applyCalls += 1;
      return { lines: ["Activating"], outcome: "Updated to 0.2.0-bbbb", ok: true };
    },
  };
  return bridge;
}

/**
 * Reproduce the install an operator actually runs: `versions/<id>` is a plain file
 * tree (no version-control metadata), `current`/`previous` are symlinks into it,
 * and the transaction record sits beside them.
 */
async function installedLayout(): Promise<{ root: string; versionDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-install-"));
  const id = "0.2.0-aaaa11112222";
  const versionDir = join(root, "versions", id);
  await mkdir(join(versionDir, "extensions"), { recursive: true });
  await writeFile(join(versionDir, "package.json"), '{"name":"pi-engineering-runtime"}\n');
  await writeFile(join(versionDir, "extensions", "index.ts"), "export default function () {}\n");
  await symlink(join("versions", id), join(root, "current"));
  await symlink(join("versions", id), join(root, "previous"));
  await writeFile(
    join(root, "transactions.jsonl"),
    '{"transaction":"update-aaaa11112222-01","kind":"update","channel":"main","toCommit":"aaaa11112222"}\n',
  );
  await writeFile(join(root, "update-journal.json"), JSON.stringify({ phase: "committed" }));
  return { root, versionDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

after(() => setRuntimeUpdateBridge(undefined));

test("bridge: the newest host owns it, and withdrawing is only allowed for the bridge you published", () => {
  const first = stubBridge("/first");
  const second = stubBridge("/second");

  setRuntimeUpdateBridge(first);
  assert.equal(runtimeUpdateBridge(), first);

  // A reload installs a new Host; the newest one drives activation.
  setRuntimeUpdateBridge(second);
  assert.equal(runtimeUpdateBridge(), second);

  setRuntimeUpdateBridge(undefined);
  assert.equal(runtimeUpdateBridge(), undefined);
});

test("installed layout: the version tree carries no version-control metadata at all", async () => {
  const layout = await installedLayout();
  try {
    const entries = await readdir(layout.versionDir);
    assert.equal(
      entries.some((name) => name === ".git" || name === ".jj"),
      false,
      `the installed tree must be a plain file tree, saw ${entries.join(", ")}`,
    );
    // ...and the transaction record the updater relies on is what makes it updatable.
    assert.match(await readFile(join(layout.root, "transactions.jsonl"), "utf8"), /"kind":"update"/);
  } finally {
    await layout.cleanup();
  }
});

test("installed layout: the install owns a version directory and not a source checkout", async () => {
  const layout = await installedLayout();
  try {
    const install = new InstallLayout(layout.root);
    // The tree Pi loads from, exactly as the extension computes it.
    assert.equal(install.isVersionDir(layout.versionDir), true, "an installed runtime is a version directory");
    // The pointer resolves to the same directory the extension loads from.
    assert.equal(install.readPointer("current"), layout.versionDir);

    // A source checkout (repo root, or any directory that is not under versions/)
    // is NOT owned, so `/update` keeps the fast-forward path there.
    assert.equal(install.isVersionDir(layout.root), false);
    assert.equal(install.isVersionDir(join(layout.root, "versions", layout.versionDir, "extensions")), false);
    assert.ok(existsSync(join(layout.root, "versions")));
  } finally {
    await layout.cleanup();
  }
});
