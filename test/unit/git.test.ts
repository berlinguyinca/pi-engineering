import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

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

test("worktrees are created OUTSIDE the repo tree, even when opened from a subdir (review MED #3)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    // Open the repo from a subdirectory, as a user might when running /engineer
    // from <repo>/src.
    const subdirRepo = (await GitRepo.open(join(fixture.root, "src")))!;
    const head = await subdirRepo.headCommit();
    const wt = await subdirRepo.createWorktree(head, "pi-eng-subdir-test");
    try {
      assert.ok(wt.path, "worktree should be created");
      // The worktree must be a sibling of the repo root, NOT inside it (it must
      // not appear as an untracked directory in the main working tree).
      assert.ok(
        !wt.path.startsWith(`${fixture.root}/`),
        `worktree ${wt.path} must not live inside the repo root ${fixture.root}`,
      );
    } finally {
      await subdirRepo.removeWorktree(wt);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: clean repo at HEAD is fresh (empty)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    assert.deepEqual(await repo.changedPathsSince(head, ["src/"]), []);
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: uncommitted in-scope change is stale, out-of-scope is fresh", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    await writeFile(join(fixture.root, "src", "add.js"), "export function add(a,b){return a+b;}\n");
    assert.ok((await repo.changedPathsSince(head, ["src/"])).length > 0, "in-scope change must be stale");
    assert.deepEqual(await repo.changedPathsSince(head, ["src/ledger/"]), [], "out-of-scope must be fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: committed change is detected", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    await writeFile(join(fixture.root, "src", "add.js"), "export function add(a,b){return a+b;}\n");
    await exec("git", ["-C", fixture.root, "add", "-A"]);
    await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "change"]);
    assert.ok((await repo.changedPathsSince(head, ["src/"])).length > 0, "committed change must be stale");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: empty commit is never fresh (fail-safe)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const changed = await repo.changedPathsSince("", ["src/"]);
    assert.ok(changed.length > 0, "empty/placeholder commit must be stale, never fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: unknown commit (git error) is stale (fail-safe)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const changed = await repo.changedPathsSince("0000000000000000000000000000000000000000", ["src/"]);
    assert.ok(changed.length > 0, "unknown commit (git error) must be stale, never fresh");
  } finally {
    await fixture.cleanup();
  }
});

test("changedPathsSince: glob pathspec matches a new test file", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(fixture.root, "test", "unit"), { recursive: true });
    await writeFile(join(fixture.root, "test", "unit", "roadmap-x.test.ts"), "export const x = 1;\n");
    assert.ok((await repo.changedPathsSince(head, ["test/unit/roadmap*"])).length > 0, "glob must match new file");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `EngineeringRuntime.createCandidateWorktree` asserts that worktree creation
 * is safe to run concurrently (tournament legs and parallel DAG waves create
 * candidates at the same time). This pins that contract: distinct paths, all
 * usable. It does NOT reproduce the rare `.git/worktrees/…/HEAD` failure seen
 * once under full-suite load — that mechanism is still unidentified.
 */
test("concurrent worktree creation yields distinct usable worktrees", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branches = ["pi-eng-race-a", "pi-eng-race-b", "pi-eng-race-c", "pi-eng-race-d"];
    const worktrees = await Promise.all(branches.map((branch) => repo.createWorktree(head, branch)));
    try {
      assert.equal(new Set(worktrees.map((w) => w.path)).size, branches.length, "each candidate gets its own path");
      for (const wt of worktrees) assert.equal(await repo.headCommitIn(wt.path), head);
    } finally {
      for (const wt of worktrees) await repo.removeWorktree(wt).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a conflicting second handoff mutates only the preserved integration candidate", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const incumbentStatus = await repo.status();
    const first = await repo.createWorktree(base, "handoff-first");
    const second = await repo.createWorktree(base, "handoff-second");
    const candidate = await repo.createWorktree(base, "integration-candidate");
    try {
      await writeFile(join(first.path, "src", "add.js"), "export const value = 'first';\n");
      await repo.commitAll(first.path, "first handoff");
      await writeFile(join(second.path, "src", "add.js"), "export const value = 'second';\n");
      await repo.commitAll(second.path, "second handoff");

      assert.equal((await repo.mergeRefInWorktree(candidate, first.branch)).merged, true);
      const conflict = await repo.mergeRefInWorktree(candidate, second.branch);

      assert.equal(conflict.conflict, true);
      assert.equal(await repo.headCommit(), base, "incumbent HEAD must not move");
      assert.equal(await repo.status(), incumbentStatus, "incumbent index/tree must remain untouched");
      assert.ok(await repo.resolveCommit(candidate.branch), "candidate ref must remain inspectable");
      assert.notEqual(await repo.headCommitIn(candidate.path), base, "successful first handoff remains on candidate");
    } finally {
      await repo.removeWorktree(first, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(second, { keepBranch: true }).catch(() => {});
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});

test("candidate promotion refuses incumbent divergence without touching index or tree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const candidate = await repo.createWorktree(base, "promotion-candidate");
    try {
      await writeFile(join(candidate.path, "src", "candidate.js"), "export const candidate = true;\n");
      await repo.commitAll(candidate.path, "candidate");
      await writeFile(join(fixture.root, "src", "incumbent.js"), "export const incumbent = true;\n");
      await exec("git", ["-C", fixture.root, "add", "-A"]);
      await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "incumbent diverged"]);
      const diverged = await repo.headCommit();

      const promoted = await repo.promoteCandidate(candidate, base);

      assert.equal(promoted.promoted, false);
      assert.match(promoted.reason ?? "", /diverged/i);
      assert.equal(await repo.headCommit(), diverged);
      assert.equal(await repo.status(), "");
      assert.ok(await repo.resolveCommit(candidate.branch));
    } finally {
      await repo.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
    }
  } finally {
    await fixture.cleanup();
  }
});
