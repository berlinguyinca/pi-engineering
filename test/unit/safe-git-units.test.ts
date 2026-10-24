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
  configEnv,
  diffing,
  planFromListing,
  remoteExecKeys,
  safeGit,
  safeGitSync,
  subcommandIndex,
  withoutInjectedConfig,
} from "../../src/git/safeGit.ts";
import { MemorySteeringLedger, applySteering, parseSteeringItem } from "../../src/orchestration/steering.ts";
import { loadHerdrConnection } from "../../src/runtime/herdr/herdrConnection.ts";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const rec = (scope: string, key: string, value = "v") => `${scope}\0file:/r/${scope}\0${key}\n${value}\0`;

test("planFromListing: a failed or truncated listing is refused, not planned around", () => {
  const bad = planFromListing({ code: 1, stdout: "", stderr: "x" }, "/r", "strict", {}, null);
  assert.match(bad.unreadable ?? "", /unreadable/);
  const cut = planFromListing({ code: 0, stdout: "", stderr: "", truncated: true }, "/r", "strict", {}, null);
  assert.match(cut.unreadable ?? "", /too large/);
  assert.equal(planFromListing(ok(rec("local", "user.name")), "/r", "strict", {}, null).unreadable, undefined);
});

test("planFromListing: GIT_PROXY_COMMAND is pinned unless the operator has one (env or trusted config)", () => {
  const none = ok(rec("local", "core.gitProxy", "/evil"));
  assert.equal(planFromListing(none, "/r", "strict", {}, null).extraEnv.GIT_PROXY_COMMAND, "false");
  assert.equal(planFromListing(none, "/r", "operator", {}, null).extraEnv.GIT_PROXY_COMMAND, "false");
  assert.deepEqual(planFromListing(none, "/r", "operator", { GIT_PROXY_COMMAND: "corp-proxy" }, null).extraEnv, {});
  assert.equal(
    planFromListing(none, "/r", "strict", { GIT_PROXY_COMMAND: "corp-proxy" }, null).extraEnv.GIT_PROXY_COMMAND,
    "false",
    "strict mode never honours the operator's proxy",
  );
  const trusted = ok(rec("global", "core.gitProxy", "corp") + rec("local", "core.gitProxy", "/evil"));
  assert.deepEqual(planFromListing(trusted, "/r", "operator", {}, null).extraEnv, {});
  assert.equal(planFromListing(trusted, "/r", "strict", {}, null).extraEnv.GIT_PROXY_COMMAND, "false");
});

test("planFromListing: oversized keys and driver floods are refused instead of overflowing the environment", () => {
  const huge = ok(rec("local", `filter.${"a".repeat(40_000)}.clean`));
  assert.match(planFromListing(huge, "/r", "strict", {}, null).unreadable ?? "", /too long/);
  const many = ok(
    Array.from({ length: 20_000 }, (_, i) => rec("local", `filter.${"n".repeat(40)}${i}.clean`)).join(""),
  );
  assert.match(planFromListing(many, "/r", "strict", {}, null).unreadable ?? "", /too many/);
});

test("remoteExecKeys: the operator's own (trusted-scope) keys are not reported, the repository's are, in both modes' terms", () => {
  const e = [
    { scope: "global", origin: "f", key: "remote.o.uploadpack", value: "x" },
    { scope: "local", origin: "f", key: "remote.o.uploadpack", value: "x" },
    { scope: "worktree", origin: "f", key: "http.sslVerify", value: "false" },
    { scope: "global", origin: "f", key: "http.proxy", value: "corp" },
  ];
  assert.deepEqual(remoteExecKeys(e, "operator"), ["remote.o.uploadpack", "http.sslVerify"]);
  assert.deepEqual(remoteExecKeys(e, "strict"), [
    "remote.o.uploadpack",
    "remote.o.uploadpack",
    "http.sslVerify",
    "http.proxy",
  ]);
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

test("spawn failures (argument or environment too large) are results, never rejections, for async and sync", async () => {
  const l = lab();
  try {
    // 140 000 bytes in one subsection name exceeds the 128 KiB limit of a single environment string
    const name = "z".repeat(140_000);
    writeFileSync(
      join(l.root, "dirty", ".git", "config"),
      `${execFileSync("cat", [join(l.root, "dirty", ".git", "config")]).toString()}[filter "${name}"]\n\tclean = /bin/true\n`,
    );
    for (const trust of ["strict", "operator"] as const) {
      const r = await safeGit(["status", "--porcelain"], { cwd: join(l.root, "dirty"), trust, timeoutMs: 30_000 });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /refused/);
      const s = safeGitSync(["status", "--porcelain"], { cwd: join(l.root, "dirty"), trust, timeoutMs: 30_000 });
      assert.notEqual(s.code, 0);
      assert.match(s.stderr, /refused/);
    }
    const missing = await safeGit(["status"], { cwd: join(l.root, "nope") });
    assert.notEqual(missing.code, 0, "an unusable cwd is a result");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("safeGitSync refuses like the async variant: network keys, unreadable config, planted driver, planted proxy", () => {
  const l = lab();
  try {
    const d = join(l.root, "dirty");
    const up = l.hook("uploadpack");
    const clean = l.hook("clean");
    const proxy = l.hook("proxy");
    l.sh(
      `git config remote.o.url ${d} && git config remote.o.uploadpack '${up}' && git config filter.e.clean '${clean}' && git config core.gitProxy '${proxy}' && echo '* filter=e' > .git/info/attributes && echo changed > f.txt`,
      d,
    );
    for (const trust of ["strict", "operator"] as const) {
      l.reset();
      const f = safeGitSync(["fetch", "o"], { cwd: d, trust, timeoutMs: 20_000 });
      assert.equal(f.code, 128);
      assert.match(f.stderr, /refused/);
      safeGitSync(["add", "-A"], { cwd: d, trust, timeoutMs: 20_000 });
      assert.deepEqual(l.seen(), [], `${trust}: sync add ran ${l.seen().join(",")}`);
      l.sh("git -c filter.e.clean= -c filter.e.smudge= reset -q", d);
      l.reset();
      safeGitSync(["ls-remote", "git://example.invalid/x.git"], {
        cwd: join(l.root, "clean"),
        trust,
        timeoutMs: 20_000,
      });
      assert.deepEqual(l.seen(), [], `${trust}: sync ran ${l.seen().join(",")}`);
    }
    const gone = safeGitSync(["status"], { cwd: join(l.root, "nope"), trust: "strict", timeoutMs: 5_000 });
    assert.equal(gone.code, 128);
    assert.match(gone.stderr, /refused/);
    l.sh(`git config core.gitProxy '${proxy}'`, join(l.root, "clean"));
    l.reset();
    safeGitSync(["ls-remote", "git://example.invalid/x.git"], {
      cwd: join(l.root, "clean"),
      trust: "operator",
      timeoutMs: 20_000,
    });
    assert.deepEqual(l.seen(), [], "planted gitProxy did not run in the sync variant");
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
