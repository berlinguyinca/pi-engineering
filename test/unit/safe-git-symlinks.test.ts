/**
 * T16 round 4 (HIGH-2): symbolic links planted in the shared `.git` (worktrees/<n>/index, packed-refs, FETCH_HEAD,
 * shallow, HEAD, config, refs/**, logs/**, objects/**) make git write outside the repository or quote a file it
 * should never read. Pi looks at those paths first and refuses the call; a stderr relayed to a worker is bounded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetRemotePinsForTests, limitStderr, safeGit, stateHooks } from "../../src/git/safeGit.ts";
import { TREE_SCAN_LIMIT, scanRepoTree, setTreeScanLimitForTests } from "../../src/git/safeGitTree.ts";

const MODES = ["strict", "operator"] as const;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-links-"));
  stateHooks.stateRoot = join(root, "state");
  mkdirSync(join(root, "home"));
});
afterEach(() => {
  stateHooks.stateRoot = undefined;
  setTreeScanLimitForTests(TREE_SCAN_LIMIT);
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  HOME: join(root, "home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env: env(), stdio: "pipe" }).toString();

function lab(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  sh(
    `git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git branch other && git worktree add -q ../wt -b feat && git init -q --bare ../remote.git && git remote add origin ../remote.git && git push -q origin main`,
    dir,
  );
  return {
    dir,
    prim: join(dir, "prim"),
    wt: join(dir, "wt"),
    G: join(dir, "prim", ".git"),
    WG: join(dir, "prim", ".git", "worktrees", "wt"),
    victim: join(dir, "victim", "target"),
    secret: join(dir, "secret"),
  };
}

type Case = {
  name: string;
  link: (l: ReturnType<typeof lab>) => string;
  cwd: (l: ReturnType<typeof lab>) => string;
  cmd: string[];
  prep?: (l: ReturnType<typeof lab>) => void;
};
const CASES: Case[] = [
  {
    name: "linked worktree index",
    link: (l) => join(l.WG, "index"),
    cwd: (l) => l.wt,
    cmd: ["add", "-A"],
    prep: (l) => writeFileSync(join(l.wt, "f ssh-ed25519 AAAAATTACKER"), "n"),
  },
  {
    name: "primary index",
    link: (l) => join(l.G, "index"),
    cwd: (l) => l.prim,
    cmd: ["add", "-A"],
    prep: (l) => writeFileSync(join(l.prim, "g"), "n"),
  },
  {
    name: "refs/heads/other",
    link: (l) => join(l.G, "refs", "heads", "other"),
    cwd: (l) => l.wt,
    cmd: ["branch", "-f", "other", "HEAD"],
  },
  { name: "packed-refs", link: (l) => join(l.G, "packed-refs"), cwd: (l) => l.wt, cmd: ["pack-refs", "--all"] },
  {
    name: "logs/refs/heads/other",
    link: (l) => join(l.G, "logs", "refs", "heads", "other"),
    cwd: (l) => l.wt,
    cmd: ["branch", "-f", "other", "HEAD"],
  },
  {
    name: "FETCH_HEAD of a worktree",
    link: (l) => join(l.WG, "FETCH_HEAD"),
    cwd: (l) => l.wt,
    cmd: ["fetch", "origin"],
  },
  {
    name: "FETCH_HEAD of the primary",
    link: (l) => join(l.G, "FETCH_HEAD"),
    cwd: (l) => l.prim,
    cmd: ["fetch", "origin"],
  },
  { name: "shallow", link: (l) => join(l.G, "shallow"), cwd: (l) => l.wt, cmd: ["log", "-1"] },
  {
    name: "info/grafts",
    link: (l) => join(l.G, "info", "grafts"),
    cwd: (l) => l.wt,
    cmd: ["log", "-1"],
    prep: (l) => mkdirSync(join(l.G, "info"), { recursive: true }),
  },
  { name: "worktree HEAD", link: (l) => join(l.WG, "HEAD"), cwd: (l) => l.wt, cmd: ["status"] },
  { name: "ORIG_HEAD", link: (l) => join(l.G, "ORIG_HEAD"), cwd: (l) => l.prim, cmd: ["reset", "--hard"] },
  { name: "config", link: (l) => join(l.G, "config"), cwd: (l) => l.prim, cmd: ["config", "user.name", "x"] },
  { name: "worktree gitdir", link: (l) => join(l.WG, "gitdir"), cwd: (l) => l.wt, cmd: ["worktree", "list"] },
  {
    name: "objects/info/alternates",
    link: (l) => join(l.G, "objects", "info", "alternates"),
    cwd: (l) => l.wt,
    cmd: ["log", "-1"],
  },
  {
    name: "an object fan-out directory",
    link: (l) => join(l.G, "objects", "ab"),
    cwd: (l) => l.wt,
    cmd: ["commit", "--allow-empty", "-m", "q"],
    prep: (l) => rmSync(join(l.G, "objects", "ab"), { recursive: true, force: true }),
  },
  {
    name: "another worktree's admin directory",
    link: (l) => join(l.G, "worktrees", "other-wt"),
    cwd: (l) => l.wt,
    cmd: ["status"],
  },
  {
    name: "a logs directory",
    link: (l) => join(l.G, "logs"),
    cwd: (l) => l.wt,
    cmd: ["branch", "-f", "other", "HEAD"],
    prep: (l) => rmSync(join(l.G, "logs"), { recursive: true, force: true }),
  },
];

for (const c of CASES) {
  test(`symlink at ${c.name}: refused in both modes, the target is never touched, and no content of it is relayed`, async () => {
    for (const trust of MODES) {
      const l = lab(`${c.name.replace(/\W+/g, "_")}-${trust}`);
      mkdirSync(dirname(l.victim), { recursive: true });
      writeFileSync(l.secret, "SECRET-TOKEN-AAAA\nline2-BBBB\n");
      c.prep?.(l);
      const link = c.link(l);
      mkdirSync(dirname(link), { recursive: true });
      rmSync(link, { recursive: true, force: true });
      // links to an absent file (a write would create it) for write cases and to the secret for read cases
      symlinkSync(
        ["shallow", "info/grafts", "worktree HEAD", "packed-refs", "worktree gitdir"].some((n) => c.name.includes(n))
          ? l.secret
          : l.victim,
        link,
      );
      const r = await safeGit(c.cmd, { cwd: c.cwd(l), trust, timeoutMs: 20_000 });
      assert.equal(r.code, 128, `${trust} ${c.name}: ${r.stdout} ${r.stderr}`);
      assert.match(
        r.stderr,
        /refused: the repository's git directory contains .*(symbolic link|not a regular)/,
        `${trust} ${c.name}`,
      );
      assert.equal(existsSync(l.victim), false, `${trust} ${c.name}: the link target was created`);
      assert.doesNotMatch(r.stdout + r.stderr, /SECRET-TOKEN|BBBB/, `${trust} ${c.name}: leaked`);
      assert.equal(readFileSync(l.secret, "utf8"), "SECRET-TOKEN-AAAA\nline2-BBBB\n");
    }
  });
}

test("controls: raw git writes through an index link and quotes a linked file in its error, so the cases above are live", () => {
  const l = lab("control");
  mkdirSync(dirname(l.victim), { recursive: true });
  rmSync(join(l.WG, "index"), { force: true });
  symlinkSync(l.victim, join(l.WG, "index"));
  writeFileSync(join(l.wt, "f"), "n");
  sh("git add -A", l.wt);
  assert.equal(existsSync(l.victim), true, "raw git created the link target");
  writeFileSync(l.secret, "SECRET-TOKEN-AAAA\nline2-BBBB\n");
  rmSync(join(l.G, "packed-refs"), { force: true });
  symlinkSync(l.secret, join(l.G, "packed-refs"));
  let said = "";
  try {
    sh("git for-each-ref 2>&1", l.wt);
  } catch (e) {
    said = String((e as { stdout?: Buffer }).stdout ?? "");
  }
  assert.match(said, /line2|SECRET/, "raw git quotes a line of the linked file");
});

test("a FIFO or socket where a file belongs is refused (git would block reading it)", async () => {
  const l = lab("fifo");
  rmSync(join(l.WG, "index"), { force: true });
  execFileSync("mkfifo", [join(l.WG, "index")]);
  for (const trust of MODES) {
    const r = await safeGit(["status"], { cwd: l.wt, trust, timeoutMs: 5_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /index is not a regular file/);
  }
});

test("scanRepoTree: a clean repository passes (including linked worktrees, packed and loose refs); the entry limit fails closed", () => {
  const l = lab("clean");
  sh("git pack-refs --all && git branch loose1 && git tag t1", l.prim);
  const layout = { gitDir: l.G, commonDir: l.G };
  assert.equal(scanRepoTree(layout), null);
  assert.equal(scanRepoTree({ gitDir: l.WG, commonDir: l.G }), null);
  setTreeScanLimitForTests(3);
  assert.match(String(scanRepoTree(layout)), /too many entries/);
});

test("the stderr relayed to a caller is bounded: long lines are cut and the total is capped", () => {
  const long = `fatal: ${"x".repeat(5000)}`;
  const cut = limitStderr(`${long}\nshort`);
  assert.ok((cut.split("\n")[0]?.length ?? 0) < 1100);
  assert.match(cut, /line truncated/);
  assert.match(cut, /\nshort$/);
  const many = limitStderr(Array.from({ length: 5000 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n"));
  assert.ok(many.length < 70 * 1024);
  assert.match(many, /stderr truncated/);
  assert.equal(limitStderr("small"), "small");
});
