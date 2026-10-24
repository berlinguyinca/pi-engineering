/**
 * Watching the runtime source for a new commit, so the running Pi reloads
 * itself instead of waiting for a restart or a hand-typed `/pie reload`.
 *
 * Polling, not `fs.watch`: the signal that matters is "the checkout's HEAD
 * moved" (a merge landed on the branch Pi loads from), which one `git
 * rev-parse HEAD` answers exactly, and a half-edited working tree must NOT
 * trigger a reload — it would load code nobody has finished writing. An
 * uncommitted edit therefore changes nothing here; commit it (or merge it)
 * and the next poll picks it up. And because a handover snapshots the
 * working tree, not the commit, a HEAD move while tracked files are edited
 * is NOT acted on either (`trackedChanges`): the owner waits until the tree
 * is clean, so a half-edited file never rides along under a merge's SHA.
 *
 * The watcher is a timer and nothing else (spec §4 leak list): `dispose()`
 * clears it and resolves once a poll in flight has finished, the timer is
 * unref'd so it never keeps the process alive. What to DO on a change is the
 * owner's (`onChange`): the watcher only knows fingerprints.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeGit, safeGitSync } from "../../git/safeGit.ts";
import { type GitRunner, type SelfUpdateResult, checkForUpdate } from "../../update/selfUpdate.ts";

export const DEFAULT_AUTO_RELOAD_INTERVAL_MS = 15_000;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** How often a tracking checkout is fetched and fast-forwarded (a network call; not every poll). */
export const DEFAULT_FOLLOW_REMOTE_INTERVAL_MS = 5 * 60_000;

export interface SourceWatchOptions {
  intervalMs: number;
  /** Clock for retry deadlines; defaults to Date.now. */
  now?(): number;
  /** The fingerprint the running code corresponds to; null when unknown (the first poll sets it). */
  baseline?: string | null;
  /** The source's current fingerprint, or null when it cannot be read (the poll is skipped). */
  fingerprint(): Promise<string | null>;
  /**
   * The fingerprint moved. Return true when the change was acted on (the
   * baseline advances), false to leave it unaccepted. Repeated failures of
   * the same fingerprint retry after 30s, doubling up to 5 minutes. A new
   * fingerprint retries immediately; successful activation resets the delay.
   */
  onChange(next: string, previous: string): Promise<boolean> | boolean;
  /** A failed poll or handler; never thrown out of the timer. */
  onError?(error: unknown): void;
}

export class SourceWatcher {
  private readonly opts: SourceWatchOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private baseline: string | null;
  private disposed = false;
  private started = false;
  private polling: Promise<void> | undefined;
  private retry: { fingerprint: string; delayMs: number; after: number } | undefined;

  constructor(opts: SourceWatchOptions) {
    this.opts = opts;
    this.baseline = opts.baseline ?? null;
  }

  /** The fingerprint the watcher currently considers "running". */
  get current(): string | null {
    return this.baseline;
  }

  /** Started and not disposed. True during a poll too (the timer is re-armed after it). */
  get active(): boolean {
    return !this.disposed && this.started;
  }

  start(): void {
    if (this.disposed || this.timer) return;
    this.started = true;
    this.schedule();
  }

  /**
   * Stop polling. Resolves once a poll in flight (and the git child it may
   * be running) has finished, so an owner tearing down the checkout — a test
   * deleting it, a session closing — does not race a fetch still writing
   * into `.git`.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.polling ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  private deferRetry(fingerprint: string): void {
    const delayMs = Math.min((this.retry?.delayMs ?? INITIAL_RETRY_DELAY_MS / 2) * 2, MAX_RETRY_DELAY_MS);
    this.retry = { fingerprint, delayMs, after: (this.opts.now?.() ?? Date.now()) + delayMs };
  }

  /** One poll now. Reads the source immediately but respects any activation retry deadline. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        const next = await this.opts.fingerprint();
        if (next === null || this.disposed) return;
        if (this.retry?.fingerprint !== next) this.retry = undefined;
        if (this.baseline === null) {
          this.baseline = next;
          return;
        }
        if (next === this.baseline) {
          this.retry = undefined;
          return;
        }
        if (this.retry && (this.opts.now?.() ?? Date.now()) < this.retry.after) return;
        try {
          const acted = await this.opts.onChange(next, this.baseline);
          if (acted) {
            this.baseline = next;
            this.retry = undefined;
          } else this.deferRetry(next);
        } catch (error) {
          this.deferRetry(next);
          throw error;
        }
      } catch (error) {
        this.opts.onError?.(error);
      } finally {
        this.polling = undefined;
        // Re-armed only by the timer path: an explicit poll() must not start
        // a second timer beside the one already waiting.
        if (!this.disposed && this.timer === undefined) this.schedule();
      }
    })();
    return this.polling;
  }
}

/**
 * The environment for git run from a timer, where nobody can answer a
 * prompt. `git_terminal_prompt` opens /dev/tty directly, whatever stdio is,
 * so it is switched off; askpass is pointed at `true` (empty answer, fast
 * failure); optional locks are off so a background `status` never takes
 * `.git/index.lock` from under the operator's own `git add`.
 *
 * ssh runs in batch mode (a passphrase or an unknown host key fails at once)
 * ONLY when nothing of the operator's would be displaced by it:
 * `GIT_SSH_COMMAND` wins over both `GIT_SSH` and `core.sshCommand` in git, so
 * when either is set (`sshConfigured` covers the config key, which this
 * function cannot read on its own) the operator's command is kept as is and
 * the runner's detached, tty-less child is what stops a prompt from hanging.
 */
export function unattendedGitEnv(base: NodeJS.ProcessEnv = process.env, sshConfigured = false): NodeJS.ProcessEnv {
  const sshOverride = !base.GIT_SSH_COMMAND && !base.GIT_SSH && !sshConfigured;
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "",
    GIT_OPTIONAL_LOCKS: "0",
    ...(sshOverride ? { GIT_SSH_COMMAND: "ssh -oBatchMode=yes" } : {}),
  };
}

const sshConfiguredByRoot = new Map<string, boolean>();

/**
 * Has the operator configured `core.sshCommand` for `root` (or globally)?
 * Read once per checkout: it is configuration, not state that moves.
 */
export function sshCommandConfigured(root: string): boolean {
  const known = sshConfiguredByRoot.get(root);
  if (known !== undefined) return known;
  // Through safeGit (operator trust): the operator's system/global `core.sshCommand` counts, a repository-local one
  // (writable by whoever works in the checkout) does not reach git at all.
  const r = safeGitSync(["config", "--get", "core.sshCommand"], { cwd: root, trust: "operator", timeoutMs: 5_000 });
  const configured = r.code === 0 && r.stdout.trim().length > 0;
  sshConfiguredByRoot.set(root, configured);
  return configured;
}

/**
 * Is a git operation that moves HEAD on its own underway — a rebase, a merge
 * with conflicts, a bisect — or is HEAD detached? Each intermediate HEAD of
 * those is not code anyone meant to run, and a snapshot would copy the
 * half-resolved working tree with it. The watcher skips its poll until they
 * are done; a `git checkout` of another branch still counts as a move.
 */
export function gitOperationInProgress(root: string): boolean {
  const gitDir = resolveGitDir(root);
  if (!gitDir) return false;
  for (const marker of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "BISECT_LOG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    if (existsSync(join(gitDir, marker))) return true;
  }
  try {
    // A detached HEAD is a bare commit id rather than "ref: refs/heads/…".
    return !readFileSync(join(gitDir, "HEAD"), "utf8").startsWith("ref: ");
  } catch {
    return false;
  }
}

/** `.git` of `root`, following the `gitdir:` file a worktree keeps there. */
function resolveGitDir(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return null;
    const target = pointer.slice("gitdir: ".length);
    return resolve(root, target);
  } catch {
    return null;
  }
}

/**
 * A GitRunner (src/update/selfUpdate.ts) over `root`, for the follow-remote
 * step and the legacy session-start update. The child runs in its own
 * session (`detached`), so it has no controlling terminal: neither git nor
 * ssh can open /dev/tty to ask anything, whatever the operator's ssh
 * configuration is. stdin is closed for the same reason.
 */
export function gitRunner(root: string, timeoutMs = 30_000): GitRunner {
  return async (args) => {
    const env = unattendedGitEnv({}, sshCommandConfigured(root));
    const r = await safeGit(args, {
      cwd: root,
      trust: "operator",
      timeoutMs,
      detached: true,
      env: {
        GIT_ASKPASS: env.GIT_ASKPASS ?? "true",
        SSH_ASKPASS: env.SSH_ASKPASS ?? "",
        GIT_OPTIONAL_LOCKS: "0",
        ...(env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND } : {}),
      },
    });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

/**
 * Tracked files with uncommitted changes in `root` (staged or not), or null
 * when git cannot answer. Untracked files are not listed: they are not part
 * of what a merge would have touched, and a snapshot of them is harmless.
 */
export async function trackedChanges(root: string, timeoutMs = 10_000): Promise<string[] | null> {
  const r = await gitRunner(root, timeoutMs)(["status", "--porcelain", "--untracked-files=no"]);
  if (r.code !== 0) return null;
  return r.stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim());
}

/**
 * Bring a checkout that tracks a remote (a session on another host, loading
 * pi-engineering from a clone of the GitHub repository) up to that remote:
 * fetch, then a strict fast-forward — never over uncommitted work, never
 * when the branch diverged (`checkForUpdate` owns those rules). A
 * fast-forward moves HEAD, which the watcher then turns into a hot reload.
 */
export function followRemote(root: string): Promise<SelfUpdateResult> {
  return checkForUpdate({ cwd: root, git: gitRunner(root), apply: true });
}

/** `git rev-parse HEAD` of `root`, or null when it is not a readable checkout. */
export async function gitHead(root: string, timeoutMs = 5_000): Promise<string | null> {
  // A rebase, merge or bisect in flight (or a detached HEAD): no fingerprint,
  // so the poll is skipped rather than loading an intermediate state.
  if (gitOperationInProgress(root)) return null;
  const r = await safeGit(["rev-parse", "HEAD"], { cwd: root, trust: "operator", timeoutMs });
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
