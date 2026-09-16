/**
 * The session narrative — the only generated content in the panel.
 *
 * Three constraints, all from the design spec, and all enforced here rather
 * than by convention:
 *
 *   1. **Deltas, not transcripts.** The prompt is built from what changed
 *      (`deltas.ts`), so it cannot grow with the session.
 *   2. **Behind the same admission gate as every other model call**, and
 *      skipped entirely while a gateway cooldown is active. The gate is NOT
 *      automatic — `AdmissionController.acquire()` is called from
 *      `PiWorkerExecutor` only — so the slot is acquired explicitly here.
 *   3. **Labeled as generated, and never evidence.** The only sink is
 *      `PanelState`. This class holds no ledger and imports none, so there is
 *      no path by which a summary becomes a recorded fact (INV-006).
 *
 * Failure is silent by design: a refused gateway or a failed summary leaves
 * the previous narrative in place with its own timestamp, and the tab reports
 * when it was last updated rather than implying it is current.
 */

import type { PanelState } from "../PanelState.ts";
import { type NarrativeInput, buildNarrativePrompt, computeDeltas, sanitizeNarrative } from "./deltas.ts";

/** A held admission slot (the shape `AdmissionController.acquire()` returns). */
export interface NarratorSlot {
  release(): void;
}

export interface NarratorOptions {
  state: PanelState;
  /**
   * The model seam. Injected so everything worth testing here needs no model,
   * and so this file knows nothing about a provider.
   */
  summarize: (prompt: string) => Promise<string>;
  /** Consulted BEFORE the gate: a narrative is never worth waiting out a cooldown. */
  cooldownRemainingMs: () => number;
  /** Explicit admission slot. The gate is not automatic. */
  acquire: () => Promise<NarratorSlot>;
  /** Minimum gap between model calls. */
  minIntervalMs?: number;
  now?: () => number;
  enabled?: boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 120_000;

export class Narrator {
  private readonly state: PanelState;
  private readonly summarize: (prompt: string) => Promise<string>;
  private readonly cooldownRemainingMs: () => number;
  private readonly acquire: () => Promise<NarratorSlot>;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly enabled: boolean;

  /** The last observation we successfully summarised. */
  private previous: NarrativeInput | undefined;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private disposed = false;

  constructor(opts: NarratorOptions) {
    this.state = opts.state;
    this.summarize = opts.summarize;
    this.cooldownRemainingMs = opts.cooldownRemainingMs;
    this.acquire = opts.acquire;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.enabled = opts.enabled ?? true;
  }

  /**
   * Observe the current state. Returns true only when a model call was made
   * AND produced a usable narrative.
   */
  async observe(input: NarrativeInput): Promise<boolean> {
    if (this.disposed || !this.enabled) return false;

    // Nothing changed: not worth a call. This is what keeps an idle session free.
    const deltas = computeDeltas(this.previous, input);
    if (deltas.length === 0) return false;

    // Debounce. A run emits phase events faster than anyone reads prose.
    if (this.now() - this.lastCallAt < this.minIntervalMs) return false;

    // Skipped, not queued: acquire() waits the cooldown out, and that wait is
    // unbounded, so acquiring here would park for minutes and then publish a
    // summary that is already stale.
    if (this.cooldownRemainingMs() > 0) return false;

    // One summary at a time. A second observation arriving mid-call must not
    // start a parallel one.
    if (this.inFlight) return false;
    this.inFlight = true;

    const slot = await this.acquire();
    try {
      const text = sanitizeNarrative(await this.summarize(buildNarrativePrompt(deltas, this.currentText())));
      // The ATTEMPT is what the debounce paces, not the success. Recording it
      // only on success meant a failing narrator had no debounce at all:
      // `lastCallAt` never advanced, so every panel state change started
      // another call. Against a saturated gateway — the one condition that
      // makes these calls fail in the first place — that is a busy-retry
      // adding load to the thing already failing, and the panel refresh loop
      // drives state changes every few seconds. Found by a dogfood run against
      // a live gateway that was refusing with `queue_timeout`.
      //
      // `previous` still advances only on success, which is what the original
      // intent was protecting: a failed call must not swallow the change it
      // failed to describe, so the next attempt still sees those deltas.
      this.lastCallAt = this.now();
      if (!text) return false;
      if (this.disposed) return false;
      this.state.set({ narrative: { text, updatedAt: this.now(), generated: true } });
      this.previous = { ...input, files: [...input.files] };
      return true;
    } catch {
      // Silent by design: the previous narrative and its timestamp stand. The
      // attempt is still paced, for the reason above.
      this.lastCallAt = this.now();
      return false;
    } finally {
      slot.release();
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private currentText(): string | undefined {
    return this.state.snapshot.narrative?.text;
  }
}
