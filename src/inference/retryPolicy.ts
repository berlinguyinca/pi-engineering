/**
 * Same-model stream-retry policy (fault-tolerance spec §4).
 *
 * For an interrupted stream, retry the SAME logical request before changing
 * models, with a growing wait ladder and jitter:
 *
 *   attempt 1 fails → wait ~30s
 *   attempt 2 fails → wait ~60s
 *   attempt 3 fails → wait ~120s
 *
 * Any server-supplied retry time (`Retry-After`, `retry_after_ms`, InferWeave
 * retry metadata) takes precedence and is a FLOOR: the harness never shortens
 * a server-requested cooldown.
 */

import { addBoundedJitter } from "./retryDelay.ts";

export interface StreamRetryPolicyConfig {
  enabled: boolean;
  /** Total attempts allowed for one logical request (default 4: 3 retries). */
  maxAttempts: number;
  /** Wait before attempt 2 (default 30s). */
  initialDelayMs: number;
  /** Local backoff ceiling (default 120s = 2m). */
  maxDelayMs: number;
  /** Positive jitter fraction applied to the LOCAL portion (default ~1/6). */
  jitterRatio: number;
  /** Server-supplied delay is a floor; when false, local ladder wins. */
  honorServerDelay: boolean;
}

export const DEFAULT_STREAM_RETRY_POLICY: StreamRetryPolicyConfig = {
  enabled: true,
  maxAttempts: 4,
  initialDelayMs: 30_000,
  maxDelayMs: 120_000,
  jitterRatio: 1 / 6,
  honorServerDelay: true,
};

/** How the policy resolved the wait before the next attempt. */
export type StreamRetryDelaySource = "server" | "server_plus_ladder" | "ladder" | "exhausted" | "disabled";

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  source: StreamRetryDelaySource;
  /** 1-based attempt that just failed. */
  attempt: number;
  attemptsUsed: number;
  reason?: string;
}

export interface RetryPolicyOptions {
  config?: Partial<StreamRetryPolicyConfig>;
  /** Jitter source (injectable for deterministic tests). */
  random?: () => number;
}

/**
 * Pure decision function over the ladder. Injectable random keeps tests
 * deterministic; no state is kept here — the attempt number IS the state.
 */
export class StreamRetryPolicy {
  readonly config: StreamRetryPolicyConfig;
  private readonly random: () => number;

  constructor(opts: RetryPolicyOptions = {}) {
    this.config = { ...DEFAULT_STREAM_RETRY_POLICY, ...opts.config };
    this.random = opts.random ?? Math.random;
  }

  /** Local ladder delay for the attempt that just failed (1-based). */
  ladderDelayMs(failedAttempt: number): number {
    const exponent = Math.max(0, failedAttempt - 1);
    const raw = this.config.initialDelayMs * 2 ** Math.min(exponent, 30);
    return Math.min(Math.max(raw, 0), this.config.maxDelayMs);
  }

  /**
   * Decide whether to retry and how long to wait.
   *
   * `serverDelayMs` (from Retry-After / retry_after_ms / InferWeave metadata)
   * is a floor: the final wait is `max(server, jitteredLadder)`, and jitter is
   * positive-only so the server minimum is never shortened.
   */
  decide(failedAttempt: number, serverDelayMs?: number): RetryDecision {
    const attempt = Math.max(1, Math.floor(failedAttempt));
    const attemptsUsed = attempt;
    if (!this.config.enabled) {
      return { shouldRetry: false, delayMs: 0, source: "disabled", attempt, attemptsUsed, reason: "stream retry disabled" };
    }
    if (attempt >= this.config.maxAttempts) {
      return {
        shouldRetry: false,
        delayMs: 0,
        source: "exhausted",
        attempt,
        attemptsUsed,
        reason: `attempt budget exhausted (${this.config.maxAttempts})`,
      };
    }
    const ladder = addBoundedJitter(this.ladderDelayMs(attempt), this.config.jitterRatio, this.random);
    if (this.config.honorServerDelay && serverDelayMs !== undefined && serverDelayMs > 0) {
      const delayMs = Math.max(serverDelayMs, ladder);
      return {
        shouldRetry: true,
        delayMs,
        source: delayMs === serverDelayMs ? "server" : "server_plus_ladder",
        attempt,
        attemptsUsed,
      };
    }
    return { shouldRetry: true, delayMs: ladder, source: "ladder", attempt, attemptsUsed };
  }
}

/** Resolve an env-style duration ("30s", "2m", "120000") to ms. */
export function parseRetryDurationMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(trimmed);
  if (!match) return fallback;
  const n = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const ms = Math.round(n * factor);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}
