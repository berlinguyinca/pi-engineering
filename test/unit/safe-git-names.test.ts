/**
 * T16 review round 2: classification works on the PARTS of a key (git's own split: first dot, last dot), never on a
 * regular expression over the whole key, so no subsection spelling escapes a rule. Real git, both trust modes, with a
 * raw-git control for every payload.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type GitTrust,
  attributeDriverNames,
  keyId,
  neutralFor,
  neutralisers,
  parseKey,
  parseScopedConfig,
  remoteExecKeys,
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
const entry = (key: string, value = "x", scope = "local") => ({ scope, origin: "file:/r/.git/config", key, value });

test("parseKey splits like git: section at the first dot, variable after the last, subsection is everything between", () => {
  assert.deepEqual(parseKey("filter.a.b.clean"), { section: "filter", sub: "a.b", variable: "clean" });
  assert.deepEqual(parseKey("Filter..CLEAN"), { section: "filter", sub: "", variable: "clean" });
  assert.deepEqual(parseKey("core.sshCommand"), { section: "core", sub: null, variable: "sshcommand" });
  assert.deepEqual(parseKey("filter.a b.smudge"), { section: "filter", sub: "a b", variable: "smudge" });
  assert.deepEqual(parseKey("filter.a\rb.smudge"), { section: "filter", sub: "a\rb", variable: "smudge" });
  assert.equal(parseKey("nodots"), null);
  assert.equal(parseKey("trailing."), null);
  assert.equal(parseKey(".lead"), null);
});

test("every odd subsection name is neutralised for every exec vector (pure)", () => {
  for (const name of ODD_NAMES) {
    const keys: Array<[string, string]> = [
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
      [`diff.${name}.textconv`, "cat"],
      [`diff.${name}.command`, ""],
      [`merge.${name}.driver`, ""],
      [`trailer.${name}.command`, ""],
      [`trailer.${name}.cmd`, ""],
      [`submodule.${name}.update`, "checkout"],
      [`lfs.extension.${name}.clean`, ""],
      [`lfs.extension.${name}.smudge`, ""],
      [`lfs.customtransfer.${name}.path`, ""],
      [`gpg.${name}.program`, "false"],
    ];
    for (const [key, want] of keys) {
      const out = neutralisers([entry(key, "touch /x")], "strict");
      assert.deepEqual(out, [{ key, value: want }], `${JSON.stringify(key.slice(0, 60))}`);
    }
    for (const trust of MODES) {
      const credential = neutralisers([entry(`credential.${name}.helper`, "!touch /x")], trust);
      assert.deepEqual(credential, [{ key: `credential.${name}.helper`, value: "" }]);
    }
    assert.deepEqual(remoteExecKeys([entry(`remote.${name}.uploadpack`, "x")], "strict"), [
      `remote.${name}.uploadpack`,
    ]);
    assert.deepEqual(remoteExecKeys([entry(`remote.${name}.proxy`, "x")], "operator"), [`remote.${name}.proxy`]);
  }
});

test('subsections are case-SENSITIVE: [filter "A"] and [filter "a"] are both neutralised; section and variable are not', () => {
  const out = neutralisers(
    [entry("filter.A.clean", "x"), entry("filter.a.clean", "y"), entry("FILTER.a.CLEAN", "z")],
    "strict",
  );
  assert.deepEqual(out, [
    { key: "filter.A.clean", value: "" },
    { key: "filter.a.clean", value: "" },
  ]);
  assert.notEqual(keyId(parseKey("filter.A.clean") as never), keyId(parseKey("filter.a.clean") as never));
  assert.equal(keyId(parseKey("FILTER.a.CLEAN") as never), keyId(parseKey("filter.a.clean") as never));
});

test("operator mode restores the operator's own value for the same key, and only for the same subsection spelling", () => {
  const out = neutralisers(
    [
      entry("filter.lfs.clean", "git-lfs clean -- %f", "global"),
      entry("filter.lfs.clean", "touch /x", "local"),
      entry("filter.LFS.clean", "touch /y", "local"),
    ],
    "operator",
  );
  assert.deepEqual(out, [
    { key: "filter.lfs.clean", value: "git-lfs clean -- %f" },
    { key: "filter.LFS.clean", value: "" },
  ]);
});

test("neutralFor knows only the execution vectors", () => {
  assert.equal(neutralFor(parseKey("user.name") as never), null);
  assert.equal(neutralFor(parseKey("filter.x.helper") as never), null);
  assert.equal(neutralFor(parseKey("core.editor") as never), "true");
  assert.equal(neutralFor(parseKey("lfs.url") as never), null);
});

test("attributeDriverNames reads filter/diff/merge names, quoted patterns and macros", () => {
  const text = [
    "# comment",
    "*.bin filter=lfs diff=lfs merge=lfs -text",
    '"my file.txt" filter=quoted',
    "[attr]mine diff=viaMacro",
    "*.x  filter=a=b\tdiff=tabbed",
    "nofilter text",
    "empty filter=",
  ].join("\n");
  assert.deepEqual(attributeDriverNames(text), [
    ["filter", "lfs"],
    ["diff", "lfs"],
    ["merge", "lfs"],
    ["filter", "quoted"],
    ["diff", "viaMacro"],
    ["filter", "a=b"],
    ["diff", "tabbed"],
  ]);
});

test("a listing record ends its key at the first newline, so a newline can never be part of a key", () => {
  const e = parseScopedConfig("local\0file:/r\0filter.a\nb.clean\nvalue\0");
  assert.equal(e[0]?.key, "filter.a");
  assert.equal(e[0]?.value, "b.clean\nvalue");
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

test("a U+2028 / empty / CR subsection cannot dodge the network refusal or the trailer rule", async () => {
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
        assert.equal(r.code, 128, `${trust} ${JSON.stringify(name)}: ${r.stderr.slice(0, 80)}`);
        assert.match(r.stderr, /refused/);
        assert.deepEqual(l.seen(), []);
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

test("submodule.<name>.update = !command does not run on `submodule update`", async () => {
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
      await safeGit(["submodule", "update"], { cwd: l.repo, trust, timeoutMs: 30_000 });
      assert.deepEqual(l.seen(), [], `${trust}: submodule update ran the planted command`);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
