/**
 * InferWeave admission-retry transport (spec 02-retry-state-machine).
 *
 * This is the harness-owned InferWeave-facing transport boundary. It wraps one
 * provider's `streamSimple` so a structurally recognised admission rejection
 * becomes a scheduler-directed wait inside the *same* logical inference
 * operation instead of a terminal inference failure.
 *
 * Ownership rules enforced here:
 *   - only responses carrying `type: "inference_admission"` are waited on, and
 *     classification reads the structured body, never rendered error text;
 *   - an admission response is re-issued with `x-should-retry: false` and the
 *     attempt runs with `maxRetries: 0`, so the caller's transport retry budget
 *     cannot multiply this loop (spec 03 §2);
 *   - every wait is interruptible through the caller's `AbortSignal`;
 *   - once model output has reached the consumer the stream is never replayed.
 */

import { randomUUID } from "node:crypto";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  FetchFunction,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { monotonicNow } from "../core/clock.ts";
// The pi-ai `utils/event-stream` subpath does not resolve under Pi's resource
// loader (it resolves the package main then appends the subpath, yielding
// `dist/compat.js/utils/event-stream`). `@earendil-works/pi-ai/compat` exports
// the `AssistantMessageEventStream` type but not its constructor, so build a
// structurally-compatible empty stream locally instead. `AssistantMessage` and
// `AssistantMessageEvent` are already imported as types from compat above.
function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  let finalResult: AssistantMessage | undefined;
  const stream = {
    push(event: AssistantMessageEvent): void {
      queue.push(event);
      const w = waiters.splice(0);
      for (const fn of w) fn();
    },
    end(result?: AssistantMessage): void {
      if (result !== undefined) finalResult = result;
      done = true;
      const w = waiters.splice(0);
      for (const fn of w) fn();
    },
    result(): Promise<AssistantMessage> {
      if (done) return Promise.resolve(finalResult as AssistantMessage);
      return new Promise<AssistantMessage>((resolve) => {
        const check = (): void => {
          if (done) resolve(finalResult as AssistantMessage);
          else waiters.push(check);
        };
        check();
      });
    },
    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      let i = 0;
      while (true) {
        while (i < queue.length) {
          const ev = queue[i++];
          if (ev) yield ev;
        }
        if (done) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
  return stream as unknown as AssistantMessageEventStream;
}
import {
  type AdmissionDecision,
  type AdmissionRetryConfig,
  decideAdmission,
  resolveAdmissionScope,
} from "./admissionConfig.ts";
import {
  type AdmissionAction,
  AdmissionFailure,
  type AdmissionHeaders,
  type AdmissionInfo,
  DEFAULT_ADMISSION_REASON_POLICY,
  admissionFromResponse,
  augmentInferenceErrorMessage,
  isAssistantOutputEvent,
  isAutomaticReplayAllowed,
  mayCarryAdmission,
  serverRequestIdFromHeaders,
} from "./admissionContract.ts";
import type { AdmissionEvent, AdmissionEventBus, AdmissionEventName } from "./admissionEvents.ts";
import { type RetryDelaySource, decideWait, resolveRetryDelay } from "./retryDelay.ts";

/** One provider attempt: the shape of pi-ai's `streamSimple`. */
export type AdmissionStreamFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** pi-ai's fetch contract; Pi supplies its own or `globalThis.fetch` is used. */
export type AdmissionFetch = FetchFunction;

/** Scope keys attached to every emitted event when known. */
export interface AdmissionScope {
  sessionId?: string;
  agentId?: string;
  role?: string;
  workerId?: string;
  runId?: string;
}

/** State-machine phases (spec 02 §1). */
export type AdmissionPhase =
  | "READY"
  | "REQUESTING"
  | "ADMISSION_WAIT"
  | "RETRYING"
  | "STREAMING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/** Why an admission chain stopped waiting. */
export type AdmissionTerminalReason = TerminalReason;

/** Queue saturation reported by InferWeave. */
export interface AdmissionSaturation {
  active?: number;
  activeLimit?: number;
  queued?: number;
  queueLimit?: number;
}

/** Live state of one logical inference operation. */
export interface AdmissionState {
  phase: AdmissionPhase;
  provider: string;
  model: string;
  logicalRequestId: string;
  attempt: number;
  maxAttempts: number;
  /** Cumulative time already waited for this logical operation. */
  waitedMs: number;
  /** Monotonic time since the operation started. */
  elapsedMs: number;
  reason?: string;
  httpStatus?: number;
  /** Resolved wait for the current or next wait state. */
  delayMs?: number;
  delaySource?: RetryDelaySource;
  /** Epoch ms at which the current wait ends; drives the countdown UI. */
  waitUntilMs?: number;
  queueDepth?: number;
  queueLimit?: number;
  activeWorkers?: number;
  workerLimit?: number;
  serverRequestId?: string;
  classification?: AdmissionAction;
}

/** Everything the retry loop needs that is not per-request state. */
export interface AdmissionTransportOptions {
  config: AdmissionRetryConfig;
  /** Event bus; when absent the loop still retries, silently. */
  events?: AdmissionEventBus;
  /** Attempt implementation. Defaults to the pi-ai implementation for `model.api`. */
  delegate?: AdmissionStreamFunction;
  /** Monotonic duration clock. Injectable for deterministic tests. */
  now?: () => number;
  /** Interruptible sleep. Injectable for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source. */
  random?: () => number;
  /**
   * Scope keys for events. When a function, it receives the attempt's
   * `options.sessionId` (Pi sets it to the lane session id), which lets a
   * shared runtime attribute waits to the correct worker even under concurrency.
   */
  scope?: AdmissionScope | ((sessionId?: string) => AdmissionScope);
  /** Called on every phase change. */
  onState?: (state: AdmissionState) => void;
  /** Called with queue saturation so routing can prefer an idle replica. */
  onSaturation?: (ref: { provider: string; id: string }, saturation: AdmissionSaturation) => void;
  /** Shared per provider/model wait ledger, so an outer layer cannot re-spend it. */
  budget?: AdmissionBudgetLedger;
  /** Structured log hook. */
  log?: (level: "debug" | "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
}

/** What the capture fetch learned about one attempt's rejection. */
export interface AdmissionAttemptCapture {
  status?: number;
  headers?: AdmissionHeaders;
  bodyText?: string;
  admission?: AdmissionInfo;
  serverRequestId?: string;
}

/** Header carrying the harness logical-request identity. */
export const LOGICAL_REQUEST_HEADER = "x-pi-logical-request-id";
/** Header carrying the 1-based attempt number. */
export const ATTEMPT_HEADER = "x-pi-attempt";
/** Header the transport sets to claim ownership of an admission rejection. */
export const SHOULD_RETRY_HEADER = "x-should-retry";

/** Copy a `Headers` object into a plain record with lower-cased keys. */
export function headersToRecord(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Wrap `fetch` so one attempt's rejection response is captured structurally.
 *
 * Only candidate statuses (429/503) are buffered, and only to parse the
 * admission contract; successful responses stream through untouched so
 * streaming semantics are unaffected. A recognised admission response is
 * re-issued with `x-should-retry: false`, which is how Pi's own transport retry
 * is told this class of rejection is owned by the harness.
 */
export function createAdmissionCaptureFetch(
  capture: AdmissionAttemptCapture,
  baseFetch: AdmissionFetch = globalThis.fetch as AdmissionFetch,
  markNonRetryable = true,
): AdmissionFetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!mayCarryAdmission(response.status)) return response;
    let text: string;
    try {
      text = await response.text();
    } catch {
      return response;
    }
    const headers = headersToRecord(response.headers);
    capture.status = response.status;
    capture.headers = headers;
    capture.bodyText = text;
    const info = admissionFromResponse({ status: response.status, headers, body: text });
    capture.serverRequestId = info?.requestId ?? serverRequestIdFromHeaders(headers);
    if (info) capture.admission = info;
    const responseHeaders = new Headers(headers);
    if (info && markNonRetryable) responseHeaders.set(SHOULD_RETRY_HEADER, "false");
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}

/** AbortError in the shape Pi and pi-ai use. */
export function createAdmissionAbortError(): Error {
  const error = new Error("Inference request aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Sleep that rejects immediately on abort and never leaves a timer behind.
 * This is what makes a 15-minute scheduler wait cancellable in practice.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAdmissionAbortError());
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAdmissionAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Cumulative wait ledger keyed by `provider/model`.
 *
 * A logical request that exhausts its budget marks the window spent, so an
 * outer layer (agent-level retry, scheduler re-dispatch) entering the same
 * provider again fails fast instead of spending another full wait budget.
 */
export class AdmissionBudgetLedger {
  private readonly entries = new Map<string, { windowStart: number; waitedMs: number; exhaustedUntil: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private entry(key: string, windowMs: number): { windowStart: number; waitedMs: number; exhaustedUntil: number } {
    const now = this.now();
    let entry = this.entries.get(key);
    const stale = entry !== undefined && now > entry.windowStart + windowMs && entry.exhaustedUntil <= now;
    if (!entry || stale) {
      entry = { windowStart: now, waitedMs: 0, exhaustedUntil: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Cumulative waited time in the current window. */
  waited(key: string, windowMs: number): number {
    return this.entry(key, windowMs).waitedMs;
  }

  /** Record waited time for a provider/model. */
  addWait(key: string, windowMs: number, ms: number): void {
    this.entry(key, windowMs).waitedMs += Math.max(0, ms);
  }

  /** Declare the budget spent; further admissions fail fast for `cooldownMs`. */
  markExhausted(key: string, windowMs: number, cooldownMs: number): void {
    const entry = this.entry(key, windowMs);
    entry.exhaustedUntil = this.now() + Math.max(0, cooldownMs);
  }

  exhaustedUntil(key: string, windowMs: number): number {
    return this.entry(key, windowMs).exhaustedUntil;
  }

  isExhausted(key: string, windowMs: number): boolean {
    return this.exhaustedUntil(key, windowMs) > this.now();
  }

  /** True when cumulative waiting in the window passed `sharedBudgetMs`. */
  overSharedBudget(key: string, windowMs: number, sharedBudgetMs: number): boolean {
    if (sharedBudgetMs <= 0) return false;
    return this.waited(key, windowMs) >= sharedBudgetMs;
  }

  reset(): void {
    this.entries.clear();
  }
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build the terminal assistant message for a failed or aborted request. */
export function terminalAssistantMessage(
  model: Model<Api>,
  errorMessage: string,
  stopReason: "error" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/** Result of consuming one attempt's stream. */
interface AttemptOutcome {
  /** Terminal event seen, if the stream produced one. */
  terminal: "done" | "error" | undefined;
  /** True when the terminal error was withheld so the loop can retry. */
  withheld: boolean;
  /** True when the terminal event was forwarded to the consumer. */
  forwarded: boolean;
  /** True when any model output reached the consumer. */
  committed: boolean;
  /** True when the attempt terminated as aborted. */
  aborted: boolean;
}

/** Why a chain stopped waiting. */
type TerminalReason = "budget_attempts" | "budget_elapsed" | "budget_ledger" | "fallback" | "permanent";

/**
 * Forward one attempt's options for a fresh call, claiming retry ownership.
 *
 * Exported so tests and installers can see exactly what changes per attempt.
 */
export function prepareAttemptOptions(
  options: SimpleStreamOptions | undefined,
  config: AdmissionRetryConfig,
  logicalRequestId: string,
  attempt: number,
): SimpleStreamOptions {
  const next: SimpleStreamOptions = { ...(options ?? {}) };
  if (config.own_transport_retries) {
    // Admission handling owns retry for this provider: the transport layer gets
    // a single attempt, so waits cannot multiply across layers.
    next.maxRetries = 0;
    next.maxRetryDelayMs = 0;
  }
  if (config.correlation_headers) {
    next.headers = {
      ...(options?.headers ?? {}),
      [LOGICAL_REQUEST_HEADER]: logicalRequestId,
      [ATTEMPT_HEADER]: String(attempt),
    };
  }
  return next;
}

/**
 * Run one logical inference operation with admission-aware waiting.
 *
 * `invoke` is called once per attempt and must return a fresh stream built with
 * that attempt's capture object. The returned stream carries the events of the
 * attempt that finishes the operation: retryable admission attempts are
 * consumed and withheld, so the consumer never sees `Error: 429` for a wait the
 * harness is handling.
 */
export function executeWithAdmissionRetry(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  invoke: (
    attempt: number,
    attemptOptions: SimpleStreamOptions,
    capture: AdmissionAttemptCapture,
  ) => AssistantMessageEventStream,
  opts: AdmissionTransportOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const now = opts.now ?? monotonicNow;
  const wallNow = Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  const config = resolveAdmissionScope(opts.config, model.provider, model.id);
  const scopeConfig = opts.scope ?? {};
  const sessionIdOf = (): string | undefined => options?.sessionId;
  const logicalRequestId = randomUUID();
  const startedAt = now();
  const budgetKey = `${model.provider}/${model.id}`;
  /** The ledger is inert unless a shared window is configured. */
  const ledgerWindowMs = config.shared_budget_ms > 0 ? config.shared_budget_ms : config.max_elapsed_ms;
  const ledgerActive = config.shared_budget_ms > 0 && opts.budget !== undefined;

  let attempt = 0;
  let waitedMs = 0;
  let last: AdmissionInfo | undefined;
  let lastStatus = 429;
  let lastDelayMs = 0;
  let lastDelaySource: RetryDelaySource | undefined;
  let lastDecision: AdmissionAction | undefined;
  let lastPolicy: AdmissionDecision | undefined;

  const scopeOf = (): AdmissionScope => (typeof scopeConfig === "function" ? scopeConfig(sessionIdOf()) : scopeConfig);

  const stateOf = (phase: AdmissionPhase, extra: Partial<AdmissionState> = {}): AdmissionState => ({
    phase,
    provider: model.provider,
    model: model.id,
    logicalRequestId,
    attempt,
    maxAttempts: config.max_attempts,
    waitedMs,
    elapsedMs: now() - startedAt,
    reason: last?.reason,
    httpStatus: last ? lastStatus : undefined,
    delayMs: lastDelayMs > 0 ? lastDelayMs : undefined,
    delaySource: lastDelaySource,
    queueDepth: last?.queued,
    queueLimit: last?.queueLimit,
    activeWorkers: last?.active,
    workerLimit: last?.activeLimit,
    serverRequestId: last?.requestId,
    classification: lastDecision,
    ...extra,
  });

  const setState = (phase: AdmissionPhase, extra: Partial<AdmissionState> = {}): void => {
    opts.onState?.(stateOf(phase, extra));
  };

  const publish = (name: AdmissionEventName, extra: Partial<AdmissionEvent> = {}): void => {
    const bus: AdmissionEventBus | undefined = opts.events;
    if (!bus) return;
    const scope = scopeOf();
    bus.publish(name, {
      provider: model.provider,
      model: model.id,
      logicalRequestId,
      attempt,
      maxAttempts: config.max_attempts,
      elapsedWaitMs: waitedMs,
      serverRequestId: last?.requestId,
      reason: last?.reason,
      httpStatus: last ? lastStatus : undefined,
      queueDepth: last?.queued,
      queueLimit: last?.queueLimit,
      activeWorkers: last?.active,
      workerLimit: last?.activeLimit,
      classification: lastDecision,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      role: scope.role,
      workerId: scope.workerId,
      runId: scope.runId,
      ...extra,
    });
  };

  const terminate = (message: AssistantMessage, event: AssistantMessageEvent, phase: "FAILED" | "CANCELLED"): void => {
    setState(phase);
    out.push(event);
    out.end(message);
  };

  /** Consume one attempt stream, withholding a retryable admission terminal. */
  const consumeAttempt = async (
    stream: AssistantMessageEventStream,
    attemptCapture: AdmissionAttemptCapture,
  ): Promise<AttemptOutcome> => {
    let committed = false;
    for await (const event of stream) {
      if (event.type === "done") {
        // The hand-rolled stream does not auto-resolve `result()` / unblock the
        // iterator on a pushed terminal event: end it explicitly so the consumer
        // sees completion (and `result()` resolves) instead of hanging.
        out.push(event);
        out.end(event.message);
        return { terminal: "done", withheld: false, forwarded: true, committed, aborted: false };
      }
      if (event.type === "error") {
        const admission = attemptCapture.admission;
        // Withhold only an unambiguous, structured admission rejection that has
        // produced no output yet: replaying after output would duplicate it.
        if (
          admission !== undefined &&
          (isAutomaticReplayAllowed(admission, committed) ||
            (!committed &&
              admission.explicitReplayContract !== true &&
              ["fail", "fallback"].includes(DEFAULT_ADMISSION_REASON_POLICY[admission.reason]?.action ?? ""))) &&
          !config.observe_only &&
          event.reason !== "aborted"
        ) {
          last = admission;
          lastStatus = attemptCapture.status ?? lastStatus;
          return { terminal: "error", withheld: true, forwarded: false, committed, aborted: false };
        }
        // Forwarded (non-withheld) error: end `out` so the consumer's iteration
        // and `result()` resolve instead of hanging (mirrors the done case).
        const terminal = admission
          ? { ...event.error, errorMessage: augmentInferenceErrorMessage(event.error.errorMessage, admission) }
          : event.error;
        out.push({ ...event, error: terminal });
        out.end(terminal);
        return {
          terminal: "error",
          withheld: false,
          forwarded: true,
          committed,
          aborted: event.reason === "aborted",
        };
      }
      if (isAssistantOutputEvent(event.type)) {
        if (!committed) setState("STREAMING");
        committed = true;
      }
      out.push(event);
    }
    return { terminal: undefined, withheld: false, forwarded: false, committed, aborted: false };
  };

  /** Report a terminal admission failure, retaining every contract field. */
  const failAdmission = (reason: TerminalReason): void => {
    const admission = last;
    if (!admission) return;
    const usesFallback = reason === "fallback" || reason === "budget_ledger";
    const failure = new AdmissionFailure({
      provider: model.provider,
      modelId: model.id,
      logicalRequestId,
      status: lastStatus,
      reason: admission.reason,
      action: lastDecision ?? "retry",
      attempts: attempt,
      elapsedMs: now() - startedAt,
      lastDelayMs: lastDelayMs > 0 ? lastDelayMs : undefined,
      serverRequestId: admission.requestId,
      terminatedBy:
        reason === "budget_attempts"
          ? "budget_attempts"
          : reason === "budget_elapsed"
            ? "budget_elapsed"
            : reason === "budget_ledger"
              ? "budget_ledger"
              : undefined,
      fallbackAttempted: usesFallback,
      serverMessage: admission.message,
      code: admission.code,
      actionCode: admission.actionCode,
    });
    if (usesFallback) {
      publish("inference.fallback.triggered", { terminatedBy: reason });
    } else {
      publish("inference.retry.exhausted", { terminatedBy: reason });
    }
    opts.log?.(usesFallback ? "warn" : "error", "inference admission budget exhausted", {
      logicalRequestId,
      provider: model.provider,
      model: model.id,
      reason: admission.reason,
      attempts: attempt,
      waitedMs,
      terminatedBy: reason,
      serverRequestId: admission.requestId,
    });
    if (ledgerActive) opts.budget?.markExhausted(budgetKey, ledgerWindowMs, ledgerWindowMs);
    const message = terminalAssistantMessage(model, failure.message, "error");
    terminate(message, { type: "error", reason: "error", error: message }, "FAILED");
  };

  /** Report a cancellation: not an InferWeave failure, and never retried here. */
  const cancelWait = (terminatedBy: string): void => {
    const detail = last
      ? `Last admission response: ${last.reason} (HTTP ${lastStatus}), request ${last.requestId ?? "unknown"}.`
      : "No admission response recorded.";
    const message = terminalAssistantMessage(
      model,
      `Cancelled while waiting for InferWeave admission capacity (attempt ${attempt}, waited ${Math.round(waitedMs / 1000)}s). This is a cancellation, not an InferWeave failure. ${detail}`,
      "aborted",
    );
    publish("inference.retry.cancelled", { terminatedBy });
    opts.log?.("info", "admission wait cancelled", {
      logicalRequestId,
      provider: model.provider,
      model: model.id,
      attempt,
      waitedMs,
      terminatedBy,
    });
    terminate(message, { type: "error", reason: "aborted", error: message }, "CANCELLED");
  };

  const run = async (): Promise<void> => {
    setState("READY");
    for (;;) {
      attempt++;
      const capture: AdmissionAttemptCapture = {};
      const attemptOptions = prepareAttemptOptions(options, config, logicalRequestId, attempt);
      setState(attempt === 1 ? "REQUESTING" : "RETRYING");
      publish("inference.retry.started");
      opts.log?.("debug", "inference attempt started", {
        logicalRequestId,
        attempt,
        provider: model.provider,
        model: model.id,
      });

      // Synchronous state/event/log hooks above may consume the last sliver of
      // the elapsed budget. Guard at the actual replay boundary, immediately
      // before opening the next provider request, and retain the last refusal.
      if (attempt > 1 && lastPolicy) {
        const preInvokeReason = evaluateTerminal({
          decision: lastPolicy.action,
          fallbackAfterMs: lastPolicy.fallbackAfterMs,
          reasonBudgetMs: lastPolicy.maxElapsedMs,
          waitedMs,
          elapsedMs: now() - startedAt,
          attempt: attempt - 1,
          maxAttempts: config.max_attempts,
          ledger: ledgerActive ? opts.budget : undefined,
          budgetKey,
          windowMs: ledgerWindowMs,
          sharedBudgetMs: config.shared_budget_ms,
        });
        if (preInvokeReason) {
          failAdmission(preInvokeReason);
          return;
        }
      }

      let outcome: AttemptOutcome;
      try {
        outcome = await consumeAttempt(invoke(attempt, attemptOptions, capture), capture);
      } catch (error) {
        const aborted = isAbortError(error) || options?.signal?.aborted === true;
        const message = terminalAssistantMessage(
          model,
          error instanceof Error ? error.message : String(error),
          aborted ? "aborted" : "error",
        );
        if (aborted) {
          publish("inference.retry.cancelled", { terminatedBy: "transport_abort" });
          terminate(message, { type: "error", reason: "aborted", error: message }, "CANCELLED");
        } else {
          // Non-admission transport failure: preserved verbatim for the caller.
          terminate(message, { type: "error", reason: "error", error: message }, "FAILED");
        }
        return;
      }

      if (outcome.terminal === "done") {
        setState("SUCCEEDED");
        publish("inference.retry.succeeded");
        return;
      }
      if (outcome.terminal === "error" && !outcome.withheld) {
        setState(outcome.aborted ? "CANCELLED" : "FAILED");
        if (outcome.aborted) publish("inference.retry.cancelled", { terminatedBy: "provider_abort" });
        return;
      }
      if (outcome.terminal === undefined) {
        const message = terminalAssistantMessage(model, "Inference stream ended without a terminal event", "error");
        terminate(message, { type: "error", reason: "error", error: message }, "FAILED");
        return;
      }

      const admission = capture.admission;
      if (!admission) {
        // Defensive: withholding implies an admission capture.
        const message = terminalAssistantMessage(model, capture.bodyText ?? "Admission rejection", "error");
        terminate(message, { type: "error", reason: "error", error: message }, "FAILED");
        return;
      }

      reportSaturation(opts, model, admission);
      lastStatus = capture.status ?? lastStatus;
      const decision = decideAdmission(config, {
        reason: admission.reason,
        status: lastStatus,
        serverDelayMs: admission.retryAfterMs,
        explicitReplayContract: admission.explicitReplayContract,
      });
      lastDecision = decision.action;
      lastPolicy = decision;

      if (options?.signal?.aborted) {
        cancelWait("aborted_before_wait");
        return;
      }

      const terminalReason = evaluateTerminal({
        decision: decision.action,
        fallbackAfterMs: decision.fallbackAfterMs,
        reasonBudgetMs: decision.maxElapsedMs,
        waitedMs,
        elapsedMs: now() - startedAt,
        attempt,
        maxAttempts: config.max_attempts,
        ledger: ledgerActive ? opts.budget : undefined,
        budgetKey,
        windowMs: ledgerWindowMs,
        sharedBudgetMs: config.shared_budget_ms,
      });
      if (terminalReason) {
        failAdmission(terminalReason);
        return;
      }

      const delay = resolveRetryDelay({
        headers: capture.headers,
        body: admission.payload,
        attempt,
        bounds: {
          minDelayMs: config.min_delay_ms,
          maxDelayMs: config.max_delay_ms,
          baseBackoffMs: config.base_backoff_ms,
          maxBackoffMs: config.max_backoff_ms,
          jitterRatio: config.jitter_ratio,
          honorRetryAfter: config.honor_retry_after,
        },
        nowMs: wallNow(),
        random,
      });
      const waitDecision = decideWait({
        serverMinimumMs: delay.serverDelayMs,
        proposedMs: delay.delayMs,
        remainingMs: Math.max(0, decision.maxElapsedMs - (now() - startedAt)),
      });
      if (waitDecision.action === "stop") {
        lastDelayMs = delay.delayMs;
        lastDelaySource = delay.source;
        failAdmission("budget_elapsed");
        return;
      }
      const waitMs = waitDecision.waitMs;
      lastDelayMs = waitMs;
      lastDelaySource = delay.source;
      if (waitMs <= 0) {
        failAdmission("budget_elapsed");
        return;
      }

      const waitUntilMs = wallNow() + waitMs;
      publish("inference.retry.scheduled", {
        delayUsedMs: waitMs,
        retryAfterMs: admission.retryAfterMs,
        delaySource: delay.source,
        classification: decision.action,
      });
      setState("ADMISSION_WAIT", {
        reason: admission.reason,
        httpStatus: lastStatus,
        delayMs: waitMs,
        delaySource: delay.source,
        waitUntilMs,
        queueDepth: admission.queued,
        queueLimit: admission.queueLimit,
        activeWorkers: admission.active,
        workerLimit: admission.activeLimit,
        serverRequestId: admission.requestId,
        classification: decision.action,
      });
      publish("inference.retry.waiting", {
        delayUsedMs: waitMs,
        retryAfterMs: admission.retryAfterMs,
        delaySource: delay.source,
        classification: decision.action,
      });

      try {
        await sleep(waitMs, options?.signal);
      } catch (error) {
        if (!isAbortError(error)) throw error;
        cancelWait("cancelled_during_wait");
        return;
      }
      waitedMs += waitMs;
      if (ledgerActive) opts.budget?.addWait(budgetKey, ledgerWindowMs, waitMs);
      if (options?.signal?.aborted) {
        cancelWait("cancelled_after_wait");
        return;
      }
      const postWaitReason = evaluateTerminal({
        decision: decision.action,
        fallbackAfterMs: decision.fallbackAfterMs,
        reasonBudgetMs: decision.maxElapsedMs,
        waitedMs,
        elapsedMs: now() - startedAt,
        attempt,
        maxAttempts: config.max_attempts,
        ledger: ledgerActive ? opts.budget : undefined,
        budgetKey,
        windowMs: ledgerWindowMs,
        sharedBudgetMs: config.shared_budget_ms,
      });
      if (postWaitReason) {
        failAdmission(postWaitReason);
        return;
      }
    }
  };

  void run().catch((error: unknown) => {
    const message = terminalAssistantMessage(
      model,
      `InferWeave admission handler failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    terminate(message, { type: "error", reason: "error", error: message }, "FAILED");
  });
  return out;
}

/** Decide whether the chain must stop waiting before the next attempt. */
export function evaluateTerminal(input: {
  decision: AdmissionAction;
  fallbackAfterMs?: number;
  reasonBudgetMs: number;
  waitedMs: number;
  elapsedMs?: number;
  attempt: number;
  maxAttempts: number;
  ledger?: AdmissionBudgetLedger;
  budgetKey: string;
  windowMs: number;
  sharedBudgetMs: number;
}): TerminalReason | undefined {
  if (input.decision === "fail") return "permanent";
  if (input.decision === "fallback") return "fallback";
  const elapsedMs = input.elapsedMs ?? input.waitedMs;
  if (input.decision === "retry_then_fallback" && elapsedMs >= (input.fallbackAfterMs ?? input.reasonBudgetMs)) {
    return "fallback";
  }
  if (elapsedMs >= input.reasonBudgetMs) return "budget_elapsed";
  if (input.ledger?.isExhausted(input.budgetKey, input.windowMs)) return "budget_ledger";
  if (input.ledger?.overSharedBudget(input.budgetKey, input.windowMs, input.sharedBudgetMs)) return "budget_ledger";
  if (input.attempt >= input.maxAttempts) return "budget_attempts";
  return undefined;
}

function reportSaturation(opts: AdmissionTransportOptions, model: Model<Api>, admission: AdmissionInfo): void {
  if (!opts.config.report_saturation || !opts.onSaturation) return;
  const saturation: AdmissionSaturation = {
    active: admission.active,
    activeLimit: admission.activeLimit,
    queued: admission.queued,
    queueLimit: admission.queueLimit,
  };
  if (
    saturation.active === undefined &&
    saturation.queued === undefined &&
    saturation.activeLimit === undefined &&
    saturation.queueLimit === undefined
  ) {
    return;
  }
  opts.onSaturation({ provider: model.provider, id: model.id }, saturation);
}

/**
 * Build the `streamSimple` implementation for one provider registration.
 *
 * Pi calls the returned function for every inference on the wrapped provider.
 * Each attempt is a fresh delegate call carrying its own capture fetch, so the
 * raw rejection is read structurally before Pi flattens it into an error.
 */
export function createAdmissionStreamSimple(opts: AdmissionTransportOptions): AdmissionStreamFunction {
  const delegate: AdmissionStreamFunction =
    opts.delegate ??
    ((model, context, options) => {
      const api = getApiProvider(model.api);
      if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
      // pi-ai 0.87 providers take a normalized TranscriptContext (system prompt
      // folded into a leading system message). Pi's ModelRuntime normalizes
      // before dispatching to a provider, so the context arriving here already
      // has that shape; the brand is type-only.
      return api.streamSimple(model, context as Parameters<typeof api.streamSimple>[1], options);
    });
  return (model, context, options) =>
    executeWithAdmissionRetry(
      model,
      context,
      options,
      (attempt, attemptOptions, capture) => {
        const baseFetch: AdmissionFetch = options?.fetch ?? (globalThis.fetch as AdmissionFetch);
        const fetchImpl = createAdmissionCaptureFetch(capture, baseFetch, opts.config.own_transport_retries);
        return delegate(model, context, { ...attemptOptions, fetch: fetchImpl });
      },
      opts,
    );
}
