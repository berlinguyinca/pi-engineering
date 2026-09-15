import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { WorkspaceFeeder, parseGitStatusShort } from "../../src/panel/feeders/WorkspaceFeeder.ts";

/** A GitRepo stand-in exposing only what the feeder reads. */
function fakeRepo(opts: { status: () => Promise<string>; branch?: string | null }): GitRepo {
  return {
    status: opts.status,
    currentBranch: async () => opts.branch ?? "main",
  } as unknown as GitRepo;
}

test("workspace feeder: parses git status --short into typed entries", () => {
  const entries = parseGitStatusShort(
    [" M src/a.ts", "A  src/b.ts", "?? notes.md", " D old.ts", 'R  "old name.ts" -> "new name.ts"', ""].join("\n"),
  );
  assert.deepEqual(entries, [
    { path: "src/a.ts", change: "modified" },
    { path: "src/b.ts", change: "added" },
    { path: "notes.md", change: "untracked" },
    { path: "old.ts", change: "deleted" },
    { path: "new name.ts", change: "renamed" },
  ]);
});

test("workspace feeder: empty status yields no entries", () => {
  assert.deepEqual(parseGitStatusShort(""), []);
  assert.deepEqual(parseGitStatusShort("\n\n"), []);
});

test("workspace feeder: publishes branch, files and context usage", async () => {
  const state = new PanelState();
  const feeder = new WorkspaceFeeder({
    state,
    repo: fakeRepo({ status: async () => " M README.md\n" }),
    now: () => 0,
    contextUsage: () => ({ tokens: 1200, percent: 12 }),
  });

  await feeder.refresh();

  assert.equal(state.snapshot.workspace?.branch, "main");
  assert.deepEqual(state.snapshot.workspace?.files, [{ path: "README.md", change: "modified" }]);
  assert.equal(state.snapshot.workspace?.contextTokens, 1200);
  assert.equal(state.snapshot.workspace?.contextPercent, 12);
});

test("workspace feeder: unknown context usage is omitted, not zeroed", async () => {
  const state = new PanelState();
  const feeder = new WorkspaceFeeder({
    state,
    repo: fakeRepo({ status: async () => "" }),
    now: () => 0,
    contextUsage: () => ({ tokens: null, percent: null }),
  });
  await feeder.refresh();
  assert.equal(state.snapshot.workspace?.contextTokens, undefined);
});

test("workspace feeder: git is not re-run inside the TTL", async () => {
  let calls = 0;
  const state = new PanelState();
  const repo = fakeRepo({
    status: async () => {
      calls++;
      return " M README.md\n";
    },
  });
  let now = 0;
  const feeder = new WorkspaceFeeder({ state, repo, now: () => now, ttlMs: 30_000 });

  await feeder.refresh();
  await feeder.refresh();
  assert.equal(calls, 1, "the second refresh must be served from cache");

  now = 31_000;
  await feeder.refresh();
  assert.equal(calls, 2, "an expired cache must re-read");

  feeder.invalidate();
  await feeder.refresh();
  assert.equal(calls, 3, "invalidate must force a re-read");
});

test("workspace feeder: a failing git marks the section and keeps the last good data", async () => {
  const state = new PanelState();
  let fail = false;
  const repo = fakeRepo({
    status: async () => {
      if (fail) throw new Error("git exploded");
      return " M README.md\n";
    },
  });
  const feeder = new WorkspaceFeeder({ state, repo, now: () => 0, ttlMs: 0 });

  await feeder.refresh();
  fail = true;
  await feeder.refresh();

  assert.match(state.snapshot.errors[0]?.message ?? "", /git exploded/);
  assert.deepEqual(
    state.snapshot.workspace?.files,
    [{ path: "README.md", change: "modified" }],
    "last good data survives",
  );
});

test("workspace feeder: a recovered read clears the error", async () => {
  const state = new PanelState();
  let fail = true;
  const repo = fakeRepo({
    status: async () => {
      if (fail) throw new Error("git exploded");
      return " M README.md\n";
    },
  });
  const feeder = new WorkspaceFeeder({ state, repo, now: () => 0, ttlMs: 0 });

  await feeder.refresh();
  assert.equal(state.snapshot.errors.length, 1);
  fail = false;
  await feeder.refresh();
  assert.deepEqual(state.snapshot.errors, []);
});

test("workspace feeder: outside a git repo there is no error, just no files", async () => {
  const state = new PanelState();
  const feeder = new WorkspaceFeeder({ state, repo: null, now: () => 0 });
  await feeder.refresh();
  assert.deepEqual(state.snapshot.workspace?.files, []);
  assert.deepEqual(state.snapshot.errors, []);
});

test("workspace feeder: refresh never rejects", async () => {
  const state = new PanelState();
  const repo = fakeRepo({
    status: async () => {
      throw new Error("boom");
    },
  });
  const feeder = new WorkspaceFeeder({ state, repo, now: () => 0, ttlMs: 0 });
  await assert.doesNotReject(() => feeder.refresh());
});
