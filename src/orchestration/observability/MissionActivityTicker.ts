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
