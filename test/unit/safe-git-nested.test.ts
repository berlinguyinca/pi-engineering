/**
 * T16 round 3 (HIGH-1): a tracked nested repository or submodule makes git start a CHILD `git status` inside it, and
 * that child reads the NESTED repository's own config (a clean filter, textconv, fsmonitor there). The nested
 * repository is not the one safeGit shadows, so its config can only be kept out by making sure the child is not
 * started. Raw-git controls prove the payload is live; the matrix below runs every subcommand Pi uses.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type GitTrust, safeGit, safeGitSync } from "../../src/git/safeGit.ts";

const MODES: GitTrust[] = ["strict", "operator"];
type Kind = "submodule" | "embedded";

function lab(kind: Kind) {
  const root = mkdtempSync(join(tmpdir(), `safe-git-nested-${kind}-`));
  mkdirSync(join(root, "home"));
  const marks = join(root, "M");
  mkdirSync(marks);
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" }).toString();
  for (const n of ["filter", "fsmon", "textconv"]) {
    writeFileSync(join(root, `${n}.sh`), `#!/bin/sh\ntouch '${marks}/${n}'\ncat\n`);
    chmodSync(join(root, `${n}.sh`), 0o755);
  }
  sh(
    "git init -q -b main src && cd src && git config user.name t && git config user.email t@t && echo s > s.txt && git add . && git commit -qm s",
  );
  sh(
    "git init -q -b main outer && cd outer && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm i && git branch other",
  );
  const outer = join(root, "outer");
  if (kind === "submodule") sh("git -c protocol.file.allow=always submodule add -q ../src sub", outer);
  else sh("cp -r ../src sub", outer);
  sh("git add -A && git commit -qm sub && echo b > b.txt && git add b.txt && git commit -qm b", outer);
  const nestedGit = sh("git -C sub rev-parse --absolute-git-dir", outer).trim();
  sh(
    `git -C sub config filter.e.clean ${root}/filter.sh && git -C sub config core.fsmonitor ${root}/fsmon.sh && git -C sub config diff.e.textconv ${root}/textconv.sh`,
    outer,
  );
  mkdirSync(join(nestedGit, "info"), { recursive: true });
  writeFileSync(join(nestedGit, "info", "attributes"), "* filter=e diff=e\n");
  const dirty = () => {
    // same size, new mtime: git has to hash the file, which runs the nested repository's clean filter
    writeFileSync(join(outer, "sub", "s.txt"), "x\n");
    execFileSync("touch", [join(outer, "sub", "s.txt")]);
  };
  const reset = () => {
    try {
      // restoring runs raw git inside the nested repository (its own fsmonitor), so it happens BEFORE the markers are cleared
      sh("git -C sub -c core.fsmonitor=false -c filter.e.clean= checkout -q -f -- . ", outer);
    } catch {
      /* nothing to restore */
    }
    for (const n of readdirSync(marks)) rmSync(join(marks, n));
  };
  return { root, outer, marks, sh, dirty, reset, seen: () => readdirSync(marks).sort(), env };
}

for (const kind of ["submodule", "embedded"] as Kind[]) {
  test(`control (${kind}): raw git runs the nested repository's filter for add, status, diff, diff-files, diff-index and describe --dirty`, () => {
    const l = lab(kind);
    try {
      let ran = 0;
      for (const cmd of [
        "add -A",
        "status --porcelain",
        "diff",
        "diff-files",
        "diff-index HEAD",
        "describe --dirty --always",
      ]) {
        l.reset();
        l.dirty();
        try {
          l.sh(`git -c core.fsmonitor=false ${cmd}`, l.outer);
        } catch {
          /* exit status is not the point */
        }
        if (l.seen().includes("filter")) ran++;
      }
      assert.ok(ran >= 3, `raw git ran the nested filter for only ${ran} of 6 commands: the setup is not live`);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });

  test(`safeGit (${kind}): no subcommand Pi uses starts the nested repository's filter, textconv or fsmonitor, in either mode`, async () => {
    const l = lab(kind);
    try {
      const cmds: string[][] = [
        ["status", "--porcelain"],
        ["status"],
        ["status", "--porcelain", "-uno"],
        ["add", "-A"],
        ["add", "."],
        ["add", "-u"],
        ["add", "b.txt"],
        ["diff"],
        ["diff", "HEAD"],
        ["diff", "--cached"],
        ["diff", "--stat", "HEAD~1"],
        ["diff", "--submodule=diff"],
        ["diff", "--submodule=log"],
        ["log", "-p", "-3"],
        ["show", "HEAD"],
        ["show", "--submodule=diff", "HEAD~1"],
        ["commit", "-a", "-m", "q"],
        ["commit", "--allow-empty", "-m", "q"],
        ["stash", "push"],
        ["stash", "list"],
        ["reset", "--hard"],
        ["reset"],
        ["checkout", "."],
        ["checkout", "other"],
        ["switch", "main"],
        ["restore", "."],
        ["rebase", "other"],
        ["merge", "other"],
        ["cherry-pick", "other"],
        ["revert", "--no-edit", "HEAD"],
        ["pull"],
        ["fetch"],
        ["push"],
        ["update-index", "--refresh"],
        ["mv", "a.txt", "a2.txt"],
        ["rm", "-f", "a2.txt"],
        ["clean", "-nd"],
        ["diff-files"],
        ["diff-index", "HEAD"],
        ["diff-tree", "-p", "HEAD"],
        ["describe", "--always"],
        ["describe", "--always", "--tags"],
        ["worktree", "list"],
        ["ls-files", "-m"],
        ["ls-files", "--stage"],
        ["rev-parse", "HEAD"],
        ["branch", "-a"],
        ["grep", "a"],
        ["blame", "a.txt"],
        ["archive", "HEAD", "-o", "/dev/null"],
        ["format-patch", "-1", "--stdout"],
        ["apply", "--check", "/dev/null"],
        ["cat-file", "-p", "HEAD"],
      ];
      for (const trust of MODES) {
        for (const args of cmds) {
          l.reset();
          l.dirty();
          await safeGit(args, { cwd: l.outer, trust, timeoutMs: 30_000 });
          assert.deepEqual(l.seen(), [], `${trust} ${args.join(" ")}: ran ${l.seen().join(",")}`);
          try {
            l.sh("git -c core.fsmonitor=false -c filter.e.clean= reset -q --hard main", l.outer);
          } catch {
            /* state restoration is best effort */
          }
        }
        l.reset();
        l.dirty();
        const sync = safeGitSync(["add", "-A"], { cwd: l.outer, trust, timeoutMs: 30_000 });
        assert.equal(sync.code, 0, sync.stderr);
        assert.deepEqual(l.seen(), [], `${trust} sync add -A`);
      }
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });

  test(`safeGit (${kind}): .gitmodules ignore=none and update=!cmd do not bring the child back`, async () => {
    const l = lab(kind);
    try {
      l.sh(
        "git config -f .gitmodules submodule.sub.ignore none && git config -f .gitmodules submodule.sub.update '!echo x' && git add .gitmodules && git commit -qm gm",
        l.outer,
      );
      for (const trust of MODES) {
        for (const args of [
          ["status"],
          ["diff"],
          ["commit", "-a", "-m", "q"],
          ["add", "-A"],
          ["diff-files"],
          ["stash", "push"],
        ]) {
          l.reset();
          l.dirty();
          await safeGit(args, { cwd: l.outer, trust, timeoutMs: 30_000 });
          assert.deepEqual(l.seen(), [], `${trust} ${args.join(" ")}: ran ${l.seen().join(",")}`);
        }
      }
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });

  test(`safeGit (${kind}): add -A still stages everything else, and leaves the nested repository's own change out`, async () => {
    const l = lab(kind);
    try {
      l.dirty();
      writeFileSync(join(l.outer, "new.txt"), "new\n");
      writeFileSync(join(l.outer, "b.txt"), "b changed\n");
      const r = await safeGit(["add", "-A"], { cwd: l.outer, trust: "strict", timeoutMs: 30_000 });
      assert.equal(r.code, 0, r.stderr);
      const staged = l.sh("git diff --cached --name-only", l.outer).trim().split("\n").sort();
      assert.deepEqual(staged, ["b.txt", "new.txt"]);
      // an explicit pathspec keeps working, and names that are not nested are unaffected
      writeFileSync(join(l.outer, "c.txt"), "c\n");
      assert.equal((await safeGit(["add", "c.txt"], { cwd: l.outer, trust: "strict" })).code, 0);
      assert.ok(l.sh("git diff --cached --name-only", l.outer).includes("c.txt"));
      // a bare `git add` with nothing to select is still a no-op, not "add everything"
      writeFileSync(join(l.outer, "d.txt"), "d\n");
      await safeGit(["add"], { cwd: l.outer, trust: "strict" });
      assert.equal(l.sh("git diff --cached --name-only", l.outer).includes("d.txt"), false);
      const fromFile = await safeGit(["add", "--pathspec-from-file=-"], {
        cwd: l.outer,
        trust: "strict",
        input: "d.txt\n",
      });
      assert.equal(fromFile.code, 128);
      assert.match(fromFile.stderr, /nested repository/);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });

  test(`safeGit (${kind}): describe works, describe --dirty is refused while a nested repository exists, and diff-files / diff-index still answer`, async () => {
    const l = lab(kind);
    try {
      l.sh("git tag v1", l.outer);
      const plain = await safeGit(["describe", "--tags"], { cwd: l.outer, trust: "strict" });
      assert.equal(plain.stdout.trim().startsWith("v1"), true, plain.stderr);
      for (const flag of ["--dirty", "--dirty=-x", "--broken"]) {
        const r = await safeGit(["describe", "--tags", flag], { cwd: l.outer, trust: "strict" });
        assert.equal(r.code, 128, flag);
        assert.match(r.stderr, /nested repository at sub/);
      }
      writeFileSync(join(l.outer, "a.txt"), "changed\n");
      const files = await safeGit(["diff-files", "--name-only"], { cwd: l.outer, trust: "strict" });
      assert.equal(files.stdout.trim(), "a.txt");
      const idx = await safeGit(["diff-index", "--name-only", "HEAD"], { cwd: l.outer, trust: "strict" });
      assert.equal(idx.stdout.trim(), "a.txt");
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });
}

test("a repository without nested repositories: describe --dirty and add behave exactly as plain git", async () => {
  const l = lab("embedded");
  try {
    rmSync(join(l.outer, "sub"), { recursive: true, force: true });
    l.sh("git add -A && git commit -qm nosub && git tag v2", l.outer);
    writeFileSync(join(l.outer, "a.txt"), "changed\n");
    const d = await safeGit(["describe", "--dirty", "--tags"], { cwd: l.outer, trust: "strict" });
    assert.equal(d.stdout.trim(), "v2-dirty");
    assert.equal((await safeGit(["add", "-A"], { cwd: l.outer, trust: "strict" })).code, 0);
    assert.equal(l.sh("git diff --cached --name-only", l.outer).trim(), "a.txt");
    assert.ok(existsSync(join(l.outer, ".git")));
    assert.equal(readFileSync(join(l.outer, "a.txt"), "utf8"), "changed\n");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
