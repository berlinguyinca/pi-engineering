/**
 * T16 round 5: what the caller can put on the command line, scp-like remotes, the git version Pi needs, and
 * repositories that use sha256 object ids.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  forgetRemotePinsForTests,
  refusedOption,
  safeGit,
  stateHooks,
  testHooks,
  urlArguments,
} from "../../src/git/safeGit.ts";

const MODES = ["strict", "operator"] as const;
let root = "";
const prior: Record<string, string | undefined> = {};
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-args2-"));
  stateHooks.stateRoot = join(root, "state");
  for (const k of KEYS) prior[k] = process.env[k];
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(root, "operator.gitconfig");
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = op\n\temail = op@x\n");
});
afterEach(() => {
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  stateHooks.stateRoot = undefined;
  testHooks.gitVersion = undefined;
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const sh = (c: string, cwd = root) =>
  execFileSync("bash", ["-c", c], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  }).toString();

let n = 0;
function repo(remote = "https://127.0.0.1:1/org/repo.git") {
  const dir = join(root, `r${n++}`);
  mkdirSync(dir);
  sh(
    `git init -q -b main . && git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one && git remote add origin ${remote}`,
    dir,
  );
  return dir;
}
function hook(name: string) {
  const marks = join(root, `marks-${name}`);
  mkdirSync(marks, { recursive: true });
  const script = join(root, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch "${marks}/ran-$$"\nexit 0\n`);
  chmodSync(script, 0o755);
  return { script, ran: () => existsSync(marks) && sh(`ls ${marks}`).trim().length > 0, marks };
}

// ─── caller-supplied -c ─────────────────────────────────────────────────────────────────────────────────────────

test("a caller's own -c cannot override a setting Pi forces or select a program (both modes): the hook never runs", async () => {
  for (const trust of MODES) {
    const r = repo();
    const h = hook(`hooks-${trust}`);
    mkdirSync(join(root, `hp-${trust}`));
    writeFileSync(join(root, `hp-${trust}`, "pre-commit"), `#!/bin/sh\ntouch ${h.marks}/pre-commit-ran\n`);
    chmodSync(join(root, `hp-${trust}`, "pre-commit"), 0o755);
    for (const args of [
      ["-c", `core.hooksPath=${join(root, `hp-${trust}`)}`, "commit", "--allow-empty", "-m", "x"],
      ["-c", `core.fsmonitor=${h.script}`, "status"],
      ["-c", `core.attributesFile=${h.script}`, "status"],
      ["-c", `core.sshCommand=${h.script}`, "status"],
      ["-c", "protocol.ext.allow=always", "status"],
      ["-c", "lfs.url=http://127.0.0.1:1/x", "status"],
      ["-c", `include.path=${h.script}`, "status"],
      ["-c", `alias.st=!${h.script}`, "status"],
      ["-ccore.hooksPath=/tmp/x", "status"],
      [`--config-env=core.hooksPath=HOME`, "status"],
    ]) {
      const res = await safeGit(args, { cwd: r, trust, timeoutMs: 10_000 });
      assert.equal(res.code, 128, `${trust} ${args.join(" ")}: ${res.stderr}`);
      assert.match(res.stderr, /^refused: /);
    }
    assert.equal(h.ran(), false, `${trust}: a program ran`);
  }
});

test("harmless caller -c settings (identity, quoting) still work", async () => {
  for (const trust of MODES) {
    const r = repo();
    const res = await safeGit(
      ["-c", "user.name=Someone", "-c", "user.email=s@x", "commit", "--allow-empty", "-m", "two"],
      {
        cwd: r,
        trust,
      },
    );
    assert.equal(res.code, 0, res.stderr);
  }
});

test("refusedOption names the option, and leaves ordinary arguments alone", () => {
  assert.match(String(refusedOption(["-c", "core.hooksPath=/x", "status"], 2)), /core\.hooksPath/);
  assert.equal(refusedOption(["-c", "user.name=x", "status"], 2), null);
  assert.equal(refusedOption(["status", "--short"], 0), null);
  assert.match(String(refusedOption(["fetch", "--upload-pack=x", "origin"], 0)), /--upload-pack/);
  assert.match(String(refusedOption(["fetch", "--upload-pack", "x", "origin"], 0)), /--upload-pack/);
  assert.match(String(refusedOption(["push", "--receive-pack=x", "origin"], 0)), /--receive-pack/);
  assert.match(String(refusedOption(["ls-remote", "--exec=x", "origin"], 0)), /--exec/);
  assert.match(String(refusedOption(["clone", "-u", "x", "url"], 0)), /upload-pack/);
  assert.equal(refusedOption(["push", "-u", "origin", "main"], 0), null);
  assert.equal(refusedOption(["log", "--", "--upload-pack=file"], 0), null, "after -- it is a path");
});

test("program-naming options of the network commands are refused before git runs", async () => {
  for (const trust of MODES) {
    const r = repo();
    const h = hook(`prog-${trust}`);
    for (const args of [
      ["fetch", `--upload-pack=${h.script}`, "origin"],
      ["fetch", "--upload-pack", h.script, "origin"],
      ["pull", `--upload-pack=${h.script}`, "origin"],
      ["push", `--receive-pack=${h.script}`, "origin", "main"],
      ["ls-remote", `--upload-pack=${h.script}`, "origin"],
      ["clone", `--upload-pack=${h.script}`, "https://127.0.0.1:1/x.git", join(root, "dest")],
      ["clone", "-u", h.script, "https://127.0.0.1:1/x.git", join(root, "dest2")],
    ]) {
      const res = await safeGit(args, { cwd: r, trust, timeoutMs: 10_000 });
      assert.equal(res.code, 128, `${trust} ${args.join(" ")}: ${res.stderr}`);
      assert.match(res.stderr, /names a program git would run|upload-pack/);
    }
    assert.equal(h.ran(), false);
  }
});

// ─── scp-like remotes ───────────────────────────────────────────────────────────────────────────────────────────

test("scp-like arguments (host:path, user@host:path) are URLs: the operator's allow-list applies to them", async () => {
  writeFileSync(
    process.env.GIT_CONFIG_GLOBAL as string,
    "[user]\n\tname = op\n\temail = op@x\n[pi]\n\tallowedRemote = https://127.0.0.1:1/*\n",
  );
  for (const trust of MODES) {
    const r = repo();
    for (const url of ["git@evil.example:org/x.git", "evil.example:org/x.git"]) {
      for (const cmd of ["fetch", "ls-remote", "pull"]) {
        const res = await safeGit([cmd, url], { cwd: r, trust, timeoutMs: 10_000 });
        assert.equal(res.code, 128, `${trust} ${cmd} ${url}: ${res.stderr}`);
        assert.match(res.stderr, /not in the operator's pi\.allowedRemote list/, `${trust} ${cmd} ${url}`);
      }
    }
    const clone = await safeGit(["clone", "git@evil.example:org/x.git", join(root, `c-${trust}`)], { cwd: r, trust });
    assert.equal(clone.code, 128);
    assert.match(clone.stderr, /not in the operator's pi\.allowedRemote list/);
    // a refspec (main:main) is not a URL, and a remote NAME is not either
    const ok = await safeGit(["fetch", "origin", "main:refs/remotes/o/main"], { cwd: r, trust, timeoutMs: 10_000 });
    assert.doesNotMatch(ok.stderr, /allowedRemote/, `${trust}: ${ok.stderr}`);
  }
});

test("urlArguments: only the repository argument of a network command is tested for the scp form", () => {
  const names = new Set(["origin"]);
  assert.deepEqual(urlArguments(["fetch", "git@h:p.git"], 0, names), ["git@h:p.git"]);
  assert.deepEqual(urlArguments(["fetch", "origin", "a:b"], 0, names), []);
  assert.deepEqual(urlArguments(["push", "origin", "main:main"], 0, names), []);
  assert.deepEqual(urlArguments(["clone", "h:p.git", "dest"], 0, names), ["h:p.git"]);
  assert.deepEqual(urlArguments(["status", "a:b"], 0, names), []);
});

// ─── git version and sha256 ─────────────────────────────────────────────────────────────────────────────────────

test("a git older than 2.40 is refused with the reason (no GIT_ATTR_SOURCE: attributes could not be cut off)", async () => {
  const r = repo();
  for (const v of ["git version 2.39.5", "git version 2.12.0", "git version 1.9.1", "something else"]) {
    testHooks.gitVersion = v;
    const res = await safeGit(["status"], { cwd: r });
    assert.equal(res.code, 128, v);
    assert.match(res.stderr, /older than 2\.40|could not be determined/, v);
  }
  for (const v of ["git version 2.40.0", "git version 2.43.0", "git version 3.0.1", "git version 2.40.1.windows.1"]) {
    testHooks.gitVersion = v;
    assert.equal((await safeGit(["status"], { cwd: r })).code, 0, v);
  }
});

test("a sha256 repository works in both modes, and its own empty tree cuts attributes off (a sha1 id would be an unknown object)", async () => {
  const dir = join(root, "sha256");
  mkdirSync(dir);
  const evil = hook("evil-clean");
  writeFileSync(
    process.env.GIT_CONFIG_GLOBAL as string,
    `[user]\n\tname = op\n\temail = op@x\n[filter "evil"]\n\tclean = ${evil.script}\n`,
  );
  sh(
    "git init -q --object-format=sha256 -b main . && git config user.name t && git config user.email t@t && echo hi > a.txt && git add -A && git commit -qm one",
    dir,
  );
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
  for (const trust of MODES) {
    writeFileSync(join(dir, "a.txt"), `changed ${trust}\n`);
    for (const args of [
      ["status", "--short"],
      ["diff"],
      ["add", "-A"],
      ["commit", "-m", `x ${trust}`],
      ["log", "--oneline"],
    ]) {
      const res = await safeGit(args, { cwd: dir, trust, timeoutMs: 20_000 });
      assert.equal(res.code, 0, `${trust} ${args.join(" ")}: ${res.stderr}`);
    }
  }
  assert.equal(evil.ran(), false, "the operator's filter was selected by the repository's .gitattributes");
  assert.match(sh("git rev-parse HEAD", dir).trim(), /^[0-9a-f]{64}$/);
});

test("safeGit does not run its synchronous preparation inside the caller's own turn", async () => {
  const r = repo();
  let planned = false;
  testHooks.afterPlan = () => {
    planned = true;
  };
  try {
    const pending = safeGit(["status", "--short"], { cwd: r });
    assert.equal(planned, false, "prepare ran before safeGit returned its promise");
    assert.equal((await pending).code, 0);
    assert.equal(planned, true);
  } finally {
    testHooks.afterPlan = undefined;
  }
});
