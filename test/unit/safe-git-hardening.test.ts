/**
 * T16 H5: planted repository-local execution vectors (filter drivers, textconv, external diff, merge drivers,
 * fsmonitor, hooks, gpg, sshCommand, credential helpers, info/attributes) must not run through safeGit.
 * A raw `git` control run proves each payload is live, so the assertions cannot pass vacuously.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliForkGit } from "../../src/git/forkGit.ts";
import {
  type GitTrust,
  neutralisers,
  parseScopedConfig,
  safeGit,
  safeGitEnv,
  setConfigListLimitForTests,
} from "../../src/git/safeGit.ts";

const sh = (cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();

interface Fixture {
  root: string;
  primary: string;
  linked: string;
  marks: string;
  seen(): string[];
  reset(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "safe-git-"));
  const home = join(root, "home");
  mkdirSync(home);
  const marks = join(root, "MARK");
  mkdirSync(marks);
  const env = { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  sh(
    `git init -q -b main primary && cd primary && git config user.name t && git config user.email t@t && echo a > f.txt && git add . && git commit -qm init && git branch other && git init -q --bare ../remote.git && git remote add origin ../remote.git && git push -q origin main && git worktree add -q -b work ../linked HEAD`,
    root,
    env,
  );
  const fakeBin = join(root, "fake");
  writeFileSync(join(fakeBin), `#!/bin/sh\ntouch ${marks}/fakebin\nexit 1\n`);
  chmodSync(fakeBin, 0o755);
  // The planting is done the way a worker would: from inside the linked worktree, via the shared config.
  const M = marks;
  sh(
    [
      `git config core.fsmonitor "sh -c 'touch ${M}/fsmonitor' --"`,
      `git config filter.x.clean "sh -c 'touch ${M}/filter-clean; cat'"`,
      `git config filter.x.smudge "sh -c 'touch ${M}/filter-smudge; cat'"`,
      `git config filter.y.process "sh -c 'touch ${M}/filter-process'"`,
      `git config filter.y.required true`,
      `git config diff.x.textconv "sh -c 'touch ${M}/textconv; cat \\"\\$1\\"' --"`,
      `git config diff.x.command "sh -c 'touch ${M}/diff-external' --"`,
      `git config merge.x.driver "sh -c 'touch ${M}/mergedriver; false' --"`,
      `git config commit.gpgsign true`,
      `git config gpg.program ${fakeBin}`,
      `git config core.sshCommand ${fakeBin}`,
      `git config credential.helper "!touch ${M}/credhelper; :"`,
      `git config core.editor "touch ${M}/editor"`,
      `git config core.alternateRefsCommand "touch ${M}/altrefs"`,
      `git config remote.origin.uploadpack "touch ${M}/uploadpack; git-upload-pack"`,
      `CD=$(git rev-parse --git-common-dir)`,
      `mkdir -p $CD/info $CD/hooks`,
      `printf '* filter=x diff=x merge=x\\n*.proc filter=y\\n' >> $CD/info/attributes`,
      `for h in pre-commit prepare-commit-msg commit-msg post-commit post-checkout post-merge pre-merge-commit pre-push post-rewrite reference-transaction post-index-change; do printf '#!/bin/sh\\ntouch ${M}/hook-%s\\n' $h > $CD/hooks/$h; chmod +x $CD/hooks/$h; done`,
    ].join("\n"),
    linked,
    env,
  );
  const f: Fixture = {
    root,
    primary,
    linked,
    marks,
    seen: () => readdirSync(marks).sort(),
    reset: () => {
      for (const n of readdirSync(marks)) rmSync(join(marks, n), { force: true });
    },
  };
  return f;
}

// The operator's own global config would otherwise leak into assertions (and into the control).
process.env.GIT_CONFIG_NOSYSTEM = "1";

const MODES: GitTrust[] = ["strict", "operator"];

test("control: the planted payloads really run under raw git (the tests below are not vacuous)", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.linked, "f.txt"), "b\n");
    const env = { HOME: join(f.root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    sh("git status --porcelain || true", f.linked, env);
    sh("git show HEAD || true", f.primary, env);
    sh("git worktree add -q ../ctl -b ctl HEAD || true", f.primary, env);
    sh("git fetch -q origin || true", f.primary, env);
    const seen = f.seen();
    for (const want of ["filter-clean", "fsmonitor", "textconv", "filter-smudge", "uploadpack"]) {
      assert.ok(seen.includes(want), `raw git should have run ${want}; saw ${seen.join(",")}`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const trust of MODES) {
  test(`safeGit (${trust}) runs none of the planted drivers, hooks or helpers`, async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.linked, "f.txt"), "b\n");
      writeFileSync(join(f.linked, "untracked.txt"), "u\n");
      writeFileSync(join(f.linked, "a.proc"), "p\n");
      const run = async (args: string[], cwd: string) => {
        const r = await safeGit(args, { cwd, trust });
        return r;
      };
      const probes: Array<[string, string[], string]> = [
        ["status (linked)", ["status", "--porcelain", "--untracked-files=all"], f.linked],
        ["status (primary)", ["status", "--porcelain"], f.primary],
        ["diff HEAD (linked)", ["diff", "--numstat", "HEAD"], f.linked],
        ["diff (linked)", ["diff", "HEAD"], f.linked],
        ["show", ["show", "--format=", "--patch", "HEAD"], f.primary],
        ["log -p", ["log", "-p", "-1"], f.primary],
        ["add -A (linked)", ["add", "-A"], f.linked],
        ["reset --hard (linked)", ["reset", "--hard", "HEAD"], f.linked],
        ["worktree add", ["worktree", "add", "-q", join(f.root, "new"), "-b", "nb", "HEAD"], f.primary],
        ["revert", ["revert", "--no-edit", "HEAD"], f.primary],
        ["merge", ["merge", "--no-ff", "-m", "x", "other"], f.primary],
        ["worktree remove", ["worktree", "remove", "--force", join(f.root, "new")], f.primary],
      ];
      for (const [name, args, cwd] of probes) {
        f.reset();
        await run(args, cwd);
        assert.deepEqual(f.seen(), [], `${name} ran planted code: ${f.seen().join(",")}`);
      }
      // a per-remote upload-pack command cannot be overridden by -c, so network operations are refused instead
      for (const sub of [
        ["fetch", "origin"],
        ["ls-remote", "origin"],
        ["push", "origin", "main"],
      ]) {
        f.reset();
        const r = await run(sub, f.primary);
        assert.notEqual(r.code, 0, `${sub[0]} must refuse while remote.origin.uploadpack is planted`);
        assert.match(r.stderr, /refused/);
        assert.deepEqual(f.seen(), [], `${sub[0]} ran planted code`);
      }
      // commit with a dirty tree: hooks, gpg, editor must stay quiet and the commit must still be made
      f.reset();
      writeFileSync(join(f.linked, "g.txt"), "g\n");
      await run(["add", "g.txt"], f.linked);
      const c = await run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], f.linked);
      assert.equal(c.code, 0, c.stderr);
      assert.deepEqual(f.seen(), [], `commit ran planted code: ${f.seen().join(",")}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("operator mode keeps the operator's own global config and neutralises only the repository's", () => {
  const entries = parseScopedConfig(
    [
      "global\0filter.lfs.clean\ngit-lfs clean -- %f",
      "global\0credential.helper\nstore",
      "global\0user.name\nOp",
      "local\0filter.lfs.clean\ntouch /x",
      "local\0filter.evil.smudge\ntouch /y",
      "local\0credential.helper\n!touch /z",
      "",
    ].join("\0"),
  );
  assert.equal(entries.length, 6);
  const op = neutralisers(entries, "operator");
  const pairs = op.map((c) => `${c.key}=${c.value}`);
  assert.ok(pairs.includes("filter.lfs.clean=git-lfs clean -- %f"), "operator's lfs filter is restored");
  assert.ok(pairs.includes("filter.evil.smudge="), "repo-only filter is blanked");
  assert.deepEqual(
    pairs.filter((p) => p.startsWith("credential.helper=")),
    ["credential.helper=", "credential.helper=store"],
    "reset then the operator's own helper",
  );
  assert.ok(!pairs.some((p) => p.includes("touch")), "no repository command survives");
  const strict = neutralisers(entries, "strict").map((c) => `${c.key}=${c.value}`);
  assert.ok(strict.includes("filter.lfs.clean="), "strict mode trusts no scope");
});

test("a repository can neither re-enable a driver through core.attributesFile nor tracked .gitattributes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.linked, ".gitattributes"), "* filter=x diff=x\n");
    writeFileSync(join(f.linked, "f.txt"), "changed\n");
    f.reset();
    for (const trust of MODES) {
      await safeGit(["status", "--porcelain"], { cwd: f.linked, trust });
      await safeGit(["diff", "HEAD"], { cwd: f.linked, trust });
      await safeGit(["add", "-A"], { cwd: f.linked, trust });
    }
    assert.deepEqual(f.seen(), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fail closed: a config too large to inspect (or unreadable) runs nothing", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.linked, "f.txt"), "changed\n");
    // a worker pads the shared config so that listing it overflows the buffer
    const junk = Array.from({ length: 400 }, (_, i) => `[junk${i}]\n\tkey = ${"x".repeat(40)}\n`).join("");
    writeFileSync(
      join(f.primary, ".git", "config"),
      `${readFileSync(join(f.primary, ".git", "config"), "utf8")}${junk}`,
    );
    setConfigListLimitForTests(2048);
    try {
      for (const trust of MODES) {
        f.reset();
        const r = await safeGit(["status", "--porcelain"], { cwd: f.linked, trust });
        assert.equal(r.code, 128);
        assert.match(r.stderr, /refused/);
        assert.deepEqual(f.seen(), []);
      }
    } finally {
      setConfigListLimitForTests(64 * 1024 * 1024);
    }
    const missing = await safeGit(["status"], { cwd: join(f.root, "does-not-exist") });
    assert.notEqual(missing.code, 0);
    assert.deepEqual(f.seen(), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("operator mode honours the operator's own git environment; strict mode does not", () => {
  const source = {
    PATH: "/usr/bin",
    GIT_CONFIG_GLOBAL: "/etc/ci/gitconfig",
    GIT_SSL_CAINFO: "/etc/ssl/corp.pem",
    GIT_ALLOW_PROTOCOL: "https:http:ssh",
    GIT_DIR: "/elsewhere",
    GIT_EXTERNAL_DIFF: "/bin/evil",
    GIT_EDITOR: "vi",
  };
  const op = safeGitEnv(source, "operator");
  assert.equal(op.GIT_CONFIG_GLOBAL, "/etc/ci/gitconfig");
  assert.equal(op.GIT_SSL_CAINFO, "/etc/ssl/corp.pem");
  assert.equal(op.GIT_ALLOW_PROTOCOL, "https:http:ssh");
  assert.equal(op.GIT_DIR, undefined);
  assert.equal(op.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(op.GIT_EDITOR, "true");
  const strict = safeGitEnv(source, "strict");
  assert.equal(strict.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(strict.GIT_ALLOW_PROTOCOL, "https:ssh:file");
  assert.equal(strict.GIT_SSL_CAINFO, undefined);
});

test("T13 fork git (CliForkGit): isClean and addWorktree run no planted filter, smudge, fsmonitor or hook", async () => {
  const f = fixture();
  try {
    const base = sh("git rev-parse HEAD", f.primary).trim();
    writeFileSync(join(f.linked, "f.txt"), "dirty\n");
    writeFileSync(join(f.linked, "untracked.txt"), "u\n");
    const git = new CliForkGit(f.primary);
    f.reset();
    await git.isClean(f.linked).catch(() => {});
    assert.deepEqual(f.seen(), [], `isClean ran ${f.seen().join(",")}`);
    await git.addWorktree(join(f.root, "fork-wt"), "pi-fork/fk-0123456789abcdef", base).catch(() => {});
    assert.deepEqual(f.seen(), [], `addWorktree ran ${f.seen().join(",")}`);
    await git.diffStat(base, base).catch(() => {});
    assert.deepEqual(f.seen(), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
