import { formatWaitingFor } from "../../gateway/admissionNotice.ts";

/**
 * Decides whether a clock-only tick could change anything on screen.
 *
 * Ages render as seconds under a minute, `Xm YYs` under an hour, then `Xh YYm`,
 * so a mission that has been quiet for hours changes once a minute yet used to
 * be re-projected, re-redacted and redrawn every second. The gate remembers the
 * timestamps an event displayed and lets a tick through only when one of the
 * rendered ages differs, or when `maxStaleMs` has passed so time-derived state
 * (a worker going stalled) is still re-evaluated from the live projection.
 */
export class ClockOnlyGate {
  private readonly seen = new Map<string, { stamps: string[]; ages: string; builtAtMs: number }>();

  private readonly maxStaleMs: number;

  constructor(maxStaleMs = 15_000) {
    this.maxStaleMs = maxStaleMs;
  }

  /** Record what a freshly built event displays. Call after every full build. */
  remember(missionId: string, stamps: Array<string | null | undefined>, nowMs: number): void {
    const kept = stamps.filter((stamp): stamp is string => !!stamp);
    this.seen.set(missionId, { stamps: kept, ages: ClockOnlyGate.ages(kept, nowMs), builtAtMs: nowMs });
  }

  /** True when a clock-only tick at `nowMs` needs a full rebuild and redraw. */
  due(missionId: string, nowMs: number): boolean {
    const entry = this.seen.get(missionId);
    if (!entry) return true;
    if (nowMs - entry.builtAtMs >= this.maxStaleMs) return true;
    return ClockOnlyGate.ages(entry.stamps, nowMs) !== entry.ages;
  }

  forget(missionId: string): void {
    this.seen.delete(missionId);
  }

  clear(): void {
    this.seen.clear();
  }

  private static ages(stamps: string[], nowMs: number): string {
    return stamps
      .map((stamp) => {
        const at = Date.parse(stamp);
        return Number.isFinite(at) ? formatWaitingFor(Math.max(0, nowMs - at)) : "";
      })
      .join("|");
  }
}

/** Clock-only UI refreshes. Never writes events or manufactures worker liveness. */
export class MissionActivityTicker {
  private readonly missions = new Set<string>();
  private cancel?: () => void;
  private closed = false;
  private readonly options: {
    state: (missionId: string) => string | undefined;
    emit: (missionId: string, observedAt: string) => void;
    now?: () => string;
    schedule?: (tick: () => void) => () => void;
  };

  constructor(options: MissionActivityTicker["options"]) {
    this.options = options;
  }

  watch(missionId: string): void {
    if (this.closed) return;
    const state = this.options.state(missionId);
    if (!state || ["COMPLETE", "FAILED", "CANCELED"].includes(state)) this.missions.delete(missionId);
    else this.missions.add(missionId);
    if (this.missions.size === 0) {
      this.cancel?.();
      this.cancel = undefined;
    } else if (!this.cancel) {
      const tick = () => this.tick();
      this.cancel = this.options.schedule
        ? this.options.schedule(tick)
        : (() => {
            const timer = setInterval(tick, 1000);
            timer.unref();
            return () => clearInterval(timer);
          })();
    }
  }

  private tick(): void {
    const now = this.options.now?.() ?? new Date().toISOString();
    for (const missionId of this.missions) {
      try {
        this.options.emit(missionId, now);
      } catch {
        // UI listeners cannot interrupt monitoring of other missions.
      }
      this.watch(missionId);
    }
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
    this.missions.clear();
  }
}
