/**
 * Live output-token throughput tracker.
 *
 * Consumes streaming message events and exposes cheap reads for the footer.
 * Deliberately independent of terminal rendering so the same tracker can later
 * feed subprocess telemetry, dashboards, RPC/JSON status, and aggregate
 * multi-agent metrics.
 *
 * Throughput calculation
 * ----------------------
 * Preferred source: if streaming events expose monotonically increasing
 * cumulative provider-reported output tokens, we sample `(timestamp,
 * cumulativeOutputTokens)` and compute a rolling rate over only the samples
 * inside the configured window:
 *
 *     (newestTokens - oldestTokens) / (newestTime - oldestTime)
 *
 * Fallback estimation: some providers report zero/unchanged usage until
 * completion. In that case we estimate generated tokens from streamed assistant
 * deltas using a cheap approximation (`chars / estimateCharsPerToken`), batched
 * so we never tokenize every character delta. At `endGeneration` we reconcile
 * with the authoritative final `message.usage.output` when the provider reports
 * it.
 *
 * Idle behavior: after streaming ends we retain `lastCompletedTokensPerSecond`
 * so the footer does not collapse to `0 t/s`.
 */

export type ThroughputPhase = "idle" | "streaming" | "waiting" | "unavailable";

export interface ThroughputSnapshot {
  phase: ThroughputPhase;
  currentTokensPerSecond?: number;
  lastCompletedTokensPerSecond?: number;
  outputTokens?: number;
}

export interface StreamSample {
  /** Monotonic timestamp (ms). */
  t: number;
  /** Cumulative output tokens at time `t`. */
  tokens: number;
  /** True when provider-reported (authoritative), false for char-estimate. */
  authoritative: boolean;
}

export interface ThroughputTrackerOptions {
  /** Rolling window in ms. Default 2500. */
  windowMs?: number;
  /** Injectable monotonic clock (ms). Default Date.now. Deterministic in tests. */
  now?: () => number;
  /** Characters per token for the fallback estimate. Default 4. */
  estimateCharsPerToken?: number;
  /** Min delta chars buffered before flushing a fallback sample. Default 32. */
  estimateBatchChars?: number;
}

const DEFAULT_WINDOW_MS = 2500;

export class ThroughputTracker {
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly charsPerToken: number;
  private readonly batchChars: number;

  private samples: StreamSample[] = [];
  private fallbackBufferChars = 0;
  private fallbackTokens = 0;

  private generationStart = 0;
  private generationEnd = 0;
  private outputTokens = 0;
  private lastCompletedTokensPerSecond: number | undefined;
  private phase: ThroughputPhase = "idle";

  constructor(opts: ThroughputTrackerOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.now ?? (() => Date.now());
    this.charsPerToken = opts.estimateCharsPerToken ?? 4;
    this.batchChars = opts.estimateBatchChars ?? 32;
  }

  /** Start a new generation/request. Resets per-request samples. */
  beginGeneration(): void {
    const t = this.clock();
    this.samples = [];
    this.fallbackBufferChars = 0;
    this.fallbackTokens = 0;
    this.outputTokens = 0;
    this.generationStart = t;
    this.generationEnd = 0;
    this.phase = "waiting"; // no samples yet
  }

  /**
   * Feed a streaming event.
   * @param cumulativeOutputTokens provider-reported cumulative output tokens, if
   *   the provider updates them during streaming; 0/undefined => fallback estimate.
   * @param deltaText streamed assistant text delta for the fallback estimate.
   */
  onStreamEvent(evt: { cumulativeOutputTokens?: number; deltaText?: string }): void {
    const t = this.clock();
    if (this.phase === "idle" || this.phase === "unavailable") {
      // A stream event arrived without an explicit beginGeneration.
      this.beginGeneration();
    }

    const reported =
      typeof evt.cumulativeOutputTokens === "number" &&
      Number.isFinite(evt.cumulativeOutputTokens) &&
      evt.cumulativeOutputTokens > 0;
    if (reported) {
      // Switch to authoritative accounting: clear any prior char-estimate samples
      // so we never mix estimate and authoritative tokens in one rate.
      if (this.samples.length > 0 && !this.samples[this.samples.length - 1]!.authoritative) {
        this.samples = [];
        this.fallbackBufferChars = 0;
        this.fallbackTokens = 0;
      }
      const last = this.samples[this.samples.length - 1];
      if (!last || evt.cumulativeOutputTokens! > last.tokens) {
        this.samples.push({ t, tokens: evt.cumulativeOutputTokens!, authoritative: true });
      }
      this.outputTokens = evt.cumulativeOutputTokens!;
      this.phase = "streaming";
      return;
    }

    // Fallback estimate from delta text, batched to avoid per-delta tokenizing.
    const delta = evt.deltaText ?? "";
    if (delta.length > 0) {
      this.fallbackBufferChars += delta.length;
      if (this.fallbackBufferChars >= this.batchChars) {
        this.fallbackTokens += Math.floor(this.fallbackBufferChars / this.charsPerToken);
        this.fallbackBufferChars %= this.charsPerToken;
        this.samples.push({ t, tokens: this.fallbackTokens, authoritative: false });
        this.outputTokens = this.fallbackTokens;
        this.phase = "streaming";
      }
    }
  }

  /**
   * End the generation and reconcile with the authoritative final usage.
   * @param finalOutputTokens provider-reported final output tokens (from
   *   `message.usage.output`). 0/undefined => keep the last estimate.
   */
  endGeneration(finalOutputTokens?: number): void {
    const t = this.clock();
    this.generationEnd = t;
    const authoritative =
      typeof finalOutputTokens === "number" && Number.isFinite(finalOutputTokens) && finalOutputTokens > 0;
    if (authoritative) {
      this.outputTokens = finalOutputTokens!;
      // Recompute the completed rate from the authoritative total over the whole
      // generation duration (this is the "final authoritative response TPS").
      const durationSec = (t - this.generationStart) / 1000;
      this.lastCompletedTokensPerSecond = durationSec > 0 ? finalOutputTokens! / durationSec : undefined;
    } else {
      // No authoritative total: retain the best estimate we have.
      this.lastCompletedTokensPerSecond = this.rollingTokensPerSecond(t) ?? this.lastCompletedTokensPerSecond;
    }
    this.samples = [];
    this.fallbackBufferChars = 0;
    this.fallbackTokens = 0;
    this.phase = "idle";
  }

  /** Reset for a model/context switch: clears all history including last completed. */
  reset(): void {
    this.samples = [];
    this.fallbackBufferChars = 0;
    this.fallbackTokens = 0;
    this.generationStart = 0;
    this.generationEnd = 0;
    this.outputTokens = 0;
    this.lastCompletedTokensPerSecond = undefined;
    this.phase = "unavailable";
  }

  /** Cheap read for the renderer. Never spawns work. */
  snapshot(): ThroughputSnapshot {
    const t = this.clock();
    let current: number | undefined;
    if (this.phase === "streaming") {
      const rolling = this.rollingTokensPerSecond(t);
      if (rolling != null) {
        current = rolling;
      } else {
        // Streaming but fewer than two in-window samples => no rate yet.
        this.phase = "waiting";
      }
    }
    return {
      phase: this.phase,
      currentTokensPerSecond: current,
      lastCompletedTokensPerSecond: this.lastCompletedTokensPerSecond,
      outputTokens: this.outputTokens > 0 ? this.outputTokens : undefined,
    };
  }

  private rollingTokensPerSecond(now: number): number | undefined {
    this.prune(now);
    if (this.samples.length < 2) return undefined;
    const oldest = this.samples[0]!;
    const newest = this.samples[this.samples.length - 1]!;
    const dtMs = newest.t - oldest.t;
    if (dtMs <= 0) return undefined;
    const dtokens = newest.tokens - oldest.tokens;
    if (dtokens < 0) return undefined;
    return dtokens / (dtMs / 1000);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.t < cutoff) {
      this.samples.shift();
    }
    // Bound the sample history to the window plus a small margin (no unbounded growth).
    const maxSamples = Math.max(64, Math.ceil(this.windowMs / 16));
    if (this.samples.length > maxSamples) {
      this.samples = this.samples.slice(this.samples.length - maxSamples);
    }
  }
}
