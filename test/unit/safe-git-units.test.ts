/**
 * T16 review round 2: the small pieces of safeGit that other tests only reach indirectly, pinned one by one
 * (listing failure, proxy pin, relocation by -C, option skipping, injected-config strip, diff flags, the synchronous
 * variant's refusals, spawn failures), plus the Herdr connection wiring and the fork-port digest catch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type RepoLayout,
  applyPinDelta,
  configEnv,
  contactsNetwork,
  diffing,
  discoverRepo,
  excludePathspecs,
  redirectsRepository,
  remoteAllowed,
  safeGit,
  safeGitEnv,
  safeGitSync,
  setConfigListLimitForTests,
  subcommandIndex,
  withoutInjectedConfig,
} from "../../src/git/safeGit.ts";
import { MemorySteeringLedger, applySteering, parseSteeringItem } from "../../src/orchestration/steering.ts";
import { loadHerdrConnection } from "../../src/runtime/herdr/herdrConnection.ts";

test("applyPinDelta moves a pin by exactly what the command changed, never by what else is in the config", () => {
  const row = (k: string, v: string) => `${k}\0${v}`;
  const pin = [row("remote.o.url", "u1"), row("remote.o.pushurl", "p1")].sort().join("\u0001");
  const out = applyPinDelta(pin, [{ key: "remote.o.url", value: "u1" }], [{ key: "remote.o.url", value: "u2" }]);
  assert.equal(out, [row("remote.o.pushurl", "p1"), row("remote.o.url", "u2")].sort().join("\u0001"));
  assert.equal(applyPinDelta("", [], [{ key: "remote.o.url", value: "u" }]), row("remote.o.url", "u"));
  assert.equal(
    applyPinDelta(
      pin,
      [],
      [
        { key: "core.filemode", value: "false" },
        { key: "branch.x.merge", value: "m" },
      ],
    ),
    pin,
  );
  assert.equal(applyPinDelta(row("remote.o.url", "u"), [{ key: "remote.o.url", value: "u" }], []), "");
});

test("remoteAllowed: exact match, or a prefix when the entry ends in *", () => {
  assert.equal(remoteAllowed("https://h/a.git", ["https://h/a.git"]), true);
  assert.equal(remoteAllowed("https://h/a.git.evil", ["https://h/a.git"]), false);
  assert.equal(remoteAllowed("https://h/org/x.git", ["https://h/org/*"]), true);
  assert.equal(remoteAllowed("https://h/other/x.git", ["https://h/org/*"]), false);
  assert.equal(remoteAllowed("https://h/org/x.git", []), false);
});

test("redirectsRepository sees --git-dir / --work-tree in either spelling, and only among git's own options", () => {
  assert.equal(redirectsRepository(["--git-dir", "/g", "status"], 2), true);
  assert.equal(redirectsRepository(["--git-dir=/g", "status"], 1), true);
  assert.equal(redirectsRepository(["--work-tree=/w", "status"], 1), true);
  assert.equal(
    redirectsRepository(["-C", "/x", "status", "--git-dir=/g"], 2),
    false,
    "after the subcommand it is the subcommand's own argument",
  );
  assert.equal(redirectsRepository(["status"], 0), false);
});

test("contactsNetwork: remote edits are local (Pi repairs a pin with them), remote update/prune/show are not", () => {
  const net = (args: string[]) => contactsNetwork(args, subcommandIndex(args));
  for (const a of [
    ["fetch"],
    ["pull"],
    ["push", "o"],
    ["ls-remote"],
    ["lfs", "locks"],
    ["-C", "d", "fetch"],
    ["remote", "update"],
    ["remote", "show", "o"],
    ["remote", "-v", "prune", "o"],
    ["remote", "set-head", "o", "-a"],
  ]) {
    assert.equal(net(a), true, a.join(" "));
  }
  for (const a of [
    ["remote"],
    ["remote", "-v"],
    ["remote", "add", "o", "u"],
    ["remote", "set-url", "o", "u"],
    ["remote", "rename", "a", "b"],
    ["remote", "remove", "o"],
    ["remote", "get-url", "o"],
    ["status"],
    ["config", "--get", "x"],
  ]) {
    assert.equal(net(a), false, a.join(" "));
  }
});

test("excludePathspecs spells nested repositories as literal, top-anchored exclusions", () => {
  assert.deepEqual(excludePathspecs(["sub", "a b/c"]), [":(exclude,top,literal)sub", ":(exclude,top,literal)a b/c"]);
});

test("safeGitEnv pins transports in both modes; operator keeps its own GIT_ALLOW_PROTOCOL, strict never does", () => {
  assert.equal(safeGitEnv({}, "strict").GIT_ALLOW_PROTOCOL, "https:ssh");
  assert.equal(safeGitEnv({ GIT_ALLOW_PROTOCOL: "ext" }, "strict").GIT_ALLOW_PROTOCOL, "https:ssh");
  assert.equal(safeGitEnv({}, "operator").GIT_ALLOW_PROTOCOL, "https:http:ssh:git");
  assert.equal(safeGitEnv({ GIT_ALLOW_PROTOCOL: "https" }, "operator").GIT_ALLOW_PROTOCOL, "https");
});

test("subcommandIndex skips git's own options, including --git-dir/--work-tree/--namespace with a separate value", () => {
  assert.equal(subcommandIndex(["status"]), 0);
  assert.equal(subcommandIndex(["-c", "a=b", "-C", "d", "status"]), 4);
  assert.equal(subcommandIndex(["--git-dir", "/g", "status"]), 2);
  assert.equal(subcommandIndex(["--work-tree", "/w", "log"]), 2);
  assert.equal(subcommandIndex(["--namespace", "n", "log"]), 2);
  assert.equal(subcommandIndex(["--no-pager", "--bare", "diff"]), 2);
});

test("diffing adds the no-ext-diff/no-textconv flags to diff, show and log only, after the subcommand", () => {
  assert.deepEqual(diffing(["diff", "HEAD"], 0), ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
  assert.deepEqual(diffing(["-C", "d", "show", "x"], 2), ["-C", "d", "show", "--no-ext-diff", "--no-textconv", "x"]);
  assert.deepEqual(diffing(["log"], 0), ["log", "--no-ext-diff", "--no-textconv"]);
  assert.deepEqual(diffing(["status"], 0), ["status"]);
});

test("withoutInjectedConfig removes every way to inject config and nothing else; configEnv adds only ours", () => {
  const out = withoutInjectedConfig({
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "k",
    GIT_CONFIG_VALUE_0: "v",
    GIT_CONFIG_KEY_12: "k",
    GIT_CONFIG_VALUE_12: "v",
    GIT_CONFIG_PARAMETERS: "'a=b'",
    GIT_CONFIG_GLOBAL: "/g",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_KEY_x: "kept-not-numeric",
  });
  assert.deepEqual(out, {
    PATH: "/bin",
    GIT_CONFIG_GLOBAL: "/g",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_KEY_x: "kept-not-numeric",
  });
  assert.deepEqual(configEnv([]), { GIT_CONFIG_COUNT: "0" });
});

function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-units-"));
  mkdirSync(join(root, "home"));
  const marks = join(root, "M");
  mkdirSync(marks);
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" });
  const hook = (name: string) => {
    mkdirSync(join(root, "hp"), { recursive: true });
    const p = join(root, "hp", name);
    writeFileSync(p, `#!/bin/sh\ntouch '${marks}/${name}'\ncat\n`);
    chmodSync(p, 0o755);
    return p;
  };
  sh(
    "git init -q -b main clean && git init -q -b main dirty && for d in clean dirty; do (cd $d && git config user.name t && git config user.email t@t && echo a > f.txt && git add . && git commit -qm i); done",
  );
  return {
    root,
    marks,
    sh,
    hook,
    seen: () => readdirSync(marks).sort(),
    reset: () => {
      for (const n of readdirSync(marks)) rmSync(join(marks, n));
    },
  };
}

test("-C relocates the config that is read: a planted repository named by -C (absolute or relative) is neutralised", async () => {
  const l = lab();
  try {
    const clean = l.hook("clean");
    l.sh(
      `git config filter.e.clean '${clean}' && echo '* filter=e' > .git/info/attributes && echo changed > f.txt`,
      join(l.root, "dirty"),
    );
    for (const target of [join(l.root, "dirty"), "../dirty"]) {
      for (const trust of ["strict", "operator"] as const) {
        l.reset();
        await safeGit(["-C", target, "add", "-A"], { cwd: join(l.root, "clean"), trust });
        assert.deepEqual(l.seen(), [], `${trust} -C ${target}`);
        l.sh("git reset -q", join(l.root, "dirty"));
      }
    }
    // control: the relocation really reaches that repository (status works there and sees its change)
    const s = await safeGit(["-C", "../dirty", "status", "--porcelain"], {
      cwd: join(l.root, "clean"),
      trust: "strict",
    });
    assert.match(s.stdout, /f\.txt/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("spawn failures (an argument too large for exec) are results, never rejections, for async and sync", async () => {
  const l = lab();
  try {
    const big = "z".repeat(140_000); // above the 128 KiB limit of one argument
    for (const trust of ["strict", "operator"] as const) {
      const r = await safeGit(["status", big], { cwd: join(l.root, "dirty"), trust, timeoutMs: 30_000 });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /E2BIG|refused/);
      const s = safeGitSync(["status", big], { cwd: join(l.root, "dirty"), trust, timeoutMs: 30_000 });
      assert.notEqual(s.code, 0);
      assert.match(s.stderr, /E2BIG|refused/);
    }
    const missing = await safeGit(["status"], { cwd: join(l.root, "nope") });
    assert.notEqual(missing.code, 0, "an unusable cwd is a result");
    // a 140 000-byte subsection name in the repository's config is simply not allow-listed: it costs nothing
    writeFileSync(
      join(l.root, "dirty", ".git", "config"),
      `${execFileSync("cat", [join(l.root, "dirty", ".git", "config")]).toString()}[filter "${big}"]\n\tclean = /bin/true\n`,
    );
    const ok = await safeGit(["status", "--porcelain"], {
      cwd: join(l.root, "dirty"),
      trust: "strict",
      timeoutMs: 30_000,
    });
    assert.equal(ok.code, 0, ok.stderr);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a repository config that git cannot read, or that is too large to list, is refused (async and sync), never passed through", async () => {
  const l = lab();
  try {
    const d = join(l.root, "dirty");
    const cfg = join(d, ".git", "config");
    const good = execFileSync("cat", [cfg]).toString();
    const hook = l.hook("clean");
    // a syntax error AFTER a planted driver: raw git cannot even start, and the allow-list must not guess what it meant
    writeFileSync(cfg, `${good}[filter "e"]\n\tclean = ${hook}\n[broken\n`);
    for (const trust of ["strict", "operator"] as const) {
      const r = await safeGit(["status", "--porcelain"], { cwd: d, trust });
      assert.equal(r.code, 128);
      assert.match(r.stderr, /refused: the repository config is unreadable/);
      const s = safeGitSync(["status", "--porcelain"], { cwd: d, trust, timeoutMs: 20_000 });
      assert.equal(s.code, 128);
      assert.match(s.stderr, /unreadable/);
    }
    writeFileSync(cfg, `${good}[filter "e"]\n\tclean = ${hook}\n${"[x]\n\ty = ".concat("1\n").repeat(2000)}`);
    setConfigListLimitForTests(1024);
    try {
      for (const trust of ["strict", "operator"] as const) {
        const r = await safeGit(["status", "--porcelain"], { cwd: d, trust });
        assert.equal(r.code, 128);
        assert.match(r.stderr, /refused: the repository config is too large/);
        assert.deepEqual(l.seen(), []);
      }
    } finally {
      setConfigListLimitForTests(64 * 1024 * 1024);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("safeGitSync: planted driver, proxy, uploadpack and fsmonitor never run; refusals match the async variant", () => {
  const l = lab();
  try {
    const d = join(l.root, "dirty");
    const up = l.hook("uploadpack");
    const clean = l.hook("clean");
    const proxy = l.hook("proxy");
    const fsm = l.hook("fsm");
    l.sh(
      `git config remote.o.url ${d} && git config remote.o.uploadpack '${up}' && git config filter.e.clean '${clean}' && git config core.gitProxy '${proxy}' && git config core.fsmonitor '${fsm}' && echo '* filter=e' > .git/info/attributes && echo changed > f.txt`,
      d,
    );
    for (const trust of ["strict", "operator"] as const) {
      l.reset();
      safeGitSync(["fetch", "o"], { cwd: d, trust, timeoutMs: 20_000 });
      safeGitSync(["add", "-A"], { cwd: d, trust, timeoutMs: 20_000 });
      safeGitSync(["status", "--porcelain"], { cwd: d, trust, timeoutMs: 20_000 });
      assert.deepEqual(l.seen(), [], `${trust}: sync ran ${l.seen().join(",")}`);
      l.sh("git -c filter.e.clean= -c filter.e.smudge= reset -q", d);
      l.reset();
      safeGitSync(["ls-remote", "git://example.invalid/x.git"], { cwd: d, trust, timeoutMs: 20_000 });
      assert.deepEqual(l.seen(), [], `${trust}: sync ls-remote ran ${l.seen().join(",")}`);
    }
    const gone = safeGitSync(["status"], { cwd: join(l.root, "nope"), trust: "strict", timeoutMs: 5_000 });
    assert.notEqual(gone.code, 0);
    const redirected = safeGitSync(["--git-dir", `${d}/.git`, "status"], {
      cwd: l.root,
      trust: "strict",
      timeoutMs: 5_000,
    });
    assert.equal(redirected.code, 128);
    assert.match(redirected.stderr, /refused/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("discoverRepo mirrors git: .git dir, gitdir: file, commondir, bare, skipped empty .git dir, fatal bad .git file, none", () => {
  const l = lab();
  try {
    const found = (p: string): RepoLayout => {
      const r = discoverRepo(p);
      assert.ok(r !== null && r !== "invalid", `${p}: ${String(r)}`);
      return r as RepoLayout;
    };
    const clean = join(l.root, "clean");
    mkdirSync(join(clean, "sub", "deeper"), { recursive: true });
    const main = found(join(clean, "sub", "deeper"));
    assert.equal(main.workTree, clean);
    assert.equal(main.gitDir, join(clean, ".git"));
    assert.equal(main.commonDir, join(clean, ".git"));
    l.sh(`git worktree add -q ${join(l.root, "wt")} -b wtb`, clean);
    const wt = found(join(l.root, "wt"));
    assert.equal(wt.workTree, join(l.root, "wt"));
    assert.equal(wt.gitDir, join(clean, ".git", "worktrees", "wt"));
    assert.equal(wt.commonDir, join(clean, ".git"));
    l.sh(`git clone -q --bare ${clean} ${join(l.root, "bare.git")}`);
    assert.equal(found(join(l.root, "bare.git")).workTree, null);
    // planted core.worktree / core.bare cannot move the search: they are never read
    l.sh(`git config core.worktree ${l.root} && git config core.bare true`, clean);
    assert.equal(found(clean).workTree, clean);
    mkdirSync(join(l.root, "plain", ".git"), { recursive: true });
    // an empty .git directory is not a repository: git goes on upward (and finds none inside the lab)
    const up = discoverRepo(join(l.root, "plain"));
    assert.ok(up === null || (up !== "invalid" && !up.workTree?.startsWith(l.root)));
    mkdirSync(join(l.root, "broken"));
    writeFileSync(join(l.root, "broken", ".git"), "not a pointer");
    assert.equal(discoverRepo(join(l.root, "broken")), "invalid");
    writeFileSync(join(l.root, "gone"), "");
    mkdirSync(join(l.root, "dangling"));
    writeFileSync(join(l.root, "dangling", ".git"), `gitdir: ${join(l.root, "nowhere")}\n`);
    assert.equal(discoverRepo(join(l.root, "dangling")), "invalid");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

// ─── Herdr connection wiring ──────────────────────────────────────────────────────────────────────────────────────

test("loadHerdrConnection applies the key-file rules end to end: directory, oversize, mode, foreign owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-key-"));
  try {
    const yaml = (key: string) =>
      writeFileSync(join(dir, "engineering.yaml"), `herdr:\n  url: https://cp.example\n  api_key_file: ${key}\n`);
    const good = join(dir, "good");
    writeFileSync(good, "k-for-test\n", { mode: 0o600 });
    chmodSync(good, 0o600);
    yaml(good);
    assert.ok((await loadHerdrConnection(dir)).connection, "control: a 0600 file owned by the user is accepted");

    yaml(dir);
    const asDir = await loadHerdrConnection(dir);
    assert.equal(asDir.connection, null);
    assert.match(asDir.notes.join(" "), /regular file/);

    const big = join(dir, "big");
    writeFileSync(big, "k".repeat(4097), { mode: 0o600 });
    chmodSync(big, 0o600);
    yaml(big);
    assert.match((await loadHerdrConnection(dir)).notes.join(" "), /too large/);

    const open = join(dir, "open");
    writeFileSync(open, "k", { mode: 0o644 });
    chmodSync(open, 0o644);
    yaml(open);
    assert.match((await loadHerdrConnection(dir)).notes.join(" "), /group or others/);

    yaml(good);
    const real = process.getuid;
    process.getuid = () => 4_000_000;
    try {
      const foreign = await loadHerdrConnection(dir);
      assert.equal(foreign.connection, null);
      assert.match(foreign.notes.join(" "), /owned by the current user/);
    } finally {
      process.getuid = real;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fork port whose digest() throws or rejects is stale (fail closed), and the request is never applied", async () => {
  const wire = {
    steering_id: "st-fork",
    action: "fork",
    target: { node_id: "task:t1", expected_digest: "D1" },
    instruction: null,
    params: { base_sha: "a".repeat(40) },
    proposed_by: { id: "a" },
    confirmed_by: { id: "b" },
    room: { id: "r" },
    trust: "untrusted",
    valid_until_epoch: 10_000,
  };
  const item = parseSteeringItem(wire);
  assert.ok(item);
  for (const digest of [
    () => {
      throw new Error("boom");
    },
    async () => {
      throw new Error("boom");
    },
  ]) {
    const applied: string[] = [];
    const ack = await applySteering(
      item,
      {
        now: () => 900,
        resolve: () => null,
        steerRunning: () => "delivered",
        resumeMission: async () => ({ changed: false }),
        forks: {
          knows: () => true,
          digest,
          apply: async (i) => {
            applied.push(i.steeringId);
            return { outcome: "applied", note: "ok" };
          },
        },
      },
      new MemorySteeringLedger(),
    );
    assert.equal(ack?.outcome, "stale");
    assert.deepEqual(applied, []);
  }
});
