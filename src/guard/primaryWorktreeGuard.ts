/**
 * Primary worktree guard — one agent, one worktree, enforced.
 *
 * The convention (AGENTS.md, "One agent, one worktree": each agent works in
 * its own git worktree and never runs `git checkout` / `git switch` /
 * `git reset` in a directory it does not own) was prose until it cost a
 * feature: a long-running session worked directly in a repository's PRIMARY
 * checkout (the main / production worktree) while another session carried
 * uncommitted work there; a force-switch destroyed the work, and a mission
 * in the same checkout planned against a base that kept moving.
 *
 * The guard sits on the session's `tool_call` hook (next to
 * `toolCallGuard.ts`) and BLOCKS the session's own mutating calls against
 * any git repository's primary worktree:
 *
 *   - `write` / `edit` (any tool with a `path` argument) into a path in the
 *     primary checkout;
 *   - bash commands that change the primary checkout's state (`git commit`,
 *     `git checkout`, `git switch`, `git reset`, `git merge`, …; see
 *     `isMutatingGitCommand`);
 *   - bash redirects / `tee` / `sed -i` / `mv` / `cp` writing into it.
 *
 * Read-only inspection and worktree management (`git status`, `git log`,
 * `git fetch`, `git worktree add|remove|list|prune`) stay allowed — that is
 * how a session observes the repo and leaves for its own worktree. Each
 * mutating invocation is judged where ITS segment runs, so a `git -C <primary>
 * log` in the tail of a compound command does not turn the session's own
 * `git push` into a primary-checkout mutation.
 *
 * One state change against the primary checkout is allowed on proof: deleting
 * a local branch the guard can show is merged into the base and checked out
 * nowhere (`PI_ENG_BRANCH_TEARDOWN=0` turns it off). That is the convention's
 * end-of-life step — merge, then clean up the branch you created — and it had
 * no in-session route at all.
 *
 * The block reason names the segment that tripped and what to do next: create
 * or use a worktree of your own.
 *
 * A session that genuinely must work in the primary checkout (production
 * ops) starts with `PI_ENG_PRIMARY=1`; `PI_ENG_WORKTREE_GUARD=0` disables
 * the guard entirely. The checks are best-effort for bash (no full shell
 * parsing): an unrecognized mutating form is not a hole in the guard's
 * contract, it is a gap to close when it bites.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { safeGit } from "../git/safeGit.ts";
import { resolveWriteTarget, extractWriteTargets as shellWriteTargets } from "./shellTargets.ts";

export interface PrimaryWorktreeGuardConfig {
  enabled: boolean;
  /** Session authorized to work in primary checkouts (production ops). */
  primarySession: boolean;
  /**
   * Allow deleting a local branch from the primary checkout when the guard can
   * PROVE the delete loses nothing (the branch is merged into the base and is
   * not checked out in any worktree). This is the end-of-life step of the
   * one-agent-one-worktree convention: the session merges its branch and then
   * cannot clean up the branch it created. Disable with
   * `PI_ENG_BRANCH_TEARDOWN=0`.
   */
  branchTeardown: boolean;
}

export interface PrimaryWorktreeGuardOptions {
  /** Injectable for tests; defaults to the real git-based check. */
  isPrimary?: (dir: string) => boolean | Promise<boolean>;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function resolvePrimaryWorktreeGuardConfig(env: NodeJS.ProcessEnv = process.env): PrimaryWorktreeGuardConfig {
  return {
    enabled: !/^(0|false|off|no)$/i.test(env.PI_ENG_WORKTREE_GUARD ?? ""),
    primarySession: truthy(env.PI_ENG_PRIMARY),
    branchTeardown: !/^(0|false|off|no)$/i.test(env.PI_ENG_BRANCH_TEARDOWN ?? ""),
  };
}

/** Split a shell command into segments at the usual separators. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * File targets a bash command WRITES: `>` / `>>` redirects, `tee` targets,
 * `sed -i` files, `mv` / `cp` destinations.
 *
 * This used to be four regexes over the raw string, which read quoting and
 * redirection syntax as data — `grep -rn "x > y" src/` produced a write target,
 * and `echo x > "$OUT"/log.txt` produced none. It delegates to a shell-aware
 * tokenizer (`shellTargets.ts`); see #456 for the corpus of real commands that
 * each behaviour was chosen against.
 */
export function extractWriteTargets(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return shellWriteTargets(command, env);
}

/** Flags that consume the following word as their argument. */
const GIT_FLAGS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--git-common-dir"]);

/**
 * Split a segment into words and drop the shell punctuation that clings to
 * them (`'git`, `$(git`, `commit"`), so quoting does not hide an invocation
 * and a quoted verb still reads as a verb.
 */
function tokenize(segment: string): string[] {
  return segment
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^[$('"`!]+/, "").replace(/['"`),;:]+$/, ""))
    .filter(Boolean);
}

/**
 * True when the word IS a git invocation: the bare `git` command or a path to
 * the binary (`/usr/bin/git`, `./git`). A substring is not enough — matching
 * `\bgit\b` against every word also matched the path segment of
 * `gh api repos/<owner>/<repo>/git/refs/tags/v1`, the suffix of
 * `rm -f /tmp/stable-verify.git`, and the middle of a branch name like
 * `fix/primary-guard-git-token-matching`. Each of those made the guard read
 * the NEXT word as a git verb (`--jq`, `/tmp/shaltest`, `origin/main`), decide
 * it was mutating, and block a command that never touched the repository —
 * including the `git worktree add ... -b <branch>` the block message itself
 * tells the model to run.
 *
 * A trailing `:` is kept on purpose: `echo "--- git: what is X ---` is prose.
 */
function isGitCommand(word: string): boolean {
  return word === "git" || /(^|\/)git$/.test(word);
}

/** Words that may precede a command name without being the command itself. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "time", "do", "then", "else", "!", "(", "{"]);

/** True when `tokens[i]` is where a command name may sit (after `FOO=bar sudo …`). */
function atCommandPosition(tokens: string[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const prev = tokens[j];
    if (prev === undefined || COMMAND_PREFIXES.has(prev) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prev)) continue;
    return false;
  }
  return true;
}

interface GitInvocation {
  verb: string;
  /** The `git` word sits where a command name sits, not inside an argument. */
  invoked: boolean;
}

function gitInvocations(segment: string): GitInvocation[] {
  const tokens = tokenize(segment);
  const invocations: GitInvocation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === undefined || !isGitCommand(word)) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const flag = tokens[j];
      if (flag === undefined || !flag.startsWith("-")) break;
      j += GIT_FLAGS_WITH_ARG.has(flag) ? 2 : 1;
    }
    const verb = tokens[j];
    if (verb !== undefined) invocations.push({ verb, invoked: atCommandPosition(tokens, i) });
  }
  return invocations;
}

const READ_ONLY_VERBS = new Set([
  "status",
  "log",
  "whatchanged",
  "diff",
  "show",
  "fetch",
  "rev-parse",
  "rev-list",
  "ls-files",
  "remote",
  "blame",
  "annotate",
  "describe",
  "shortlog",
  "tag",
  "branch",
  "worktree",
  "config",
  "stash",
  "count-objects",
  "fsck",
  "gc",
  // Object / ref inspection. These were in NEITHER list, and an unknown verb
  // at a command position fails closed — so asking the primary checkout what it
  // contains was blocked as if it changed it. A session that cannot inspect is
  // left only with the mutating verbs it is allowed to run, which is the wrong
  // trade: `git ls-remote --heads origin` (the question "what is upstream?")
  // was refused in a live session while it was trying to recover its own
  // worktree.
  "ls-remote",
  "ls-tree",
  "ls-object",
  "ls-objects",
  "cat-file",
  "show-ref",
  "merge-base",
  "name-rev",
  "grep",
  "cherry",
  "verify-commit",
  "verify-tag",
  "verify-pack",
  // Subcommand-aware (see the *Mutates helpers): listed read-only, refused
  // when the subcommand or flag changes state.
  "reflog",
  "for-each-ref",
]);

/** Read-only `reflog` subcommands; `delete`/`expire` rewrite the reflog. */
const READ_ONLY_REFLOG_SUBCOMMANDS = new Set(["show", "exist", "exists"]);

/** `git remote` subcommands that change the remote configuration. */
const REMOTE_MUTATING_SUBCOMMANDS = new Set(["add", "remove", "rename", "set-url", "set-head", "setbranches", "prune"]);

/** Flags that make `git for-each-ref` write instead of list. */
const FOR_EACH_REF_MUTATING_FLAGS = new Set(["--delete", "--stdin", "--create-reflog"]);

/**
 * Verbs that change repository state (worktree, index, HEAD, refs). Kept
 * explicit so that a word which merely follows the letters `git` in prose is
 * not mistaken for a command; `git checkout`-style aliases are not verbs, and
 * git refuses an unknown one with "is not a git command".
 */
const MUTATING_VERBS = new Set([
  "commit",
  "checkout",
  "switch",
  "reset",
  "merge",
  "rebase",
  "cherry-pick",
  "am",
  "apply",
  "add",
  "rm",
  "restore",
  "update-ref",
  "push",
  "pull",
  "clone",
  "init",
  "clean",
  "mv",
  "rename",
  "revert",
  "bisect",
  "filter-branch",
  "symbolic-ref",
  "hash-object",
  "write-tree",
  "update-index",
  "commit-tree",
  "replace",
  "notes",
]);

/**
 * True when the command contains a `git` invocation that changes
 * repository state (worktree, index, HEAD, refs). Read-only verbs and
 * worktree management are false — that is how a session inspects the repo
 * and leaves the primary checkout.
 *
 * Two things make a word count as an invocation: it must BE `git` (or a path
 * to the binary), and the verb after it must be a verb git knows. Anything
 * else is prose — `echo "--- git: what is 524176f18392 ---"` and
 * `git/refs/tags/v1` are not commands, and blocking them (both happened in a
 * live session) only stops a session from doing the thing the block message
 * tells it to do.
 *
 * Conservative where it matters: quoting is stripped rather than skipped, so
 * `sh -c 'git commit -m x'` is still caught, and an unknown verb at a real
 * command position stays blocked in case git grows a mutating verb this list
 * predates.
 */
/**
 * Read-only verbs whose subcommand decides whether the command writes. A Map,
 * not an object literal, so a verb like `constructor` cannot resolve to
 * something that is not a check.
 */
const SUBCOMMAND_CHECKS = new Map<string, (segment: string) => boolean>([
  ["branch", (segment) => branchOrTagMutates(segment, "branch")],
  ["tag", (segment) => branchOrTagMutates(segment, "tag")],
  ["stash", stashMutates],
  ["config", configMutates],
  ["reflog", reflogMutates],
  ["remote", remoteMutates],
  ["for-each-ref", forEachRefMutates],
]);

export interface MutatingGitSegment {
  /** The verb that changes state (`branch`, `commit`, …). */
  verb: string;
  /** The whole compound-command segment that contains it. */
  segment: string;
}

/**
 * The first segment of `command` that changes repository state, or null when
 * the command is allowed. This is the verdict `isMutatingGitCommand` answers
 * with as a boolean, kept visible because a compound command is refused
 * WHOLESALE: `git worktree remove --force /wt && git branch -D fix/x` blocks
 * on the second segment alone, and a reason that says only "this git command
 * targets the primary checkout" leaves the session to guess which half was the
 * problem. It guessed by retrying four times in a live session, each retry
 * re-chaining the same allowed `worktree` half with the blocked `branch -D`
 * half, until it reached for `--git-dir` to get around the refusal.
 */
export function mutatingGitSegment(command: string): MutatingGitSegment | null {
  return offenders(command)[0] ?? null;
}

/** Every mutating git invocation in `command`, in order. */
function offenders(command: string): MutatingGitSegment[] {
  const out: MutatingGitSegment[] = [];
  for (const segment of segments(command)) out.push(...segmentOffenders(segment));
  return out;
}

function segmentOffenders(segment: string): MutatingGitSegment[] {
  const out: MutatingGitSegment[] = [];
  for (const { verb, invoked } of gitInvocations(segment)) {
    if (verb === "worktree") continue; // escape hatch: add/remove/list/prune
    if (READ_ONLY_VERBS.has(verb)) {
      // A read-only verb can still write through its subcommand (`branch -D`,
      // `stash pop`, `config user.email`, `remote set-url`).
      if (SUBCOMMAND_CHECKS.get(verb)?.(segment)) out.push({ verb, segment });
      continue;
    }
    if (MUTATING_VERBS.has(verb)) out.push({ verb, segment });
    // `git <verb git does not know>`: fail closed
    else if (invoked) out.push({ verb, segment });
  }
  return out;
}

export interface MutatingGitLocation extends MutatingGitSegment {
  /** The directory THAT segment's git runs in. */
  cwd: string;
}

/**
 * Every mutating git invocation with the directory its OWN segment runs in.
 *
 * The whole-command view cannot answer this, and the difference is the last
 * step of a session's work: `cd <own-worktree> && git push -u origin fix/x &&
 * git -C <primary> log --oneline -3` has ONE effective directory under
 * `effectiveGitCwd` (the `-C` in the tail wins), so the push of the session's
 * own branch reads as a mutation of the primary checkout and is refused —
 * twice in a live session, including the push that would have published the
 * fix for the guard itself. Each segment is judged where it actually runs.
 */
export function mutatingGitLocations(command: string, sessionCwd: string): MutatingGitLocation[] {
  let cwd = sessionCwd;
  const out: MutatingGitLocation[] = [];
  for (const segment of segments(command)) {
    const segmentCwd = segmentGitCwd(segment, cwd);
    for (const offender of segmentOffenders(segment)) out.push({ ...offender, cwd: segmentCwd });
    cwd = segmentCwd; // a `cd` carries into later segments, as it does in the shell
  }
  return out;
}

export function isMutatingGitCommand(command: string): boolean {
  return mutatingGitSegment(command) !== null;
}

/**
 * `git branch` lists; anything with a name or flag creates/renames/deletes.
 * `git tag` lists with no name and no write flag; a name creates, and
 * `-d`/`-f`/`-a`/`-m`/`-s`/`-u`/`-F` delete, move, or write an annotated or
 * signed tag. Those tag writes were missed: `git tag -d v1.0` and
 * `git tag -a v1.0 -m msg` both start with a flag, and the rule "a flag means
 * it is a listing" read them as read-only — so deleting a tag, or writing an
 * annotated one, in the PRIMARY checkout was allowed.
 */
function branchOrTagMutates(segment: string, verb: "branch" | "tag"): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === verb);
  if (i === -1) return false;
  const rest = tokens.slice(i + 1);
  const first = rest[0];
  if (first === undefined) return false; // bare `git branch` / `git tag` lists
  if (verb === "branch") {
    // -d/-D/-f/-m/-c (incl. combined like -dv) create/rename/delete.
    if (rest.some((t) => t.startsWith("-") && /[dDfmc]/.test(t.slice(1)))) return true;
    if (rest.includes("--list") || rest.includes("-l")) return false; // `--list [pattern]` is read-only
    if (rest.every((t) => ["-a", "-r", "-v", "-vv", "--all", "--remotes"].includes(t))) return false;
    return true; // a name argument (create) or an unknown flag: be strict
  }
  // `git tag`: listing flags win over a pattern argument; write flags and a
  // bare name write.
  const LISTING = new Set(["-l", "--list"]);
  const WRITING = new Set([
    "-d",
    "--delete",
    "-f",
    "--force",
    "-a",
    "--annotate",
    "-m",
    "--message",
    "-F",
    "--file",
    "-s",
    "--sign",
    "-u",
    "--local-user",
  ]);
  // Flags that consume the next word (so `-m v1.0` does not read `v1.0` as a
  // tag name being created).
  const TAKES_ARG = new Set(["-m", "--message", "-F", "--file", "-u", "--local-user"]);
  const norm = (t: string) => (t.includes("=") ? t.slice(0, t.indexOf("=")) : t);
  // An explicit listing flag wins: `git tag -l v*` lists, even though `v*` is a
  // word that would otherwise read as a tag name.
  if (rest.some((t) => LISTING.has(norm(t)))) return false;
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]!;
    if (!t.startsWith("-")) return true; // a name argument: create
    const flag = norm(t);
    if (WRITING.has(flag)) return true;
    if (TAKES_ARG.has(flag)) j++;
  }
  return false; // flags only (e.g. `--sort=-creatordate`): a listing
}

/** `git remote` lists/shows; `add|remove|rename|set-url|set-head|prune` write. */
function remoteMutates(segment: string): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "remote");
  if (i === -1) return false;
  // `remote -v`, `remote show`, `remote get-url`, bare `remote` read; `remote
  // update` fetches, which `git fetch` is already allowed to do.
  return tokens.slice(i + 1).some((t) => REMOTE_MUTATING_SUBCOMMANDS.has(t));
}

/** `git reflog` lists; `delete`/`expire` rewrite it. */
function reflogMutates(segment: string): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "reflog");
  if (i === -1) return false;
  const sub = tokens[i + 1];
  return sub !== undefined && !READ_ONLY_REFLOG_SUBCOMMANDS.has(sub);
}

/** `git for-each-ref` lists; `--delete` / `--stdin` / `--create-reflog` write. */
function forEachRefMutates(segment: string): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "for-each-ref");
  if (i === -1) return false;
  return tokens.slice(i + 1).some((t) => FOR_EACH_REF_MUTATING_FLAGS.has(t));
}

/** `git stash list|show` read; `apply|pop|drop|clear|branch|save|push|store` mutate. */
function stashMutates(segment: string): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "stash");
  if (i === -1) return false;
  const sub = tokens[i + 1];
  return sub !== undefined && !["list", "show"].includes(sub);
}

/** `git config --get/--list/--show-origin` read; setting/removing mutates. */
function configMutates(segment: string): boolean {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "config");
  if (i === -1) return false;
  return !tokens
    .slice(i + 1)
    .some((t) => ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "-l"].includes(t));
}

/** Flags whose value names the checkout, wherever the process runs. */
const GIT_DIR_FLAGS = new Set(["-C", "--git-dir", "--work-tree"]);

/**
 * The checkout a `git` invocation names for itself: `-C <dir>` moves the run,
 * `--work-tree=<dir>` names the checkout outright, `--git-dir=<dir>` names its
 * metadata directory (whose parent is the checkout for a main worktree, and
 * which stays inside the primary tree for a linked one — so it fails closed).
 *
 * `--git-dir` matters because it is the way around `-C`: a session refused
 * `git -C <primary> branch -D x` reached for `git --git-dir=<primary>/.git
 * branch -D x` and got through. Same checkout, same answer now either way.
 */
function gitDirFlagCwd(tokens: string[], from: string): string {
  let dir = from;
  let workTree: string | null = null;
  let gitDirCwd: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!GIT_DIR_FLAGS.has(flag)) continue;
    const value = eq === -1 ? tokens[i + 1] : token.slice(eq + 1);
    if (value === undefined || value.startsWith("-")) continue;
    const abs = resolve(dir, value);
    if (flag === "-C") dir = abs;
    else if (flag === "--work-tree") workTree = abs;
    // `--git-dir` names the metadata directory; its parent is the checkout for
    // a main worktree. A linked worktree's git dir (`<main>/.git/worktrees/x`)
    // stays inside the primary tree, so it fails closed.
    else gitDirCwd = basename(abs) === ".git" ? dirname(abs) : abs;
  }
  // `--work-tree` states the checkout outright; `--git-dir` only implies one.
  return workTree ?? gitDirCwd ?? dir;
}

/** A bash write target, resolved against the directory its own segment runs in. */
function writeTargetsBySegment(segments: string[], sessionCwd: string): { target: string; abs: string }[] {
  let cwd = sessionCwd;
  const out: { target: string; abs: string }[] = [];
  for (const segment of segments) {
    cwd = segmentGitCwd(segment, cwd);
    for (const target of extractWriteTargets(segment)) out.push({ target, abs: resolveWriteTarget(target, cwd) });
  }
  return out;
}

/** The directory the `git` in ONE segment of a compound command runs in. */
function segmentGitCwd(segment: string, sessionCwd: string): string {
  const tokens = tokenize(segment);
  let cwd = sessionCwd;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "cd") cwd = resolve(cwd, tokens[i + 1]!);
  }
  return gitDirFlagCwd(tokens, cwd);
}

/**
 * The directory a bash command's `git` runs in: the session cwd, overridden by
 * `cd <dir>` and by the git directory flags (`-C`, `--git-dir`, `--work-tree`),
 * with a `cd` carrying across segments the way the shell carries it.
 *
 * One directory for the whole command — the conservative view when the segments
 * are not being told apart (a redirect target is written where the process
 * runs). A command that mixes directories must be judged per segment; see
 * `mutatingGitLocations`.
 */
export function effectiveGitCwd(command: string, sessionCwd: string): string {
  let cwd = sessionCwd;
  for (const segment of segments(command)) cwd = segmentGitCwd(segment, cwd);
  return cwd;
}

interface WorktreeCheck {
  /** Canonical worktree root; null when `dir` is not inside a git worktree. */
  root: string | null;
  primary: boolean;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function gitRevParse(dir: string): Promise<[string, string, string] | null> {
  // through safeGit (round 4): a worker-written `core.worktree` / `core.bare` in the shared config cannot change which
  // work tree the guard believes `dir` is in
  const r = await safeGit(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
    cwd: dir,
    timeoutMs: 10_000,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  if (r.code !== 0) return null;
  const [top, gitDir, commonDir] = r.stdout.split("\n").map((l) => l.trim());
  if (!top || !gitDir || !commonDir) return null;
  return [top, gitDir, commonDir];
}

async function worktreeCheck(dir: string): Promise<WorktreeCheck> {
  // The queried dir may not exist yet (a write into a new nested file): walk
  // up until git can resolve a worktree.
  let d = canonical(dir);
  for (;;) {
    const parsed = await gitRevParse(d);
    if (parsed) {
      const [top, gitDir, commonDir] = parsed;
      const dirIs = (v: string) => (isAbsolute(v) ? canonical(v) : canonical(resolve(d, v)));
      const root = canonical(top);
      // Primary checkout: per-worktree git dir equals the common dir.
      return { root, primary: dirIs(gitDir) === dirIs(commonDir) };
    }
    const parent = dirname(d);
    if (parent === d) return { root: null, primary: false };
    d = parent;
  }
}

/** A plain local branch name: not a rev spec, not a shell word, not a path escape. */
const BRANCH_NAME = /^(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The branch names of a plain `git branch -d|-D <name>…` — nothing else. Any
 * other flag (`-r`, `-f`, `-m`, `-c`, `-u`, `--list`) returns no names, which
 * keeps the teardown allowance to the one operation it exists for.
 */
function branchDeleteNames(segment: string): string[] {
  const tokens = tokenize(segment);
  const i = tokens.findIndex((t) => t === "branch");
  if (i === -1) return [];
  let deleting = false;
  const names: string[] = [];
  for (const token of tokens.slice(i + 1)) {
    if (token.startsWith("-")) {
      const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (flag === "-d" || flag === "-D" || flag === "--delete") {
        deleting = true;
        continue;
      }
      return [];
    }
    if (!BRANCH_NAME.test(token)) return [];
    names.push(token);
  }
  return deleting ? names : [];
}

/** Read-only git in `cwd`, trimmed; empty string when it fails. */
async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const r = await safeGit(args, { cwd, timeoutMs: 10_000, env: { GIT_OPTIONAL_LOCKS: "0" } });
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * True when none of `shas` (branches `names`, resolved by the caller) holds a
 * commit the base lacks, and none of `names` is checked out in a worktree.
 *
 * Two proofs, either one enough, against every base the repo offers (its HEAD,
 * `origin/HEAD`, `main`): ancestry (`rev-list --count <sha>^<base>` is 0) and
 * patch equivalence (`git cherry <base> <sha>` reports nothing new). Ancestry
 * alone is not enough — a squash merge leaves the branch's own commits ahead of
 * the base while its content is entirely in it, which is the shape a merged
 * session branch is left in.
 */
async function mergedIntoBase(names: string[], shas: string[], root: string): Promise<boolean> {
  const listed = await gitOutput(root, ["worktree", "list", "--porcelain"]);
  const checkedOut = new Set(
    listed
      .split("\n")
      .filter((line) => line.startsWith("branch "))
      .map((line) => line.slice("branch ".length).trim()),
  );
  for (const name of names) if (checkedOut.has(`refs/heads/${name}`)) return false;

  const bases = new Set<string>();
  for (const ref of ["HEAD", "origin/HEAD", "origin/main", "main"]) {
    const sha = await gitOutput(root, ["rev-parse", "--verify", "--quiet", ref]);
    if (sha) bases.add(sha);
  }
  if (bases.size === 0) return false;

  for (const sha of shas) {
    let merged = false;
    for (const base of bases) {
      // `<sha> ^<base>` as TWO arguments: `<sha>^<base>` is git's parent syntax
      // ("the first parent of sha, named base"), which fails as an unknown
      // revision and would read as "not merged".
      if ((await gitOutput(root, ["rev-list", "--count", sha, `^${base}`])) === "0") {
        merged = true;
        break;
      }
      const cherry = (await gitOutput(root, ["cherry", base, sha]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      // `- <sha>`: already upstream, patch-equivalent. `+ <sha>`: not.
      if (cherry.length > 0 && cherry.every((line) => line.startsWith("-"))) {
        merged = true;
        break;
      }
    }
    if (!merged) return false;
  }
  return true;
}

/**
 * True when `dir` (or its enclosing worktree) IS the repository's primary
 * checkout. False for linked worktrees and non-git directories. Results are
 * cached per canonical directory.
 */
export async function isPrimaryWorktree(
  dir: string,
  cache = new Map<string, WorktreeCheck | Promise<WorktreeCheck>>(),
): Promise<boolean> {
  const key = canonical(dir);
  const hit = cache.get(key);
  const check =
    (hit as Promise<WorktreeCheck> | undefined) ??
    (async () => {
      const result = await worktreeCheck(key);
      cache.set(key, result);
      return result;
    })();
  const result = await check;
  return result.primary;
}

export interface PrimaryWorktreeVerdict {
  block: true;
  reason: string;
}

function blockReason(what: string, root: string, culprit?: MutatingGitSegment, hint?: string): string {
  const lines = [
    `Blocked: ${what} targets the PRIMARY checkout ${root} (the repository's main worktree).`,
    "One agent, one worktree (AGENTS.md): this session must work in its own worktree —",
    "create one with `git worktree add <sibling-dir> -b <branch> origin/<base>` (or use an existing one)",
    "and operate there. Read-only inspection and `git worktree` management stay allowed here.",
  ];
  if (culprit) {
    // Name the half that tripped: a compound command is refused wholesale, and
    // without this the session re-runs the same mix and reads the refusal as a
    // blanket ban on the allowed part too.
    lines.push(
      `Culprit segment: \`${culprit.segment}\` (\`git ${culprit.verb}\` changes the primary checkout).`,
      "Only that segment blocks — run the allowed parts of this command separately.",
    );
  }
  if (hint) lines.push(hint);
  lines.push("If this session must work in the primary checkout (production ops), start it with PI_ENG_PRIMARY=1.");
  return lines.join("\n");
}

export class PrimaryWorktreeGuard {
  private readonly cache = new Map<string, WorktreeCheck | Promise<WorktreeCheck>>();
  /** No-loss branch-delete verdicts, keyed by root + names + resolved shas. */
  private readonly teardown = new Map<string, Promise<boolean>>();
  private readonly sessionCwd: string | (() => string);
  private readonly config: PrimaryWorktreeGuardConfig;
  private readonly options: PrimaryWorktreeGuardOptions;

  constructor(
    sessionCwd: string | (() => string),
    config: PrimaryWorktreeGuardConfig = resolvePrimaryWorktreeGuardConfig(),
    options: PrimaryWorktreeGuardOptions = {},
  ) {
    this.sessionCwd = sessionCwd;
    this.config = config;
    this.options = options;
  }

  private cwd(): string {
    return typeof this.sessionCwd === "function" ? this.sessionCwd() : this.sessionCwd;
  }

  /** What `dir` is: primary checkout, linked worktree, or not a repository. */
  private async check(dir: string): Promise<WorktreeCheck> {
    const key = canonical(dir);
    const hit = this.cache.get(key) as Promise<WorktreeCheck> | undefined;
    if (hit) return hit;
    const injected = this.options.isPrimary;
    // Injected checker (tests): it decides directly, and the canonical dir
    // doubles as the root in the message.
    const made = (async (): Promise<WorktreeCheck> => {
      if (injected) {
        const primary = !!(await injected(key));
        return { root: primary ? key : null, primary };
      }
      return worktreeCheck(key);
    })();
    this.cache.set(key, made);
    return made;
  }

  private async primaryAt(dir: string): Promise<string | null> {
    const check = await this.check(dir);
    return check.primary ? check.root : null;
  }

  /**
   * Guidance for a session that has nowhere to work. Removing your own worktree
   * is allowed (`git worktree` is the escape hatch), and it leaves the session
   * with its cwd outside every worktree, where every command it can still
   * reach is a read on the primary checkout. The refusal should say so instead
   * of pointing at a worktree that no longer exists.
   */
  private async sessionHint(): Promise<string | undefined> {
    const own = await this.check(this.cwd());
    if (own.primary) {
      return `Your session directory ${this.cwd()} IS the primary checkout — move to a worktree you own.`;
    }
    if (own.root === null) {
      return [
        `Your session directory ${this.cwd()} is not inside a git worktree (did a \`git worktree remove\` take it?).`,
        "`git worktree add <sibling-dir> -b <branch> origin/<base>` gives you one back, and it is allowed here.",
      ].join(" ");
    }
    return undefined;
  }

  /**
   * True when `segment` is a plain `git branch -d|-D <name>…` whose branches are
   * provably safe to delete: local refs, not checked out anywhere, with nothing
   * the base lacks. This is the convention's end-of-life step — merge, then
   * clean up the branch you created — which had no in-session route at all
   * beyond restarting with PI_ENG_PRIMARY=1.
   */
  private async deletesMergedBranchOnly(root: string, segment: string): Promise<boolean> {
    const names = branchDeleteNames(segment);
    if (names.length === 0) return false;
    const shas: string[] = [];
    for (const name of names) {
      const sha = await gitOutput(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      // Not a local branch: a remote-tracking ref, a tag, or a typo. The
      // allowance is for the session's own branches, so refuse.
      if (!sha) return false;
      shas.push(sha);
    }
    // Keyed by sha as well as name: a branch that was merged can gain commits
    // and become unmerged, and a stale verdict must not authorise that delete.
    const key = `${root}\u0000${names.join(",")}\u0000${shas.join(",")}`;
    const cached = this.teardown.get(key);
    if (cached) return cached;
    const verdict = mergedIntoBase(names, shas, root);
    this.teardown.set(key, verdict);
    return verdict;
  }

  /**
   * Inspect a tool call before it runs. Returns a block verdict, or
   * undefined to let it run. Async: the primary check shells out to git
   * (cached per directory).
   */
  async onToolCall(toolName: string, input: unknown): Promise<PrimaryWorktreeVerdict | undefined> {
    if (!this.config.enabled || this.config.primarySession) return undefined;
    const args = (input ?? {}) as Record<string, unknown>;

    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command : undefined;
      if (command === undefined) return undefined;
      // Per segment, because a compound command carries its own directories:
      // `cd <own-wt> && echo x > notes.md && git -C <primary> log` writes in
      // the worktree the session owns, and judging that write against the
      // directory a LATER step names blocks work that is allowed.
      const parts = segments(command);
      for (const target of writeTargetsBySegment(parts, this.cwd())) {
        const root = await this.primaryAt(dirname(target.abs));
        if (root) return { block: true, reason: blockReason(`the write target \`${target.target}\``, root) };
      }
      // Likewise each mutating invocation is judged where ITS segment runs: a
      // `git -C <primary> log` in the tail must not turn the session's own
      // `git push` into a primary-checkout mutation.
      let refusedDelete = false;
      for (const location of mutatingGitLocations(command, this.cwd())) {
        const root = await this.primaryAt(location.cwd);
        if (!root) continue; // that segment runs where the session may work
        if (this.config.branchTeardown && location.verb === "branch") {
          if (await this.deletesMergedBranchOnly(root, location.segment)) continue;
          refusedDelete = branchDeleteNames(location.segment).length > 0;
        }
        const hint = refusedDelete
          ? "A branch delete is allowed here only when it provably loses nothing: the branch must be a local ref, merged into the base (by ancestry or patch-equivalent), and not checked out in any worktree."
          : await this.sessionHint();
        return { block: true, reason: blockReason("this git command", root, location, hint) };
      }
      return undefined;
    }

    // Only the built-in file writers take a path that mutates the worktree;
    // read-only tools (read, symbol, …) with a path argument are allowed.
    if (toolName !== "write" && toolName !== "edit") return undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (path === undefined) return undefined;
    const abs = resolveWriteTarget(path, this.cwd());
    const root = await this.primaryAt(dirname(abs));
    if (root) return { block: true, reason: blockReason(`the write to \`${path}\``, root) };
    return undefined;
  }
}

interface ToolHookHost {
  on(
    event: "tool_call",
    handler: (event: { toolName: string; input: unknown }) => Promise<PrimaryWorktreeVerdict | undefined>,
  ): unknown;
}

/** Attach one primary-worktree guard to a live session's tool_call hook. */
export function registerPrimaryWorktreeGuard(
  pi: ToolHookHost,
  sessionCwd: string | (() => string),
  config?: PrimaryWorktreeGuardConfig,
): PrimaryWorktreeGuard {
  const guard = new PrimaryWorktreeGuard(sessionCwd, config ?? resolvePrimaryWorktreeGuardConfig());
  pi.on("tool_call", async (event) => guard.onToolCall(String(event.toolName), event.input));
  return guard;
}
