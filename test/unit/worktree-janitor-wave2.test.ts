import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { OWNER_MARKER_FILE, sweepWorktrees } from "../../src/git/worktreeJanitor.ts";
import { gcPlan } from "../../src/runtime/janitor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { ageWorktree, createOwned, exists, writeOwnerMarker } from "../support/janitorFixtures.ts";

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

test("a missing, unparseable or mismatching ownership marker keeps the worktree", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const cases: Array<[string, (path: string, branch: string) => Promise<void>, RegExp]> = [
        [
          "notjson",
          async (p) => void (await writeFile(join(await gitDirOf(p), OWNER_MARKER_FILE), "{nope")),
          /unreadable or not JSON/,
        ],
        [
          "creator",
          async (p, b) => void (await writeOwnerMarker(repo, p, b, { creator: "someone-else" })),
          /not a version 1 pi-engineering marker/,
        ],
        ["version", async (p, b) => void (await writeOwnerMarker(repo, p, b, { version: 2 })), /not a version 1/],
        [
          "hash",
          async (p, b) => void (await writeOwnerMarker(repo, p, b, { repoRootHash: "zzzz" })),
          /repoRootHash mismatch/,
        ],
        [
          "sha",
          async (p, b) => void (await writeOwnerMarker(repo, p, b, { repoRootSha256: "0".repeat(64) })),
          /repoRootSha256 mismatch/,
        ],
        [
          "branch",
          async (p) => void (await writeOwnerMarker(repo, p, "some-other-branch")),
          /written for branch some-other-branch/,
        ],
        [
          "dir",
          async (p) => {
            const file = join(await gitDirOf(p), OWNER_MARKER_FILE);
            await rm(file, { force: true });
            await mkdir(file);
          },
          /not a regular file/,
        ],
      ];
      const made = [];
      for (const [name, tamper, why] of cases) {
        const branch = CAND(name);
        const wt = await createOwned(repo, await repo.headCommit(), branch);
        await tamper(wt.path, branch);
        await ageWorktree(wt.path, 100 * HOUR);
        made.push({ wt, why });
      }
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 0, JSON.stringify(report));
      for (const { wt, why } of made) {
        assert.match(report.kept.find((k) => k.path === wt.path)!.reason, why, wt.path);
        assert.equal(await exists(wt.path), true);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a marker without repoRootSha256 is still honoured (the field is optional)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await withTrash(async (trashRoot) => {
      const repo = (await GitRepo.open(fixture.root))!;
      const wt = await createOwned(repo, await repo.headCommit(), CAND("nosha1"));
      await writeOwnerMarker(repo, wt.path, null, { repoRootSha256: undefined, branch: null });
      await ageWorktree(wt.path, 100 * HOUR);
      const report = await sweep(repo, trashRoot);
      assert.equal(report.reclaimed.length, 1, JSON.stringify(report));
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
      assert.equal(await exists(ours), false, "our suffixed admin dir removed");
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
  assert.deepEqual(gcPlan("--purge-trash --apply"), { dryRun: false, purge: { olderThanDays: 14 } });
  assert.deepEqual(gcPlan("--purge-trash --older-than 30 --apply"), { dryRun: false, purge: { olderThanDays: 30 } });
  assert.deepEqual(gcPlan("--apply --purge-trash --older-than=7"), { dryRun: false, purge: { olderThanDays: 7 } });
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
  assert.deepEqual(gcPlan("--apply"), { dryRun: false });
  assert.equal(gcPlan("--purge-trash --apply --dry-run").dryRun, true);
});
