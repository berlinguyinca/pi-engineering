/**
 * Model-stream stall watchdog (defect C).
 *
 * A gateway that accepts a model request and then holds the connection open
 * without sending ANY data makes the awaited model call hang forever: no
 * session events fire, so the session-level inactivity guards (which re-arm
 * on events) never trigger, and the execution lives on as a zombie — the
 * runtime reported "Model streaming" liveness for 55+ minutes on a request
 * that would never produce a token.
 *
 * This watchdog closes that gap. It is armed for the duration of a MODEL
 * turn and reset on every piece of stream data:
 *
 *   - armed at prompt start (covers a request that never begins streaming)
 *   - reset on every streamed token (message_update)
 *   - paused while a tool runs (a 20-minute test suite is not a stall)
 *   - re-armed when the tool completes (the next model turn starts)
 *
 * A long-but-active stream therefore never stalls: only silence for the
 * whole window does. When the window expires, `onStall` fires exactly once;
 * the caller aborts the in-flight request and surfaces the stall as a
 * transient network failure so the existing retry ladder handles it.
 */

/** The stall error signature the watchdog writes into assistantError. */
export const STREAM_STALL_MARKER = "model stream stalled";

/** Match the watchdog's stall error in failure settlement (progress-bearing stalls settle as transient:network). */
export function isStalledStream(error: string | undefined): boolean {
  return (error ?? "").includes(STREAM_STALL_MARKER);
}

export interface StreamStallWatchdogOptions {
  /** Silence window in ms. Must be > 0 (a watchdog with no window is disabled at the call site). */
  stallMs: number;
  /** Fired exactly once when the window expires unarmed. */
  onStall: () => void;
  /** Injectable timer for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class StreamStallWatchdog {
  private readonly stallMs: number;
  private readonly onStall: () => void;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };
  private readonly now: () => number;
  private timer: { clear: () => void } | undefined;
  private armedAtMs = Number.NEGATIVE_INFINITY;
  private fired = false;

  constructor(opts: StreamStallWatchdogOptions) {
    if (!Number.isFinite(opts.stallMs) || opts.stallMs <= 0) {
      throw new Error(`model stream stall window must be a positive ms value, got ${String(opts.stallMs)}`);
    }
    this.stallMs = opts.stallMs;
    this.onStall = opts.onStall;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Never keep a hung worker's process alive on this timer alone.
        handle.unref?.();
        return { clear: () => clearTimeout(handle) };
      });
  }

  /** Start or reset the silence window. Idempotent while armed. */
  arm(): void {
    if (this.fired) return;
    this.armedAtMs = this.now();
    this.timer?.clear();
    this.timer = this.setTimer(() => this.expire(), this.stallMs);
  }

  /** Cancel the window (e.g. a tool is running, or the turn ended). */
  disarm(): void {
    this.timer?.clear();
    this.timer = undefined;
    this.armedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Whether the window is currently armed and unfired. */
  get isActive(): boolean {
    return this.timer !== undefined && !this.fired;
  }

  /** True once the stall has fired (never re-arms). */
  get hasFired(): boolean {
    return this.fired;
  }

  /** Elapsed silence since arming (0 when disarmed or fired). */
  get elapsedMs(): number {
    if (this.timer === undefined || this.fired) return 0;
    return Math.max(0, this.now() - this.armedAtMs);
  }

  private expire(): void {
    if (this.fired) return;
    this.fired = true;
    this.timer?.clear();
    this.timer = undefined;
    this.onStall();
  }
}
