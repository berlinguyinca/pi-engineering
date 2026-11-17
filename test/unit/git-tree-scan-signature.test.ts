/**
 * #679 — the tree scan must never answer from a verdict that is older than the tree.
 *
 * A hotpatch applied in place to installed releases memoized `scanRepoTreeDetailed()` on the mtimes
 * of a fixed list of directories. That signature does not cover what the scan recurses into:
 * planting `refs/heads/x/target` bumps `refs/heads`, not `refs`, so a cached "clean" verdict
 * survives an entry the scan would refuse, and `safeGit` then runs git over a link it did not
 * choose. The patch was kept out of the repo, and these tests are why it stays out — they are the
 * counterexample from the issue, run under both memo states so a future memo has to be sound to
 * pass rather than merely fast.
 *
 * The measurements that make the memo pointless are in the scanner's header; in short, a signature
 * sound enough to cover the verdict's inputs (entry names, entry types, and `nlink` of every
 * regular file) costs at least as many syscalls as the walk it replaces.
 */
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanRepoTreeDetailed } from "../../src/git/safeGitTree.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repository whose tree the scan passes, with the directories the scan recurses into. */
function cleanRepo(): { root: string; gitDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-eng-tree-scan-"));
  roots.push(root);
  const gitDir = join(root, ".git");
  for (const dir of [
    "refs/heads",
    "refs/tags",
    "logs/refs/heads",
    "info",
    "objects/info",
    "objects/pack",
    "worktrees/w1/logs/refs/heads",
  ]) {
    mkdirSync(join(gitDir, dir), { recursive: true });
  }
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "config"), "[core]\n");
  writeFileSync(join(gitDir, "refs/heads", "main"), "0".repeat(40));
  writeFileSync(join(gitDir, "logs/refs/heads", "main"), `${"a".repeat(40)} ${"b".repeat(40)} E\t<e>\t1\n`);
  writeFileSync(join(gitDir, "objects/pack", "pack-abc.pack"), "x");
  writeFileSync(join(gitDir, "worktrees/w1", "index"), "x");
  writeFileSync(join(gitDir, "worktrees/w1", "HEAD"), "ref: refs/heads/t\n");
  writeFileSync(
    join(gitDir, "worktrees/w1", "logs/refs/heads", "t"),
    `${"a".repeat(40)} ${"b".repeat(40)} E\t<e>\t1\n`,
  );
  return { root, gitDir };
}

/** Every entry the scan visits is a regular file or a directory, so the verdict is clean. */
function assertClean(gitDir: string, label: string): void {
  const verdict = scanRepoTreeDetailed({ gitDir, commonDir: gitDir });
  assert.equal(verdict.reason, null, `${label}: expected a clean tree, got ${verdict.reason}`);
}

/**
 * The knob the hotpatch keyed its cache on. The repo has no memo, so it must change nothing; if a
 * memo lands, each case below still has to hold with it on.
 */
const memoStates: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["0", "0"],
  ["1", "1"],
];

for (const [label, value] of memoStates) {
  const withEnv = <T>(fn: () => T): T => {
    const previous = process.env.PI_ENG_TREE_SCAN_MEMO;
    if (value === undefined) delete process.env.PI_ENG_TREE_SCAN_MEMO;
    else process.env.PI_ENG_TREE_SCAN_MEMO = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.PI_ENG_TREE_SCAN_MEMO;
      else process.env.PI_ENG_TREE_SCAN_MEMO = previous;
    }
  };

  test(`#679 memo=${label}: a symlink planted below a stamped directory is refused on the next call`, () => {
    withEnv(() => {
      const { gitDir } = cleanRepo();
      assertClean(gitDir, "before");
      // The counterexample exactly as filed: a new directory one level under refs/, holding a link
      // to a file git must never write. This bumps refs/heads, which the hotpatch never stamped.
      mkdirSync(join(gitDir, "refs/heads", "x"), { recursive: true });
      symlinkSync(join(tmpdir(), "authorized_keys"), join(gitDir, "refs/heads", "x", "target"));
      const after = scanRepoTreeDetailed({ gitDir, commonDir: gitDir });
      assert.equal(after.reason, "refs/heads/x/target is a symbolic link");
      assert.equal(after.overLimit, false);
    });
  });

  test(`#679 memo=${label}: the same hole below logs/ and a linked worktree's logs/ is refused`, () => {
    withEnv(() => {
      const { gitDir } = cleanRepo();
      assertClean(gitDir, "before");
      mkdirSync(join(gitDir, "logs/refs/heads", "nested"), { recursive: true });
      symlinkSync("/etc/passwd", join(gitDir, "logs/refs/heads", "nested", "main"));
      assert.equal(
        scanRepoTreeDetailed({ gitDir, commonDir: gitDir }).reason,
        "logs/refs/heads/nested/main is a symbolic link",
      );

      const { gitDir: other } = cleanRepo();
      assertClean(other, "before");
      mkdirSync(join(other, "worktrees/w1/logs/refs/heads", "deep"), { recursive: true });
      symlinkSync(join(tmpdir(), "authorized_keys"), join(other, "worktrees/w1/logs/refs/heads", "deep", "t"));
      assert.equal(
        scanRepoTreeDetailed({ gitDir: other, commonDir: other }).reason,
        "worktrees/w1/logs/refs/heads/deep/t is a symbolic link",
      );
    });
  });

  test(`#679 memo=${label}: a hard link planted outside the scanned tree is refused`, () => {
    withEnv(() => {
      const { root, gitDir } = cleanRepo();
      assertClean(gitDir, "before");
      // No directory entry inside the tree changes, so a signature built from entry names and types
      // alone would still match. The verdict depends on nlink, which is why a sound signature has to
      // stat every regular file the walk touches -- the cost the memo was meant to avoid.
      linkSync(join(gitDir, "refs/heads", "main"), join(root, "another-name"));
      assert.equal(
        scanRepoTreeDetailed({ gitDir, commonDir: gitDir }).reason,
        "refs/heads/main has more than one hard link",
      );
    });
  });

  test(`#679 memo=${label}: replacing a file with a link is caught even though the name is unchanged`, () => {
    withEnv(() => {
      const { root, gitDir } = cleanRepo();
      assertClean(gitDir, "before");
      const victim = join(gitDir, "worktrees/w1", "index");
      const elsewhere = join(root, "elsewhere");
      writeFileSync(elsewhere, "x");
      rmSync(victim);
      symlinkSync(elsewhere, victim);
      assert.equal(scanRepoTreeDetailed({ gitDir, commonDir: gitDir }).reason, "worktrees/w1/index is a symbolic link");
    });
  });

  test(`#679 memo=${label}: an unchanged tree gives the same verdict twice`, () => {
    withEnv(() => {
      const { gitDir } = cleanRepo();
      const first = scanRepoTreeDetailed({ gitDir, commonDir: gitDir });
      const second = scanRepoTreeDetailed({ gitDir, commonDir: gitDir });
      assert.deepEqual(second, first);
      assert.equal(second.reason, null);
    });
  });
}
