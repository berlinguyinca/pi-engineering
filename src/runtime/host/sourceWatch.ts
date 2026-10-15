/**
 * Watching the runtime source for a new commit, so the running Pi reloads
 * itself instead of waiting for a restart or a hand-typed `/pie reload`.
 *
 * Polling, not `fs.watch`: the signal that matters is "the checkout's HEAD
 * moved" (a merge landed on the branch Pi loads from), which one `git
 * rev-parse HEAD` answers exactly, and a half-edited working tree must NOT
 * trigger a reload — it would load code nobody has finished writing. An
 * uncommitted edit therefore changes nothing here; commit it (or merge it)
 * and the next poll picks it up.
 *
 * The watcher is a timer and nothing else (spec §4 leak list): `dispose()`
 * clears it, the timer is unref'd so it never keeps the process alive, and a
 * poll that is still running when the watcher is disposed finishes quietly.
 * What to DO on a change is the owner's (`onChange`): the watcher only knows
 * fingerprints.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type GitRunner, type SelfUpdateResult, checkForUpdate } from "../../update/selfUpdate.ts";

export const DEFAULT_AUTO_RELOAD_INTERVAL_MS = 15_000;
/** How often a tracking checkout is fetched and fast-forwarded (a network call; not every poll). */
export const DEFAULT_FOLLOW_REMOTE_INTERVAL_MS = 5 * 60_000;

export interface SourceWatchOptions {
  intervalMs: number;
  /** The fingerprint the running code corresponds to; null when unknown (the first poll sets it). */
  baseline?: string | null;
  /** The source's current fingerprint, or null when it cannot be read (the poll is skipped). */
  fingerprint(): Promise<string | null>;
  /**
   * The fingerprint moved. Return true when the change was acted on (the
   * baseline advances), false to leave the baseline and try again next poll —
   * for instance while another handover is still running.
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

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  /** One poll now. Exposed for tests and for an explicit "check now". */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        const next = await this.opts.fingerprint();
        if (next === null || this.disposed) return;
        if (this.baseline === null) {
          this.baseline = next;
          return;
        }
        if (next === this.baseline) return;
        const acted = await this.opts.onChange(next, this.baseline);
        if (acted) this.baseline = next;
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
 * failure); ssh runs in batch mode so a passphrase or an unknown host key
 * fails at once. The operator's own GIT_SSH_COMMAND, when set, is kept.
 */
export function unattendedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "",
    ...(base.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }),
  };
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

/** A GitRunner (src/update/selfUpdate.ts) over `root`, for the follow-remote step. */
export function gitRunner(root: string, timeoutMs = 30_000): GitRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["-C", root, ...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: unattendedGitEnv(),
        },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: unknown }).code as number | undefined) : 0;
          resolve({
            code: typeof code === "number" ? code : error ? 1 : 0,
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? error?.message ?? "",
          });
        },
      );
    });
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
export function gitHead(root: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    // A rebase, merge or bisect in flight (or a detached HEAD): no fingerprint,
    // so the poll is skipped rather than loading an intermediate state.
    if (gitOperationInProgress(root)) return resolve(null);
    execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const sha = stdout.trim();
      resolve(/^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}
