/**
 * ExclusiveFileLock on a filesystem without hard links (some FUSE, SMB, vfat
 * mounts): publishing the owner record by link(2) fails with EPERM/ENOTSUP
 * there, and the lock must fall back to an O_EXCL create instead of failing.
 * The filesystem is reproduced through the lock's `linkFile` seam.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExclusiveFileLock, type FileLockRecoveryHooks } from "../../src/platform/eventstore/fileLock.ts";

const root = mkdtempSync(join(tmpdir(), "filelock-nolink-"));
after(() => rmSync(root, { recursive: true, force: true }));

function noHardLinks(code: string): FileLockRecoveryHooks & { calls: number } {
  const hooks = {
    calls: 0,
    linkFile: async () => {
      hooks.calls++;
      throw Object.assign(new Error(`${code}: operation not permitted, link`), { code });
    },
  };
  return hooks;
}

test("acquire, exclude and release work when the filesystem refuses hard links", async () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV", "EMLINK"]) {
    const file = join(root, `store-${code}.jsonl`);
    const hooks = noHardLinks(code);
    const lock = await ExclusiveFileLock.acquire(file, hooks);
    assert.ok(hooks.calls > 0, "the hard-link path was attempted first");
    const record = JSON.parse(readFileSync(`${file}.lock`, "utf8")) as { ownerToken: string; pid: number };
    assert.equal(record.ownerToken, lock.owner.ownerToken, "a complete owner record was published");
    await assert.rejects(ExclusiveFileLock.acquire(file, noHardLinks(code)), /is held/, "still exclusive");
    lock.release();
    const again = await ExclusiveFileLock.acquire(file, noHardLinks(code));
    again.release();
  }
});

test("a stale owner is recovered without hard links too", async () => {
  const file = join(root, "stale.jsonl");
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  // This process's PID with a start time that is not its own: a previous incarnation.
  writeFileSync(
    `${file}.lock`,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      openedAt: new Date(0).toISOString(),
      ownerToken: "stale-owner",
      bootId,
      processStartTime: "1",
    }),
  );
  const lock = await ExclusiveFileLock.acquire(file, noHardLinks("ENOTSUP"));
  assert.notEqual(lock.owner.ownerToken, "stale-owner");
  lock.release();
});

test("other link failures are not mistaken for a filesystem without hard links", async () => {
  const file = join(root, "eacces.jsonl");
  await assert.rejects(ExclusiveFileLock.acquire(file, noHardLinks("EACCES")), /EACCES/);
});
