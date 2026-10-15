/**
 * The HEAD watcher behind automatic hot reload (src/runtime/host/sourceWatch.ts):
 * a timer around an injected fingerprint, nothing else.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SourceWatcher, gitHead } from "../../src/runtime/host/sourceWatch.ts";

function watcher(opts: {
  values: Array<string | null>;
  baseline?: string | null;
  act?: (next: string, previous: string) => boolean;
}) {
  let i = 0;
  const changes: Array<[string, string]> = [];
  const w = new SourceWatcher({
    intervalMs: 5,
    ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
    fingerprint: async () => opts.values[Math.min(i++, opts.values.length - 1)] ?? null,
    onChange: (next, previous) => {
      changes.push([next, previous]);
      return opts.act ? opts.act(next, previous) : true;
    },
  });
  return { w, changes };
}

test("watcher: the first poll sets the baseline; a changed fingerprint fires once and advances it", async () => {
  const { w, changes } = watcher({ values: ["a", "a", "b", "b"] });
  await w.poll();
  assert.equal(w.current, "a");
  await w.poll();
  assert.deepEqual(changes, []);
  await w.poll();
  assert.deepEqual(changes, [["b", "a"]]);
  assert.equal(w.current, "b");
  await w.poll();
  assert.deepEqual(changes, [["b", "a"]], "no repeat for the same fingerprint");
  w.dispose();
});

test("watcher: a supplied baseline fires on the first poll that differs (the checkout moved before the session)", async () => {
  const { w, changes } = watcher({ values: ["b"], baseline: "a" });
  await w.poll();
  assert.deepEqual(changes, [["b", "a"]]);
  w.dispose();
});

test("watcher: onChange returning false keeps the baseline, so the change is retried next poll", async () => {
  let busy = true;
  const { w, changes } = watcher({ values: ["a", "b", "b", "b"], act: () => !busy });
  await w.poll();
  await w.poll();
  assert.equal(w.current, "a");
  assert.equal(changes.length, 1);
  busy = false;
  await w.poll();
  assert.equal(w.current, "b");
  assert.equal(changes.length, 2);
  w.dispose();
});

test("watcher: an unreadable fingerprint (null) is skipped, never a change", async () => {
  const { w, changes } = watcher({ values: ["a", null, "a"] });
  await w.poll();
  await w.poll();
  await w.poll();
  assert.deepEqual(changes, []);
  assert.equal(w.current, "a");
  w.dispose();
});

test("watcher: the timer polls on its own, is unref'd, and dispose stops it", async () => {
  const { w, changes } = watcher({ values: ["a", "b"] });
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  w.start();
  assert.equal(w.active, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(changes, [["b", "a"]]);
  w.dispose();
  assert.equal(w.active, false);
  // One more interval: nothing runs after dispose.
  await new Promise((r) => setTimeout(r, 20));
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before + 1, `timers leaked: ${before} → ${after}`);
});

test("watcher: a throwing fingerprint is reported, not thrown, and polling continues", async () => {
  const errors: unknown[] = [];
  let n = 0;
  const w = new SourceWatcher({
    intervalMs: 5,
    fingerprint: async () => {
      if (++n === 1) throw new Error("boom");
      return "a";
    },
    onChange: () => true,
    onError: (e) => errors.push(e),
  });
  await w.poll();
  assert.equal(errors.length, 1);
  await w.poll();
  assert.equal(w.current, "a");
  w.dispose();
});

test("gitHead: the checkout's HEAD, and null for a directory that is not one", async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-githead-"));
  try {
    assert.equal(await gitHead(root), null);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" })
        .toString()
        .trim();
    git("init", "-q");
    writeFileSync(join(root, "a.txt"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    const first = await gitHead(root);
    assert.match(first ?? "", /^[0-9a-f]{40}$/);
    writeFileSync(join(root, "a.txt"), "2\n");
    assert.equal(await gitHead(root), first, "an uncommitted edit does not move HEAD");
    git("add", "-A");
    git("commit", "-qm", "two");
    assert.notEqual(await gitHead(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
