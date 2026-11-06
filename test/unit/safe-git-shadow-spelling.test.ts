/**
 * Translating a shadow git directory back to the real repository must never invent a path.
 *
 * Recorded vs canonical: Pi records the shadow path as it built it, `git` prints what it prints, and on macOS the
 * recorded form (`/var/…`, because `$TMPDIR` lives behind `/var` → `/private/var`) is the literal TAIL of the
 * canonical form. A `split().join()` rewrite of that tail turned `/private` + `/var/…` into `/private/private/…`,
 * a path that cannot exist, and every `mkdir` under a repository's common directory (locks, worktree
 * administration) then failed with ENOENT. These cases pin the substitution itself, independent of how any
 * particular `git` build chooses to spell the path it was handed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { safeGit, stateHooks } from "../../src/git/safeGit.ts";
import { mentionsShadow, shadowRewrites, unshadowText } from "../../src/git/shadowPaths.ts";

const RECORDED = "/var/folders/T/state/safegit/shadow/s-1";
const CANONICAL = "/private/var/folders/T/state/safegit/shadow/s-1";
const REAL_COMMON = "/private/work/repo/.git";
const REAL_WORK_TREE = "/private/work/repo";

const spelling = { root: RECORDED, rootReal: CANONICAL, common: `${RECORDED}/.git`, commonReal: `${CANONICAL}/.git` };
const targets = { commonTo: REAL_COMMON, rootTo: REAL_WORK_TREE };

test("the canonical spelling git prints maps to the real directory, never to a doubled prefix", () => {
  const out = unshadowText(`${CANONICAL}/.git\n`, spelling, targets);
  assert.equal(out, `${REAL_COMMON}\n`);
  assert.ok(!out.includes("/private/private"), out);
  assert.ok(!out.includes("safegit"), out);
});

test("the recorded spelling maps too, because git may echo what it was handed", () => {
  assert.equal(unshadowText(`${RECORDED}/.git`, spelling, targets), REAL_COMMON);
});

test("both spellings in one string are translated", () => {
  const out = unshadowText(`worktree ${CANONICAL}/.git\ngitdir: ${RECORDED}/.git`, spelling, targets);
  assert.equal(out, `worktree ${REAL_COMMON}\ngitdir: ${REAL_COMMON}`);
});

test("the longer spelling wins: <root>/.git is the common directory, a bare <root> is its parent", () => {
  assert.equal(
    unshadowText(`${RECORDED}/.git`, { ...spelling, rootReal: null, commonReal: null }, targets),
    REAL_COMMON,
  );
  assert.equal(
    unshadowText(`${RECORDED}/attributes`, { ...spelling, rootReal: null, commonReal: null }, targets),
    `${REAL_WORK_TREE}/attributes`,
  );
});

test("a bare root with no real counterpart is left alone rather than guessed", () => {
  const out = unshadowText(`${RECORDED}/attributes`, spelling, { commonTo: REAL_COMMON, rootTo: null });
  assert.equal(out, `${RECORDED}/attributes`);
});

test("the tail of a longer absolute path is a different directory and stays untouched", () => {
  // a repository whose own path ENDS where the shadow path starts: rewriting this would corrupt a real path
  const nested = `/mnt/builds/var/folders/T/state/safegit/shadow/s-1/.git`;
  assert.equal(
    unshadowText(nested, { root: "/var/folders/T/state/safegit/shadow/s-1", common: `${RECORDED}/.git` }, targets),
    nested,
  );
});

test("text that holds no shadow path comes back identical, and mapping twice changes nothing", () => {
  const plain = "On branch main\nnothing to commit, working tree clean\n";
  assert.equal(unshadowText(plain, spelling, targets), plain);
  const once = unshadowText(`x ${CANONICAL}/.git`, spelling, targets);
  assert.equal(unshadowText(once, spelling, targets), once);
});

test("rewrites skip a spelling that equals its own target, longest first otherwise", () => {
  const list = shadowRewrites(
    { root: "/a", rootReal: "/a", common: "/a/b", commonReal: "/x/y" },
    { commonTo: "/t", rootTo: "/u" },
  );
  assert.deepEqual(list.map((r) => r.to).sort(), ["/t", "/t", "/u"]);
  assert.deepEqual([...new Set(list.map((r) => r.from))].sort(), ["/a", "/a/b", "/x/y"]);
  const lengths = list.map((r) => r.from.length);
  assert.deepEqual(
    lengths,
    [...lengths].sort((a, b) => b - a),
    "longest spelling must be tried first",
  );
  assert.equal(list.at(-1)?.from, "/a");
});

test("mentionsShadow sees either spelling of the shadow", () => {
  assert.ok(mentionsShadow(`gitdir: ${CANONICAL}/worktrees/wt`, spelling));
  assert.ok(mentionsShadow(`gitdir: ${RECORDED}/worktrees/wt`, spelling));
  assert.ok(!mentionsShadow("gitdir: /private/work/repo/.git/worktrees/wt", spelling));
});

// ─── the same guarantee through a real safeGit call ──────────────────────────────────────────────────────────────

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-spelling-"));
  // Force the two spellings apart on any platform: the state root Pi records is a symlink, its real path is not.
  const real = join(root, "state-real");
  mkdirSync(real, { mode: 0o700 });
  stateHooks.stateRoot = join(root, "state-link");
  symlinkSync(real, join(root, "state-link"));
  mkdirSync(join(root, "home"));
});
after(() => {
  stateHooks.stateRoot = undefined;
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  HOME: join(root, "home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

test("a shadow reached through a symlink still resolves to the real repository, not to a doubled path", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: env() });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { env: env() });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { env: env() });
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "one"], { env: env() });

  const recordedRoot = realpathSync(join(root, "state-link"));
  assert.notEqual(recordedRoot, join(root, "state-link"), "the fixture must actually present two spellings");

  for (const args of [
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--show-toplevel"],
  ]) {
    const r = await safeGit(args, { cwd: repo, trust: "operator" });
    assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
    const printed = r.stdout.trim();
    assert.ok(!printed.includes("/private/private"), `${args.join(" ")} doubled a prefix: ${printed}`);
    assert.ok(!printed.includes("safegit"), `${args.join(" ")} leaked the shadow directory: ${printed}`);
    assert.ok(existsSync(printed), `${args.join(" ")} named a path that does not exist: ${printed}`);
  }
});
