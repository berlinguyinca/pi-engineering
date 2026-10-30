import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
async function ageTree(dir: string, then: Date): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await ageTree(full, then);
    await utimes(full, then, then).catch(() => {});
  }
}

async function ageWorktree(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  await ageTree(path, then);
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

test("mission liveness: live and FAILED keep, COMPLETE/CANCELED reclaim, unknown keeps", () => {
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
  assert.equal(liveness({ missionId: "MSN-dead" }), "live", "FAILED missions can be reopened: never terminal");
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

test("live owner is kept; a terminal owner is reclaimed once past the minimum age; ownerless is kept however idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const live = await repo.createWorktree(head, "pi-eng-candidate-MSN-live01-repo-1-0-EXC-a");
    const fresh = await repo.createWorktree(head, "pi-eng-candidate-MSN-fresh1-repo-1-0-EXC-a");
    const stale = await repo.createWorktree(head, "pi-eng-candidate-MSN-stale1-repo-1-0-EXC-a");
    const ownerless = await repo.createWorktree(head, "pi-eng-candidate-nostale1");
    await ageWorktree(stale.path, 30 * HOUR);
    await ageWorktree(ownerless.path, 300 * HOUR);

    const liveness = (owner: { missionId?: string; taskId?: string }) =>
      owner.missionId === "MSN-live01" ? ("live" as const) : ("terminal" as const);
    const dry = await sweepWorktrees({ repo, ownerLiveness: liveness, dryRun: true });
    assert.deepEqual(
      dry.reclaimed.map((r) => r.path),
      [stale.path],
    );
    assert.equal(await exists(stale.path), true, "dry run touches nothing");

    const report = await sweepWorktrees({ repo, ownerLiveness: liveness });
    assert.deepEqual(
      report.reclaimed.map((r) => r.path),
      [stale.path],
    );
    assert.deepEqual(report.kept.map((k) => k.path).sort(), [live.path, fresh.path, ownerless.path].sort());
    assert.match(report.kept.find((k) => k.path === live.path)!.reason, /live/);
    assert.match(report.kept.find((k) => k.path === fresh.path)!.reason, /active .* min ago/);
    assert.match(report.kept.find((k) => k.path === ownerless.path)!.reason, /no parsable mission\/task owner/);
    assert.equal(await exists(stale.path), false);
    assert.equal(await exists(ownerless.path), true);
    assert.equal(report.reclaimed[0]!.preservedCommit, null, "clean worktree needs no preserving commit");
    assert.ok(await repo.resolveCommit(stale.branch), "branch survives");
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

test("a namespace directory git lost track of is reported as a stray and never removed, however idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const head = await repo.headCommit();
    const wt = await repo.createWorktree(head, "pi-eng-candidate-MSN-lost01-repo-1-0-EXC-a");
    // Lose the admin metadata the way `git worktree prune` after a move would.
    const link = (await readFile(join(wt.path, ".git"), "utf8")).trim().replace(/^gitdir:\s*/, "");
    await rm(link, { recursive: true, force: true });
    assert.equal((await repo.listLinkedWorktrees()).length, 0, "git no longer lists it");
    await writeFile(join(wt.path, "unsaved.txt"), "only copy\n");
    await ageWorktree(wt.path, 30 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepWorktrees({ repo, ownerLiveness: () => "terminal", maxIdleMs: 24 * HOUR, dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /stray, not removed/);
      assert.equal(await readFile(join(wt.path, "unsaved.txt"), "utf8"), "only copy\n");
    }
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
      const ordinary = await repo.createWorktree(base, CAND("ordinary"));
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
      const report = await sweepWorktrees({ repo, ownerLiveness: terminal, now: () => Date.now() + 48 * HOUR });
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

// ---- Owner rule 2026-10-30: "we can't lose data due to sweeps" ----

const CAND = (n: string) => `pi-eng-candidate-MSN-${n}-repo-1-0-EXC-a`;
const terminal = () => "terminal" as const;
const sweepOld = (repo: GitRepo, extra: { dryRun?: boolean } = {}) =>
  sweepWorktrees({ repo, ownerLiveness: terminal, maxIdleMs: 24 * HOUR, ...extra });

test("housekeeping defaults to dry-run; only explicit 1/true/on/yes act, 0/false/off/no disable", () => {
  assert.equal(housekeepingMode({}), "dry-run");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "" }), "dry-run");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "  " }), "dry-run");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "dry-run" }), "dry-run");
  assert.equal(housekeepingMode({ PI_HOUSEKEEPING: "banana" }), "dry-run");
  for (const v of ["1", "true", "on", "yes", "ON", " Yes "]) {
    assert.equal(housekeepingMode({ PI_HOUSEKEEPING: v }), "on", v);
  }
  for (const v of ["0", "false", "off", "no", "OFF"]) {
    assert.equal(housekeepingMode({ PI_HOUSEKEEPING: v }), "off", v);
  }
});

test("an unregistered stray directory with files is never deleted, in dry-run or on mode, and is reported", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const stray = join(dirname(fixture.root), `${repo.worktreeNamespacePrefix()}stray-with-data`);
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "precious.txt"), "irreplaceable\n");
    await ageWorktree(stray, 100 * HOUR).catch(() => {});
    const then = new Date(Date.now() - 100 * HOUR);
    await utimes(stray, then, then);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.equal(report.failed.length, 0);
      const kept = report.kept.find((k) => k.path === stray);
      assert.ok(kept, "stray reported");
      assert.match(kept.reason, /stray, not removed/);
      assert.equal(await readFile(join(stray, "precious.txt"), "utf8"), "irreplaceable\n");
    }
    await rm(stray, { recursive: true, force: true });
  } finally {
    await fixture.cleanup();
  }
});

test("a worktree on a user branch is kept however long it has been idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("user01"));
    await exec("git", ["-C", wt.path, "checkout", "-q", "-b", "feature/x"]);
    await ageWorktree(wt.path, 10 * 24 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /user branch/);
      assert.equal(await exists(wt.path), true);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a detached unreachable HEAD in a pi-eng worktree is kept and reported", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("detach");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "only-here.txt"), "work\n");
    await exec("git", ["-C", wt.path, "add", "-A"]);
    await exec("git", ["-C", wt.path, "commit", "-qm", "unique work"]);
    const sha = (await exec("git", ["-C", wt.path, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", wt.path, "checkout", "-q", "--detach"]);
    await exec("git", ["-C", fixture.root, "branch", "-D", branch]);
    await ageWorktree(wt.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /detached/);
      assert.equal(await exists(wt.path), true);
    }
    await exec("git", ["-C", fixture.root, "cat-file", "-e", sha]);
  } finally {
    await fixture.cleanup();
  }
});

test("a worktree holding an ignored .env is kept; ignored derived dirs do not block", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    await writeFile(join(fixture.root, ".gitignore"), ".env\nnode_modules/\n");
    await exec("git", ["-C", fixture.root, "add", ".gitignore"]);
    await exec("git", ["-C", fixture.root, "commit", "-qm", "ignore"]);
    const secret = await repo.createWorktree(await repo.headCommit(), CAND("envs01"));
    const derived = await repo.createWorktree(await repo.headCommit(), CAND("deriv1"));
    await writeFile(join(secret.path, ".env"), "TOKEN=abc\n");
    await mkdir(join(derived.path, "node_modules", "x"), { recursive: true });
    await writeFile(join(derived.path, "node_modules", "x", "i.js"), "1\n");
    await ageWorktree(secret.path, 100 * HOUR);
    await ageWorktree(derived.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.deepEqual(
      report.reclaimed.map((r) => r.path),
      [derived.path],
      JSON.stringify(report),
    );
    assert.match(report.kept.find((k) => k.path === secret.path)!.reason, /ignored files.*\.env/);
    assert.equal(await readFile(join(secret.path, ".env"), "utf8"), "TOKEN=abc\n");
  } finally {
    await fixture.cleanup();
  }
});

test("an eligible clean pi-eng worktree is reclaimed in on mode only, and its branch survives", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("clean01");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await ageWorktree(wt.path, 100 * HOUR);
    const dry = await sweepOld(repo, { dryRun: true });
    assert.equal(dry.reclaimed.length, 1);
    assert.equal(await exists(wt.path), true, "dry run removes nothing");
    const on = await sweepOld(repo);
    assert.equal(on.reclaimed.length, 1);
    assert.equal(await exists(wt.path), false);
    assert.ok(await repo.resolveCommit(branch), "branch survives");
  } finally {
    await fixture.cleanup();
  }
});

test("untracked node_modules keeps the worktree before anything is committed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("nm0001");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "real-work.txt"), "keep me\n");
    await mkdir(join(wt.path, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(wt.path, "node_modules", "pkg", "index.js"), "x\n");
    await ageWorktree(wt.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /untracked derived folder/);
    }
    assert.equal(await repo.resolveCommit(branch), await repo.headCommit(), "no preserving commit was made");
    assert.equal(await readFile(join(wt.path, "real-work.txt"), "utf8"), "keep me\n");
  } finally {
    await fixture.cleanup();
  }
});

test("a locked worktree is left untouched in dry-run and on: no preserving commit, no removal", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("lock01");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "dirty.txt"), "uncommitted\n");
    await exec("git", ["-C", fixture.root, "worktree", "lock", wt.path]);
    await ageWorktree(wt.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /locked/);
    }
    assert.equal(await repo.resolveCommit(branch), await repo.headCommit(), "no preserving commit was made");
    assert.equal(await readFile(join(wt.path, "dirty.txt"), "utf8"), "uncommitted\n");
  } finally {
    await fixture.cleanup();
  }
});

async function commitFile(root: string, file: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
  await exec("git", ["-C", root, "add", "-f", file]);
  await exec("git", ["-C", root, "commit", "-qm", file]);
}

test("an ignored user file inside a tracked docs/dist folder keeps the worktree (not a derived folder)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "*.local\n");
    await commitFile(fixture.root, "docs/dist/README.md", "tracked\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("ign001"));
    await writeFile(join(wt.path, "docs/dist/notes.local"), "HUMAN DATA\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /ignored files.*notes\.local/);
    assert.equal(await readFile(join(wt.path, "docs/dist/notes.local"), "utf8"), "HUMAN DATA\n");
  } finally {
    await fixture.cleanup();
  }
});

test("an ignored FILE whose own name is a derived name keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "coverage\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("ign002"));
    await mkdir(join(wt.path, "notes"), { recursive: true });
    await writeFile(join(wt.path, "notes/coverage"), "HUMAN\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.equal(await readFile(join(wt.path, "notes/coverage"), "utf8"), "HUMAN\n");
  } finally {
    await fixture.cleanup();
  }
});

test("assume-unchanged and skip-worktree edits keep the worktree and are listed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const a = await repo.createWorktree(await repo.headCommit(), CAND("asm001"));
    const b = await repo.createWorktree(await repo.headCommit(), CAND("skp001"));
    await exec("git", ["-C", a.path, "update-index", "--assume-unchanged", "src/add.js"]);
    await writeFile(join(a.path, "src/add.js"), "HUMAN EDIT\n");
    await exec("git", ["-C", b.path, "update-index", "--skip-worktree", "src/add.js"]);
    await writeFile(join(b.path, "src/add.js"), "HUMAN EDIT 2\n");
    await ageWorktree(a.path, 100 * HOUR);
    await ageWorktree(b.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      for (const wt of [a, b]) assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /src\/add\.js/);
    }
    assert.equal(await readFile(join(a.path, "src/add.js"), "utf8"), "HUMAN EDIT\n");
    assert.equal(await readFile(join(b.path, "src/add.js"), "utf8"), "HUMAN EDIT 2\n");
  } finally {
    await fixture.cleanup();
  }
});

test("a detached HEAD whose only containing ref is refs/stash is still unreachable and kept", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("stash1");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "u.txt"), "u\n");
    await exec("git", ["-C", wt.path, "add", "-A"]);
    await exec("git", ["-C", wt.path, "commit", "-qm", "unique"]);
    const sha = (await exec("git", ["-C", wt.path, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", wt.path, "checkout", "-q", "--detach"]);
    await exec("git", ["-C", fixture.root, "branch", "-D", branch]);
    await writeFile(join(wt.path, "u.txt"), "stashme\n");
    await exec("git", ["-C", wt.path, "stash", "-q"]);
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /not reachable/);
    assert.equal(await exists(wt.path), true);
    await exec("git", ["-C", fixture.root, "cat-file", "-e", sha]);
  } finally {
    await fixture.cleanup();
  }
});

test("an owner-less pi-eng-candidate-mine branch with work is kept however idle, in every liveness", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), "pi-eng-candidate-mine");
    await writeFile(join(wt.path, "wip.txt"), "human wip\n");
    await ageWorktree(wt.path, 300 * HOUR);
    for (const liveness of ["unknown", "terminal"] as const) {
      const report = await sweepWorktrees({ repo, ownerLiveness: () => liveness, maxIdleMs: 24 * HOUR });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /no parsable mission\/task owner/);
    }
    assert.equal(await readFile(join(wt.path, "wip.txt"), "utf8"), "human wip\n");
  } finally {
    await fixture.cleanup();
  }
});

test("changes that remain after the preserve step keep the worktree (tracked edit inside dist/)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, "dist/out.js", "built\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("remain1");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "dist/out.js"), "HUMAN EDIT\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const dry = await sweepOld(repo, { dryRun: true });
    assert.equal(dry.reclaimed.length, 0, "dry-run must not over-report");
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
    assert.match(
      report.kept.find((k) => k.path === wt.path)!.reason,
      /changes would remain after the preserving commit/,
    );
    assert.equal(await readFile(join(wt.path, "dist/out.js"), "utf8"), "HUMAN EDIT\n");
  } finally {
    await fixture.cleanup();
  }
});

test("status.showUntrackedFiles=no in the repo config does not hide untracked work", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    await exec("git", ["-C", fixture.root, "config", "status.showUntrackedFiles", "no"]);
    const branch = CAND("unt001");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "untracked-human.txt"), "HUMAN\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    const preserved = (await exec("git", ["-C", fixture.root, "ls-tree", "-r", "--name-only", branch])).stdout;
    assert.ok(
      (await exists(join(wt.path, "untracked-human.txt"))) || /untracked-human\.txt/.test(preserved),
      JSON.stringify(report),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an initialized submodule keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  const sub = await makeFixtureRepo();
  try {
    await exec("git", [
      "-C",
      fixture.root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      sub.root,
      "sub",
    ]);
    await exec("git", ["-C", fixture.root, "commit", "-qm", "sub"]);
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("sub001"));
    await exec("git", ["-C", wt.path, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
    await writeFile(join(wt.path, "sub", "new.txt"), "HUMAN SUB NEW\n");
    await ageWorktree(wt.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /submodule/);
    }
    assert.equal(await readFile(join(wt.path, "sub", "new.txt"), "utf8"), "HUMAN SUB NEW\n");
  } finally {
    await fixture.cleanup();
    await sub.cleanup();
  }
});

// ---- Review round 2 ----

async function nestedRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q", dir]);
  await writeFile(join(dir, "x.txt"), "HUMAN COMMITTED\n");
  await exec("git", ["-C", dir, "add", "x.txt"]);
  await exec("git", ["-C", dir, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "unpushed"]);
}

test("an ignored root target/ holding a nested git repo keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "target/\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("n3aaaa"));
    await nestedRepo(join(wt.path, "target", "experiment"));
    await ageWorktree(wt.path, 100 * HOUR);
    for (const dryRun of [true, false]) {
      const report = await sweepOld(repo, { dryRun });
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /ignored files.*target/);
    }
    assert.equal(await exists(join(wt.path, "target", "experiment", ".git")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("a node_modules/ that is not itself ignored (only *.log inside is) keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "*.log\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("n5aaaa"));
    await mkdir(join(wt.path, "node_modules"), { recursive: true });
    await writeFile(join(wt.path, "node_modules", "debug.log"), "HUMAN LOG\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.equal(await readFile(join(wt.path, "node_modules", "debug.log"), "utf8"), "HUMAN LOG\n");
  } finally {
    await fixture.cleanup();
  }
});

test("derived means: ROOT-level, ignored itself, repo-free. A nested ignored dist/ keeps; a root ignored dist/ is reclaimed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "dist/\n");
    await commitFile(fixture.root, "pkg/keep.txt", "tracked\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const root = await repo.createWorktree(await repo.headCommit(), CAND("rootd1"));
    const nested = await repo.createWorktree(await repo.headCommit(), CAND("nestd1"));
    await mkdir(join(root.path, "dist"), { recursive: true });
    await writeFile(join(root.path, "dist", "bundle.js"), "built\n");
    await mkdir(join(nested.path, "pkg", "dist"), { recursive: true });
    await writeFile(join(nested.path, "pkg", "dist", "bundle.js"), "built?\n");
    await ageWorktree(root.path, 100 * HOUR);
    await ageWorktree(nested.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.deepEqual(
      report.reclaimed.map((r) => r.path),
      [root.path],
      JSON.stringify(report),
    );
    assert.equal(await exists(join(nested.path, "pkg", "dist", "bundle.js")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("an embedded git repository (untracked) keeps the worktree and is never staged as a gitlink", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("n4aaaa"));
    await nestedRepo(join(wt.path, "scratch"));
    await writeFile(join(wt.path, "scratch", "wip.txt"), "HUMAN WIP\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /embedded git repository/);
    assert.equal(await exists(join(wt.path, "scratch", "wip.txt")), true);
    const staged = (await exec("git", ["-C", wt.path, "diff", "--cached", "--name-only"])).stdout;
    assert.equal(staged.trim(), "", "a kept worktree's index is untouched");
  } finally {
    await fixture.cleanup();
  }
});

test("an ignored file created after the preserving commit (concurrent writer) keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, ".gitignore", "*.env\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("t1aaaa");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "dirty.txt"), "x\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const refFile = join(fixture.root, ".git", "refs", "heads", branch);
    const before = await readFile(refFile, "utf8");
    let wrote = false;
    let done = false;
    // A real concurrent writer: drops an ignored file the moment the preserving commit moves the branch.
    const writer = (async () => {
      while (!done && !wrote) {
        if ((await readFile(refFile, "utf8").catch(() => before)) !== before) {
          await writeFile(join(wt.path, "late.env"), "WRITTEN AFTER PLAN\n");
          wrote = true;
        }
      }
    })();
    const report = await sweepOld(repo).finally(() => {
      done = true;
    });
    await writer;
    assert.equal(wrote, true, "the writer must have raced the sweep");
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /ignored files.*late\.env/);
    assert.equal(await readFile(join(wt.path, "late.env"), "utf8"), "WRITTEN AFTER PLAN\n");
  } finally {
    await fixture.cleanup();
  }
});

test("dry-run matches the real run for a tracked edit inside dist/", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await commitFile(fixture.root, "dist/app.js", "orig\n");
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("n7aaaa"));
    await writeFile(join(wt.path, "dist/app.js"), "HUMAN EDIT\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const dry = await sweepOld(repo, { dryRun: true });
    const real = await sweepOld(repo);
    assert.equal(dry.reclaimed.length, real.reclaimed.length);
    assert.equal(real.reclaimed.length, 0);
    assert.equal(await readFile(join(wt.path, "dist/app.js"), "utf8"), "HUMAN EDIT\n");
    assert.equal((await exec("git", ["-C", wt.path, "diff", "--cached", "--name-only"])).stdout.trim(), "");
  } finally {
    await fixture.cleanup();
  }
});

test("an eligible dirty worktree is preserved through a temporary index and reclaimed", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("idx001");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "work.txt"), "w\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
    const files = (await exec("git", ["-C", fixture.root, "ls-tree", "-r", "--name-only", branch])).stdout;
    assert.match(files, /work\.txt/);
  } finally {
    await fixture.cleanup();
  }
});

test("a detached HEAD reachable only from a remote-tracking ref is kept", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const branch = CAND("remo01");
    const wt = await repo.createWorktree(await repo.headCommit(), branch);
    await writeFile(join(wt.path, "u.txt"), "u\n");
    await exec("git", ["-C", wt.path, "add", "-A"]);
    await exec("git", ["-C", wt.path, "commit", "-qm", "unique"]);
    await exec("git", ["-C", wt.path, "checkout", "-q", "--detach"]);
    await exec("git", ["-C", fixture.root, "update-ref", "refs/remotes/origin/feature", "HEAD"], {
      cwd: wt.path,
    }).catch(() => {});
    const sha = (await exec("git", ["-C", wt.path, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", fixture.root, "update-ref", "refs/remotes/origin/feature", sha]);
    await exec("git", ["-C", fixture.root, "branch", "-D", branch]);
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /not reachable/);
  } finally {
    await fixture.cleanup();
  }
});

test("recent activity deep in the tree (not just the top dir) keeps the worktree young", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await repo.createWorktree(await repo.headCommit(), CAND("act001"));
    await ageWorktree(wt.path, 100 * HOUR);
    assert.ok(Date.now() - (await worktreeLastActivity(wt.path)) > 99 * HOUR);
    await writeFile(join(wt.path, "src", "deep.txt"), "edited just now\n");
    assert.ok(Date.now() - (await worktreeLastActivity(wt.path)) < HOUR);
    const report = await sweepOld(repo);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /minimum age/);
  } finally {
    await fixture.cleanup();
  }
});

test("MSN-ext-/MSN-local- ids parse truncated, so they never match a real mission and stay kept", async () => {
  assert.deepEqual(parseWorktreeOwner("pi-eng-candidate-MSN-ext-0123456789abcdef0123-repo-1-0-EXC-a"), {
    missionId: "MSN-ext",
  });
  const mine = { getMission: () => undefined, getTask: () => undefined };
  assert.equal(missionOwnerLiveness(mine)({ missionId: "MSN-ext" }), "unknown");
});
