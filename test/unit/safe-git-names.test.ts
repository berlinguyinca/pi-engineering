/**
 * T16 round 3: the repository's config reaches git only through the allow-list (`generateConfig`). These tests cover
 * the pure generator (every spelling of every vector, including ones nobody has named), round-tripping through real
 * git, and the end-to-end behaviour with odd names.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type FileEntry,
  type GitTrust,
  configDelta,
  generateConfig,
  parseFileConfig,
  parseKey,
  parseScopedConfig,
  safeGit,
} from "../../src/git/safeGit.ts";

const MODES: GitTrust[] = ["strict", "operator"];
const ODD_NAMES = [
  "plain",
  "a b",
  "a b",
  "a\rb",
  "",
  "a=b",
  "=",
  "a.b",
  ".lead",
  "trail.",
  "ünï\u{1F600}",
  "has space",
  'q"uote',
  "back\\slash",
  "x".repeat(2000),
  "UPPER",
  "upper",
];
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const row = (key: string, value: string | null = "x"): FileEntry => ({ key, value });
const keptKeys = (rows: FileEntry[]) => generateConfig(rows, false).kept.map((k) => k.key);

test("parseKey splits like git: section at the first dot, variable after the last, subsection is everything between", () => {
  assert.deepEqual(parseKey("filter.a.b.clean"), { section: "filter", sub: "a.b", variable: "clean" });
  assert.deepEqual(parseKey("Filter..CLEAN"), { section: "filter", sub: "", variable: "clean" });
  assert.deepEqual(parseKey("core.sshCommand"), { section: "core", sub: null, variable: "sshcommand" });
  assert.deepEqual(parseKey("filter.a b.smudge"), { section: "filter", sub: "a b", variable: "smudge" });
  assert.deepEqual(parseKey("filter.a\rb.smudge"), { section: "filter", sub: "a\rb", variable: "smudge" });
  assert.equal(parseKey("nodots"), null);
  assert.equal(parseKey("trailing."), null);
  assert.equal(parseKey(".lead"), null);
});

const VECTORS = [
  "filter.N.clean",
  "filter.N.smudge",
  "filter.N.process",
  "filter.N.required",
  "diff.N.textconv",
  "diff.N.command",
  "merge.N.driver",
  "merge.N.name",
  "trailer.N.command",
  "trailer.N.cmd",
  "submodule.N.update",
  "submodule.N.url",
  "lfs.extension.N.clean",
  "lfs.extension.N.smudge",
  "lfs.customtransfer.N.path",
  "gpg.N.program",
  "credential.N.helper",
  "credential.helper",
  "remote.N.uploadpack",
  "remote.N.receivepack",
  "remote.N.vcs",
  "remote.N.proxy",
  "remote.N.promisor",
  "remote.N.partialclonefilter",
  "url.N.insteadOf",
  "url.N.pushInsteadOf",
  "http.N.proxy",
  "http.proxy",
  "http.extraHeader",
  "http.curloptResolve",
  "protocol.N.allow",
  "core.fsmonitor",
  "core.hooksPath",
  "core.sshCommand",
  "core.gitProxy",
  "core.askPass",
  "core.editor",
  "core.pager",
  "core.attributesFile",
  "core.excludesFile",
  "core.alternateRefsCommand",
  "core.worktree",
  "core.bare",
  "core.untrackedCache.x",
  "sequence.editor",
  "gpg.program",
  "gpg.ssh.defaultKeyCommand",
  "gpg.ssh.program",
  "extensions.partialclone",
  "extensions.worktreeConfig",
  "include.path",
  "includeIf.gitdir:/.path",
  "lfs.url",
  "lfs.pushurl",
  "lfs.standalonetransferagent",
  "diff.external",
  "difftool.N.cmd",
  "mergetool.N.cmd",
  "alias.x",
  "uploadpack.packObjectsHook",
  "pager.log",
  "web.browser",
  "sendemail.smtpServer",
  "credential.N.username",
  "transfer.hideRefs",
  "receive.denyCurrentBranch",
];

test("every vector under every odd subsection name is absent from the generated config (pure)", () => {
  for (const name of ODD_NAMES) {
    for (const v of VECTORS) {
      const key = v.replace(".N.", `.${name}.`);
      if (key === v) continue;
      const g = generateConfig([row(key, "touch /x")], false);
      assert.deepEqual(g.kept, [], JSON.stringify(key.slice(0, 60)));
      assert.ok(!g.text.includes("touch /x"), JSON.stringify(key.slice(0, 60)));
    }
  }
  for (const v of VECTORS) {
    if (v.includes(".N.")) continue;
    assert.deepEqual(generateConfig([row(v, "touch /x")], false).kept, [], v);
  }
});

test("keys nobody has named are dropped too: only the allow-list gets in", () => {
  assert.deepEqual(keptKeys([row("filter.future.thing"), row("core.someNewExecKnob"), row("newsection.sub.var")]), []);
  assert.deepEqual(keptKeys([row("core.filemode", "false"), row("user.name", "t"), row("filter.a.clean", "x")]), [
    "core.filemode",
    "user.name",
  ]);
});

test("values are validated: an allowed key with a hostile or malformed value is dropped, not repaired", () => {
  assert.deepEqual(
    keptKeys([row("core.filemode", "touch /x"), row("core.eol", "$(x)"), row("core.compression", "9; x")]),
    [],
  );
  assert.deepEqual(keptKeys([row("user.name", "a\nb"), row("user.name", "a\u0001b")]), []);
  assert.deepEqual(
    keptKeys([row("lfs.http://h/x/info/lfs.access", "basic"), row("lfs.http://h/x/info/lfs.access", "x")]),
    ["lfs.http://h/x/info/lfs.access"],
  );
  assert.deepEqual(keptKeys([row("remote.o.url", ""), row("remote.o.url", null)]), []);
});

test("branch.<b>.remote, pushRemote and remote.pushDefault may only name a remote that exists (or `.`)", () => {
  const rows = (v: string) => [
    row("remote.origin.url", "https://h/x.git"),
    row("branch.main.remote", v),
    row("branch.main.pushRemote", v),
    row("remote.pushDefault", v),
  ];
  for (const bad of ["https://evil/x.git", "ext::sh -c x", "/tmp/evil", "../evil", "nosuch", "git@evil:x", ""]) {
    assert.deepEqual(keptKeys(rows(bad)), ["remote.origin.url"], JSON.stringify(bad));
  }
  assert.deepEqual(keptKeys(rows("origin")), [
    "remote.origin.url",
    "branch.main.remote",
    "branch.main.pushRemote",
    "remote.pushDefault",
  ]);
  assert.deepEqual(keptKeys(rows(".")).slice(1, 3), ["branch.main.remote", "branch.main.pushRemote"]);
});

test("the generated text round-trips through real git for every odd subsection name, and carries nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "safe-git-gen-"));
  try {
    const rows: FileEntry[] = [row("core.filemode", "false"), row("user.name", 'Q "uote" \\ back\tslash')];
    for (const n of ODD_NAMES) {
      if (n === "") continue;
      rows.push(row(`remote.${n}.url`, `https://h/${n.length}.git`), row(`branch.${n}.merge`, "refs/heads/x"));
    }
    const g = generateConfig(rows, true);
    const file = join(root, "config");
    writeFileSync(file, g.text);
    const out = execFileSync("git", ["config", "--file", file, "--list", "-z"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).toString();
    const back = parseFileConfig(out).filter((e) => e.key !== "core.repositoryformatversion" && e.key !== "core.bare");
    assert.deepEqual(
      back.map((e) => [e.key, e.value]),
      g.kept.map((e) => [e.key, e.value]),
    );
    assert.equal(g.kept.length, rows.length - 0, "nothing the test offered was lost");
    assert.match(g.text, /bare = "true"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configDelta compares as multisets: only what the command changed", () => {
  const a = [row("remote.o.url", "u1"), row("remote.o.fetch", "f"), row("remote.o.fetch", "g")];
  const b = [
    row("remote.o.url", "u2"),
    row("remote.o.fetch", "g"),
    row("remote.o.fetch", "f"),
    row("branch.x.merge", "m"),
  ];
  const d = configDelta(a, b);
  assert.deepEqual(d.remove, [row("remote.o.url", "u1")]);
  assert.deepEqual(d.add, [row("remote.o.url", "u2"), row("branch.x.merge", "m")]);
  assert.deepEqual(configDelta(a, a), { remove: [], add: [] });
});

test("a listing record ends its key at the first newline, so a newline can never be part of a key", () => {
  const e = parseScopedConfig("local\0file:/r\0filter.a\nb.clean\nvalue\0");
  assert.equal(e[0]?.key, "filter.a");
  assert.equal(e[0]?.value, "b.clean\nvalue");
  const f = parseFileConfig("filter.a\nb.clean\nvalue\0core.bare\0");
  assert.deepEqual(f, [row("filter.a", "b.clean\nvalue"), { key: "core.bare", value: null }]);
});

// ─── against real git ──────────────────────────────────────────────────────────────────────────────────────────

function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-names-"));
  mkdirSync(join(root, "home"));
  const marks = join(root, "M");
  mkdirSync(marks);
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (c: string, cwd: string) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" });
  sh(
    "git init -q -b main repo && cd repo && git config user.name t && git config user.email t@t && printf 'a\\nb\\n' > f.txt && git add . && git commit -qm i",
    root,
  );
  const hook = (name: string) => {
    const p = join(root, name);
    writeFileSync(
      p,
      `#!/bin/sh\ntouch '${marks}/${name}'\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\n`,
    );
    chmodSync(p, 0o755);
    return p;
  };
  return {
    root,
    repo: join(root, "repo"),
    marks,
    hook,
    sh,
    env,
    seen: () => readdirSync(marks).sort(),
    reset: () => {
      for (const n of readdirSync(marks)) rmSync(join(marks, n));
    },
  };
}

test("filters, textconv and merge drivers with every odd name stay quiet - including names a regex over the key missed", async () => {
  const l = lab();
  try {
    const names = ODD_NAMES.filter((n) => n.length < 100 && !/\s/.test(n) && n !== "");
    const attrs: string[] = [];
    let cfg = "";
    names.forEach((name, i) => {
      const clean = l.hook(`clean-${i}`);
      const tc = l.hook(`textconv-${i}`);
      cfg += `[filter "${esc(name)}"]\n\tclean = ${clean}\n[diff "${esc(name)}"]\n\ttextconv = ${tc}\n`;
      attrs.push(`f${i}.txt filter=${name} diff=${name}`);
    });
    // the empty subsection and a U+2028 name cannot be written in an attributes file; they are reached through config only
    cfg += `[filter ""]\n\tclean = ${l.hook("clean-empty")}\n[filter "x y"]\n\tclean = ${l.hook("clean-ls")}\n`;
    const cfgPath = join(l.repo, ".git", "config");
    writeFileSync(cfgPath, execFileSync("cat", [cfgPath]).toString() + cfg);
    writeFileSync(join(l.repo, ".git", "info", "attributes"), `${attrs.join("\n")}\n`);
    names.forEach((_, i) => writeFileSync(join(l.repo, `f${i}.txt`), "x\n"));

    try {
      l.sh("git add -A", l.repo);
    } catch {
      /* clean filter output */
    }
    assert.ok(l.seen().length >= names.length - 3, `control: raw git ran the drivers; saw ${l.seen().length}`);
    for (const trust of MODES) {
      l.reset();
      names.forEach((_, i) => writeFileSync(join(l.repo, `f${i}.txt`), `changed ${trust}\n`));
      for (const args of [
        ["status", "--porcelain"],
        ["add", "-A"],
        ["diff", "--cached"],
        ["diff", "HEAD"],
        ["show", "HEAD"],
      ]) {
        await safeGit(args, { cwd: l.repo, trust, timeoutMs: 60_000 });
      }
      assert.deepEqual(l.seen(), [], `${trust}: ran ${l.seen().join(",")}`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a U+2028 / empty / CR subsection cannot dodge the allow-list: uploadpack and trailer commands never run", async () => {
  const l = lab();
  try {
    for (const name of ["r s", "", "r\rs"]) {
      const cfgPath = join(l.repo, ".git", "config");
      writeFileSync(
        cfgPath,
        `${execFileSync("cat", [cfgPath]).toString()}[remote "${esc(name)}"]\n\turl = ${l.repo}\n\tuploadpack = ${l.hook("uploadpack")}\n`,
      );
      for (const trust of MODES) {
        l.reset();
        const r = await safeGit(["ls-remote", name || "."], { cwd: l.repo, trust, timeoutMs: 20_000 });
        assert.deepEqual(l.seen(), [], `${trust} ${JSON.stringify(name)}: ${r.stderr.slice(0, 80)}`);
      }
    }
    const t = l.hook("trailer");
    writeFileSync(
      join(l.repo, ".git", "config"),
      `${execFileSync("cat", [join(l.repo, ".git", "config")]).toString()}[trailer "t k"]\n\tcommand = ${t}\n[trailer "c"]\n\tcmd = ${t}\n`,
    );
    for (const trust of MODES) {
      for (const tok of ["t k", "c"]) {
        l.reset();
        await safeGit(["interpret-trailers", "--trailer", `${tok}: v`], { cwd: l.repo, trust, input: "s\n" });
        assert.deepEqual(l.seen(), [], `${trust} trailer ${JSON.stringify(tok)}`);
      }
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("submodule.<name>.update = !command does not run, and `submodule update` itself is refused", async () => {
  const l = lab();
  try {
    const src = join(l.root, "sm-src");
    l.sh(
      `git init -q -b main sm-src && cd sm-src && git config user.name t && git config user.email t@t && echo 1 > s && git add . && git commit -qm s1 && echo 2 > s && git commit -qam s2`,
      l.root,
    );
    l.sh(
      `git -c protocol.file.allow=always submodule add -q ${src} sm && git -C sm checkout -q HEAD~1 && git add -A && git commit -qm sub`,
      l.repo,
    );
    l.sh("git -C sm checkout -q main", l.repo);
    l.sh("git add -A && git commit -qm bump", l.repo);
    l.sh("git -C sm checkout -q HEAD~1", l.repo);
    const cmd = l.hook("subupdate");
    writeFileSync(
      join(l.repo, ".git", "config"),
      `${execFileSync("cat", [join(l.repo, ".git", "config")]).toString()}[submodule "sm"]\n\tupdate = !${cmd}\n`,
    );
    try {
      l.sh("git submodule update", l.repo);
    } catch {
      /* the command exits 0 */
    }
    assert.ok(l.seen().includes("subupdate"), `control: raw git runs the update command; saw ${l.seen().join(",")}`);
    for (const trust of MODES) {
      l.sh("git -C sm checkout -q HEAD~1 2>/dev/null || true", l.repo);
      l.reset();
      const r = await safeGit(["submodule", "update"], { cwd: l.repo, trust, timeoutMs: 30_000 });
      assert.equal(r.code, 128);
      assert.match(r.stderr, /refused/);
      assert.deepEqual(l.seen(), [], `${trust}: submodule update ran the planted command`);
      // and nothing else a caller may reasonably run reads that key either
      for (const args of [["status"], ["diff"], ["checkout", "."], ["log", "-p", "-1"]]) {
        await safeGit(args, { cwd: l.repo, trust, timeoutMs: 30_000 });
      }
      assert.deepEqual(l.seen(), [], `${trust}: a plain command ran the planted update command`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
