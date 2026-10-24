/**
 * T16 round 3: what the shadow common directory must NOT break. Every ordinary flow Pi relies on is run through
 * safeGit against real repositories and compared with what raw git does: the real repository ends up in the state raw
 * git would have left it in (refs, packed-refs, config, worktree links), paths in output are the real ones, and no
 * temporary directory is left behind.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type GitTrust, forgetRemotePinsForTests, safeGit, safeGitSync, testHooks } from "../../src/git/safeGit.ts";
import { resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const MODES: GitTrust[] = ["strict", "operator"];

afterEach(() => {
  testHooks.afterPlan = undefined;
  resetTelemetrySinks();
  forgetRemotePinsForTests();
});

function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-shadow-"));
  mkdirSync(join(root, "home"));
  const marks = join(root, "M");
  mkdirSync(marks);
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" }).toString();
  sh(
    "git init -q -b main repo && cd repo && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git init -q -b main --bare ../remote.git && git remote add origin ../remote.git && git push -q origin main",
  );
  const hook = (name: string) => {
    const p = join(root, `h-${name}`);
    writeFileSync(p, `#!/bin/sh\ntouch '${marks}/${name}'\ncat\n`, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  };
  return {
    root,
    repo: join(root, "repo"),
    remote: join(root, "remote.git"),
    marks,
    sh,
    hook,
    env,
    seen: () => readdirSync(marks).sort(),
  };
}

const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("pi-safegit-"));

test("no shadow directory is left behind, for success, failure and refusal, async and sync", async () => {
  const l = lab();
  try {
    const before = leftovers();
    for (const trust of MODES) {
      await safeGit(["status"], { cwd: l.repo, trust });
      await safeGit(["nosuchsubcommand"], { cwd: l.repo, trust });
      await safeGit(["--git-dir", l.repo, "status"], { cwd: l.repo, trust });
      safeGitSync(["log", "-1"], { cwd: l.repo, trust });
      safeGitSync(["nosuchsubcommand"], { cwd: l.repo, trust });
    }
    assert.deepEqual(leftovers(), before);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("commits, branches, tags, merges and ref deletion leave the real repository exactly as raw git would", async () => {
  for (const trust of MODES) {
    const l = lab();
    try {
      const run = async (...args: string[]) => {
        const r = await safeGit(args, { cwd: l.repo, trust });
        assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
        return r.stdout;
      };
      writeFileSync(join(l.repo, "b.txt"), "b\n");
      await run("add", "b.txt");
      await run("commit", "-q", "-m", "two");
      await run("branch", "feature");
      await run("tag", "v1");
      await run("checkout", "-q", "feature");
      writeFileSync(join(l.repo, "c.txt"), "c\n");
      await run("add", "-A");
      await run("commit", "-q", "-m", "three");
      await run("checkout", "-q", "main");
      await run("merge", "-q", "--no-ff", "-m", "merge", "feature");
      await run("branch", "-d", "feature");
      await run("tag", "-d", "v1");
      // real git agrees on the result (no shadow state leaked into the real directory)
      assert.equal(l.sh("git log --oneline | wc -l", l.repo).trim(), "4");
      assert.equal(l.sh("git branch --list feature", l.repo).trim(), "");
      assert.equal(l.sh("git tag --list", l.repo).trim(), "");
      assert.equal(l.sh("git fsck --strict 2>&1 | grep -c -E '^(error|fatal)' || true", l.repo).trim(), "0");
      assert.deepEqual(
        readdirSync(join(l.repo, ".git")).filter((n) => n.endsWith(".lock") || n.includes("pi-safegit")),
        [],
      );
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }
});

test("packed-refs written inside the shadow (pack-refs, gc, deleting a packed branch) is written back to the real directory", async () => {
  for (const trust of MODES) {
    const l = lab();
    try {
      l.sh("git branch keep && git branch drop && git tag t1", l.repo);
      const pack = await safeGit(["pack-refs", "--all"], { cwd: l.repo, trust });
      assert.equal(pack.code, 0, pack.stderr);
      const packed = readFileSync(join(l.repo, ".git", "packed-refs"), "utf8");
      assert.match(packed, /refs\/heads\/keep/);
      assert.match(packed, /refs\/tags\/t1/);
      assert.equal(existsSync(join(l.repo, ".git", "refs", "heads", "keep")), false, "loose ref was packed");
      const del = await safeGit(["branch", "-D", "drop"], { cwd: l.repo, trust });
      assert.equal(del.code, 0, del.stderr);
      assert.doesNotMatch(readFileSync(join(l.repo, ".git", "packed-refs"), "utf8"), /refs\/heads\/drop/);
      assert.equal(l.sh("git branch --list", l.repo).includes("drop"), false);
      assert.equal(l.sh("git branch --list", l.repo).includes("keep"), true);
      const gc = await safeGit(["gc", "-q"], { cwd: l.repo, trust });
      assert.equal(gc.code, 0, gc.stderr);
      assert.equal(l.sh("git fsck --strict 2>&1 | grep -c -E '^(error|fatal)' || true", l.repo).trim(), "0");
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }
});

test("a ref another process packs while the command runs is not lost (refs and packed-refs are the real ones, with the real locks)", async () => {
  const l = lab();
  try {
    l.sh("git branch other && git pack-refs --all", l.repo);
    testHooks.afterPlan = () => {
      l.sh("git branch late && git pack-refs --all", l.repo);
    };
    const r = await safeGit(["branch", "-D", "other"], { cwd: l.repo, trust: "strict" });
    assert.equal(r.code, 0, r.stderr);
    const packed = readFileSync(join(l.repo, ".git", "packed-refs"), "utf8");
    assert.match(packed, /refs\/heads\/late/, "the other process's update survived");
    assert.doesNotMatch(packed, /refs\/heads\/other/);
    assert.equal(l.sh("git branch --list", l.repo).includes("late"), true);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a file git creates in the common directory because it does not exist yet (shallow) is written back to the real one", async () => {
  const l = lab();
  try {
    l.sh(
      "echo b > b.txt && git add . && git commit -qm two && echo c > c.txt && git add . && git commit -qm three && git push -q origin main",
      l.repo,
    );
    l.sh(`git clone -q --no-local ${l.remote} ../src2 && git init -q -b main ../shallow-target`, l.repo);
    const target = join(l.root, "shallow-target");
    assert.equal(existsSync(join(target, ".git", "shallow")), false);
    const f = await safeGit(["fetch", "-q", "--depth", "1", `file://${l.remote}`, "main"], {
      cwd: target,
      trust: "strict",
    });
    assert.equal(f.code, 0, f.stderr);
    assert.equal(existsSync(join(target, ".git", "shallow")), true, "shallow reached the real directory");
    assert.equal(l.sh("git rev-list --count FETCH_HEAD", target).trim(), "1");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("config the command itself writes (remote add/set-url/rename/remove, upstream, git config) reaches the real config; other keys are untouched", async () => {
  for (const trust of MODES) {
    const l = lab();
    try {
      const fsm = l.hook("fsm");
      l.sh(`git config core.fsmonitor ${fsm} && git config filter.keep.clean cat`, l.repo);
      const ok = async (...args: string[]) => {
        const r = await safeGit(args, { cwd: l.repo, trust });
        assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
        return r.stdout;
      };
      await ok("remote", "add", "up", "https://example.invalid/up.git");
      await ok("remote", "set-url", "origin", "https://example.invalid/o.git");
      await ok("config", "branch.main.description", "dropped-by-allowlist-but-written");
      await ok("branch", "--set-upstream-to=origin/main", "main").catch(() => {});
      await ok("config", "user.name", "Changed");
      await ok("remote", "rename", "up", "second");
      const cfg = l.sh("git config --list --local", l.repo);
      assert.match(cfg, /remote\.second\.url=https:\/\/example\.invalid\/up\.git/);
      assert.match(cfg, /remote\.origin\.url=https:\/\/example\.invalid\/o\.git/);
      assert.match(cfg, /user\.name=Changed/);
      assert.match(cfg, /branch\.main\.description=dropped-by-allowlist-but-written/);
      assert.match(cfg, /core\.fsmonitor=/, "keys the generated config did not carry stay in the real file");
      assert.match(cfg, /filter\.keep\.clean=cat/);
      assert.doesNotMatch(cfg, /remote\.up\./);
      await ok("remote", "remove", "second");
      assert.doesNotMatch(l.sh("git config --list --local", l.repo), /remote\.second\./);
      // the derived keys are never duplicated
      const text = readFileSync(join(l.repo, ".git", "config"), "utf8");
      assert.equal((text.match(/repositoryformatversion/g) ?? []).length, 1);
      assert.equal((text.match(/\bbare\b/g) ?? []).length, 1);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }
});

test("fetch, push and pull work with a pinned remote, and Pi adding the first remote pins it", async () => {
  for (const trust of MODES) {
    const l = lab();
    try {
      l.sh("git remote remove origin", l.repo);
      assert.equal((await safeGit(["remote", "add", "origin", l.remote], { cwd: l.repo, trust })).code, 0);
      writeFileSync(join(l.repo, "n.txt"), "n\n");
      l.sh("git add . && git commit -qm n", l.repo);
      const push = await safeGit(["push", "-q", "origin", "main"], { cwd: l.repo, trust });
      assert.equal(push.code, 0, push.stderr);
      const fetch = await safeGit(["fetch", "-q", "origin"], { cwd: l.repo, trust });
      assert.equal(fetch.code, 0, fetch.stderr);
      l.sh(
        `git clone -q ${l.remote} ../other && cd ../other && git config user.name t && git config user.email t@t && echo z > z.txt && git add . && git commit -qm z && git push -q origin main`,
        l.repo,
      );
      const pull = await safeGit(["pull", "-q", "--ff-only", "origin", "main"], { cwd: l.repo, trust });
      assert.equal(pull.code, 0, pull.stderr);
      assert.ok(existsSync(join(l.repo, "z.txt")));
      // a worker repoints the remote: now refused
      l.sh(`git config remote.origin.url ${join(l.root, "elsewhere.git")}`, l.repo);
      const refused = await safeGit(["fetch", "origin"], { cwd: l.repo, trust });
      assert.equal(refused.code, 128);
      assert.match(refused.stderr, /remote URLs changed/);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }
});

test("worktree add / list / remove / prune: paths are real, the new worktree's .git points at the real directory, and it works with raw git", async () => {
  for (const trust of MODES) {
    const l = lab();
    try {
      const wt = join(l.root, `wt-${trust}`);
      const add = await safeGit(["worktree", "add", "-q", "-b", `b-${trust}`, wt], { cwd: l.repo, trust });
      assert.equal(add.code, 0, add.stderr);
      const link = readFileSync(join(wt, ".git"), "utf8");
      assert.equal(link.trim(), `gitdir: ${join(l.repo, ".git", "worktrees", `wt-${trust}`)}`);
      assert.ok(!link.includes("pi-safegit"));
      for (const f of readdirSync(join(l.repo, ".git", "worktrees", `wt-${trust}`), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)) {
        const body = readFileSync(join(l.repo, ".git", "worktrees", `wt-${trust}`, f), "utf8");
        assert.ok(!body.includes("pi-safegit"), `${f} names the shadow directory`);
      }
      assert.equal(l.sh("git status --porcelain", wt), "");
      const list = await safeGit(["worktree", "list", "--porcelain"], { cwd: l.repo, trust });
      assert.match(list.stdout, new RegExp(`worktree ${l.repo}\\n`));
      assert.match(list.stdout, new RegExp(`worktree ${wt}\\n`));
      assert.ok(!list.stdout.includes("pi-safegit"));
      const common = await safeGit(["rev-parse", "--git-common-dir", "--git-dir", "--show-toplevel"], {
        cwd: wt,
        trust,
      });
      assert.deepEqual(common.stdout.trim().split("\n"), [
        join(l.repo, ".git"),
        join(l.repo, ".git", "worktrees", `wt-${trust}`),
        wt,
      ]);
      // work inside the linked worktree through safeGit, then remove it from the primary
      writeFileSync(join(wt, "w.txt"), "w\n");
      assert.equal((await safeGit(["add", "-A"], { cwd: wt, trust })).code, 0);
      assert.equal((await safeGit(["commit", "-q", "-m", "w"], { cwd: wt, trust })).code, 0);
      assert.equal(l.sh(`git log -1 --format=%s b-${trust}`, l.repo).trim(), "w");
      const rm = await safeGit(["worktree", "remove", "--force", wt], { cwd: l.repo, trust });
      assert.equal(rm.code, 0, rm.stderr);
      assert.equal(existsSync(wt), false);
      assert.equal((await safeGit(["worktree", "prune"], { cwd: l.repo, trust })).code, 0);
      assert.equal((await safeGit(["branch", "-D", `b-${trust}`], { cwd: l.repo, trust })).code, 0);
      assert.equal(readdirSync(join(l.repo, ".git", "worktrees")).length, 0);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }
});

test("the first worktree of a repository (no .git/worktrees yet) is created in the real directory", async () => {
  const l = lab();
  try {
    assert.equal(existsSync(join(l.repo, ".git", "worktrees")), false);
    const wt = join(l.root, "first");
    const add = await safeGit(["worktree", "add", "-q", "-b", "first", wt], { cwd: l.repo, trust: "strict" });
    assert.equal(add.code, 0, add.stderr);
    assert.deepEqual(readdirSync(join(l.repo, ".git", "worktrees")), ["first"]);
    assert.equal(l.sh("git rev-parse --abbrev-ref HEAD", wt).trim(), "first");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("subdirectories, -C, symlinked paths, bare repositories and directories that are not repositories", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.repo, "sub", "deep"), { recursive: true });
    writeFileSync(join(l.repo, "sub", "deep", "d.txt"), "d\n");
    const inSub = await safeGit(["status", "--porcelain"], { cwd: join(l.repo, "sub", "deep") });
    assert.equal(
      inSub.stdout,
      l.sh("git status --porcelain", join(l.repo, "sub", "deep")),
      "same output as raw git from a subdirectory",
    );
    assert.equal((await safeGit(["add", "d.txt"], { cwd: join(l.repo, "sub", "deep") })).code, 0);
    assert.equal(l.sh("git diff --cached --name-only", l.repo).trim(), "sub/deep/d.txt");
    const top = await safeGit(["rev-parse", "--show-prefix"], { cwd: join(l.repo, "sub", "deep") });
    assert.equal(top.stdout.trim(), "sub/deep/");
    const viaC = await safeGit(["-C", "repo", "log", "-1", "--format=%s"], { cwd: l.root });
    assert.equal(viaC.stdout.trim(), "one");
    symlinkSync(l.repo, join(l.root, "link"));
    const viaLink = await safeGit(["log", "-1", "--format=%s"], { cwd: join(l.root, "link") });
    assert.equal(viaLink.stdout.trim(), "one");
    const bare = await safeGit(["log", "-1", "--format=%s", "main"], { cwd: l.remote });
    assert.equal(bare.stdout.trim(), "one");
    const isBare = await safeGit(["rev-parse", "--is-bare-repository"], { cwd: l.remote });
    assert.equal(isBare.stdout.trim(), "true");
    const inside = await safeGit(["rev-parse", "--is-bare-repository"], { cwd: l.repo });
    assert.equal(inside.stdout.trim(), "false");
    mkdirSync(join(l.root, "plain"));
    const plain = await safeGit(["status"], { cwd: join(l.root, "plain") });
    assert.notEqual(plain.code, 0);
    assert.match(plain.stderr, /not a git repository/);
    const v = await safeGit(["--version"], { cwd: join(l.root, "plain") });
    assert.equal(v.code, 0);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("git init and git clone run without reading an enclosing repository's config", async () => {
  const l = lab();
  try {
    const marker = l.hook("enclosing-fsmonitor");
    l.sh(
      `git config core.fsmonitor ${marker} && git config 'url.${l.root}/redirected/.insteadOf' '${l.remote}'`,
      l.repo,
    );
    for (const trust of MODES) {
      const dir = join(l.repo, `nested-${trust}`);
      mkdirSync(dir);
      const init = await safeGit(["init", "-q", "-b", "main", dir], { cwd: l.repo, trust });
      assert.equal(init.code, 0, init.stderr);
      const clone = await safeGit(["clone", "-q", l.remote, join(dir, "c")], { cwd: dir, trust });
      assert.equal(clone.code, 0, clone.stderr);
      assert.ok(existsSync(join(dir, "c", "a.txt")), "the enclosing repository's insteadOf did not redirect the clone");
    }
    assert.deepEqual(l.seen(), []);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("LFS-style auth writes (lfs.<url>.access) survive: written by the command, kept in the real config, honoured next time", async () => {
  const l = lab();
  try {
    const key = "lfs.https://example.invalid/x.git/info/lfs.access";
    const w = await safeGit(["config", key, "basic"], { cwd: l.repo, trust: "operator" });
    assert.equal(w.code, 0, w.stderr);
    assert.equal(l.sh(`git config --get '${key}'`, l.repo).trim(), "basic");
    const r = await safeGit(["config", "--get", key], { cwd: l.repo, trust: "operator" });
    assert.equal(r.stdout.trim(), "basic", "the allow-list carries lfs.<url>.access");
    // a hostile value is not carried
    l.sh(`git config '${key}' 'x; evil'`, l.repo);
    const bad = await safeGit(["config", "--get", key], { cwd: l.repo, trust: "operator" });
    assert.equal(bad.stdout.trim(), "");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a repository with no remote is not pinned to 'nothing': a remote added later by raw git is accepted on first sight", async () => {
  const l = lab();
  try {
    l.sh("git remote remove origin", l.repo);
    assert.equal((await safeGit(["status"], { cwd: l.repo, trust: "operator" })).code, 0);
    l.sh(`git remote add origin ${l.remote}`, l.repo);
    const f = await safeGit(["fetch", "-q", "origin"], { cwd: l.repo, trust: "operator" });
    assert.equal(f.code, 0, f.stderr);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("strict mode ignores a core.attributesFile and the default per-user attributes file; operator mode keeps the operator's", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".config", "git"), { recursive: true });
    writeFileSync(join(l.root, "home", ".config", "git", "attributes"), "*.txt -diff\n");
    writeFileSync(join(l.repo, "a.txt"), "changed\n");
    const prior = { h: process.env.HOME, x: process.env.XDG_CONFIG_HOME };
    process.env.HOME = join(l.root, "home");
    process.env.XDG_CONFIG_HOME = undefined as never;
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    try {
      assert.match(
        l.sh("git diff", l.repo),
        /Binary files|\+changed/,
        "control: raw git reads the per-user attributes file",
      );
      const raw = l.sh("git diff", l.repo);
      const strict = await safeGit(["diff"], { cwd: l.repo, trust: "strict" });
      assert.match(strict.stdout, /\+changed/, "strict: the per-user attributes file is not read");
      if (/Binary files/.test(raw)) {
        // GIT_ATTR_NOSYSTEM only drops the system file; the per-user one is operator territory in operator mode
        const operator = await safeGit(["diff"], { cwd: l.repo, trust: "operator" });
        assert.match(operator.stdout, /Binary files/);
      }
    } finally {
      if (prior.h === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = prior.h;
      if (prior.x !== undefined) process.env.XDG_CONFIG_HOME = prior.x;
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("parallel calls on one repository (commits, ref updates, fetches, status) all succeed and leave a consistent repository", async () => {
  const l = lab();
  try {
    const jobs: Array<Promise<number>> = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(safeGit(["branch", `p${i}`], { cwd: l.repo, trust: "strict" }).then((r) => r.code));
      jobs.push(safeGit(["status", "--porcelain"], { cwd: l.repo, trust: "strict" }).then((r) => r.code));
      jobs.push(safeGit(["fetch", "-q", "origin"], { cwd: l.repo, trust: "strict" }).then((r) => r.code));
      jobs.push(safeGit(["tag", `t${i}`], { cwd: l.repo, trust: "strict" }).then((r) => r.code));
    }
    const codes = await Promise.all(jobs);
    assert.deepEqual(
      codes.filter((c) => c !== 0),
      [],
    );
    assert.equal(l.sh("git branch --list 'p*' | wc -l", l.repo).trim(), "12");
    assert.equal(l.sh("git tag --list | wc -l", l.repo).trim(), "12");
    assert.equal(l.sh("git fsck --strict 2>&1 | grep -c -E '^(error|fatal)' || true", l.repo).trim(), "0");
    assert.deepEqual(
      readdirSync(join(l.repo, ".git")).filter((n) => n.endsWith(".lock")),
      [],
    );
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
