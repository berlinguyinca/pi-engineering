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
 * Pi's own `retryAssistantCall` can restart after partial output because it
 * discards the whole failed message; mid-stream, we have no such luxury.
 *
 * This module is pure: the actual sleeping, and the process-wide cooldown it
 * belongs to, are injected as `hold`.
 */

import { type GatewayWaitSignal, parseGatewayWait } from "./signals.ts";

/** A terminal event ends pi's stream and resolves its result. */
function isTerminal(type: string | undefined): boolean {
  return type === "done" || type === "error";
}

/** The slice of pi's assistant event we need to reason about. */
export interface RetryableEvent {
  type?: string;
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
   * Attempt ceiling. Unlimited by default — saturation is a wait, not a
   * failure, which is the entire point of this module.
   */
  maxAttempts?: number;
  /** Ceiling on a SYNTHESIZED wait. Advertised waits are honoured exactly. */
  maxEscalatedWaitMs?: number;
  /** Observe each hold (status bar, telemetry). */
  onHold?(info: { attempt: number; signal: GatewayWaitSignal; errorText: string }): void;
}

export interface GatewayStreamRetryOutcome {
  /** Provider attempts made, including the one that settled. */
  attempts: number;
  /** How many times a wait was honoured. */
  holds: number;
}

/** Default ceiling for a wait we invented rather than were told. */
export const MAX_ESCALATED_WAIT_MS = 60_000;

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "");
}

/**
 * Grow a synthesized wait with consecutive failures.
 *
 * A gateway that reports `retry_after_ms` is obeyed to the millisecond — it
 * knows when its queue drains and we do not. A bare `503 no worker for model`
 * advertises nothing, so `parseGatewayWait` hands back a flat default; asking
 * again every 5s while a model has no workers at all is a busy-wait against an
 * outage. Escalate those, and cap them so the session still recovers promptly
 * once capacity returns.
 */
function waitFor(signal: GatewayWaitSignal, attempt: number, capMs: number): GatewayWaitSignal {
  if (signal.source === "body" || signal.source === "header") return signal;
  const escalated = Math.min(capMs, signal.retryAfterMs * 2 ** Math.max(0, attempt - 1));
  return { ...signal, retryAfterMs: escalated };
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
  const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  const capMs = opts.maxEscalatedWaitMs ?? MAX_ESCALATED_WAIT_MS;
  let holds = 0;

  for (let attempt = 1; ; attempt++) {
    /** Any non-terminal event forwarded: from here a retry would duplicate. */
    let forwarded = false;
    /** A terminal error held back while a retry is still possible. */
    let withheld: E | undefined;
    let result: R | undefined;
    let thrown: unknown;

    try {
      const inner = open(attempt);
      for await (const event of inner) {
        if (isTerminal(event.type)) {
          // Terminal events resolve the stream, so they are always the last
          // thing we forward — and an error one is held until we have decided.
          if (event.type === "error" && !forwarded) {
            withheld = event;
            continue;
          }
          sink.push(event);
          continue;
        }
        forwarded = true;
        sink.push(event);
      }
      result = await inner.result();
    } catch (err) {
      thrown = err;
    }

    const failure = thrown !== undefined ? errorText(thrown) : (result?.errorMessage ?? "");
    const isAbort = result?.stopReason === "aborted" || opts.signal?.aborted === true;
    const wait = isAbort || forwarded ? null : parseGatewayWait({ text: failure });
    const retryable = wait?.retryable === true && attempt < maxAttempts;

    if (retryable && wait) {
      const held = waitFor(wait, attempt, capMs);
      opts.onHold?.({ attempt, signal: held, errorText: failure });
      holds++;
      await opts.hold(held, attempt);
      // Escape during the hold ends the turn. Normalising to an aborted
      // message matches what Pi's own retry does when its backoff is
      // interrupted, so callers never have to care when cancellation landed.
      if (opts.signal?.aborted) {
        sink.end(abortedFrom(result));
        return { attempts: attempt, holds };
      }
      continue;
    }

    // Settled: a throw with nothing to report is the caller's problem, since
    // building an assistant message needs the model.
    if (thrown !== undefined) throw thrown;
    if (withheld) sink.push(withheld);
    sink.end(result);
    return { attempts: attempt, holds };
  }
}

/** Normalise a failed result into an aborted one, dropping the error text. */
function abortedFrom<R extends RetryableResult>(result: R | undefined): R {
  const { errorMessage: _dropped, ...rest } = (result ?? {}) as RetryableResult;
  return { ...rest, stopReason: "aborted" } as R;
}
