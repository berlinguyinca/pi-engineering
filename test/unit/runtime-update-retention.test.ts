/**
 * Retention cleanup (spec §37): keep current, previous, the running version,
 * the newest N, and anything an incomplete journal references.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { UpdateJournal } from "../../src/update/journal.ts";
import { applyRetention } from "../../src/update/retention.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function installed(layout: InstallLayout, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `0.1.${i}`;
    const dir = layout.versionDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    await layout.writeMeta(dir, {
      id,
      version: id,
      commit: null,
      channel: "main",
      source: "t",
      installedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      runtimeApi: 1,
    });
    out.push(dir);
  }
  return out;
}

test("retention keeps current, previous, running, newest 3 and journal-referenced runtimes; removes the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-retention-"));
  dirs.push(root);
  const layout = new InstallLayout(root);
  const journal = new UpdateJournal(layout.journalFile);
  const v = await installed(layout, 8);
  await layout.setPointer("previous", v[0] as string);
  await layout.setPointer("current", v[1] as string);
  // An interrupted transaction names v2 (candidate) and its staging tree.
  const staging = join(layout.stagingDir, "update-abc");
  mkdirSync(staging, { recursive: true });
  const finished = join(layout.stagingDir, "update-old");
  mkdirSync(finished, { recursive: true });
  journal.begin({
    transaction: "update-abc",
    kind: "update",
    fromVersion: "0.1.1",
    fromCommit: null,
    toVersion: "0.1.2",
    toCommit: null,
    previousRuntime: v[1] as string,
    candidateRuntime: v[2] as string,
    pointers: { current: v[1] as string, previous: v[0] as string },
    phase: "activating",
  });
  for (let i = 0; i < 5; i++) {
    const cp = join(layout.checkpointsDir, `tx-${i}`);
    mkdirSync(cp, { recursive: true });
    utimesSync(cp, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
  }
  const removed = await applyRetention(layout, journal, { running: v[3] as string, keepVersions: 3 });
  const kept = v.filter((d) => existsSync(d));
  assert.deepEqual(
    kept.map((d) => d.split("/").pop()),
    ["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.5", "0.1.6", "0.1.7"],
    "previous, current, journal candidate, running, newest three",
  );
  assert.deepEqual(
    removed.versions.map((d) => d.split("/").pop()),
    ["0.1.4"],
  );
  assert.equal(existsSync(finished), true, "an incomplete transaction's staging area is not swept while it is open");
  assert.equal(removed.checkpoints.length, 2, "only the newest three checkpoints stay");

  // Once the transaction is finished its staging tree goes too.
  const rec = journal.read();
  assert.ok(rec && rec !== "corrupt");
  journal.advance(rec, "rolled_back");
  const second = await applyRetention(layout, journal, { running: v[3] as string });
  assert.ok(second.staging.includes(staging) && second.staging.includes(finished));
  assert.equal(existsSync(v[2] as string), false, "no longer referenced by an open transaction");
  assert.equal(existsSync(v[1] as string), true, "current is never removed");
});
