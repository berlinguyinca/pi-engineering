/**
 * The panel's periodic refresh, as a thing that can be tested.
 *
 * This logic lived inline in the extension entry point, where the only way to
 * observe it was counting the process's timers — which is both flaky and
 * unable to distinguish this timer from any other. Two defects lived there
 * undetected: the loop was started and never stopped, and because starting is a
 * no-op while a timer already exists, the first session's loop permanently
 * owned refreshing and kept running git against the first session's repository.
 *
 * Every review of this area has made the same observation: the components are
 * well tested and the wiring is not, and the wiring is where the leaks are. So
 * the wiring becomes a component.
 */

export interface RefreshLoopOptions {
  /** Work to do on each tick. Exceptions are contained. */
  tick: () => void;
  intervalMs: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * A single restartable interval.
 *
 * `start()` on an already-running loop restarts it rather than being ignored:
 * the old behaviour meant a new session inherited the previous one's loop,
 * pointed at the previous one's repository, and could never replace it.
 */
export class PanelRefreshLoop {
  private readonly tick: () => void;
  private readonly intervalMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private handle: unknown = null;

  constructor(opts: RefreshLoopOptions) {
    this.tick = opts.tick;
    this.intervalMs = opts.intervalMs;
    this.setTimer = opts.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearTimer = opts.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get active(): boolean {
    return this.handle !== null;
  }

  /** Start, replacing any loop already running. */
  start(): void {
    this.stop();
    this.handle = this.setTimer(() => {
      try {
        this.tick();
      } catch {
        // A refresh is never worth taking a session down for.
      }
    }, this.intervalMs);
    // A UI refresh must never be the reason a process stays alive.
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  /** Stop. Safe to call when not running. */
  stop(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }
}
