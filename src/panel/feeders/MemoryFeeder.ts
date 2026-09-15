/**
 * Memory feeder — what this session put into memory.
 *
 * A read model over `blackholeTelemetry()`, which already exposes every counter
 * the Memory tab shows. Nothing new is recorded, and nothing is computed here
 * that the Blackhole manager does not already know.
 *
 * Blackhole is **off by default**, so the common case is no manager at all.
 * That is reported as "off" rather than as zeros: a disabled adapter and a
 * broken one must not look the same to the operator.
 */

import type { BlackholeManagerState } from "../../blackhole/types.ts";
import type { PanelMemoryView, PanelState } from "../PanelState.ts";

/** The slice of the Blackhole manager this feeder reads. */
export interface MemorySource {
  state(): BlackholeManagerState;
}

export interface MemoryFeederOptions {
  state: PanelState;
  /** Null when Blackhole is not configured for this runtime. */
  blackhole: MemorySource | null;
}

const DISABLED: PanelMemoryView = {
  enabled: false,
  entries: 0,
  promotionCandidates: 0,
  promoted: 0,
  compactions: 0,
  workers: { observer: 0, reflector: 0, dropper: 0 },
};

export class MemoryFeeder {
  private readonly state: PanelState;
  private readonly blackhole: MemorySource | null;
  private disposed = false;

  constructor(opts: MemoryFeederOptions) {
    this.state = opts.state;
    this.blackhole = opts.blackhole;
  }

  /** Read the current counts. Never throws. */
  refresh(): void {
    if (this.disposed) return;
    if (!this.blackhole) {
      this.state.set({ memory: DISABLED });
      this.state.clearError("memory");
      return;
    }
    try {
      const snapshot = this.blackhole.state();
      const workers = snapshot.memoryWorkersRun;
      this.state.set({
        memory: snapshot.enabled
          ? {
              enabled: true,
              entries: snapshot.entries,
              promotionCandidates: snapshot.promotionCandidates,
              promoted: snapshot.promoted,
              compactions: snapshot.compactions,
              workers: {
                observer: workers.observer,
                reflector: workers.reflector,
                dropper: workers.dropper,
              },
            }
          : DISABLED,
      });
      this.state.clearError("memory");
    } catch (err) {
      // A broken adapter marks its own section and leaves the panel standing.
      this.state.noteError("memory", err instanceof Error ? err.message : String(err));
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
