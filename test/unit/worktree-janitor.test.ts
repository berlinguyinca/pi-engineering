import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { rustTargetDir } from "../../src/git/rustBuildCache.ts";
import {
  describeJanitorReport,
  parseWorktreeOwner,
  sweepWorktrees,
  worktreeIdleMs,
  worktreeLastActivity,
  worktreeMinAgeMs,
} from "../../src/git/worktreeJanitor.ts";
import {
  describeHousekeeping,
  housekeepingMode,
  missionOwnerLiveness,
  runHousekeeping,
} from "../../src/runtime/janitor.ts";
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
  const savedRoot = process.env.PI_RUST_CACHE_DIR;
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const branch = "pi-eng-candidate-MSN-done01-repo-1-0-EXC-a";
    const wt = await repo.createWorktree(head, branch);
    process.env.PI_RUST_CACHE_DIR = join(fixture.root, "rust-cache");
    const target = (await rustTargetDir(wt.path))!;
    await mkdir(join(target, "debug"), { recursive: true });
    await writeFile(join(wt.path, "src", "unsaved.js"), "export const unsaved = 1;\n");
    await writeFile(join(wt.path, "src", "add.js"), "export const add = (a, b) => a + b;\n");

    const report = await sweepWorktrees({
      repo,
      ownerLiveness: () => "terminal",
      maxIdleMs: 24 * HOUR,
      minAgeMs: 0,
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
    assert.equal(await exists(target), false, "the worktree's cargo target dir goes with it");
  } finally {
    if (savedRoot === undefined) delete process.env.PI_RUST_CACHE_DIR;
    else process.env.PI_RUST_CACHE_DIR = savedRoot;
    await fixture.cleanup();
  }
});

test("live owner is kept; unknown owner is kept while recently active and reclaimed once idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const live = await repo.createWorktree(head, "pi-eng-candidate-MSN-live01-repo-1-0-EXC-a");
    const fresh = await repo.createWorktree(head, "pi-eng-scratch-fresh1");
    const stale = await repo.createWorktree(head, "pi-eng-scratch-stale1");
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
    assert.ok(await repo.resolveCommit("pi-eng-scratch-stale1"), "branch survives");
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

    const fresh = await sweepWorktrees({
      repo,
      ownerLiveness: () => "terminal",
      maxIdleMs: 24 * HOUR,
      minAgeMs: 0,
    });
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
    await ageWorktree(done.path, 2 * HOUR);
    await ageWorktree(live.path, 2 * HOUR);
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

test("nothing younger than the minimum age is reclaimed, even for a terminal owner", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-candidate-MSN-young1-repo-1-0-EXC-a");
    const young = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(young.reclaimed.length, 0);
    assert.match(young.kept[0]!.reason, /minimum age/);
    assert.equal(await exists(wt.path), true);
    await ageWorktree(wt.path, 2 * HOUR);
    const old = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(old.reclaimed.length, 1);
    assert.equal(worktreeMinAgeMs({ PI_WORKTREE_MIN_AGE_HOURS: "0" }), HOUR, "cannot be lowered below the default");
    assert.equal(worktreeMinAgeMs({ PI_WORKTREE_MIN_AGE_HOURS: "6" }), 6 * HOUR);
  } finally {
    await fixture.cleanup();
  }
});

test("a worktree a durable candidate or cleanup record still references is never reclaimed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-candidate-MSN-rec001-repo-1-0-EXC-a");
    await ageWorktree(wt.path, 100 * HOUR);
    const common = (
      await exec("git", ["-C", fixture.root, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    const dir = join(common, "pi-engineering-candidates");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cleanup.record.json"),
      JSON.stringify({ missionId: "MSN-rec001", path: wt.path, branch: "x", state: "intent" }),
    );
    const kept = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(kept.reclaimed.length, 0);
    assert.match(kept.kept[0]!.reason, /durable mission record/);
    assert.equal(await exists(wt.path), true);
    await rm(join(dir, "cleanup.record.json"));
    const gone = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(gone.reclaimed.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a mission known only to another process is kept however long the worktree has been idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-candidate-MSN-other1-repo-1-0-EXC-a");
    await ageWorktree(wt.path, 100 * HOUR);
    // This process's store has never heard of MSN-other1 (a second pi process runs it).
    const mine = { getMission: () => undefined, getTask: () => undefined };
    const report = await sweepWorktrees({ repo, ownerLiveness: missionOwnerLiveness(mine), maxIdleMs: 24 * HOUR });
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept[0]!.reason, /not durably terminal/);
    assert.equal(await exists(wt.path), true);
    // Durable facts decide: parked in WAITING_FOR_LLM stays live, COMPLETE is terminal.
    const parked = missionOwnerLiveness(mine, { "MSN-other1": "WAITING_FOR_LLM" });
    assert.equal(parked({ missionId: "MSN-other1" }), "live");
    const done = missionOwnerLiveness(mine, { "MSN-other1": "COMPLETE" });
    assert.equal(done({ missionId: "MSN-other1" }), "terminal");
    const reclaimed = await sweepWorktrees({ repo, ownerLiveness: done, maxIdleMs: 24 * HOUR });
    assert.equal(reclaimed.reclaimed.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a quarantined durable record still protects its worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-candidate-MSN-quar01-repo-1-0-EXC-a");
    await ageWorktree(wt.path, 100 * HOUR);
    const common = (
      await exec("git", ["-C", fixture.root, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    const qdir = join(common, "pi-engineering-candidates", "quarantine");
    await mkdir(qdir, { recursive: true });
    await writeFile(join(qdir, "candidate.bad.json"), JSON.stringify({ path: wt.path }));
    assert.deepEqual([...(await repo.durablyReferencedWorktreePaths([wt.path]))], [wt.path]);
    const report = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(report.reclaimed.length, 0);
    assert.equal(await exists(wt.path), true);
  } finally {
    await fixture.cleanup();
  }
});

test("a path assertSafeWorktreePath refuses lands in report.failed, untouched", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    // A worktree whose basename is exactly the namespace prefix is not a candidate worktree.
    const odd = join(dirname(fixture.root), repo.worktreeNamespacePrefix());
    await exec("git", ["-C", fixture.root, "worktree", "add", "-q", odd, "-b", "pi-eng-candidate-MSN-odd001-x"]);
    await ageWorktree(odd, 100 * HOUR);
    const report = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 0 });
    assert.equal(report.reclaimed.length, 0);
    assert.equal(report.failed.length, 1, JSON.stringify(report));
    assert.match(report.failed[0]!.error, /refusing/);
    assert.equal(await exists(odd), true);
    await exec("git", ["-C", fixture.root, "worktree", "remove", "--force", odd]).catch(() => {});
  } finally {
    await fixture.cleanup();
  }
});

test("housekeeping is on by default; only 0 disables it and dry-run reports only", () => {
  assert.equal(housekeepingMode({}), "on");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "1" }), "on");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "0" }), "off");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "dry-run" }), "dry-run");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "yes" }), "on");
});

test("runHousekeeping aborts: a pre-aborted run rejects before touching git, an in-flight one leaves no child handles", async () => {
  const fixture = await makeFixtureRepo();
  const handles = () =>
    process.getActiveResourcesInfo().filter((r) => r === "Timeout" || r === "PipeWrap" || r === "ChildProcess");
  const before = handles().length;
  try {
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(runHousekeeping({ cwd: fixture.root, dryRun: true, signal: pre.signal }), /abort/i);

    const live = new AbortController();
    const run = runHousekeeping({ cwd: fixture.root, dryRun: true, signal: live.signal });
    live.abort();
    await assert.rejects(run, /abort/i);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(handles().length <= before, "no git child pipes or kill timers survive an aborted run");
  } finally {
    await fixture.cleanup();
  }
});

for (const metadata of ["registered", "pruned"] as const) {
  test(`aged ${metadata} planner-worker recovery output survives housekeeping while ordinary orphans are reclaimed`, async () => {
    const fixture = await makeFixtureRepo();
    try {
      const repo = (await GitRepo.open(fixture.root))!;
      await writeFile(join(fixture.root, ".gitignore"), "recover.txt\n");
      await exec("git", ["-C", fixture.root, "add", ".gitignore"]);
      await exec("git", ["-C", fixture.root, "commit", "-qm", "ignore recovery output"]);
      const base = await repo.headCommit();
      const worker = await repo.createWorktree(base, "pi-eng-pw-recovery-blocked");
      const ordinary = await repo.createWorktree(base, "pi-eng-scratch-orphan");
      const output = join(worker.path, "recover.txt");
      await writeFile(output, "ignored worker output remains recoverable\n");
      const stateDir = join(fixture.root, ".pi-eng", "planner-worker", "recovery");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "state.json"),
        JSON.stringify({
          status: "failed",
          unharvested_worktrees: [worker.path],
          retired_worktrees: [{ ...worker, base_commit: base }],
        }),
      );
      if (metadata === "pruned") {
        const admin = (await readFile(join(worker.path, ".git"), "utf8")).trim().replace(/^gitdir:\s*/, "");
        await rm(admin, { recursive: true });
        assert.equal(
          (await repo.listLinkedWorktrees()).some((wt) => wt.path === worker.path),
          false,
        );
      }
      const report = await sweepWorktrees({ repo, now: () => Date.now() + 48 * HOUR });
      assert.equal(await readFile(output, "utf8"), "ignored worker output remains recoverable\n");
      assert.ok(report.kept.some((wt) => wt.path === worker.path && /planner-worker.*recovery/i.test(wt.reason)));
      assert.deepEqual(
        report.reclaimed.map((wt) => wt.path),
        [ordinary.path],
      );
      assert.equal(await exists(ordinary.path), false);
      assert.equal(await repo.resolveCommit(worker.branch), base, "housekeeping leaves the recovery branch untouched");
      assert.equal(report.failed.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });
}
