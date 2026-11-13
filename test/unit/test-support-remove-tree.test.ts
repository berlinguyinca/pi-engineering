/**
 * Teardown removal has to survive a straggler writer. A child that keeps creating entries
 * under a tree while the recursive unlink walks it makes POSIX `rmdir` return `ENOTEMPTY`,
 * which is what failed an entire integration file with no assertion failure (#681):
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/rt-host-entry-XXXX/home/.../.git'`.
 * `rm(..., { force: true })` covers `ENOENT`, not a race.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { removeTree } from "../support/removeTree.ts";

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "remove-tree-"));
  mkdirSync(join(root, "deep", "nested"), { recursive: true });
  writeFileSync(join(root, "deep", "nested", "file"), "content");
  return root;
}

describe("removeTree", () => {
  it("removes a tree while a real child process keeps writing entries into it", async () => {
    const root = sandbox();
    // A real writer, not a stub: entries appear for as long as the tree exists, so the
    // first unlink pass can meet a directory that refilled behind it.
    const child = spawn("sh", ["-c", 'for i in $(seq 1 400); do : > "$1/w-$i"; done', "sh", root], {
      stdio: "ignore",
    });
    try {
      const attempts = await removeTree(root);
      assert.ok(attempts >= 1, "removeTree reports how many passes it took");
      assert.equal(existsSync(root), false, "the tree is gone by the time removeTree returns");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("removes a quiet tree in one pass", async () => {
    const root = sandbox();
    assert.equal(await removeTree(root), 1);
    assert.equal(existsSync(root), false);
  });

  it("is a no-op when there is no root", async () => {
    assert.equal(await removeTree(""), 0);
  });

  it("spends exactly its budget on a tree that never stops refilling, then reports it", async () => {
    const root = sandbox();
    let passes = 0;
    try {
      await assert.rejects(
        () =>
          removeTree(root, {
            attempts: 3,
            delayMs: 1,
            // A straggler that never stops is indistinguishable, to the loop, from a removal
            // that can never succeed. Whether a real writer collides with the walk is not
            // forceable, so this is how the give-up branch gets tested deterministically.
            pass: async () => {
              passes++;
              throw Object.assign(new Error(`rmdir '${root}'`), { code: "ENOTEMPTY" });
            },
          }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /still present after 3 attempts/);
          assert.match(message, /ENOTEMPTY/);
          assert.match(message, /remaining: deep/, "what survived is named, not swallowed");
          assert.ok((err as Error).cause, "the original errno is preserved as the cause");
          return true;
        },
      );
      assert.equal(passes, 3, "exactly the budgeted number of passes, no more");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not burn the retry budget on an errno that retrying cannot fix", async () => {
    const root = sandbox();
    const started = Date.now();
    try {
      await assert.rejects(
        // force:false makes a missing path an ENOENT instead of a silent success, and no
        // number of retries conjures a directory that was never there.
        () => removeTree(join(root, "never-created"), { attempts: 50, delayMs: 50, force: false }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /after 1 attempt/);
          assert.match(message, /ENOENT/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 200, "gave up immediately rather than retrying 50 times");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
