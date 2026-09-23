/**
 * Circuit breaker for the inference gateway (resilience spec §19).
 *
 * Prevents a request storm during cluster recovery. After `threshold`
 * consecutive connection failures the breaker transitions CLOSED -> OPEN; while
 * OPEN only lightweight health probes are allowed. When the gateway reports
 * healthy again the breaker enters HALF_OPEN, sends ONE real request; success
 * closes it, failure reopens it.
 *
 * Pure and deterministic: an injectable clock makes transitions testable
 * without sleeping.
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerSnapshot {
  state: BreakerState;
  /** Consecutive failures since the breaker last closed. */
  consecutiveFailures: number;
  /** Wall-clock time (ms) the breaker opened at, 0 when closed. */
  openedAtMs: number;
  /** Wall-clock time (ms) the breaker will attempt half-open at. */
  halfOpenAfterMs: number;
}

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private halfOpenAfterMs = 0;
  private readonly threshold: number;
  private readonly openCooldownMs: number;
  private readonly now: () => number;

  constructor(opts: { threshold?: number; openCooldownMs?: number; now?: () => number }) {
    this.threshold = opts.threshold ?? 5;
    this.openCooldownMs = opts.openCooldownMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Record a successful gateway interaction: close the breaker. */
  recordSuccess(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
    this.halfOpenAfterMs = 0;
  }

  /** Record a failure: increment counter, open the breaker past the threshold. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "HALF_OPEN") {
      // A real request failed in half-open: reopen immediately.
      this.open();
      return;
    }
    if (this.consecutiveFailures >= this.threshold && this.state !== "OPEN") {
      this.open();
    }
  }

  private open(): void {
    const nowMs = this.now();
    this.state = "OPEN";
    this.openedAtMs = nowMs;
    this.halfOpenAfterMs = nowMs + this.openCooldownMs;
  }

  /**
   * Whether a real (non-probe) request may be sent right now. While OPEN only
   * probes are permitted; a HALF_OPEN request consumes the single attempt.
   */
  allowRequest(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return true;
    // OPEN: allow a half-open probe after cooldown.
    if (this.state === "OPEN" && this.now() >= this.halfOpenAfterMs) return true;
    return false;
  }

  /** Begin a half-open real-request attempt (returns false if not allowed). */
  tryHalfOpen(): boolean {
    if (!this.allowRequest()) return false;
    if (this.state === "OPEN") this.state = "HALF_OPEN";
    return true;
  }

  /** True when only lightweight probes may be issued (no real requests). */
  get isOpen(): boolean {
    return this.state === "OPEN";
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAtMs: this.openedAtMs,
      halfOpenAfterMs: this.halfOpenAfterMs,
    };
  }
}
