/**
 * Gateway admission control (companion to src/gateway/signals.ts).
 *
 * The runtime can have several model sessions in flight at once (parallel
 * tournament legs, parallel DAG waves, plus the operator's own interactive
 * turn). When the gateway answers `429 … inference_admission` it is telling us
 * two separate things:
 *
 *   1. *wait this long* — `retry_after_ms`;
 *   2. *this is how many requests I will admit* — `active_limit`.
 *
 * Honouring (1) per-call is not enough: while one leg sleeps, the others keep
 * hammering the same saturated queue. So the cooldown is held PROCESS-WIDE —
 * every caller that wants to talk to the model waits behind the same gate —
 * and (2) clamps how many callers may hold a slot at once.
 *
 * Pure except for the injected clock and sleeper, so tests never sleep.
 */

import { type GatewayWaitSignal, describeGatewayWait } from "./signals.ts";

export interface AdmissionControllerOptions {
  /** Concurrent model sessions allowed before the gateway says otherwise. */
  maxConcurrency: number;
  /** Floor for the gateway-derived clamp: never throttle below this. */
  minConcurrency?: number;
  /**
   * Slots to leave free for the operator's own interactive turn, so background
   * work never fills the gateway's admission window on its own. Applied from
   * the START, not only after a gateway pushes back: the window before the
   * first 429 is precisely when the runtime was overloading the gateway.
   */
  reservedSlots?: number;
  /** Upper bound on a single honoured wait (a bad payload cannot park us forever). */
  maxWaitMs?: number;
  /**
   * Random stagger added when releasing waiters, so a cooldown that expires
   * does not put every leg on the wire in the same millisecond and re-earn the
   * same 429.
   */
  jitterMs?: number;
  /** Consecutive clean runs after which the clamp relaxes by one slot. */
  successesToRelax?: number;
  /** Injected monotonic clock (ms). Default Date.now. */
  now?: () => number;
  /** Injected sleeper. Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected jitter source in [0,1). Default Math.random. */
  random?: () => number;
  /** Structured observation sink (telemetry/notices). */
  onEvent?: (event: AdmissionEvent) => void;
}

export type AdmissionEvent =
  | { type: "wait"; waitMs: number; signal: GatewayWaitSignal; concurrency: number }
  | { type: "clamp"; concurrency: number; previous: number; signal: GatewayWaitSignal }
  | { type: "relax"; concurrency: number; previous: number };

export interface AdmissionStatus {
  /** Slots currently held. */
  active: number;
  /** Callers waiting for a slot or for the cooldown to expire. */
  waiting: number;
  /** Effective concurrency limit right now. */
  concurrency: number;
  /** Milliseconds remaining on the process-wide cooldown (0 when open). */
  cooldownMs: number;
  /** The signal that produced the current cooldown, when any. */
  lastSignal?: GatewayWaitSignal;
}

/** A held admission slot. Release is idempotent. */
export interface AdmissionSlot {
  release(): void;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class AdmissionController {
  private readonly configuredMax: number;
  private readonly minConcurrency: number;
  private readonly reservedSlots: number;
  private readonly maxWaitMs: number;
  private readonly jitterMs: number;
  private readonly successesToRelax: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onEvent: ((event: AdmissionEvent) => void) | undefined;

  /** Ceiling for local concurrency: the configured max, less the reserve. */
  private readonly baseConcurrency: number;
  private concurrency: number;
  private active = 0;
  private waiting = 0;
  private cooldownUntil = 0;
  private consecutiveSuccesses = 0;
  private lastSignal: GatewayWaitSignal | undefined;
  /** Waiters parked on a free slot, resolved in FIFO order. */
  private readonly slotWaiters: Array<() => void> = [];

  constructor(opts: AdmissionControllerOptions) {
    this.configuredMax = Math.max(1, opts.maxConcurrency);
    this.minConcurrency = Math.max(1, opts.minConcurrency ?? 1);
    this.reservedSlots = Math.max(0, opts.reservedSlots ?? 0);
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? 120_000);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 250);
    this.successesToRelax = Math.max(1, opts.successesToRelax ?? 3);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.onEvent = opts.onEvent;
    this.baseConcurrency = Math.max(this.minConcurrency, this.configuredMax - this.reservedSlots);
    this.concurrency = this.baseConcurrency;
  }

  status(): AdmissionStatus {
    return {
      active: this.active,
      waiting: this.waiting,
      concurrency: this.concurrency,
      cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
      ...(this.lastSignal ? { lastSignal: this.lastSignal } : {}),
    };
  }

  /** Milliseconds left on the process-wide cooldown (0 when open). */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /**
   * Wait out the process-wide cooldown without taking a slot.
   *
   * For callers Pi drives itself (the interactive turn): we cannot hold their
   * slot across the request, but we can keep them off the wire while the
   * gateway is telling everyone to back off.
   */
  async awaitCooldown(): Promise<number> {
    let waited = 0;
    this.waiting++;
    try {
      for (;;) {
        const remaining = this.cooldownRemainingMs();
        if (remaining <= 0) break;
        await this.sleep(remaining);
        waited += remaining;
      }
    } finally {
      this.waiting--;
    }
    if (waited > 0) await this.staggerOnce();
    return waited;
  }

  /**
   * Acquire an admission slot: waits for the cooldown to expire AND for a free
   * slot under the current concurrency limit.
   */
  async acquire(): Promise<AdmissionSlot> {
    for (;;) {
      await this.awaitCooldown();
      if (this.active < this.effectiveLimit()) {
        this.active++;
        break;
      }
      await this.waitForSlot();
      // Re-check: the cooldown may have re-armed while we queued.
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.wakeOne();
      },
    };
  }

  /**
   * Record a gateway wait signal: arms the process-wide cooldown and clamps
   * concurrency to the gateway's reported admission limit.
   *
   * Returns the cooldown actually armed (bounded by `maxWaitMs`).
   */
  noteWait(signal: GatewayWaitSignal): number {
    this.consecutiveSuccesses = 0;
    this.lastSignal = signal;

    const waitMs = Math.min(signal.retryAfterMs, this.maxWaitMs);
    const until = this.now() + waitMs;
    // Never shorten a cooldown another caller already earned.
    if (until > this.cooldownUntil) this.cooldownUntil = until;

    if (signal.activeLimit !== undefined) {
      // The gateway counts every concurrent request against this limit,
      // including the operator's own interactive turn, so keep the reserve
      // free rather than filling the window with background work.
      const target = Math.max(
        this.minConcurrency,
        Math.min(this.baseConcurrency, signal.activeLimit - this.reservedSlots),
      );
      if (target < this.concurrency) {
        const previous = this.concurrency;
        this.concurrency = target;
        this.onEvent?.({ type: "clamp", concurrency: target, previous, signal });
      }
    }

    this.onEvent?.({ type: "wait", waitMs, signal, concurrency: this.concurrency });
    return waitMs;
  }

  /**
   * Arm the cooldown and wait it out, holding no slot.
   * Used by a caller that just received the 429 and intends to retry.
   */
  async noteWaitAndSleep(signal: GatewayWaitSignal): Promise<number> {
    this.noteWait(signal);
    return this.awaitCooldown();
  }

  /** Record a clean run: relaxes the clamp back toward the configured max. */
  noteSuccess(): void {
    if (this.concurrency >= this.baseConcurrency) return;
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses < this.successesToRelax) return;
    this.consecutiveSuccesses = 0;
    const previous = this.concurrency;
    this.concurrency = Math.min(this.baseConcurrency, this.concurrency + 1);
    this.onEvent?.({ type: "relax", concurrency: this.concurrency, previous });
    // The freed slot is real: let a parked caller take it.
    this.wakeOne();
  }

  /** Human-readable one-liner describing the current hold, for notices. */
  describe(): string | null {
    const remaining = this.cooldownRemainingMs();
    if (remaining <= 0) return null;
    const signal = this.lastSignal;
    return signal ? `gateway backoff: ${describeGatewayWait(signal)}` : `gateway backoff: ${remaining}ms`;
  }

  private effectiveLimit(): number {
    return Math.max(this.minConcurrency, this.concurrency);
  }

  private waitForSlot(): Promise<void> {
    this.waiting++;
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(() => {
        this.waiting--;
        resolve();
      });
    });
  }

  private wakeOne(): void {
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /** Spread released waiters over a small random window. */
  private async staggerOnce(): Promise<void> {
    if (this.jitterMs <= 0) return;
    await this.sleep(Math.floor(this.random() * this.jitterMs));
  }
}
