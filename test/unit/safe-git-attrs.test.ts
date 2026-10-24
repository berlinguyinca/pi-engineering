/**
 * T16 round 4: attributes are cut off at the source (see src/git/safeGitAttrs.ts). The one thing kept is git-lfs: in
 * operator mode, when the operator's own config defines `filter.lfs`, Pi reads the repository's `.gitattributes`
 * itself and carries over ONLY `<pattern> filter=lfs diff=lfs merge=lfs -text` lines.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetRemotePinsForTests, safeGit, stateHooks } from "../../src/git/safeGit.ts";
import { generateLfsAttributes, lfsLines } from "../../src/git/safeGitAttrs.ts";

let root = "";
const prior: Record<string, string | undefined> = {};
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-attrs-"));
  stateHooks.stateRoot = join(root, "state");
  for (const k of KEYS) prior[k] = process.env[k];
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(root, "operator.gitconfig");
});
afterEach(() => {
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const sh = (c: string, cwd: string) =>
  execFileSync("bash", ["-c", c], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  }).toString();

test("lfsLines keeps only filter=lfs lines and rewrites them to the fixed attribute set", () => {
  const text = [
    "# comment",
    "*.bin filter=lfs diff=lfs merge=lfs -text",
    "*.psd filter=lfs",
    "*.evil filter=evil diff=evil merge=evil",
    "*.mixed filter=lfs filter=evil",
    "*.back filter=evil filter=lfs",
    "*.unset filter=lfs -filter",
    "*.keep text eol=crlf",
    "[attr]mymacro filter=lfs",
    "!*.neg filter=lfs",
    '"with space*.dat" filter=lfs',
    '"bad\\q" filter=lfs',
    "*.crlf filter=lfs\r",
    "   *.indented   filter=lfs   diff=evil",
    "*.ctl\u0001x filter=lfs",
  ].join("\n");
  assert.deepEqual(lfsLines(text, ""), [
    "*.bin filter=lfs diff=lfs merge=lfs -text",
    "*.psd filter=lfs diff=lfs merge=lfs -text",
    "*.back filter=lfs diff=lfs merge=lfs -text",
    '"with space*.dat" filter=lfs diff=lfs merge=lfs -text',
    "*.crlf filter=lfs diff=lfs merge=lfs -text",
    "*.indented filter=lfs diff=lfs merge=lfs -text",
  ]);
});

test("lfsLines scopes nested .gitattributes patterns to their directory", () => {
  assert.deepEqual(lfsLines("*.dat filter=lfs\n/top.dat filter=lfs\nsub/x.dat filter=lfs\ndir/ filter=lfs\n", "a/b"), [
    "a/b/**/*.dat filter=lfs diff=lfs merge=lfs -text",
    "a/b/top.dat filter=lfs diff=lfs merge=lfs -text",
    "a/b/sub/x.dat filter=lfs diff=lfs merge=lfs -text",
    "a/b/**/dir/ filter=lfs diff=lfs merge=lfs -text", // a trailing slash alone still matches at any depth below a/b
  ]);
});

test("generateLfsAttributes reads regular files only (not links, not oversized ones)", () => {
  const dir = join(root, "w");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(root, "elsewhere"), "*.secret filter=lfs\n");
  execFileSync("ln", ["-s", join(root, "elsewhere"), join(dir, "sub", ".gitattributes")]);
  const g = generateLfsAttributes(dir, [
    ".gitattributes",
    "sub/.gitattributes",
    "../escape/.gitattributes",
    "not-attributes.txt",
  ]);
  assert.equal(g.patterns, 1);
  assert.equal(g.text, "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(dir, "big"), "x");
  writeFileSync(join(dir, ".gitattributes"), `${"# pad\n".repeat(200_000)}*.bin filter=lfs\n`);
  assert.equal(generateLfsAttributes(dir, [".gitattributes"]).patterns, 0, "over 1 MiB contributes nothing");
});

function operatorLab(extra = "") {
  const marks = join(root, "marks");
  mkdirSync(marks, { recursive: true });
  const script = (name: string, body: string) => {
    const p = join(root, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${marks}/${name}-$$"\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const lfsClean = script("lfs-clean", "printf 'POINTER\\n'; cat >/dev/null");
  const evilClean = script("evil-clean", "cat");
  const textconv = script("textconv", 'cat "$1"');
  writeFileSync(
    process.env.GIT_CONFIG_GLOBAL as string,
    `[filter "lfs"]\n\tclean = ${lfsClean}\n[filter "evil"]\n\tclean = ${evilClean}\n[diff "evil"]\n\ttextconv = ${textconv}\n[user]\n\tname = op\n\temail = op@x\n${extra}`,
  );
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one",
    root,
  );
  return {
    r: join(root, "r"),
    marks: () =>
      readdirSync(marks)
        .map((n) => n.replace(/-\d+$/, ""))
        .sort(),
  };
}

test("operator mode: filter=lfs from .gitattributes applies (the stand-in clean filter runs), nothing else does", async () => {
  const l = operatorLab();
  writeFileSync(
    join(l.r, ".gitattributes"),
    "*.bin filter=lfs -text\n*.evil filter=evil diff=evil\n*.mix filter=lfs diff=evil\n",
  );
  writeFileSync(join(l.r, "big.bin"), "BIG\n");
  writeFileSync(join(l.r, "x.evil"), "E\n");
  writeFileSync(join(l.r, "y.mix"), "M\n");
  const add = await safeGit(["add", "-A"], { cwd: l.r, trust: "operator" });
  assert.equal(add.code, 0, add.stderr);
  const blob = (path: string) => sh(`git show :${path}`, l.r);
  assert.equal(blob("big.bin"), "POINTER\n", "lfs pattern -> the operator's lfs filter");
  assert.equal(blob("y.mix"), "POINTER\n", "the mixed line carries over filter=lfs only");
  assert.equal(blob("x.evil"), "E\n", "an operator driver that is not lfs is not selected by the repository");
  assert.deepEqual(
    l.marks().filter((m) => m !== "lfs-clean"),
    [],
  );
  // textconv (diff=evil) is not selected either
  writeFileSync(join(l.r, "x.evil"), "E2\n");
  await safeGit(["diff"], { cwd: l.r, trust: "operator" });
  assert.deepEqual(
    l.marks().filter((m) => m !== "lfs-clean"),
    [],
  );
});

test("operator mode: nested .gitattributes (tracked) apply to their own directory only", async () => {
  const l = operatorLab();
  mkdirSync(join(l.r, "sub"));
  writeFileSync(join(l.r, "sub", ".gitattributes"), "*.dat filter=lfs\n");
  sh("git add sub/.gitattributes && git commit -qm attrs", l.r);
  writeFileSync(join(l.r, "sub", "a.dat"), "A\n");
  writeFileSync(join(l.r, "b.dat"), "B\n");
  await safeGit(["add", "-A"], { cwd: l.r, trust: "operator" });
  assert.equal(sh("git show :sub/a.dat", l.r), "POINTER\n");
  assert.equal(sh("git show :b.dat", l.r), "B\n");
});

test("strict mode: filter=lfs selects nothing (strict ignores the operator's config, so there is no lfs filter at all)", async () => {
  const l = operatorLab();
  writeFileSync(join(l.r, ".gitattributes"), "*.bin filter=lfs -text\n");
  writeFileSync(join(l.r, "big.bin"), "BIG\n");
  await safeGit(["add", "-A"], { cwd: l.r, trust: "strict" });
  assert.equal(sh("git show :big.bin", l.r), "BIG\n");
  assert.deepEqual(l.marks(), []);
});

test("operator mode without filter.lfs in the operator's config generates no attributes at all", async () => {
  const l = operatorLab();
  writeFileSync(process.env.GIT_CONFIG_GLOBAL as string, "[user]\n\tname = op\n\temail = op@x\n");
  writeFileSync(join(l.r, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(l.r, "big.bin"), "BIG\n");
  await safeGit(["add", "-A"], { cwd: l.r, trust: "operator" });
  assert.equal(sh("git show :big.bin", l.r), "BIG\n");
  assert.equal(readFileSync(join(l.r, "big.bin"), "utf8"), "BIG\n");
});
