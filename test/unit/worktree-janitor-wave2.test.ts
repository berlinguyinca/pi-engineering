import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { OWNER_MARKER_FILE } from "../../src/git/ownerMarker.ts";
import { sweepWorktrees } from "../../src/git/worktreeJanitor.ts";
import { describeAdoptPreview, gcPlan, runAdoptPreview, runTrashPurge } from "../../src/runtime/janitor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { ageWorktree, createOwned, exists, markerFile, tamperMarker } from "../support/janitorFixtures.ts";

const exec = promisify(execFile);
const HOUR = 60 * 60 * 1000;
const CAND = (n: string) => `pi-eng-candidate-MSN-${n}-repo-1-0-EXC-a`;
const gitDirOf = async (wtPath: string): Promise<string> =>
  (await exec("git", ["-C", wtPath, "rev-parse", "--absolute-git-dir"])).stdout.trim();

/** A sweep that treats every owner as terminal 50 h ago, with an isolated trash root. */
async function withTrash<T>(run: (trashRoot: string) => Promise<T>): Promise<T> {
  const trashRoot = join(await mkdtemp(join(tmpdir(), "pi-eng-trash-test-")), "trash");
  try {
    return await run(trashRoot);
  } finally {
    await rm(join(trashRoot, ".."), { recursive: true, force: true });
  }
}
const sweep = (
  repo: GitRepo,
  trashRoot: string,
  extra: Partial<Parameters<typeof sweepWorktrees>[0]> = {},
): ReturnType<typeof sweepWorktrees> =>
  sweepWorktrees({
    repo,
    ownerLiveness: () => "terminal",
    ownerTerminalAt: () => Date.now() - 50 * HOUR,
    trashRoot,
    ...extra,
  });

test("a worktree without an ownership marker is kept and reported, however idle", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("nomark"));
      await rm(join(await gitDirOf(wt.path), OWNER_MARKER_FILE), { force: true });
      await ageWorktree(wt.path, 100 * HOUR);
      for (const dryRun of [true, false]) {
        const report = await sweep(repo, trashRoot, { dryRun });
        assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
        assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /no ownership marker/);
      }
      assert.equal(await exists(wt.path), true);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a tampered or foreign ownership marker keeps the worktree, one case per failure class", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const cases: Array<[string, (path: string) => Promise<void>, RegExp]> = [
        ["notjson", async (p) => void (await writeFile(await markerFile(p), "{nope")), /invalid json/],
        ["creator", (p) => tamperMarker(p, { creator: "someone-else" }), /foreign creator/],
        ["version", (p) => tamperMarker(p, { version: 2 }), /unsupported version/],
        ["nover", (p) => tamperMarker(p, { version: undefined }), /unsupported version/],
        ["nocrea", (p) => tamperMarker(p, { createdAt: undefined }), /bad createdAt/],
        ["hash", (p) => tamperMarker(p, { repoRootHash: "zzzz" }), /repoRootHash/],
        ["sha", (p) => tamperMarker(p, { repoRootSha256: "0".repeat(64) }), /repoRootSha256/],
        ["nosha", (p) => tamperMarker(p, { repoRootSha256: undefined }), /bad repoRootSha256/],
        ["branch", (p) => tamperMarker(p, { branch: "some-other-branch" }), /branch mismatch/],
        ["nullbr", (p) => tamperMarker(p, { branch: null }), /branch mismatch/],
        [
          "dir",
          async (p) => {
            const file = await markerFile(p);
            await rm(file, { force: true });
            await mkdir(file);
          },
          /not a regular file/,
        ],
        [
          "sibling",
          async (p) => {
            // Copy the marker of ANOTHER worktree of the same repository (a different branch).
            const sibling = await createOwned(repo, await repo.headCommit(), CAND("sibl-src"));
            await copyFile(await markerFile(sibling.path), await markerFile(p));
          },
          /branch mismatch/,
        ],
      ];
      const made: Array<{ wt: { path: string }; why: RegExp; name: string }> = [];
      for (const [name, tamper, why] of cases) {
        const wt = await createOwned(repo, await repo.headCommit(), CAND(name));
        await tamper(wt.path);
        await ageWorktree(wt.path, 100 * HOUR);
        made.push({ wt, why, name });
      }
      const report = await sweep(repo, trashRoot);
      for (const { wt, why, name } of made) {
        const kept = report.kept.find((k) => k.path === wt.path);
        assert.ok(kept, `${name}: ${JSON.stringify(report)}`);
        assert.match(kept.reason, why, name);
        assert.equal(await exists(wt.path), true, name);
      }
      assert.deepEqual(
        report.reclaimed.filter((r) => made.some((m) => m.wt.path === r.path)),
        [],
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("end to end: a worktree made by createWorktree is accepted and trashed; unmarked is kept", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const good = await repo.createWorktree(await repo.headCommit(), CAND("e2e001"));
      const bare = await repo.createWorktree(await repo.headCommit(), CAND("e2e002"));
      await rm(await markerFile(bare.path), { force: true });
      for (const wt of [good, bare]) await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      assert.deepEqual(
        report.reclaimed.map((r) => r.path),
        [good.path],
        JSON.stringify(report),
      );
      assert.equal(await exists(good.path), false);
      assert.match(report.kept.find((k) => k.path === bare.path)!.reason, /no ownership marker/);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("an eligible worktree is MOVED to <trash>/<ts>/<name>, never deleted; its registration is pruned and its branch kept", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const branch = CAND("trash1");
      const wt = await createOwned(repo, await repo.headCommit(), branch);
      await writeFile(join(wt.path, "src", "unsaved.js"), "export const unsaved = 1;\n");
      await ageWorktree(wt.path, 100 * HOUR);
      const dry = await sweep(repo, trashRoot, { dryRun: true });
      assert.equal(dry.reclaimed[0]?.trashedTo, null);
      assert.equal(await exists(trashRoot), false, "a preview creates no trash");
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
      const r = report.reclaimed[0]!;
      assert.equal(await exists(wt.path), false, "original path vacated");
      const [entry] = (await readdir(trashRoot)).filter((e) => !e.startsWith(".pi-eng-trash-root"));
      assert.ok(entry, "one trash entry");
      assert.equal(r.trashedTo, join(trashRoot, entry, basename(wt.path)));
      const marker = JSON.parse(await readFile(join(trashRoot, entry, ".pi-eng-trash.json"), "utf8"));
      assert.equal(marker.creator, "pi-engineering");
      assert.equal(marker.kind, "worktree");
      assert.equal(marker.items[0].from.endsWith(basename(wt.path)) || marker.items[0].from.includes("reclaim-"), true);
      assert.equal(
        await readFile(join(r.trashedTo!, "src", "add.js"), "utf8").then(Boolean),
        true,
        "files survive in the trash",
      );
      const { stdout: show } = await exec("git", [
        "-C",
        fixture.root,
        "show",
        "--stat",
        "--format=%s",
        r.preservedCommit!,
      ]);
      assert.match(show, /unsaved\.js/, "uncommitted work is on the branch");
      const { stdout: listed } = await exec("git", ["-C", fixture.root, "worktree", "list", "--porcelain"]);
      assert.doesNotMatch(listed, /trash1/, "registration pruned");
      assert.ok(await repo.resolveCommit(branch), "branch survives");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("only the reclaimed worktree's own admin dir is removed: another registered worktree whose .git file is missing survives intact", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      // Looks like an unmounted disk: the directory exists (empty mount point) but its .git file does not.
      const other = await createOwned(repo, await repo.headCommit(), CAND("mount1"));
      await writeFile(join(other.path, "src", "staged-only.js"), "STAGED ONLY\n");
      await exec("git", ["-C", other.path, "add", "src/staged-only.js"]);
      const otherAdmin = await gitDirOf(other.path);
      const indexBefore = await readFile(join(otherAdmin, "index"));
      await rm(join(other.path, ".git"));
      const wt = await createOwned(repo, await repo.headCommit(), CAND("trash2"));
      await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      const r = report.reclaimed.find((x) => x.path === wt.path);
      assert.ok(r, JSON.stringify(report));
      assert.equal(await exists(otherAdmin), true, "the other worktree's admin dir must survive");
      assert.deepEqual(await readFile(join(otherAdmin, "index")), indexBefore, "its staged-only index survives");
      assert.equal(await exists(await gitDirOf(wt.path).catch(() => "/nonexistent")), false);
      const { stdout } = await exec("git", ["-C", fixture.root, "worktree", "list", "--porcelain"]);
      assert.doesNotMatch(stdout, /trash2/, "our own registration is gone");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a suffixed admin name (<leaf>1) is matched by path, not by name", async () => {
  const fixture = await makeFixtureRepo();
  const elsewhere = await mkdtemp(join(tmpdir(), "pi-eng-leaf-"));
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const branch = CAND("suffx1");
      const leaf = basename(join(dirname(fixture.root), `${repo.worktreeNamespacePrefix()}${branch}`));
      const wt = await createOwned(repo, await repo.headCommit(), branch);
      // Give ours a suffixed admin name, then let a foreign worktree with the same leaf take the plain one.
      const plain = await gitDirOf(wt.path);
      const ours = `${plain}1`;
      await rename(plain, ours);
      await writeFile(join(wt.path, ".git"), `gitdir: ${ours}\n`);
      await writeFile(join(ours, "gitdir"), `${join(wt.path, ".git")}\n`);
      const foreign = join(elsewhere, leaf);
      await exec("git", ["-C", fixture.root, "worktree", "add", "-q", "-b", "foreign-branch", foreign]);
      assert.equal(basename(await gitDirOf(foreign)), leaf, "the foreign worktree took the plain admin name");
      const foreignAdmin = await gitDirOf(foreign);
      await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
      assert.equal(await exists(ours), false, "our suffixed admin dir left the repository");
      const entry = dirname(report.reclaimed[0]!.trashedTo!);
      assert.equal(await exists(join(entry, ".pi-eng-admin", "gitdir")), true, "it was moved into the trash entry");
      assert.equal(await exists(foreignAdmin), true, "the same-leaf foreign admin dir untouched");
    });
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a trash on another filesystem keeps the worktree (rename cannot cross devices) and moves it back", async (t) => {
  const here = (await stat(tmpdir())).dev;
  const shm = await stat("/dev/shm").catch(() => null);
  if (!shm || shm.dev === here) return t.skip("no second filesystem available");
  const fixture = await makeFixtureRepo();
  const trashRoot = await mkdtemp("/dev/shm/pi-eng-xdev-");
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await createOwned(repo, await repo.headCommit(), CAND("xdev01"));
    await writeFile(join(wt.path, "src", "unsaved.js"), "keep me\n");
    await ageWorktree(wt.path, 100 * HOUR);
    const report = await sweep(repo, trashRoot);
    assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
    assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /different filesystem.*PI_TRASH_DIR/);
    assert.equal(await exists(wt.path), true, "moved back to its original path");
    assert.deepEqual(
      (await readdir(trashRoot)).filter((e) => e !== ".pi-eng-trash-root"),
      [],
      "no empty trash entry left behind",
    );
  } finally {
    await rm(trashRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

async function ignoreDerived(root: string): Promise<void> {
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
  await exec("git", ["-C", root, "add", ".gitignore"]);
  await exec("git", ["-C", root, "commit", "-qm", "ignore derived"]);
}

test("N2: derived folders with files newer than the mission's terminal timestamp keep the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      await ignoreDerived(fixture.root);
      const repo = (await GitRepo.open(fixture.root))!;
      const used = await createOwned(repo, await repo.headCommit(), CAND("n2used"));
      const idle = await createOwned(repo, await repo.headCommit(), CAND("n2idle"));
      for (const wt of [used, idle]) {
        await mkdir(join(wt.path, "dist"), { recursive: true });
        await writeFile(join(wt.path, "dist", "bundle.js"), "x\n");
        await ageWorktree(wt.path, 100 * HOUR);
      }
      // `used`: its mission ended 200 h ago, but dist/ was written 100 h ago -> used after the end.
      const report = await sweep(repo, trashRoot, {
        ownerTerminalAt: (o) => Date.now() - (o.missionId === "MSN-n2used" ? 200 : 50) * HOUR,
      });
      assert.deepEqual(
        report.reclaimed.map((r) => r.path),
        [idle.path],
        JSON.stringify(report),
      );
      assert.match(
        report.kept.find((k) => k.path === used.path)!.reason,
        /dist\/ holds files newer than the mission's terminal timestamp/,
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("N2: derived folders present and no durable terminal timestamp keep the worktree; none present does not", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      await ignoreDerived(fixture.root);
      const repo = (await GitRepo.open(fixture.root))!;
      const withDist = await createOwned(repo, await repo.headCommit(), CAND("n2nots"));
      const bare = await createOwned(repo, await repo.headCommit(), CAND("n2bare"));
      await mkdir(join(withDist.path, "dist"), { recursive: true });
      await writeFile(join(withDist.path, "dist", "bundle.js"), "x\n");
      for (const wt of [withDist, bare]) await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot, { ownerTerminalAt: () => null });
      assert.deepEqual(
        report.reclaimed.map((r) => r.path),
        [bare.path],
        JSON.stringify(report),
      );
      assert.match(report.kept.find((k) => k.path === withDist.path)!.reason, /no durable terminal timestamp/);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("an unreadable directory under the worktree is named in the keep reason", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read everything");
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("unrd01"));
      const sub = join(wt.path, "src");
      await ageWorktree(wt.path, 100 * HOUR);
      await chmod(sub, 0o000);
      try {
        const report = await sweep(repo, trashRoot);
        assert.equal(report.reclaimed.length, 0);
        assert.match(
          report.kept.find((k) => k.path === wt.path)!.reason,
          new RegExp(`unreadable directory under ${sub}`),
        );
      } finally {
        await chmod(sub, 0o755);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("an unreadable index keeps the worktree instead of passing it", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read everything");
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("idx001"));
      const index = join(await gitDirOf(wt.path), "index");
      await ageWorktree(wt.path, 100 * HOUR);
      await chmod(index, 0o000);
      try {
        const report = await sweep(repo, trashRoot);
        assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
        assert.equal(await exists(wt.path), true);
        assert.ok(report.kept.find((k) => k.path === wt.path) ?? report.failed.find((f) => f.path === wt.path));
      } finally {
        await chmod(index, 0o644);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a dangling-symlink submodule .git counts as present (lstat, not stat)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("dang01"));
      const head = await repo.headCommit();
      await exec("git", ["-C", wt.path, "update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
      await mkdir(join(wt.path, "sub"));
      await symlink("/nonexistent/gitdir", join(wt.path, "sub", ".git"));
      await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /initialized submodule/);
      assert.equal(await exists(wt.path), true);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("/gc argument parsing: purge needs --apply, --older-than defaults to 14 and rejects < 7, unknown tokens preview", () => {
  assert.deepEqual(gcPlan("--purge-trash"), {
    dryRun: true,
    purge: { olderThanDays: 14 },
    note: "purging trash needs --apply; listing what it would purge",
  });
  assert.deepEqual(gcPlan("--purge-trash --apply"), {
    dryRun: false,
    purge: { olderThanDays: 14 },
  });
  assert.deepEqual(gcPlan("--purge-trash --older-than 30 --apply"), {
    dryRun: false,
    purge: { olderThanDays: 30 },
  });
  assert.deepEqual(gcPlan("--apply --purge-trash --older-than=7"), {
    dryRun: false,
    purge: { olderThanDays: 7 },
  });
  for (const bad of [
    "--purge-trash --older-than 3 --apply",
    "--purge-trash --older-than --apply",
    "--purge-trash --older-than x --apply",
  ]) {
    const plan = gcPlan(bad);
    assert.equal(plan.dryRun, true, bad);
    assert.equal(plan.purge, undefined, bad);
    assert.match(plan.note ?? "", /at least 7 days/, bad);
  }
  assert.match(gcPlan("--older-than 30 --apply").note ?? "", /only applies to --purge-trash/);
  assert.equal(gcPlan("--older-than 30 --apply").dryRun, true);
  assert.match(gcPlan("--purge-trash --bogus --apply").note ?? "", /unknown argument.*--bogus/);
  assert.equal(gcPlan("--purge-trash --bogus --apply").purge, undefined);
  for (const bad of ["--apply --older-than=30", "--apply --older-than 30", "--older-than=30"]) {
    const plan = gcPlan(bad);
    assert.equal(plan.dryRun, true, bad);
    assert.equal(plan.purge, undefined, bad);
    assert.match(plan.note ?? "", /only applies to --purge-trash/, bad);
  }
  for (const flag of ["--purge-trash --include-unmarked --apply", "--include-unmarked --apply"]) {
    const plan = gcPlan(flag);
    assert.equal(plan.dryRun, true, flag);
    assert.equal(plan.purge, undefined, flag);
    assert.match(plan.note ?? "", /unknown argument.*--include-unmarked/, flag);
  }
  assert.deepEqual(gcPlan("--adopt-preview"), { dryRun: true, adoptPreview: true });
  for (const bad of ["--adopt-preview --apply", "--adopt-preview --purge-trash"]) {
    assert.equal(gcPlan(bad).adoptPreview, undefined, bad);
    assert.match(gcPlan(bad).note ?? "", /read-only listing/, bad);
  }
  assert.deepEqual(gcPlan("--apply"), { dryRun: false });
  assert.equal(gcPlan("--purge-trash --apply --dry-run").dryRun, true);
});

test("secrets and nested repositories under an ignored target/ keep the worktree; node_modules may hold .env files", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      await writeFile(join(fixture.root, ".gitignore"), "node_modules/\ntarget/\n");
      await exec("git", ["-C", fixture.root, "add", ".gitignore"]);
      await exec("git", ["-C", fixture.root, "commit", "-qm", "ignore"]);
      const repo = (await GitRepo.open(fixture.root))!;
      const env = await createOwned(repo, await repo.headCommit(), CAND("sec001"));
      const key = await createOwned(repo, await repo.headCommit(), CAND("sec002"));
      const bareRepo = await createOwned(repo, await repo.headCommit(), CAND("sec003"));
      const nm = await createOwned(repo, await repo.headCommit(), CAND("sec004"));
      await mkdir(join(env.path, "target", "debug"), { recursive: true });
      await writeFile(join(env.path, "target", "debug", ".env"), "TOKEN=1\n");
      await mkdir(join(key.path, "target"), { recursive: true });
      await writeFile(join(key.path, "target", "id_rsa"), "PRIVATE\n");
      await exec("git", ["init", "-q", "--bare", join(bareRepo.path, "target", "mirror.git")]);
      await mkdir(join(nm.path, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(nm.path, "node_modules", "pkg", ".env.example"), "X=1\n");
      for (const wt of [env, key, bareRepo, nm]) await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      assert.deepEqual(
        report.reclaimed.map((r) => r.path),
        [nm.path],
        JSON.stringify(report),
      );
      for (const wt of [env, key, bareRepo]) {
        assert.match(report.kept.find((k) => k.path === wt.path)!.reason, /ignored files present.*target/, wt.path);
        assert.equal(await exists(wt.path), true);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a symlinked ownership marker is never trusted: git itself refuses the repository, so the sweep fails closed and touches nothing", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("symlk1"));
      const file = await markerFile(wt.path);
      await rename(file, `${file}.real`);
      await symlink(`${file}.real`, file);
      await ageWorktree(wt.path, 100 * HOUR);
      await assert.rejects(sweep(repo, trashRoot), /symbolic link/);
      assert.equal(await exists(wt.path), true);
      assert.equal(await exists(trashRoot), false);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("/gc --adopt-preview lists unmarked worktrees with the manual command, and writes nothing", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const eligible = await createOwned(repo, await repo.headCommit(), CAND("adpt01"));
    const dirty = await createOwned(repo, await repo.headCommit(), CAND("adpt02"));
    const live = await createOwned(repo, await repo.headCommit(), CAND("adpt03"));
    const marked = await createOwned(repo, await repo.headCommit(), CAND("adpt04"));
    for (const wt of [eligible, dirty, live]) await rm(await markerFile(wt.path), { force: true });
    await writeFile(join(dirty.path, "src", "edited.js"), "work\n");
    for (const wt of [eligible, dirty, live, marked]) await ageWorktree(wt.path, 100 * HOUR);
    const before = await Promise.all(
      [eligible, dirty, live].map(async (wt) => [await markerFile(wt.path), await exists(wt.path)] as const),
    );
    const { execFile: ef } = await import("node:child_process");
    const snapshot = async () =>
      (await promisify(ef)("git", ["-C", fixture.root, "status", "--porcelain=v2", "--branch"])).stdout +
      (await promisify(ef)("git", ["-C", fixture.root, "worktree", "list", "--porcelain"])).stdout;
    const gitBefore = await snapshot();
    const missions = {
      getMission: (id: string) => ({ status: id === "MSN-adpt03" ? ("EXECUTING" as const) : ("COMPLETE" as const) }),
      getTask: () => undefined,
    };
    const preview = await runAdoptPreview({ cwd: fixture.root, missions });
    const byPath = Object.fromEntries(preview.worktrees.map((w) => [w.path, w]));
    assert.equal(preview.worktrees.length, 3, "the marked worktree is not an adoption candidate");
    assert.match(byPath[eligible.path]!.command ?? "", /worktree remove/);
    assert.doesNotMatch(byPath[eligible.path]!.command ?? "", /--force/);
    assert.equal(byPath[eligible.path]!.clean, true);
    assert.equal(byPath[dirty.path]!.command, null);
    assert.equal(byPath[dirty.path]!.clean, false);
    assert.match(byPath[dirty.path]!.note, /uncommitted changes/);
    assert.equal(byPath[live.path]!.command, null);
    assert.match(byPath[live.path]!.note, /owner is live/);
    assert.match(describeAdoptPreview(preview).join("\n"), /Read-only: nothing was changed/);
    assert.equal(await snapshot(), gitBefore, "no git state changed");
    assert.deepEqual(
      await Promise.all(
        [eligible, dirty, live].map(async (wt) => [await markerFile(wt.path), await exists(wt.path)] as const),
      ),
      before,
    );
    for (const wt of [eligible, dirty, live])
      assert.equal(await exists(await markerFile(wt.path)), false, "no marker written");
  } finally {
    await fixture.cleanup();
  }
});

// Ports of the reviewer's W1/W2/W3/Q1/Q2 repros. They used to gate `git worktree remove`; a sweep no longer removes
// anything, so the window that matters now is the quarantine `git worktree move`: a late writer either lands before it
// (the janitor's re-check sees a changed tree and moves the checkout back) or follows the checkout (cwd-inside writers
// follow the inode) into the trash. Either way the file must still exist somewhere on disk.
const LATE_WRITERS: Array<{ name: string; ignore: string; rel: string; cwdInside: boolean; seed?: string }> = [
  { name: "W1 ignored file via original path", ignore: "*.env\n", rel: "late.env", cwdInside: false },
  { name: "W2 untracked file via original path", ignore: "", rel: "late.txt", cwdInside: false },
  {
    name: "W3 file in an ignored root dist/",
    ignore: "dist/\n",
    rel: "dist/notes.md",
    cwdInside: false,
    seed: "dist/app.js",
  },
  { name: "Q1 cwd-inside writer, ignored file", ignore: "*.env\n", rel: "late2.env", cwdInside: true },
  { name: "Q2 cwd-inside writer, untracked file", ignore: "", rel: "late2.txt", cwdInside: true },
];
for (const sc of LATE_WRITERS) {
  test(`late writer ${sc.name}: the file survives (kept in place or carried into the trash)`, async () => {
    const fixture = await makeFixtureRepo();
    const gate = await mkdtemp(join(tmpdir(), "pi-eng-gate-"));
    const savedPath = process.env.PATH;
    try {
      await withTrash(async (trashRoot) => {
        if (sc.ignore) {
          await writeFile(join(fixture.root, ".gitignore"), sc.ignore);
          await exec("git", ["-C", fixture.root, "add", ".gitignore"]);
          await exec("git", ["-C", fixture.root, "commit", "-qm", "ignore"]);
        }
        const repo = (await GitRepo.open(fixture.root))!;
        const wt = await createOwned(
          repo,
          await repo.headCommit(),
          CAND(`lw${sc.rel.length}${sc.cwdInside ? "c" : "p"}`),
        );
        await writeFile(join(wt.path, "dirty.txt"), "x\n");
        if (sc.seed) {
          await mkdir(join(wt.path, "dist"));
          await writeFile(join(wt.path, sc.seed), "built\n");
        }
        await ageWorktree(wt.path, 100 * HOUR);
        const realGit = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
        const ready = join(gate, "READY");
        const go = join(gate, "GO");
        await mkdir(join(gate, "bin"));
        await writeFile(
          join(gate, "bin", "git"),
          `#!/bin/sh
case " $* " in *" worktree move "*) : > "${ready}"; i=0; while [ ! -e "${go}" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done;; esac
exec "${realGit}" "$@"
`,
        );
        await chmod(join(gate, "bin", "git"), 0o755);
        process.env.PATH = `${join(gate, "bin")}:${savedPath}`;
        const target = sc.cwdInside ? sc.rel : join(wt.path, sc.rel);
        const writer = new Promise<void>((done) => {
          const p = spawn(
            "sh",
            ["-c", `while [ ! -e "${ready}" ]; do sleep 0.02; done; printf SECRET > "${target}"; : > "${go}"`],
            {
              stdio: "ignore",
              cwd: sc.cwdInside ? wt.path : undefined,
            },
          );
          p.on("exit", () => done());
        });
        const report = await sweep(repo, trashRoot);
        await writer;
        process.env.PATH = savedPath;
        assert.equal(await exists(ready), true, "the gate must have been reached");
        assert.equal(report.failed.length, 0, JSON.stringify(report));
        const found = (
          await exec("sh", [
            "-c",
            `find "${join(fixture.root, "..")}" "${trashRoot}" -name "${basename(sc.rel)}" 2>/dev/null || true`,
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean);
        assert.ok(found.length > 0, `LOST: ${sc.rel} (${JSON.stringify(report)})`);
        assert.equal(await readFile(found[0] as string, "utf8"), "SECRET");
      });
    } finally {
      process.env.PATH = savedPath;
      await rm(gate, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });
}

const OLD = new Date("2020-01-01T00:00:00Z");
async function makeMarkedTrash(root: string): Promise<string> {
  const { moveToTrash } = await import("../../src/git/trashStore.ts");
  const src = join(await mkdtemp(join(tmpdir(), "pi-eng-src-")), "old-wt");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "a.txt"), "precious\n");
  return moveToTrash(root, "worktree", src, "old-wt", "br", OLD.getTime());
}

test("unmarked orphans are never deleted, even with --apply", async () => {
  const fixture = await makeFixtureRepo();
  const trash = await mkdtemp(join(tmpdir(), "pi-eng-t-"));
  try {
    const dir = join(dirname(fixture.root), ".pi-eng-trash", "20200101T000000Z-userstuff");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mine.txt"), "user data\n");
    await utimes(join(dir, "mine.txt"), OLD, OLD);
    await utimes(dir, OLD, OLD);
    const out = await runTrashPurge({
      olderThanDays: 14,
      apply: true,
      cwd: fixture.root,
      env: { PI_TRASH_DIR: join(trash, "t"), PI_RUST_CACHE_DIR: join(trash, "rc") },
    });
    assert.equal(await exists(join(dir, "mine.txt")), true, "user data survives");
    assert.deepEqual(out.orphanTrash?.purged, []);
    assert.match(out.orphanTrash?.skipped.find((k) => k.path === dir)?.reason ?? "", /rm -rf/);
  } finally {
    await rm(join(dirname(fixture.root), ".pi-eng-trash"), { recursive: true, force: true });
    await rm(trash, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a symlinked trash root is never purged or listed, and a relative PI_TRASH_DIR is refused", async () => {
  const fixture = await makeFixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "pi-eng-t-"));
  try {
    // (a) <parent>/.pi-eng-trash -> a directory holding a timestamp-named folder
    const target = join(base, "elsewhere");
    await mkdir(join(target, "20200101T000000Z-photos"), { recursive: true });
    await writeFile(join(target, "20200101T000000Z-photos", "a.jpg"), "x");
    await symlink(target, join(dirname(fixture.root), ".pi-eng-trash"));
    // (b) PI_TRASH_DIR -> a real trash root holding an old, properly marked entry
    const realTrash = join(base, "real-trash");
    const entry = await makeMarkedTrash(realTrash);
    const linked = join(base, "linked-trash");
    await symlink(realTrash, linked);
    const out = await runTrashPurge({
      olderThanDays: 14,
      apply: true,
      cwd: fixture.root,
      env: { PI_TRASH_DIR: linked, PI_RUST_CACHE_DIR: join(base, "rc") },
    });
    assert.equal(await exists(join(target, "20200101T000000Z-photos", "a.jpg")), true, "symlink target survives");
    assert.equal(await exists(entry), true, "entry behind a symlinked PI_TRASH_DIR survives --apply");
    assert.match(out.orphanTrash?.skipped[0]?.reason ?? "", /symbolic link/);
    assert.match(out.worktreeTrash.skipped[0]?.reason ?? "", /symbolic link/);

    const rel = await runTrashPurge({
      olderThanDays: 14,
      apply: true,
      cwd: fixture.root,
      env: { PI_TRASH_DIR: "relative/trash", PI_RUST_CACHE_DIR: join(base, "rc") },
    });
    assert.match(rel.worktreeTrash.skipped[0]?.reason ?? "", /absolute path/);
  } finally {
    await rm(join(dirname(fixture.root), ".pi-eng-trash"), { force: true });
    await rm(base, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("the sweep refuses a symlinked trash root and one inside a working tree; the checkout stays", async () => {
  const fixture = await makeFixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "pi-eng-t-"));
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const wt = await createOwned(repo, await repo.headCommit(), CAND("trashroot"));
    await ageWorktree(wt.path, 100 * HOUR);
    const real = join(base, "real");
    await mkdir(real);
    const link = join(base, "link");
    await symlink(real, link);
    for (const [root, why] of [
      [link, /symbolic link/],
      [join(fixture.root, "inside-trash"), /inside the working tree/],
      [join(wt.path, "inside-trash"), /inside the working tree/],
    ] as const) {
      const report = await sweep(repo, root);
      assert.equal(report.reclaimed.length, 0, `${root}: ${JSON.stringify(report)}`);
      assert.match(report.kept.find((k) => k.path === wt.path)?.reason ?? "", why);
      assert.equal(await exists(join(wt.path, ".git")), true, "checkout untouched");
    }
    assert.deepEqual(await readdir(real), [], "nothing was written through the symlink");
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a trashed worktree keeps its git registration in the trash entry and can be restored", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("restore"));
      await ageWorktree(wt.path, 100 * HOUR);
      const admin = await gitDirOf(wt.path);
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
      const trashed = report.reclaimed[0]!.trashedTo!;
      const kept = join(dirname(trashed), ".pi-eng-admin");
      assert.equal(await exists(admin), false);
      assert.equal(await exists(join(kept, "HEAD")), true, "registration is restorable, not deleted");
      assert.doesNotMatch(report.reclaimed[0]!.reason, /worktree prune/);
      // README restore recipe
      await rename(trashed, wt.path);
      await rename(kept, admin);
      await exec("git", ["-C", fixture.root, "worktree", "repair", wt.path]);
      const list = (await exec("git", ["-C", fixture.root, "worktree", "list", "--porcelain"])).stdout;
      assert.match(list, new RegExp(`worktree ${wt.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal((await exec("git", ["-C", wt.path, "status", "--short"])).stdout.trim(), "");
    });
  } finally {
    await fixture.cleanup();
  }
});
