/**
 * Waiting out gateway saturation INSIDE a single provider call.
 *
 * Pi's agent loop calls `modelRuntime.streamSimple` (pi-coding-agent
 * core/sdk.js:194) and wraps it in `retryAssistantCall`
 * (pi-ai utils/retry.js). That wrapper retries an assistant message whose
 * `stopReason` is "error" at most `settings.retry.maxRetries` times (3 by
 * default), sleeping `baseDelayMs * 2 ** (attempt - 1)` and ignoring whatever
 * wait the gateway advertised. So a saturated gateway ends the operator's turn
 * with "Retry failed after 3 attempts" while every engineering worker — which
 * runs with Pi's retry disabled and waits on the admission controller instead —
 * sits patiently and eventually succeeds.
 *
 * `ExtensionAPI` exposes no accessor for that budget. What it does expose is
 * `registerProvider(id, { api, streamSimple })`, and `composeModelProvider`
 * dispatches the agent's call to that handler (provider-composer.js:315-323).
 * A wait performed in there is invisible to Pi's retry budget: however many
 * times we go around, Pi sees ONE attempt that took a while.
 *
 * ── The rule that makes this safe ────────────────────────────────────────────
 *
 * A retry is only legal while nothing has reached the transcript. Two
 * independent reasons, both checked against the installed package:
 *
 *   1. `AssistantMessageEventStream` completes on the first `done`/`error`
 *      event and silently drops every `push` after it (utils/event-stream.js).
 *      Forwarding a 503 and then retrying would produce output nobody sees.
 *   2. Re-running a stream that already emitted text would emit that text
 *      twice into one assistant message.
 *
 * So the pump withholds a terminal error event until it has decided not to
 * retry, and abandons retrying the moment any non-terminal event is forwarded.
 * Leading bookkeeping events (`start`) are held too, until the first output
 * event or a successful terminal: pi-ai pushes `start` as soon as the HTTP 200
 * arrives, before any token, and a gateway link cut lands exactly there. The
 * failed attempt's held `start` is discarded on retry, so exactly one reaches
 * the sink.
 *
 * That widens the retry window on purpose, and not only for link cuts: ANY
 * retryable gateway wait that lands after the 200 head but before the first
 * token (an overload, a 503 relayed mid-stream) is now waited out and replayed
 * too. It is the same safety condition — nothing visible has reached the
 * transcript — just checked on content rather than on the head.
 * Pi's own `retryAssistantCall` can restart after partial output because it
 * discards the whole failed message; mid-stream, we have no such luxury.
 *
 * This module is pure: the actual sleeping, and the process-wide cooldown it
 * belongs to, are injected as `hold`.
 */

import { monotonicNow } from "../core/clock.ts";
import { augmentInferenceErrorMessage, isAssistantOutputEvent } from "../inference/admissionContract.ts";
import {
  type GatewayWaitInput,
  type GatewayWaitSignal,
  escalateSyntheticWait,
  isLongWaitTransient,
  parseGatewayWait,
  transportDropWait,
} from "./signals.ts";

export { monotonicNow } from "../core/clock.ts";

/** A terminal event ends pi's stream and resolves its result. */
function isTerminal(type: string | undefined): boolean {
  return type === "done" || type === "error";
}

/**
 * Does this terminal event carry a failure?
 *
 * Not the same question as `type === "error"`. A provider may deliver a failed
 * turn as a `done` event whose message has `stopReason: "error"`, and treating
 * only the `error` SHAPE as a failure meant such a saturation was forwarded —
 * completing the stream — and then left to Pi's own three-attempt budget, so
 * the turn could still die on exactly the gateway this module exists to wait
 * out. Withholding it instead is equally safe: nothing has reached the sink yet,
 * which is the only condition a retry needs.
 */
function carriesFailure<E extends RetryableEvent, R extends RetryableResult>(event: E): boolean {
  if (event.type === "error") return true;
  if (event.type !== "done") return false;
  const message = (event as { message?: R }).message;
  return message?.stopReason === "error";
}

/** The slice of pi's assistant event we need to reason about. */
export interface RetryableEvent {
  type?: string;
  message?: RetryableResult;
  error?: RetryableResult;
}

/** The slice of pi's AssistantMessage we need to reason about. */
export interface RetryableResult {
  stopReason?: string;
  errorMessage?: string;
}

/** One provider attempt, shaped like pi's `AssistantMessageEventStream`. */
export interface AttemptStream<E, R> extends AsyncIterable<E> {
  result(): Promise<R>;
}

/** Where forwarded events go. Mirrors `EventStream`'s push/end pair. */
export interface RetrySink<E, R> {
  push(event: E): void;
  end(result?: R): void;
}

export interface GatewayStreamRetryOptions {
  /**
   * Honour `signal`'s wait. Resolves when a retry may proceed. This is where
   * the shared admission cooldown is applied, so every other caller in the
   * process backs off behind the same gate.
   */
  hold(signal: GatewayWaitSignal, attempt: number): Promise<void>;
  /** The turn's abort signal. Escape must end the turn, not restart it. */
  signal?: AbortSignal;
  /**
   * Finite attempt ceiling. Defaults to DEFAULT_GATEWAY_MAX_ATTEMPTS.
   */
  maxAttempts?: number;
  /** Finite monotonic elapsed budget for the complete retry chain. */
  maxElapsedMs?: number;
  /** Injectable monotonic clock. */
  now?: () => number;
  /** Injectable wall clock (epoch ms) for `waitingSinceMs`. Default Date.now. */
  wallNow?: () => number;
  /**
   * When the current run of waits began (epoch ms), carried across provider
   * calls like `priorHolds`: an outage outlives a turn. Defaults to the first
   * hold of this call.
   */
  waitingSinceMs?: number;
  /** Status/headers captured for the attempt before the body was flattened. */
  response?: () => Omit<GatewayWaitInput, "text"> | undefined;
  /** Ceiling on a SYNTHESIZED wait. Advertised waits are honoured exactly. */
  maxEscalatedWaitMs?: number;
  /**
   * Consecutive saturated attempts that happened BEFORE this call, used to
   * continue the escalation rather than restart it.
   *
   * The agent loop makes one provider call per tool round-trip, and an outage
   * outlives a turn. Escalating from `attempt` alone would reset to the base
   * wait on every call, which is the busy-wait the escalation exists to avoid.
   * Read once at entry, so a hold taken during this call is not counted twice.
   */
  priorHolds?: number;
  /** Observe each hold (status bar, telemetry). */
  onHold?(info: { attempt: number; signal: GatewayWaitSignal; errorText: string }): void;
  /**
   * Called synchronously the first time anything reaches the sink — the gateway
   * served us, so an escalation ladder can reset.
   *
   * Deliberately not the returned outcome: the caller learns that one microtask
   * after `end()` resolves the stream's result, and the agent loop issues its
   * next provider call in between. A reset that arrives late is a reset that
   * never happens.
   */
  onProgress?(): void;
  /**
   * Called synchronously just before the stream ends, with how it settled —
   * for the same reason as `onProgress`: the next provider call can start
   * before a `.then` on the outcome runs.
   */
  onSettle?(settled: GatewayStreamRetryOutcome["settled"]): void;
}

export interface GatewayStreamRetryOutcome {
  /** Provider attempts made, including the one that settled. */
  attempts: number;
  /** How many times a wait was honoured. */
  holds: number;
  /** How the stream finished. `"ok"` is what resets an escalation. */
  settled: "ok" | "error" | "aborted";
}

/**
 * Default ceiling for a wait we invented rather than were told. Kept at a
 * minute for the interactive turn so a recovered gateway is noticed promptly;
 * an advertised Retry-After / retry_after_ms is honoured exactly instead.
 */
export const MAX_ESCALATED_WAIT_MS = 60_000;
/**
 * Transient infrastructure (a model reloading or moving GPUs, capacity
 * unavailable, a gateway restart, queue timeouts) can last hours. The ELAPSED
 * horizon is what ends a wait — the operator can press Esc at any time — so
 * the attempt ceiling is only a runaway guard, never the limiting factor.
 */
export const DEFAULT_GATEWAY_MAX_ATTEMPTS = 1_000_000;
export const DEFAULT_GATEWAY_MAX_ELAPSED_MS = 12 * 3_600_000;
/**
 * The finite budget for a wait WITHOUT positive transient evidence — a bare
 * 500/502/504 (see isLongWaitTransient). A deterministic upstream failure
 * looks exactly like it and never clears, so it gets the old short budget.
 */
export const SHORT_TRANSIENT_MAX_ATTEMPTS = 8;

/**
 * Pacing floor for a long interactive wait. The first few holds follow the
 * gateway's own hint (a link cut's 1s, an advertised retry_after_ms); after
 * that every wait is at least an escalating 5s→60s, and once the operator has
 * waited half an hour, at least 3 minutes. Without it a 1s hint honoured for
 * 12 hours is ~43k requests, each re-sending the whole (up to 32 MiB) body.
 * A LONGER advertised wait is always honoured as is.
 */
export const PACE_FREE_HOLDS = 5;
export const PACE_SLOW_AFTER_MS = 30 * 60_000;
export const PACE_SLOW_FLOOR_MS = 180_000;

export function paceInteractiveWait(
  signal: GatewayWaitSignal,
  holdNumber: number,
  waitedMs: number,
  capMs: number,
): GatewayWaitSignal {
  if (holdNumber <= PACE_FREE_HOLDS) return signal;
  const floor =
    waitedMs >= PACE_SLOW_AFTER_MS
      ? PACE_SLOW_FLOOR_MS
      : Math.min(capMs, 5_000 * 2 ** Math.min(holdNumber - PACE_FREE_HOLDS - 1, 30));
  return signal.retryAfterMs >= floor ? signal : { ...signal, retryAfterMs: floor };
}
export const SHORT_TRANSIENT_MAX_ELAPSED_MS = 300_000;

function finiteBudget(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "");
}

/**
 * Run `open` until it settles, waiting out gateway saturation in between.
 *
 * Forwards events to `sink` as they arrive, so streaming output is unaffected.
 * Throws only for a failure that is neither a gateway wait nor representable as
 * an assistant message — the caller owns turning that into an error message,
 * because only it knows the model.
 */
export async function pumpWithGatewayRetry<E extends RetryableEvent, R extends RetryableResult>(
  open: (attempt: number) => AttemptStream<E, R>,
  sink: RetrySink<E, R>,
  opts: GatewayStreamRetryOptions,
): Promise<GatewayStreamRetryOutcome> {
  const maxAttempts = Math.floor(finiteBudget(opts.maxAttempts, DEFAULT_GATEWAY_MAX_ATTEMPTS, 1));
  const maxElapsedMs = finiteBudget(opts.maxElapsedMs, DEFAULT_GATEWAY_MAX_ELAPSED_MS, 0);
  const now = opts.now ?? monotonicNow;
  const startedAt = now();
  const capMs = opts.maxEscalatedWaitMs ?? MAX_ESCALATED_WAIT_MS;
  const priorHolds = opts.priorHolds ?? 0;
  const wallNow = opts.wallNow ?? Date.now;
  let waitingSinceMs = opts.waitingSinceMs;
  let holds = 0;
  let progressed = false;

  for (let attempt = 1; ; attempt++) {
    /**
     * Anything at all reached the sink: from here a retry is both unsafe and
     * pointless.
     *
     * Set by `emit`, never by the loop, because the dangerous case is a
     * TERMINAL event. `AssistantMessageEventStream` completes on the first
     * `done`/`error` and drops every later push, so once one is forwarded a
     * retry cannot reach the transcript at all — it would burn a provider call
     * whose output goes nowhere, while the operator sees the failure that was
     * already delivered. Tracking only non-terminal events missed exactly that.
     */
    let forwarded = false;
    const emit = (event: E): void => {
      forwarded = true;
      if (!progressed) {
        progressed = true;
        opts.onProgress?.();
      }
      sink.push(event);
    };
    /** Leading non-output events (`start`) held until something visible. */
    const leading: E[] = [];
    const release = (): void => {
      for (const event of leading.splice(0)) emit(event);
    };
    /** A terminal error held back while a retry is still possible. */
    let withheld: E | undefined;
    let result: R | undefined;
    let thrown: unknown;

    try {
      const inner = open(attempt);
      for await (const event of inner) {
        if (isTerminal(event.type)) {
          // Terminal events resolve the stream, so they are always the last
          // thing we forward — and a failing one is held until we have decided.
          // Both shapes count: `type: "error"`, and `done` carrying a message
          // whose stopReason is "error".
          if (carriesFailure<E, R>(event)) {
            withheld = event;
            continue;
          }
          release();
          emit(event);
          continue;
        }
        if (!forwarded && !isAssistantOutputEvent(event.type)) {
          leading.push(event);
          continue;
        }
        release();
        emit(event);
      }
      result = await inner.result();
    } catch (err) {
      thrown = err;
    }

    const failure = thrown !== undefined ? errorText(thrown) : (result?.errorMessage ?? "");
    const isAbort = result?.stopReason === "aborted" || opts.signal?.aborted === true;
    const observed = { ...(opts.response?.() ?? {}), text: failure };
    const guidance = isAbort ? null : parseGatewayWait(observed);
    // A bare transport drop (the gateway restarted under the stream) carries
    // no guidance, but before any visible output it is replay-safe: the
    // caller's own escalating hold, same budget, never after output or abort.
    const wait = forwarded ? null : (guidance ?? (isAbort ? null : transportDropWait(observed)));
    const remainingMs = maxElapsedMs - (now() - startedAt);
    const escalated = wait ? escalateSyntheticWait(wait, attempt + priorHolds, capMs) : undefined;
    if (escalated && waitingSinceMs === undefined) waitingSinceMs = wallNow();
    const held = escalated
      ? {
          ...paceInteractiveWait(escalated, attempt + priorHolds, wallNow() - (waitingSinceMs ?? wallNow()), capMs),
          waitingSinceMs,
        }
      : undefined;
    const longWait = held ? isLongWaitTransient(held) : false;
    const attemptCap = longWait ? maxAttempts : Math.min(maxAttempts, SHORT_TRANSIENT_MAX_ATTEMPTS);
    const chainRemainingMs = longWait
      ? remainingMs
      : Math.min(maxElapsedMs, SHORT_TRANSIENT_MAX_ELAPSED_MS) - (now() - startedAt);
    const retryable =
      held?.retryable === true && attempt < attemptCap && chainRemainingMs > 0 && held.retryAfterMs <= chainRemainingMs;

    if (retryable && held) {
      opts.onHold?.({ attempt, signal: held, errorText: failure });
      holds++;
      await opts.hold(held, attempt);
      // Escape during the hold ends the turn. Normalising to an aborted
      // message matches what Pi's own retry does when its backoff is
      // interrupted, so callers never have to care when cancellation landed.
      if (opts.signal?.aborted) {
        opts.onSettle?.("aborted");
        sink.end(abortedFrom(result));
        return { attempts: attempt, holds, settled: "aborted" };
      }
      // Timer jitter or a busy event loop can make the hold resolve after its
      // budget. Recheck after the await and at the replay boundary.
      const elapsedAfterHold = now() - startedAt;
      if (elapsedAfterHold < maxElapsedMs) {
        const elapsedAtReplay = now() - startedAt;
        if (elapsedAtReplay < maxElapsedMs) continue;
      }
    }

    // Settled: a throw with nothing to report is the caller's problem, since
    // building an assistant message needs the model.
    // A held `start` still precedes the failure it belongs to — but it is not
    // the gateway serving us, so it bypasses `emit` and never counts as progress.
    for (const event of leading) sink.push(event);
    if (thrown !== undefined) throw thrown;
    const finalResult = guidance ? withGuidance(result, guidance) : result;
    if (withheld) sink.push(guidance ? withEventGuidance(withheld, guidance) : withheld);
    const settled = isAbort ? "aborted" : result?.stopReason === "error" ? "error" : "ok";
    opts.onSettle?.(settled);
    sink.end(finalResult);
    return { attempts: attempt, holds, settled };
  }
}

function withGuidance<R extends RetryableResult>(result: R | undefined, guidance: GatewayWaitSignal): R | undefined {
  if (!result) return result;
  return { ...result, errorMessage: augmentInferenceErrorMessage(result.errorMessage, guidance) };
}

function withEventGuidance<E extends RetryableEvent>(event: E, guidance: GatewayWaitSignal): E {
  const field = event.type === "done" ? "message" : "error";
  const terminal = event[field];
  if (!terminal) return event;
  return { ...event, [field]: withGuidance(terminal, guidance) } as E;
}

/** Normalise a failed result into an aborted one, dropping the error text. */
function abortedFrom<R extends RetryableResult>(result: R | undefined): R {
  const { errorMessage: _dropped, ...rest } = (result ?? {}) as RetryableResult;
  return { ...rest, stopReason: "aborted" } as R;
}
