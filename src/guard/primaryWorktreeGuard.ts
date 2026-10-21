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
 * how a session observes the repo and leaves for its own worktree. The block
 * reason tells the model exactly what to do: create/use its own worktree.
 *
 * A session that genuinely must work in the primary checkout (production
 * ops) starts with `PI_ENG_PRIMARY=1`; `PI_ENG_WORKTREE_GUARD=0` disables
 * the guard entirely. The checks are best-effort for bash (no full shell
 * parsing): an unrecognized mutating form is not a hole in the guard's
 * contract, it is a gap to close when it bites.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrimaryWorktreeGuardConfig {
  enabled: boolean;
  /** Session authorized to work in primary checkouts (production ops). */
  primarySession: boolean;
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
 * `sed -i` files, `mv` / `cp` destinations. Best-effort (no quote
 * evaluation): a target starting with `$` is still returned (the checker
 * resolves what it can and skips the rest).
 */
export function extractWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const add = (m: RegExpMatchArray) => {
    const t = m[1];
    if (t !== undefined) targets.push(t);
  };
  // Redirects: `> f`, `>> f`, `2> f` — but not `->`, `=>`, `>=`, or `>&1`.
  for (const m of command.matchAll(/(?<![A-Za-z0-9_=+&])>{1,2}\s*([A-Za-z0-9_./~$@-]+)/g)) add(m);
  for (const m of command.matchAll(/\btee\s+(?:-a\s+)?([A-Za-z0-9_./~$@-]+)/g)) add(m);
  for (const m of command.matchAll(/\bsed\s+-\w*i\w*\s+'[^']*'\s+([^\s|&;()]+)/g)) add(m);
  for (const m of command.matchAll(/\b(?:cp|mv)\s+(?:-\w+\s+)*[^\s|&;()]+\s+([^\s|&;()]+)/g)) add(m);
  return targets;
}

const GIT = /\bgit\b/;
/** Flags that consume the following word as their argument. */
const GIT_FLAGS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--git-common-dir"]);

function gitVerbs(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const verbs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === undefined || !GIT.test(word)) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const flag = tokens[j];
      if (flag === undefined || !flag.startsWith("-")) break;
      j += GIT_FLAGS_WITH_ARG.has(flag) ? 2 : 1;
    }
    const verb = tokens[j];
    if (verb !== undefined) verbs.push(verb);
  }
  return verbs;
}

const READ_ONLY_VERBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "fetch",
  "rev-parse",
  "ls-files",
  "remote",
  "blame",
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
]);

/**
 * True when the command contains a `git` invocation that changes
 * repository state (worktree, index, HEAD, refs). Read-only verbs and
 * worktree management are false — that is how a session inspects the repo
 * and leaves the primary checkout.
 */
export function isMutatingGitCommand(command: string): boolean {
  return segments(command).some((segment) => {
    for (const verb of gitVerbs(segment)) {
      if (verb === "worktree") continue; // escape hatch: add/remove/list/prune
      if (!READ_ONLY_VERBS.has(verb)) return true; // commit, checkout, add, rm, …
      if (verb === "branch" || verb === "tag") return branchOrTagMutates(segment, verb);
      if (verb === "stash") return stashMutates(segment);
      if (verb === "config") return configMutates(segment);
    }
    return false;
  });
}

/** `git branch` lists; anything with a name or flag creates/renames/deletes. */
function branchOrTagMutates(segment: string, verb: "branch" | "tag"): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const i = tokens.findIndex((t) => t === verb);
  if (i === -1) return false;
  const rest = tokens.slice(i + 1);
  const first = rest[0];
  if (first === undefined) return false; // bare `git branch` / `git tag` lists
  if (verb === "branch") {
    // -d/-D/-f/-m/-c (incl. combined like -dv) create/rename/delete.
    if (rest.some((t) => t.startsWith("-") && /[dDfmc]/.test(t.slice(1)))) return true;
    if (rest.includes("--list")) return false; // `--list [pattern]` is read-only
    if (rest.every((t) => ["-a", "-r", "-v", "-vv"].includes(t))) return false;
    return true; // a name argument (create) or an unknown flag: be strict
  }
  // `git tag` (list) vs `git tag <name> [commit]` (create).
  return !first.startsWith("-");
}

/** `git stash list|show` read; `apply|pop|drop|clear|branch|save|push|store` mutate. */
function stashMutates(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const i = tokens.findIndex((t) => t === "stash");
  if (i === -1) return false;
  const sub = tokens[i + 1];
  return sub !== undefined && !["list", "show"].includes(sub);
}

/** `git config --get/--list/--show-origin` read; setting/removing mutates. */
function configMutates(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const i = tokens.findIndex((t) => t === "config");
  if (i === -1) return false;
  return !tokens
    .slice(i + 1)
    .some((t) => ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "-l"].includes(t));
}

/**
 * The directory a bash command's `git` runs in: the session cwd, overridden
 * by a leading `cd <dir>` and by `git -C <dir>`.
 */
export function effectiveGitCwd(command: string, sessionCwd: string): string {
  let cwd = sessionCwd;
  const cd = command.match(/\bcd\s+([A-Za-z0-9_./~$@-]+)/);
  if (cd?.[1]) cwd = resolve(cwd, cd[1]);
  const cFlag = command.match(/\bgit\s+(?:-\w+\s+)*-C\s+([A-Za-z0-9_./~$@-]+)/);
  if (cFlag?.[1]) cwd = resolve(cwd, cFlag[1]);
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
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
      cwd: dir,
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const [top, gitDir, commonDir] = stdout.split("\n").map((l) => l.trim());
    if (!top || !gitDir || !commonDir) return null;
    return [top, gitDir, commonDir];
  } catch {
    return null;
  }
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

function blockReason(what: string, root: string): string {
  return [
    `Blocked: ${what} targets the PRIMARY checkout ${root} (the repository's main worktree).`,
    "One agent, one worktree (AGENTS.md): this session must work in its own worktree —",
    "create one with `git worktree add <sibling-dir> -b <branch> origin/<base>` (or use an existing one)",
    "and operate there. Read-only inspection and `git worktree` management stay allowed here.",
    "If this session must work in the primary checkout (production ops), start it with PI_ENG_PRIMARY=1.",
  ].join("\n");
}

export class PrimaryWorktreeGuard {
  private readonly cache = new Map<string, WorktreeCheck | Promise<WorktreeCheck>>();
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

  private async primaryAt(dir: string): Promise<string | null> {
    const key = canonical(dir);
    const isPrimary = this.options.isPrimary;
    if (isPrimary) {
      // Injected checker (tests): it decides directly; the canonical dir
      // doubles as the root in the message.
      const check = this.cache.get(key) as Promise<WorktreeCheck> | undefined;
      const result =
        check ??
        (async () => {
          const primary = !!(await isPrimary(key));
          const out: WorktreeCheck = { root: primary ? key : null, primary };
          this.cache.set(key, out);
          return out;
        })();
      const r = await result;
      return r.primary ? r.root : null;
    }
    const check = this.cache.get(key) as Promise<WorktreeCheck> | undefined;
    const result =
      check ??
      (async () => {
        const r = await worktreeCheck(key);
        this.cache.set(key, r);
        return r;
      })();
    const r = await result;
    return r.primary ? r.root : null;
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
      const effectiveCwd = effectiveGitCwd(command, this.cwd());
      for (const target of extractWriteTargets(command)) {
        const abs = isAbsolute(target) ? target : resolve(effectiveCwd, target);
        const root = await this.primaryAt(dirname(abs));
        if (root) return { block: true, reason: blockReason(`the write target \`${target}\``, root) };
      }
      if (isMutatingGitCommand(command)) {
        const root = await this.primaryAt(effectiveCwd);
        if (root) return { block: true, reason: blockReason("this git command", root) };
      }
      return undefined;
    }

    // Only the built-in file writers take a path that mutates the worktree;
    // read-only tools (read, symbol, …) with a path argument are allowed.
    if (toolName !== "write" && toolName !== "edit") return undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (path === undefined) return undefined;
    const abs = isAbsolute(path) ? path : resolve(this.cwd(), path);
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
