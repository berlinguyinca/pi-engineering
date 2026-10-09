/**
 * The runtime's durable state directory (`.pi-eng/`) must survive ordinary git
 * operations run in the checkout it lives in.
 *
 * Observed in a live store: an implementer worker running in-place in a
 * worktree executed `git stash -u` / `git stash pop`. Because `.pi-eng/` was
 * untracked and not ignored, git swept it into the stash and recreated it with
 * umask-default modes and new inodes. The ArtifactStore then refused to open
 * (`ARTIFACT INTEGRITY: artifact root is writable by another user`, or `artifact
 * lock root identity changed` under umask 022), so every later
 * `EngineeringRuntime.open` for that checkout failed and the `mission` tool
 * reported "Orchestrator not initialized for this directory."
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });

test("runtime state survives `git stash -u` + `git stash pop` in its checkout and still opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-state-stash-"));
  try {
    await git(root, "init", "-q");
    await git(root, "commit", "--allow-empty", "-qm", "init");

    const first = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    assert.ok(first.orchestrator, "fresh runtime opens with an orchestrator");
    await first.close();

    // A worker's own untracked change, so the stash is never empty.
    await writeFile(join(root, "scratch.txt"), "wip\n");
    await git(root, "stash", "push", "-u", "-q", "-m", "worker wip");
    await git(root, "stash", "pop", "-q");

    const reopened = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    try {
      assert.ok(reopened.orchestrator, "runtime reopens after the stash round-trip");
    } finally {
      await reopened.close();
    }
    const { stdout } = await git(root, "status", "--porcelain", "--untracked-files=all");
    assert.doesNotMatch(stdout, /\.pi-eng/, "runtime state is invisible to git");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime state dir ignore marker is created once and an existing one is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-state-ignore-"));
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    await runtime.close();
    assert.equal(await readFile(join(root, ".pi-eng", ".gitignore"), "utf8"), "*\n");

    await writeFile(join(root, ".pi-eng", ".gitignore"), "# operator-owned\n*\n");
    const again = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    await again.close();
    assert.equal(await readFile(join(root, ".pi-eng", ".gitignore"), "utf8"), "# operator-owned\n*\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
