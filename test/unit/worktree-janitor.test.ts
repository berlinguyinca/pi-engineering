import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import {
  describeJanitorReport,
  parseWorktreeOwner,
  sweepWorktrees,
  worktreeIdleMs,
  worktreeLastActivity,
} from "../../src/git/worktreeJanitor.ts";
import { describeHousekeeping, missionOwnerLiveness, runHousekeeping } from "../../src/runtime/janitor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);
const HOUR = 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Push every activity probe of a worktree into the past. */
async function ageWorktree(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  const link = (await readFile(join(path, ".git"), "utf8")).trim().replace(/^gitdir:\s*/, "");
  for (const p of [path, join(path, ".git"), join(link, "index"), join(link, "HEAD"), join(link, "logs", "HEAD")]) {
    await utimes(p, then, then).catch(() => {});
  }
}

test("branch names identify their owning mission or task", () => {
  assert.deepEqual(parseWorktreeOwner("pi-eng-candidate-MSN-Z52ywV-repo-6f5f0bd085f1706c-1-0-EXC-fbX97S"), {
    missionId: "MSN-Z52ywV",
  });
  assert.deepEqual(parseWorktreeOwner("pi-eng-orch-TSK-Zg7Q8i"), { taskId: "TSK-Zg7Q8i" });
  assert.deepEqual(parseWorktreeOwner("feature/unrelated"), {});
  assert.deepEqual(parseWorktreeOwner(null), {});
  assert.equal(worktreeIdleMs({}), 24 * HOUR);
  assert.equal(worktreeIdleMs({ PI_WORKTREE_IDLE_HOURS: "2" }), 2 * HOUR);
  assert.equal(worktreeIdleMs({ PI_WORKTREE_IDLE_HOURS: "nonsense" }), 24 * HOUR);
});

test("mission liveness: live keeps, terminal reclaims, unknown defers to idleness", () => {
  const store = {
    getMission: (id: string) =>
      ({ "MSN-live": { status: "EXECUTING" }, "MSN-done": { status: "COMPLETE" }, "MSN-dead": { status: "FAILED" } })[
        id
      ] as { status: "EXECUTING" | "COMPLETE" | "FAILED" } | undefined,
    getTask: (id: string) => (id === "TSK-1" ? { mission_id: "MSN-live" } : undefined),
  };
  const liveness = missionOwnerLiveness(store);
  assert.equal(liveness({ missionId: "MSN-live" }), "live");
  assert.equal(liveness({ missionId: "MSN-done" }), "terminal");
  assert.equal(liveness({ missionId: "MSN-dead" }), "terminal");
  assert.equal(liveness({ missionId: "MSN-missing" }), "unknown");
  assert.equal(liveness({ taskId: "TSK-1" }), "live");
  assert.equal(liveness({ taskId: "TSK-404" }), "unknown");
  assert.equal(liveness({}), "unknown");
  assert.equal(missionOwnerLiveness(null)({ missionId: "MSN-live" }), "unknown");
});

test("terminal owner: worktree reclaimed, uncommitted work preserved on its branch, branch kept", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branch = "pi-eng-candidate-MSN-done01-repo-1-0-EXC-a";
    const wt = await repo.createWorktree(head, branch);
    await writeFile(join(wt.path, "src", "unsaved.js"), "export const unsaved = 1;\n");
    await writeFile(join(wt.path, "src", "add.js"), "export const add = (a, b) => a + b;\n");

    const report = await sweepWorktrees({
      repo,
      ownerLiveness: () => "terminal",
      maxIdleMs: 24 * HOUR,
    });
    assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
    assert.equal(report.failed.length, 0);
    const r = report.reclaimed[0]!;
    assert.equal(r.path, wt.path);
    assert.equal(r.branch, branch);
    assert.ok(r.preservedCommit, "uncommitted work must be committed before removal");
    assert.equal(await exists(wt.path), false, "checkout removed");
    assert.equal(
      await repo.resolveCommit(branch),
      r.preservedCommit,
      "branch kept and points at the preserving commit",
    );
    const { stdout } = await exec("git", ["-C", fixture.root, "show", "--stat", "--format=%s", r.preservedCommit]);
    assert.match(stdout, /preserve uncommitted work/);
    assert.match(stdout, /unsaved\.js/);
    assert.match(stdout, /add\.js/);
    assert.match(describeJanitorReport(report), /reclaimed 1 abandoned worktree.*1 with uncommitted work/);
  } finally {
    await fixture.cleanup();
  }
});

test("live owner is kept; unknown owner is kept while recently active and reclaimed once idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const live = await repo.createWorktree(head, "pi-eng-candidate-MSN-live01-repo-1-0-EXC-a");
    const fresh = await repo.createWorktree(head, "pi-eng-orch-TSK-fresh1");
    const stale = await repo.createWorktree(head, "pi-eng-orch-TSK-stale1");
    await ageWorktree(stale.path, 30 * HOUR);

    const liveness = (owner: { missionId?: string; taskId?: string }) =>
      owner.missionId === "MSN-live01" ? ("live" as const) : ("unknown" as const);
    const dry = await sweepWorktrees({ repo, ownerLiveness: liveness, maxIdleMs: 24 * HOUR, dryRun: true });
    assert.deepEqual(
      dry.reclaimed.map((r) => r.path),
      [stale.path],
    );
    assert.equal(await exists(stale.path), true, "dry run touches nothing");

    const report = await sweepWorktrees({ repo, ownerLiveness: liveness, maxIdleMs: 24 * HOUR });
    assert.deepEqual(
      report.reclaimed.map((r) => r.path),
      [stale.path],
    );
    assert.deepEqual(report.kept.map((k) => k.path).sort(), [live.path, fresh.path].sort());
    assert.match(report.kept.find((k) => k.path === live.path)!.reason, /live/);
    assert.match(report.kept.find((k) => k.path === fresh.path)!.reason, /active .* min ago/);
    assert.equal(await exists(stale.path), false);
    assert.equal(await exists(live.path), true);
    assert.equal(await exists(fresh.path), true);
    assert.equal(report.reclaimed[0]!.preservedCommit, null, "clean worktree needs no preserving commit");
    assert.ok(await repo.resolveCommit("pi-eng-orch-TSK-stale1"), "branch survives");
  } finally {
    await fixture.cleanup();
  }
});

test("only the runtime's own namespace is touched; foreign worktrees and siblings are ignored", async () => {
  const fixture = await makeFixtureRepo();
  const foreignDir = join(dirname(fixture.root), `${basename(fixture.root)}-manual`);
  const unrelatedSibling = join(dirname(fixture.root), `${basename(fixture.root)}-notes`);
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    await exec("git", ["-C", fixture.root, "worktree", "add", "-q", foreignDir, "-b", "manual-work", head]);
    await ageWorktree(foreignDir, 100 * HOUR);
    await mkdir(unrelatedSibling);
    const report = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(report.reclaimed.length, 0);
    assert.equal(report.kept.length, 0);
    assert.equal(await exists(foreignDir), true, "a hand-made worktree outside pi-eng-* is never touched");
    assert.equal(await exists(unrelatedSibling), true);
    assert.equal(await exists(fixture.root), true);
  } finally {
    await exec("git", ["-C", fixture.root, "worktree", "remove", "--force", foreignDir]).catch(() => {});
    await rm(unrelatedSibling, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a namespace directory git lost track of is kept while fresh and removed once idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const wt = await repo.createWorktree(head, "pi-eng-candidate-MSN-lost01-repo-1-0-EXC-a");
    // Lose the admin metadata the way `git worktree prune` after a move would.
    // Nothing in the directory is recoverable through git any more, so the
    // janitor must not trust the owner's terminal state alone: it waits for
    // the idle threshold before removing it.
    const link = (await readFile(join(wt.path, ".git"), "utf8")).trim().replace(/^gitdir:\s*/, "");
    await rm(link, { recursive: true, force: true });
    assert.equal((await repo.listLinkedWorktrees()).length, 0, "git no longer lists it");

    const fresh = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 24 * HOUR });
    assert.equal(fresh.reclaimed.length, 0);
    assert.equal(fresh.failed.length, 0, JSON.stringify(fresh.failed));
    assert.equal(fresh.kept.length, 1);
    assert.match(fresh.kept[0]!.reason, /no known owner; active/);
    assert.equal(await exists(wt.path), true);

    await ageWorktree(wt.path, 30 * HOUR);
    const idle = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 24 * HOUR });
    assert.equal(idle.reclaimed.length, 1);
    assert.equal(idle.reclaimed[0]!.branch, null);
    assert.equal(idle.reclaimed[0]!.preservedCommit, null);
    assert.match(idle.reclaimed[0]!.reason, /idle/);
    assert.equal(await exists(wt.path), false);
  } finally {
    await fixture.cleanup();
  }
});

test("runHousekeeping binds the mission store and reports only when something happened", async () => {
  const fixture = await makeFixtureRepo();
  const savedRoot = process.env.PI_RUST_CACHE_DIR;
  try {
    process.env.PI_RUST_CACHE_DIR = join(fixture.root, "rust-cache-unused");
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const done = await repo.createWorktree(head, "pi-eng-candidate-MSN-hk0001-repo-1-0-EXC-a");
    const live = await repo.createWorktree(head, "pi-eng-candidate-MSN-hk0002-repo-1-0-EXC-a");
    const missions = {
      getMission: (id: string) =>
        id === "MSN-hk0001"
          ? ({ status: "COMPLETE" } as const)
          : id === "MSN-hk0002"
            ? ({ status: "REVIEWING" } as const)
            : undefined,
      getTask: () => undefined,
    };
    const quiet = await runHousekeeping({ cwd: join(fixture.root, "src"), missions, dryRun: true });
    assert.equal(quiet.worktrees?.reclaimed.length, 1);
    const result = await runHousekeeping({ cwd: fixture.root, missions });
    assert.equal(await exists(done.path), false);
    assert.equal(await exists(live.path), true);
    assert.match(describeHousekeeping(result).join("\n"), /reclaimed 1 abandoned worktree/);
    const nothing = await runHousekeeping({ cwd: fixture.root, missions });
    assert.deepEqual(describeHousekeeping(nothing), [], "silence when there is nothing to report");
  } finally {
    if (savedRoot === undefined) delete process.env.PI_RUST_CACHE_DIR;
    else process.env.PI_RUST_CACHE_DIR = savedRoot;
    await fixture.cleanup();
  }
});

test("worktreeLastActivity reads the newest probe", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-orch-TSK-act001");
    await ageWorktree(wt.path, 50 * HOUR);
    const aged = await worktreeLastActivity(wt.path);
    assert.ok(Date.now() - aged > 49 * HOUR);
    await writeFile(join(wt.path, "touch.txt"), "x");
    await exec("git", ["-C", wt.path, "status", "--porcelain"]); // refreshes the index
    assert.ok(Date.now() - (await worktreeLastActivity(wt.path)) < HOUR);
  } finally {
    await fixture.cleanup();
  }
});
