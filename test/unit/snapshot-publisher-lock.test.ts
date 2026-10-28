import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SNAPSHOT_LOCK_FILENAME,
  type SnapshotLockHandle,
  acquireSnapshotPublisherLock,
} from "../../src/orchestration/missionSnapshot.ts";

/**
 * #427 — the snapshot is read-modify-write once publishers merge instead of
 * clobber, so two processes merging at the same moment would each read the
 * pre-merge file. The publisher lock is what makes that sequence serial.
 *
 * It refuses rather than steals: a live holder is given a bounded wait, and a
 * lock whose holder is gone (or whose file is torn) is taken over. Skipping is
 * always safe here — a skipped publish leaves the snapshot dirty and the next
 * mutation republishes.
 */

function dir(): string {
  return mkdtempSync(join(tmpdir(), "pi-snapshot-lock-"));
}

const alive = (pid: number) => pid > 0;
const dead = () => false;

/** A free lock is acquired, and releasing removes it. */
test("a free lock is acquired and released", async () => {
  const root = dir();
  const handle = await acquireSnapshotPublisherLock({ dir: root, pid: 111, isPidAlive: alive });

  assert.ok(handle, "the first publisher gets the lock");
  const held = JSON.parse(readFileSync(join(root, SNAPSHOT_LOCK_FILENAME), "utf8")) as { pid: number };
  assert.equal(held.pid, 111);

  await handle.release();

  const second = await acquireSnapshotPublisherLock({ dir: root, pid: 222, isPidAlive: alive });
  assert.ok(second, "release hands the lock to the next publisher");
  await second?.release();
});

/** A live holder is not stolen: the waiter skips, and skipping is not a loss. */
test("a lock held by a live process is refused, not stolen", async () => {
  const root = dir();
  const first = (await acquireSnapshotPublisherLock({ dir: root, pid: 333, isPidAlive: alive })) as SnapshotLockHandle;

  const second = await acquireSnapshotPublisherLock({
    dir: root,
    pid: 444,
    isPidAlive: alive,
    waitMs: 30,
    pollMs: 5,
  });

  assert.equal(second, null, "the second publisher skips rather than racing the first");
  const held = JSON.parse(readFileSync(join(root, SNAPSHOT_LOCK_FILENAME), "utf8")) as { pid: number };
  assert.equal(held.pid, 333, "the live holder keeps the lock");
  await first.release();
});

/** A crash leaves a lock behind; a dead holder's lock is taken over. */
test("a lock left by a dead process is taken over", async () => {
  const root = dir();
  writeFileSync(join(root, SNAPSHOT_LOCK_FILENAME), JSON.stringify({ pid: 999_999, atMs: Date.now() }));

  const handle = await acquireSnapshotPublisherLock({ dir: root, pid: 555, isPidAlive: dead });

  assert.ok(handle, "a lock whose holder is gone does not wedge the store directory");
  await handle?.release();
});

/** A torn lock file (crash mid-write) is treated as abandoned, not as a holder. */
test("a torn lock file is taken over", async () => {
  const root = dir();
  writeFileSync(join(root, SNAPSHOT_LOCK_FILENAME), '{ "pid": 77');

  const handle = await acquireSnapshotPublisherLock({ dir: root, pid: 666, isPidAlive: alive });

  assert.ok(handle);
  await handle?.release();
});

/** Releasing twice, and releasing after another holder took over, is harmless. */
test("release never removes another publisher's lock", async () => {
  const root = dir();
  const first = (await acquireSnapshotPublisherLock({
    dir: root,
    pid: 1001,
    isPidAlive: alive,
  })) as SnapshotLockHandle;
  // Model this publisher being fenced: the file now names somebody else.
  writeFileSync(join(root, SNAPSHOT_LOCK_FILENAME), JSON.stringify({ pid: 2002, atMs: Date.now() }));

  await first.release();
  await first.release();

  const held = JSON.parse(readFileSync(join(root, SNAPSHOT_LOCK_FILENAME), "utf8")) as { pid: number };
  assert.equal(held.pid, 2002, "a release only ever removes the lock this handle wrote");
});

/** A lock that outlives its stale horizon while the holder is alive is still honoured. */
test("an old lock held by a live process is still honoured", async () => {
  const root = dir();
  writeFileSync(join(root, SNAPSHOT_LOCK_FILENAME), JSON.stringify({ pid: 8123, atMs: Date.now() - 60_000 }));

  const handle = await acquireSnapshotPublisherLock({
    dir: root,
    pid: 7123,
    isPidAlive: (pid) => pid === 8123,
    staleMs: 1_000,
    waitMs: 20,
    pollMs: 5,
  });

  assert.equal(handle, null, "age alone does not prove a lock is abandoned — only a dead holder does");
});
