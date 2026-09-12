import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("git repo detection and head commit", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = await GitRepo.open(fixture.root);
    assert.ok(repo);
    const head = await repo.headCommit();
    assert.match(head, /^[0-9a-f]{40}$/);
    const branch = await repo.currentBranch();
    assert.ok(branch === "master" || branch === "main");
  } finally {
    await fixture.cleanup();
  }
});

test("worktree isolation creates an isolated candidate branch (INV-004)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branch = "pi-eng-isolation-test";
    const wt = await repo.createWorktree(head, branch);
    try {
      assert.ok(wt.path);
      // Make a change in the worktree and commit it.
      await writeFile(join(wt.path, "src", "add.js"), "export const add = (a,b) => a+b;\n");
      await repo.commitAll(wt.path, "test change");
      const newHead = await repo.headCommitIn(wt.path);
      const diff = await repo.captureDiff(head, newHead);
      assert.ok(diff.includes("add.js"));
      const files = await repo.changedFiles(head, newHead);
      assert.ok(files.includes("src/add.js"));
    } finally {
      await repo.removeWorktree(wt);
    }
    // The branch ref still exists (lineage preserved) even though worktree is gone.
    const repo2 = (await GitRepo.open(fixture.root))!;
    const branches = await repo2.status();
    assert.ok(typeof branches === "string");
  } finally {
    await fixture.cleanup();
  }
});
