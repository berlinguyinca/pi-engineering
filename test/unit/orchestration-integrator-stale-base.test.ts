import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo, type WorktreeInfo } from "../../src/git/GitRepo.ts";
import { Integrator } from "../../src/orchestration/integrator.ts";

const exec = promisify(execFile);
const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

/** Commit a change into a throwaway clone and push it to origin's default branch. */
async function advanceOrigin(origin: string, file: string, content: string, msg: string): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "pieng-int-advance-"));
  tempDirs.push(base);
  const work = join(base, "w");
  await exec("git", ["clone", "-q", origin, work]);
  await writeFile(join(work, file), content);
  await git(work, "add", file);
  await git(work, "commit", "-q", "-m", msg);
  const branch = (await git(work, "branch", "--show-current")) || "master";
  await git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  await rm(work, { recursive: true, force: true });
}

interface Fixture {
  origin: string;
  work: string;
  repo: GitRepo;
  branch: string;
  cleanup: () => Promise<void>;
}

/** Shared bare origin + one clone (the Integrator checkout), seeded at base X. */
async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pieng-int-fixture-"));
  tempDirs.push(base);
  const origin = join(base, "origin.git");
  await exec("git", ["init", "--bare", "-q", origin]);
  const work = join(base, "work");
  await exec("git", ["init", "-q", work]);
  await git(work, "config", "user.email", "test@e.com");
  await git(work, "config", "user.name", "Test");
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "a.js"), "export const a = 1;\n");
  await writeFile(join(work, "src", "b.js"), "export const b = 1;\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "base X");
  const branch = (await git(work, "branch", "--show-current")) || "master";
  await git(work, "remote", "add", "origin", origin);
  await git(work, "push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`);
  const repo = await GitRepo.open(work);
  assert.ok(repo);
  return { origin, work, repo, branch, cleanup: async () => rm(base, { recursive: true, force: true }) };
}

/** Create a local handoff branch in the clone and return its WorktreeInfo. */
async function makeHandoff(fx: Fixture, branch: string, file: string, content: string): Promise<{ worktree: WorktreeInfo }> {
  const { work } = fx;
  await git(work, "branch", branch, fx.branch);
  await git(work, "checkout", "-q", branch);
  await writeFile(join(work, file), content);
  await git(work, "add", file);
  await git(work, "commit", "-q", "-m", `handoff ${branch}`);
  await git(work, "checkout", "-q", fx.branch);
  return { worktree: { branch, path: work, name: branch } as WorktreeInfo };
}

describe("Integrator stale-base handling (spec 4.4 / R7)", () => {
  it("merges handoffs onto the current head, including unrelated remote advances", async () => {
    const fx = await fixture();
    const handoff = await makeHandoff(fx, "feat/a", "src/a.js", "export const a = 2;\n");
    // Remote head advances to X' touching a DIFFERENT file.
    await advanceOrigin(fx.origin, "src/c.js", "export const c = 1;\n", "advance unrelated c.js");
    const integrator = new Integrator(fx.repo);
    const outcome = await integrator.integrate({ objective: "i", baseCommit: "x", handoffs: [handoff] });
    assert.equal(outcome.exitStatus, "succeeded");
    // The merged origin head includes both the remote advance and the handoff.
    const remoteA = await git(fx.origin, "show", `${fx.branch}:src/a.js`).catch(() => "");
    const remoteC = await git(fx.origin, "show", `${fx.branch}:src/c.js`).catch(() => "");
    assert.ok(remoteA.includes("a = 2"), "handoff change published");
    assert.ok(remoteC.includes("c = 1"), "concurrent remote advance preserved");
  });

  it("reports a conflict when the current head changed the same lines, and publishes nothing", async () => {
    const fx = await fixture();
    // The remote advance touches the SAME lines the handoff will edit.
    await advanceOrigin(fx.origin, "src/a.js", "export const a = 99;\n", "concurrent a.js change");
    const handoff = await makeHandoff(fx, "feat/a", "src/a.js", "export const a = 2;\n");
    const integrator = new Integrator(fx.repo);
    const outcome = await integrator.integrate({ objective: "i", baseCommit: "x", handoffs: [handoff] });
    assert.equal(outcome.exitStatus, "conflict");
    assert.match(outcome.summary, /(merge conflict|conflict)/i);
    // Nothing was published to origin: the remote head still has the advance only.
    const remoteA = await git(fx.origin, "show", `${fx.branch}:src/a.js`).catch(() => "");
    assert.ok(remoteA.includes("a = 99"), "no partial publish of the conflicting handoff");
  });

  it("retries once on a push rejection caused by a remote advance between merge and push", async () => {
    const fx = await fixture();
    const handoff = await makeHandoff(fx, "feat/a", "src/a.js", "export const a = 2;\n");
    const logs: string[] = [];
    let advanced = false;
    const integrator = new Integrator(fx.repo, {
      log: async (message: string) => {
        logs.push(message);
        // Advance the remote the moment the integrator tries to publish.
        if (message.startsWith("push ") && !advanced) {
          advanced = true;
          await advanceOrigin(fx.origin, "src/d.js", "export const d = 1;\n", "advance d.js between merge and push");
        }
      },
    });
    const outcome = await integrator.integrate({ objective: "i", baseCommit: "x", handoffs: [handoff] });
    assert.equal(outcome.exitStatus, "succeeded");
    assert.ok(logs.includes("push-retry " + fx.branch), "push was retried once");
    const mergeAttempts = logs.filter((l) => l.startsWith("merge")).length;
    assert.ok(mergeAttempts >= 2, `expected at least two merge attempts, got ${mergeAttempts}: ${logs.join(", ")}`);
    const remoteD = await git(fx.origin, "show", `${fx.branch}:src/d.js`).catch(() => "");
    const remoteA = await git(fx.origin, "show", `${fx.branch}:src/a.js`).catch(() => "");
    assert.ok(remoteD.includes("d = 1"), "concurrent advance preserved through retry");
    assert.ok(remoteA.includes("a = 2"), "handoff published after retry");
  });
});
