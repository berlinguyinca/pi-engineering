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

export const DEFAULT_AUTO_RELOAD_INTERVAL_MS = 15_000;

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
  private polling: Promise<void> | undefined;

  constructor(opts: SourceWatchOptions) {
    this.opts = opts;
    this.baseline = opts.baseline ?? null;
  }

  /** The fingerprint the watcher currently considers "running". */
  get current(): string | null {
    return this.baseline;
  }

  get active(): boolean {
    return !this.disposed && this.timer !== undefined;
  }

  start(): void {
    if (this.disposed || this.timer) return;
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

/** `git rev-parse HEAD` of `root`, or null when it is not a readable checkout. */
export function gitHead(root: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const sha = stdout.trim();
      resolve(/^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}
