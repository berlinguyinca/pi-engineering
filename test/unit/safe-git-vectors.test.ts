/**
 * T16 H5 (review round): every execution vector is exercised against real git in BOTH trust modes, with a raw-git
 * control that proves the payload is live. Includes driver names git cannot take through `-c key=value`
 * (a `=` in the subsection) and the vectors where an empty override is ignored by git (core.gitProxy).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type GitTrust, configEnv, safeGit, safeGitPrefix } from "../../src/git/safeGit.ts";
import { describeSource, originRemote } from "../../src/runtime/host/extension.ts";

const MODES: GitTrust[] = ["strict", "operator"];
const HOME_ENV = (root: string) => ({
  HOME: join(root, "home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

interface Lab {
  root: string;
  repo: string;
  marks: string;
  hook(name: string): string;
  cfg(text: string): void;
  seen(): string[];
  reset(): void;
  raw(cmd: string, cwd?: string): void;
}

function lab(): Lab {
  const root = mkdtempSync(join(tmpdir(), "safe-git-vec-"));
  mkdirSync(join(root, "home"));
  const marks = join(root, "MARK");
  mkdirSync(marks);
  const bin = join(root, "hp");
  mkdirSync(bin);
  const repo = join(root, "repo");
  const env = { ...process.env, ...HOME_ENV(root) };
  const run = (cmd: string, cwd: string) => execFileSync("bash", ["-c", cmd], { cwd, env, stdio: "pipe" });
  run(
    "git init -q -b main repo && cd repo && git config user.name t && git config user.email t@t && printf 'one\\ntwo\\nthree\\n' > f.txt && git add . && git commit -qm init && git branch other && git config --unset user.name && git config --unset user.email",
    root,
  );
  return {
    root,
    repo,
    marks,
    hook(name) {
      // prints a harmless result for filters/textconv (cat) while leaving a marker
      const p = join(bin, name);
      writeFileSync(
        p,
        `#!/bin/sh\ntouch '${marks}/${name}'\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\nexit 1\n`,
      );
      chmodSync(p, 0o755);
      return p;
    },
    cfg(text) {
      writeFileSync(
        join(repo, ".git", "config"),
        `${execFileSync("cat", [join(repo, ".git", "config")]).toString()}${text}`,
      );
    },
    seen: () => readdirSync(marks).sort(),
    reset: () => {
      for (const n of readdirSync(marks)) rmSync(join(marks, n), { force: true });
    },
    raw(cmd, cwd = repo) {
      try {
        run(cmd, cwd);
      } catch {
        /* a failing planted payload is expected */
      }
    },
  };
}

const DRIVER_NAMES = ["a=b", "a.b", "AbC", "has space", 'q"uote', "ünï", "x=y=z", "=lead", "trail="];
const esc = (name: string) => name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

test("drivers whose NAME cannot be carried in -c key=value are still neutralised (filter, textconv, merge)", async () => {
  const l = lab();
  try {
    for (const name of DRIVER_NAMES) {
      const clean = l.hook(`clean-${DRIVER_NAMES.indexOf(name)}`);
      const smudge = l.hook(`smudge-${DRIVER_NAMES.indexOf(name)}`);
      const tc = l.hook(`textconv-${DRIVER_NAMES.indexOf(name)}`);
      const mg = l.hook(`merge-${DRIVER_NAMES.indexOf(name)}`);
      l.cfg(
        `[filter "${esc(name)}"]\n\tclean = ${clean}\n\tsmudge = ${smudge}\n[diff "${esc(name)}"]\n\ttextconv = ${tc}\n[merge "${esc(name)}"]\n\tdriver = ${mg} %O %A %B\n`,
      );
    }
    writeFileSync(
      join(l.repo, ".git", "info", "attributes"),
      `${DRIVER_NAMES.map((n, i) => `f${i}.txt filter=${n} diff=${n} merge=${n}`).join("\n")}\n`,
    );
    const files = DRIVER_NAMES.map((_, i) => `f${i}.txt`);
    for (const f of files) writeFileSync(join(l.repo, f), "x\n");

    // control: raw git runs them
    l.raw("git add -A && git diff --cached >/dev/null; git cat-file --textconv :f0.txt", l.repo);
    const live = l.seen();
    assert.ok(
      live.some((m) => m.startsWith("clean-")),
      `raw git must run a clean filter; saw ${live.join(",")}`,
    );
    assert.ok(
      live.some((m) => m.startsWith("textconv-")),
      `raw git must run textconv; saw ${live.join(",")}`,
    );
    l.raw("git -c user.name=t -c user.email=t@t commit -qm files; rm -f f?.txt; git checkout -q -f .");
    assert.ok(
      l.seen().some((m) => m.startsWith("smudge-")),
      `raw git must run a smudge filter; saw ${l.seen().join(",")}`,
    );
    l.raw("git worktree add -q ../ctl -b ctl HEAD");
    l.reset();
    l.raw("git worktree remove --force ../ctl; git branch -D ctl");

    for (const trust of MODES) {
      l.reset();
      for (const f of files) writeFileSync(join(l.repo, f), `changed ${trust}\n`);
      for (const args of [
        ["status", "--porcelain"],
        ["add", "-A"],
        ["diff", "--cached"],
        ["diff", "HEAD"],
        ["show", "HEAD"],
        ["cat-file", "--textconv", ":f0.txt"],
        ["cat-file", "--textconv", ":f1.txt"],
        ["worktree", "add", "-q", join(l.root, `w-${trust}`), "-b", `b-${trust}`, "HEAD"],
        ["checkout", "-q", "-f", "."],
      ]) {
        await safeGit(args, { cwd: l.repo, trust });
      }
      assert.deepEqual(l.seen(), [], `${trust}: exotic-named drivers ran: ${l.seen().join(",")}`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("merge drivers (including an `=` name) do not run in either mode", async () => {
  const l = lab();
  try {
    const drv = l.hook("mergedrv");
    l.cfg(`[merge "a=b"]\n\tdriver = ${drv} %O %A %B\n[merge "plain"]\n\tdriver = ${drv} %O %A %B\n`);
    writeFileSync(join(l.repo, ".git", "info", "attributes"), "f.txt merge=a=b\ng.txt merge=plain\n");
    l.raw("printf 'a\\n' > g.txt && git add . && git commit -qm base -c user.name=t");
    const diverge = (side: string) =>
      `git -c user.name=t -c user.email=t@t checkout -q -B ${side} main && printf '${side}\\ntwo\\nthree\\n' > f.txt && printf '${side}\\n' > g.txt && git -c user.name=t -c user.email=t@t commit -qam ${side}`;
    for (const trust of ["raw", ...MODES] as const) {
      l.reset();
      l.raw(`git -c user.name=t -c user.email=t@t checkout -q -B main-${trust} main`);
      l.raw(
        `${diverge(`s1-${trust}`)} && git -c user.name=t -c user.email=t@t checkout -q -B main-${trust} main && ${diverge(`s2-${trust}`)}`,
      );
      const merge = ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-edit", `s1-${trust}`];
      if (trust === "raw") l.raw(`git ${merge.join(" ")}`);
      else await safeGit(merge, { cwd: l.repo, trust });
      if (trust === "raw") assert.ok(l.seen().includes("mergedrv"), "control: raw git must run the merge driver");
      else assert.deepEqual(l.seen(), [], `${trust}: merge driver ran`);
      l.raw("git merge --abort");
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("trailer command, credential helper, askpass and alternateRefsCommand never run", async () => {
  const l = lab();
  try {
    const trailer = l.hook("trailer");
    const cred = l.hook("credhelper");
    const ask = l.hook("askpass");
    const alt = l.hook("altrefs");
    // receive-pack only asks the command for refs when the repository has alternates
    execFileSync("git", ["init", "-q", "--bare", join(l.root, "alt.git")]);
    mkdirSync(join(l.repo, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(l.repo, ".git", "objects", "info", "alternates"), `${join(l.root, "alt.git", "objects")}\n`);
    l.cfg(
      `[trailer "evil"]\n\tcommand = ${trailer}\n[credential]\n\thelper = !${cred}\n[core]\n\taskPass = ${ask}\n\talternateRefsCommand = ${alt}\n`,
    );
    const probes: Array<{ name: string; marker: string; args: string[]; input?: string }> = [
      { name: "trailer", marker: "trailer", args: ["interpret-trailers", "--trailer", "evil: v"], input: "subject\n" },
      {
        name: "credential helper",
        marker: "credhelper",
        args: ["credential", "fill"],
        input: "protocol=https\nhost=example.invalid\n\n",
      },
      {
        name: "askpass",
        marker: "askpass",
        args: ["credential", "fill"],
        input: "protocol=https\nhost=example.invalid\n\n",
      },
      { name: "alternateRefsCommand", marker: "altrefs", args: ["receive-pack", "."], input: "0000" },
    ];
    const rawEnv = { ...process.env, ...HOME_ENV(l.root) };
    for (const p of probes) {
      l.reset();
      try {
        execFileSync("git", p.args, { cwd: l.repo, env: rawEnv, input: p.input ?? "", stdio: "pipe", timeout: 20_000 });
      } catch {
        /* expected */
      }
      // askpass is shadowed by the credential helper in the control; give it its own repository state below
      if (p.marker !== "askpass")
        assert.ok(l.seen().includes(p.marker), `control: raw git must run ${p.name}; saw ${l.seen().join(",")}`);
    }
    for (const trust of MODES) {
      for (const p of probes) {
        l.reset();
        await safeGit(p.args, {
          cwd: l.repo,
          trust,
          timeoutMs: 20_000,
          ...(p.input !== undefined ? { input: p.input } : {}),
        });
        assert.deepEqual(l.seen(), [], `${trust}: ${p.name} ran: ${l.seen().join(",")}`);
      }
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("core.askPass is not consulted: askpass-only config (no helper) leaves no marker", async () => {
  const l = lab();
  try {
    const ask = l.hook("askpass-only");
    l.cfg(`[core]\n\taskPass = ${ask}\n`);
    const input = "protocol=https\nhost=example.invalid\n\n";
    const rawEnv = { ...process.env, ...HOME_ENV(l.root) };
    delete (rawEnv as Record<string, unknown>).GIT_ASKPASS;
    try {
      execFileSync("git", ["credential", "fill"], { cwd: l.repo, env: rawEnv, input, stdio: "pipe", timeout: 20_000 });
    } catch {
      /* expected */
    }
    assert.ok(l.seen().includes("askpass-only"), "control: raw git must run core.askPass");
    for (const trust of MODES) {
      l.reset();
      await safeGit(["credential", "fill"], { cwd: l.repo, trust, input, timeoutMs: 20_000 });
      assert.deepEqual(l.seen(), [], `${trust}: core.askPass ran`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("core.gitProxy and core.sshCommand planted in the repository do not run on git:// and ssh:// remotes", async () => {
  const l = lab();
  try {
    const proxy = l.hook("gitproxy");
    const ssh = l.hook("sshcmd");
    l.cfg(`[core]\n\tgitProxy = ${proxy}\n\tsshCommand = ${ssh}\n`);
    const rawEnv = { ...process.env, ...HOME_ENV(l.root) };
    for (const url of ["git://example.invalid/x.git", "ssh://example.invalid/x.git"]) {
      try {
        execFileSync("git", ["ls-remote", url], { cwd: l.repo, env: rawEnv, stdio: "pipe", timeout: 20_000 });
      } catch {
        /* expected */
      }
    }
    assert.ok(l.seen().includes("gitproxy"), `control: raw git must run core.gitProxy; saw ${l.seen().join(",")}`);
    assert.ok(l.seen().includes("sshcmd"), `control: raw git must run core.sshCommand; saw ${l.seen().join(",")}`);
    for (const trust of MODES) {
      l.reset();
      for (const url of ["git://example.invalid/x.git", "ssh://example.invalid/x.git"]) {
        await safeGit(["ls-remote", url], { cwd: l.repo, trust, timeoutMs: 20_000 });
      }
      assert.deepEqual(l.seen(), [], `${trust}: planted proxy/ssh command ran: ${l.seen().join(",")}`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("operator mode: a gitProxy or sshCommand the OPERATOR set globally is kept; the repository's is not", async () => {
  const l = lab();
  try {
    const planted = l.hook("planted-proxy");
    const mine = l.hook("operator-proxy");
    const sshMine = l.hook("operator-ssh");
    const sshPlanted = l.hook("planted-ssh");
    l.cfg(`[core]\n\tgitProxy = ${planted}\n\tsshCommand = ${sshPlanted}\n`);
    const global = join(l.root, "operator.gitconfig");
    writeFileSync(global, `[core]\n\tgitProxy = ${mine}\n\tsshCommand = ${sshMine}\n`);
    const prior = { g: process.env.GIT_CONFIG_GLOBAL, ns: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      for (const url of ["git://example.invalid/x.git", "ssh://example.invalid/x.git"]) {
        await safeGit(["ls-remote", url], { cwd: l.repo, trust: "operator", timeoutMs: 20_000 });
      }
    } finally {
      if (prior.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prior.g;
      if (prior.ns === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prior.ns;
    }
    const seen = l.seen();
    assert.ok(seen.includes("operator-proxy"), `operator's gitProxy must still run; saw ${seen.join(",")}`);
    assert.ok(seen.includes("operator-ssh"), `operator's sshCommand must still run; saw ${seen.join(",")}`);
    assert.ok(!seen.includes("planted-proxy") && !seen.includes("planted-ssh"), `planted ran: ${seen.join(",")}`);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("config injected through the environment (ambient or caller-supplied) is dropped, ours is the only GIT_CONFIG_COUNT", async () => {
  const l = lab();
  try {
    const clean = l.hook("injected-clean");
    writeFileSync(join(l.repo, ".git", "info", "attributes"), "f.txt filter=inj\n");
    writeFileSync(join(l.repo, "f.txt"), "changed\n");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.inj.clean";
    process.env.GIT_CONFIG_VALUE_0 = clean;
    process.env.GIT_CONFIG_PARAMETERS = `'filter.inj.clean=${clean}'`;
    try {
      for (const trust of MODES) {
        l.reset();
        await safeGit(["add", "-A"], { cwd: l.repo, trust });
        await safeGit(["add", "-A"], {
          cwd: l.repo,
          trust,
          env: { GIT_CONFIG_PARAMETERS: `'filter.inj.clean=${clean}'` },
        });
        assert.deepEqual(l.seen(), [], `${trust}: injected config ran`);
      }
    } finally {
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS"])
        delete process.env[k];
    }
    // control: git does honour these variables, so the scrub is what stopped it
    writeFileSync(join(l.repo, "f.txt"), "changed again, differently\n");
    const env = { ...process.env, ...HOME_ENV(l.root), ...configEnv([{ key: "filter.inj.clean", value: clean }]) };
    try {
      execFileSync("git", ["add", "-A"], { cwd: l.repo, env, stdio: "pipe" });
    } catch {
      /* clean exits 1 */
    }
    assert.ok(l.seen().includes("injected-clean"), "control: GIT_CONFIG_COUNT config reaches git");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the argv prefix carries only forced settings, never a per-repository override; configEnv keeps exact keys", async () => {
  const l = lab();
  try {
    l.cfg(`[filter "a=b"]\n\tclean = ${l.hook("x")}\n`);
    for (const trust of MODES) {
      const prefix = await safeGitPrefix(l.repo, trust);
      assert.ok(!prefix.some((a) => a.startsWith("filter.")), "no per-repository override travels as an argument");
      assert.ok(prefix.includes("core.hooksPath=/dev/null") && prefix.includes("core.fsmonitor=false"));
      assert.ok(prefix.includes("diff.ignoreSubmodules=all") && prefix.includes("submodule.recurse=false"));
    }
    assert.deepEqual(configEnv([{ key: "k=1", value: "v=2" }]), {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "k=1",
      GIT_CONFIG_VALUE_0: "v=2",
    });
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the update host's synchronous probes (describeSource, originRemote) run no planted fsmonitor or helper", () => {
  const l = lab();
  try {
    const fsm = l.hook("fsmonitor-sync");
    l.cfg(`[core]\n\tfsmonitor = ${fsm}\n[remote "origin"]\n\turl = https://example.invalid/x.git\n`);
    writeFileSync(join(l.repo, "package.json"), '{"version":"1.2.3"}');
    // control: raw git status runs it
    l.raw("git status --porcelain --untracked-files=no");
    assert.ok(l.seen().includes("fsmonitor-sync"), "control: raw git must run core.fsmonitor");
    l.reset();
    const info = describeSource(l.repo);
    assert.equal(info.version, "1.2.3");
    assert.equal(originRemote(l.repo), "https://example.invalid/x.git");
    assert.deepEqual(l.seen(), [], `sync probe ran planted code: ${l.seen().join(",")}`);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
