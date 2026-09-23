/**
 * Time-based retry window (resilience spec §2, §5).
 *
 * Replaces attempt-count retry with a wall-clock budget: a mission step may
 * keep probing/retrying while `now < retry_deadline`, where `retry_deadline =
 * retry_started_at + retry_window_ms`. The deadline is a persisted wall-clock
 * timestamp, NOT an attempt counter, so a process restart does not reset it and
 * a step never "runs out of attempts".
 *
 * Pure and deterministic: the clock is injectable for tests.
 */

export interface RetryWindowState {
  /** Wall-clock ms the retry window started (persisted). */
  retry_started_at_ms: number;
  /** Wall-clock ms the retry window expires (persisted; unchanged on restart). */
  retry_deadline_ms: number;
  /** Wall-clock ms of the last probe (for compact progress logging). */
  last_probe_at_ms: number;
  /** Probes issued within this window (informational, not a limit). */
  probe_count: number;
}

/** Create a fresh retry window starting now. */
export function startRetryWindow(nowMs: number, retryWindowMs: number): RetryWindowState {
  return {
    retry_started_at_ms: nowMs,
    retry_deadline_ms: nowMs + retryWindowMs,
    last_probe_at_ms: nowMs,
    probe_count: 0,
  };
}

/** Restore a persisted window (e.g. after a process restart) unchanged. */
export function restoreRetryWindow(state: RetryWindowState): RetryWindowState {
  return { ...state };
}

/** Remaining budget, ms; clamped to >= 0. */
export function remainingMs(state: RetryWindowState, nowMs: number): number {
  return Math.max(0, state.retry_deadline_ms - nowMs);
}

/** Whether the window is still open (budget remains). */
export function windowOpen(state: RetryWindowState, nowMs: number): boolean {
  return nowMs < state.retry_deadline_ms;
}

/** Record a probe; returns the updated window state. */
export function recordProbe(state: RetryWindowState, nowMs: number): RetryWindowState {
  return { ...state, last_probe_at_ms: nowMs, probe_count: state.probe_count + 1 };
}

/** Format an elapsed duration as HH:MM:SS for compact log lines. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
