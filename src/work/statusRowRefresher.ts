import { formatWorkStatusRow } from "./summaryText.ts";
/**
 * Keeps the compact work status row current without costing anything while idle.
 *
 * `refresh()` re-reads the projection and writes the row only when its text changed. While any run is
 * non-terminal a single unref'd timer repeats that (so a run that stops heartbeating flips to "unknown" on its
 * own); when nothing is live the timer is cleared and the idle path does no work at all. Everything impure
 * (projection, setter, timers) is injected.
 */
import type { WorkGraph } from "./types.ts";

const LIVE_HEALTH = new Set(["active", "waiting", "stalled", "recovering", "unknown"]);

export interface TimerHandle {
  unref?(): unknown;
}

export interface StatusRowRefresherOptions {
  /** Current work graph, or undefined when no runtime is open. May throw or reject: errors are swallowed. */
  getGraph: () => WorkGraph | undefined | Promise<WorkGraph | undefined>;
  setStatus: (text: string | undefined) => void;
  intervalMs: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class StatusRowRefresher {
  private readonly o: StatusRowRefresherOptions;
  private last: string | undefined;
  private timer: TimerHandle | undefined;
  private disposed = false;
  private inFlight = false;

  constructor(options: StatusRowRefresherOptions) {
    this.o = options;
  }

  /** Whether the liveness timer is armed (observable for tests). */
  get timerActive(): boolean {
    return this.timer !== undefined;
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    try {
      let graph: WorkGraph | undefined;
      try {
        graph = await this.o.getGraph();
      } catch {
        return; // keep the last row and the current timer state; the next tick retries
      }
      if (this.disposed || !graph) return;
      const text = formatWorkStatusRow(graph);
      if (text !== this.last) {
        this.last = text;
        try {
          this.o.setStatus(text);
        } catch {
          // a UI that rejects the write must not break the timer
        }
      }
      this.syncTimer(graph.runs.some((r) => LIVE_HEALTH.has(r.health)));
    } finally {
      this.inFlight = false;
    }
  }

  private syncTimer(live: boolean): void {
    if (!live) {
      this.stopTimer();
      return;
    }
    if (this.timer) return;
    const set = this.o.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = set(() => void this.refresh(), this.o.intervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    (this.o.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.last = undefined;
  }
}
