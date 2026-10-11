/**
 * Model/provider-scoped circuit breakers (fault-tolerance spec §15).
 *
 * Repeated MODEL-SCOPED failures temporarily open a circuit for that model
 * (or provider), so every fresh worker does not immediately select the same
 * unavailable model. After the cooldown the breaker goes HALF_OPEN and allows
 * exactly one probe request: success closes the circuit, failure reopens it.
 *
 * A model is NEVER blacklisted permanently — a GPU that disappeared
 * temporarily comes back, and the next probe re-qualifies it.
 *
 * Pure and deterministic: an injectable clock makes transitions testable.
 */

export type ModelBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ModelBreakerOptions {
  /** Failures within the window that open the circuit (default 3). */
  failureThreshold?: number;
  /** Sliding window over which failures count (default 5m). */
  windowMs?: number;
  /** How long an OPEN circuit stays open before HALF_OPEN (default 2m). */
  cooldownMs?: number;
  now?: () => number;
  /** Circuit identity (provider/model or provider) for event emission. */
  key?: string;
  onTransition?: (state: ModelBreakerState, key: string, info: { atMs: number }) => void;
}

export interface BreakerSnapshot {
  key: string;
  state: ModelBreakerState;
  failuresInWindow: number;
  openedAtMs: number;
  halfOpenAfterMs: number;
}

export class ModelCircuitBreaker {
  private state: ModelBreakerState = "CLOSED";
  private failureTimes: number[] = [];
  private openedAtMs = 0;
  private halfOpenAfterMs = 0;
  private probeInFlight = false;
  readonly key: string;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onTransition?: ModelBreakerOptions["onTransition"];

  constructor(opts: ModelBreakerOptions = {}) {
    this.key = opts.key ?? "default";
    this.threshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 5 * 60_000;
    this.cooldownMs = opts.cooldownMs ?? 2 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.onTransition = opts.onTransition;
  }

  getState(): ModelBreakerState {
    return this.state;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    this.failureTimes = this.failureTimes.filter((t) => t >= cutoff);
  }

  /** Record a model-scoped failure; opens the circuit past the threshold. */
  recordFailure(): ModelBreakerState {
    const nowMs = this.now();
    if (this.state === "HALF_OPEN") {
      // The probe failed: reopen immediately.
      this.open(nowMs);
      return this.state;
    }
    this.failureTimes.push(nowMs);
    this.prune(nowMs);
    if (this.failureTimes.length >= this.threshold && this.state !== "OPEN") {
      this.open(nowMs);
    }
    return this.state;
  }

  private open(nowMs: number): void {
    this.state = "OPEN";
    this.openedAtMs = nowMs;
    this.halfOpenAfterMs = nowMs + this.cooldownMs;
    this.probeInFlight = false;
    this.onTransition?.("OPEN", this.key, { atMs: nowMs });
  }

  /** Record success: close the circuit (from any state). */
  recordSuccess(): ModelBreakerState {
    this.state = "CLOSED";
    this.failureTimes = [];
    this.openedAtMs = 0;
    this.halfOpenAfterMs = 0;
    this.probeInFlight = false;
    this.onTransition?.("CLOSED", this.key, { atMs: this.now() });
    return this.state;
  }

  /**
   * Whether a request may be sent right now. While OPEN, one half-open probe
   * is allowed after the cooldown; it is single-use until it settles.
   */
  allowRequest(): boolean {
    const nowMs = this.now();
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return !this.probeInFlight;
    if (nowMs >= this.halfOpenAfterMs) {
      this.state = "HALF_OPEN";
      this.probeInFlight = true;
      this.onTransition?.("HALF_OPEN", this.key, { atMs: nowMs });
      return true;
    }
    return false;
  }

  /** Consume the half-open probe slot on request start (idempotent for CLOSED). */
  beginProbe(): void {
    if (this.state === "HALF_OPEN") this.probeInFlight = true;
  }

  snapshot(): BreakerSnapshot {
    this.prune(this.now());
    return {
      key: this.key,
      state: this.state,
      failuresInWindow: this.failureTimes.length,
      openedAtMs: this.openedAtMs,
      halfOpenAfterMs: this.halfOpenAfterMs,
    };
  }
}

export interface CircuitBreakerRegistryOptions {
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  now?: () => number;
  onTransition?: (key: string, state: ModelBreakerState, info: { atMs: number }) => void;
}

/** Breakers keyed by model (`provider/model`) and provider. */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, ModelCircuitBreaker>();
  private readonly opts: CircuitBreakerRegistryOptions;

  constructor(opts: CircuitBreakerRegistryOptions = {}) {
    this.opts = opts;
  }

  forModel(provider: string, model: string): ModelCircuitBreaker {
    return this.for(`model:${provider}/${model}`);
  }

  forProvider(provider: string): ModelCircuitBreaker {
    return this.for(`provider:${provider}`);
  }

  private for(key: string): ModelCircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new ModelCircuitBreaker({
        key,
        failureThreshold: this.opts.failureThreshold,
        windowMs: this.opts.windowMs,
        cooldownMs: this.opts.cooldownMs,
        now: this.opts.now,
        onTransition: (state, k, info) => this.opts.onTransition?.(k, state, info),
      });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  get(key: string): ModelCircuitBreaker | undefined {
    return this.breakers.get(key);
  }

  all(): BreakerSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }
}
