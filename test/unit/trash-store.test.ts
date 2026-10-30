import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { moveToTrash, purgeTrash } from "../../src/git/trashStore.ts";
import { describeTrashPurge, runTrashPurge } from "../../src/runtime/janitor.ts";

const DAY = 86_400_000;
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function trashed(trashRoot: string, name: string, daysAgo: number): Promise<string> {
  const from = join(await mkdtemp(join(tmpdir(), "pi-eng-trash-src-")), name);
  await mkdir(join(from, "src"), { recursive: true });
  await writeFile(join(from, "src", "a.txt"), "data\n");
  return moveToTrash(trashRoot, "worktree", from, name, "br", Date.now() - daysAgo * DAY);
}

test("purgeTrash lists without --apply, deletes only marked entries old enough, and rejects < 7 days", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-eng-purge-"));
  const root = join(base, "trash");
  try {
    const old = await trashed(root, "old-wt", 20);
    const young = await trashed(root, "young-wt", 3);
    await assert.rejects(purgeTrash(root, { olderThanDays: 3, apply: true }), /at least 7 days/);
    await assert.rejects(purgeTrash(root, { olderThanDays: Number.NaN, apply: true }), /at least 7 days/);

    const preview = await purgeTrash(root, { olderThanDays: 14, apply: false });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.purged.length, 1);
    assert.equal(await exists(old), true, "preview deletes nothing");

    const done = await purgeTrash(root, { olderThanDays: 14, apply: true });
    assert.equal(done.purged.length, 1);
    assert.equal(await exists(old), false);
    assert.equal(await exists(young), true, "younger than the threshold is kept");
    assert.match(done.skipped[0]!.reason, /trashed 3 d ago/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("purgeTrash never touches unmarked dirs, files, or symlinks (it does not follow them)", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-eng-purge-"));
  const root = join(base, "trash");
  const outside = join(base, "outside-precious");
  try {
    await mkdir(root, { recursive: true });
    // a user's directory dropped into the trash root: no marker
    await mkdir(join(root, "users-own-dir"));
    await writeFile(join(root, "users-own-dir", "keep.txt"), "mine\n");
    // a loose file
    await writeFile(join(root, "stray.txt"), "x\n");
    // a symlink to a dir that DOES have a valid, old marker: still must not be followed or removed
    const real = await trashed(join(base, "other-trash"), "real", 60);
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "p\n");
    await symlink(join(real, ".."), join(root, "link-to-marked"));
    await symlink(outside, join(root, "link-to-outside"));
    // a marked-looking dir whose marker is a symlink, not a regular file
    await mkdir(join(root, "fake-marker"));
    await symlink(join(real, "..", ".pi-eng-trash.json"), join(root, "fake-marker", ".pi-eng-trash.json"));

    const done = await purgeTrash(root, { olderThanDays: 7, apply: true });
    assert.deepEqual(done.purged, []);
    assert.equal(done.skipped.length, 5);
    for (const p of [
      join(root, "users-own-dir", "keep.txt"),
      join(root, "stray.txt"),
      join(outside, "precious.txt"),
      real,
    ]) {
      assert.equal(await exists(p), true, p);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("runTrashPurge covers the worktree trash and the Rust cache trash, and refuses a foreign cache root", async () => {
  const state = await mkdtemp(join(tmpdir(), "pi-eng-state-"));
  const cache = await mkdtemp(join(tmpdir(), "pi-eng-cache-"));
  const foreign = await mkdtemp(join(tmpdir(), "pi-eng-foreign-"));
  try {
    const wtOld = await trashed(join(state, "trash"), "wt-old", 30);
    const rcOld = await trashed(join(cache, ".trash"), "rc-old", 30);
    await writeFile(join(cache, ".pi-eng-rust-cache-root"), JSON.stringify({ version: 1, creator: "pi-engineering" }));
    const env = { PI_ENGINEERING_STATE_DIR: state, PI_RUST_CACHE_DIR: cache, HOME: state };
    const preview = await runTrashPurge({ olderThanDays: 14, apply: false, env });
    assert.equal(preview.worktreeTrash.purged.length, 1);
    assert.equal(preview.rustCacheTrash?.purged.length, 1);
    assert.match(describeTrashPurge(preview, true).join("\n"), /would purge 1/);
    assert.equal(await exists(wtOld), true);
    await runTrashPurge({ olderThanDays: 14, apply: true, env });
    assert.equal(await exists(wtOld), false);
    assert.equal(await exists(rcOld), false);

    // a PI_RUST_CACHE_DIR that is not ours: its .trash is never purged
    await writeFile(join(foreign, "mine.txt"), "x");
    const decoy = await trashed(join(foreign, ".trash"), "decoy", 30);
    const refused = await runTrashPurge({
      olderThanDays: 14,
      apply: true,
      env: { PI_ENGINEERING_STATE_DIR: state, PI_RUST_CACHE_DIR: foreign, HOME: state },
    });
    assert.equal(refused.rustCacheTrash, null);
    assert.match(refused.rustCacheRefused ?? "", /not a marked pi-engineering Rust cache/);
    assert.equal(await exists(decoy), true);
  } finally {
    for (const d of [state, cache, foreign]) await rm(d, { recursive: true, force: true });
  }
});

test("a purge preview has no side effects on a legacy (unmarked) Rust cache root", async () => {
  const state = await mkdtemp(join(tmpdir(), "pi-eng-state-"));
  const cache = await mkdtemp(join(tmpdir(), "pi-eng-cache-"));
  try {
    await mkdir(join(cache, "target"));
    const { chmod } = await import("node:fs/promises");
    await chmod(cache, 0o755);
    const r = await runTrashPurge({
      olderThanDays: 14,
      apply: false,
      env: { PI_ENGINEERING_STATE_DIR: state, PI_RUST_CACHE_DIR: cache, HOME: state },
    });
    assert.equal(r.rustCacheTrash, null, "an unmarked root is not purged");
    assert.equal(await exists(join(cache, ".pi-eng-rust-cache-root")), false, "no marker written by a preview");
    assert.equal((await stat(cache)).mode & 0o777, 0o755, "permissions untouched by a preview");
  } finally {
    for (const d of [state, cache]) await rm(d, { recursive: true, force: true });
  }
});

test("PI_TRASH_DIR relocates the trash; a non-empty directory that is not a trash root is refused", async () => {
  const { defaultTrashRoot } = await import("../../src/git/trashStore.ts");
  const base = await mkdtemp(join(tmpdir(), "pi-eng-trashdir-"));
  try {
    assert.equal(defaultTrashRoot({ PI_TRASH_DIR: join(base, "t") }), join(base, "t"));
    assert.equal(defaultTrashRoot({ PI_ENGINEERING_STATE_DIR: base }), join(base, "trash"));
    const mine = join(base, "mine");
    const dest = await trashed(mine, "wt", 1);
    assert.equal(await exists(dest), true);
    assert.equal(await exists(join(mine, ".pi-eng-trash-root")), true, "root marked on first use");
    const foreign = join(base, "photos");
    await mkdir(foreign);
    await writeFile(join(foreign, "a.jpg"), "x");
    await assert.rejects(trashed(foreign, "wt", 1), /not a pi-engineering trash root/);
    assert.equal(await exists(join(foreign, "a.jpg")), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
