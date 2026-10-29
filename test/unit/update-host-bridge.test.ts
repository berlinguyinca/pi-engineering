/**
 * The seam between the legacy `/update` command and the runtime host.
 *
 * The defect this exists to prevent: an installed runtime is a version directory
 * with no version-control metadata, so asking git what to do with it can only
 * answer "not a git checkout" — which an operator was told while a real update
 * was pending. `/update` must ask the host whether it owns the tree instead, so
 * the bridge has to be unambiguous about ownership, and about who may withdraw it.
 *
 * The second defect, found in the field after the first was fixed: ownership was
 * answered with `isVersionDir`, and no session ever loads from `versions/<id>`.
 * Pi imports the extension from a generation snapshot the Host copies out of the
 * installed version, so every installed session fell back to the fast-forward
 * path, which said nothing at all, and the install stopped moving — an update
 * landed on the channel and no session could install it. Ownership therefore has
 * to cover the snapshot as well as the version directory, while the pointer stays
 * strict about pointing only at `versions/<id>`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { type RuntimeUpdateBridge, runtimeUpdateBridge, setRuntimeUpdateBridge } from "../../src/update/hostBridge.ts";
import { INSTALL_META, InstallLayout } from "../../src/update/installLayout.ts";

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
  await writeFile(
    join(versionDir, INSTALL_META),
    `${JSON.stringify({ id, version: "0.2.0", commit: "aaaa11112222", channel: "main", source: "https://example.invalid/pi-engineering.git", installedAt: "2026-10-29T07:42:20.890Z", runtimeApi: 1 })}\n`,
  );
  await symlink(join("versions", id), join(root, "current"));
  await symlink(join("versions", id), join(root, "previous"));
  await writeFile(
    join(root, "transactions.jsonl"),
    '{"transaction":"update-aaaa11112222-01","kind":"update","channel":"main","toCommit":"aaaa11112222"}\n',
  );
  await writeFile(join(root, "update-journal.json"), JSON.stringify({ phase: "committed" }));
  return { root, versionDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * The tree a session really loads extensions from: the Host copies the installed
 * version into `generations/<pid>-<rand>/g1-<ts>-<rand>/` and Pi imports from
 * there, so `import.meta.url` — and therefore the extension root `/update` asks
 * about — is the snapshot, never `versions/<id>`.
 */
async function snapshotOf(root: string, id: string, label = "g1"): Promise<string> {
  const dir = join(root, "generations", `${process.pid}-a1b2c3`, `${label}-1abcde-f0e1d2`);
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(join(dir, "extensions", "index.ts"), "export default function () {}\n");
  await writeFile(
    join(dir, INSTALL_META),
    `${JSON.stringify({ id, version: "0.2.0", commit: "aaaa11112222", channel: "main", source: "https://example.invalid/pi-engineering.git", installedAt: "2026-10-29T07:42:20.890Z", runtimeApi: 1 })}\n`,
  );
  return dir;
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

test("ownership: the install owns the generation snapshot Pi loads the extension from", async () => {
  const layout = await installedLayout();
  try {
    const install = new InstallLayout(layout.root);
    const snapshot = await snapshotOf(layout.root, "0.2.0-aaaa11112222");
    // The bug this test exists for: Pi imports the extension from this snapshot,
    // so `/update` asks about it. Owning only versions/<id> made every installed
    // session fall back to the git fast-forward, which can only say "not a git
    // checkout" — and the update silently never happened.
    assert.equal(install.ownsRuntimeTree(snapshot), true, `a snapshot of an installed version is owned: ${snapshot}`);
    // The strict version-directory test is untouched: pointers still may not be
    // aimed at a snapshot.
    assert.equal(install.isVersionDir(snapshot), false);
    assert.equal(install.ownsRuntimeTree(layout.versionDir), true);
  } finally {
    await layout.cleanup();
  }
});

test("ownership: a snapshot is only owned while its install metadata names a version this install has", async () => {
  const layout = await installedLayout();
  try {
    const install = new InstallLayout(layout.root);

    // A snapshot naming a version that is not installed (pruned, or written by
    // something that is not this install) is not a tree this Host may update.
    const stale = await snapshotOf(layout.root, "9.9.9-deadbeefcafe");
    assert.equal(install.ownsRuntimeTree(stale), false, "an unknown version id is not owned");

    // A directory under generations/ with no install metadata is not a snapshot.
    const bare = join(layout.root, "generations", `${process.pid}-a1b2c3`, "g2-1abcde-f0e1d2");
    await mkdir(bare, { recursive: true });
    assert.equal(install.ownsRuntimeTree(bare), false, "a snapshot without install metadata is not owned");

    // Nor is anything outside this install's generations tree.
    const foreign = await mkdtemp(join(tmpdir(), "pi-eng-foreign-"));
    try {
      const elsewhere = await snapshotOf(foreign, "0.2.0-aaaa11112222");
      assert.equal(install.ownsRuntimeTree(elsewhere), false, "another install's generations tree is not owned");
    } finally {
      await rm(foreign, { recursive: true, force: true });
    }

    // And a source checkout keeps the fast-forward path.
    assert.equal(install.ownsRuntimeTree(layout.root), false);
    assert.equal(install.ownsRuntimeTree(join(layout.versionDir, "extensions")), false);
  } finally {
    await layout.cleanup();
  }
});

test("ownership: the host's bridge asks the install layout, so /update routes to the transaction", async () => {
  const layout = await installedLayout();
  try {
    const host = new EngineeringHostExtension({
      installRoot: layout.root,
      packageRoot: layout.root,
      entry: "src/runtime/host/runtimeEntry.ts",
    });
    const bridge = (host as unknown as { updateBridge: () => RuntimeUpdateBridge }).updateBridge();
    const snapshot = await snapshotOf(layout.root, "0.2.0-aaaa11112222");

    assert.equal(bridge.owns(snapshot), true, "the bridge owns the tree the extension is loaded from");
    assert.equal(bridge.owns(layout.versionDir), true, "an installed version directory stays owned");
    assert.equal(bridge.owns(join(layout.root, "generations", "notes")), false, "a stray directory is not owned");
  } finally {
    await layout.cleanup();
  }
});
