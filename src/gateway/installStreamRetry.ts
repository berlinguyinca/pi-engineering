/**
 * Installing the gateway stream-retry pump into a live Pi session.
 *
 * `ExtensionAPI.registerProvider(id, { api, streamSimple })` is the only seam
 * that reaches the interactive turn's provider call. `composeModelProvider`
 * dispatches to an extension `streamSimple` when — and only when —
 * `model.api === extension.api` (provider-composer.js:315-323), so the wrapper
 * is installed per `(provider, api)` pair and re-installed when the operator
 * switches to a model with a different api.
 *
 * Two hazards this module exists to avoid:
 *
 *   * **Recursion.** `getProvider(id)` returns the COMPOSED provider. Capture
 *     it before registering and it closes over the previous extension config
 *     (no `streamSimple`), so delegating to it reaches the real transport.
 *     Capture it again afterwards and the wrapper calls itself forever. The
 *     `installed` guard makes that unrepresentable rather than merely unlikely.
 *   * **Clobbering.** `registerProvider` REPLACES a provider's extension
 *     config. An operator who registered their own provider (a proxy base URL,
 *     custom models) would silently lose it, so any existing config is carried
 *     forward and only `api`/`streamSimple` are added.
 */

import { type BudgetContext, type RequestBodyBudgetConfig, streamWithinRequestBudget } from "../request/bodyBudget.ts";
import { type ThinkingOffConfig, streamWithThinkingPolicy } from "../request/thinkingPolicy.ts";

type ModelLike = {
  baseUrl?: string;
  id?: string;
  api?: string;
  provider?: string;
  contextWindow?: number;
  maxTokens?: number;
};
import type { GatewayWaitInput, GatewayWaitSignal } from "./signals.ts";
import {
  type AttemptStream,
  type GatewayStreamRetryOptions,
  type RetrySink,
  type RetryableEvent,
  type RetryableResult,
  pumpWithGatewayRetry,
} from "./streamRetry.ts";

/** A composed provider, as far as this module is concerned. */
export interface ProviderLike<M, C, O> {
  streamSimple?(model: M, context: C, options?: O): AttemptStream<RetryableEvent, RetryableResult>;
}

/** The slice of `ctx.modelRegistry` used here. */
export interface ProviderHost<M, C, O> {
  getProvider(providerId: string): ProviderLike<M, C, O> | undefined;
  getRegisteredProviderConfig?(providerId: string): Record<string, unknown> | undefined;
  /**
   * Overloaded on a real `ModelRegistry`: `(id, config)` registers an extension
   * config, `(provider)` registers a native provider. Both are used here.
   */
  registerProvider(providerId: string | ProviderLike<M, C, O>, config?: Record<string, unknown>): void;
  /** Present on a real `ModelRegistry`; absent on minimal hosts. */
  getRegisteredNativeProvider?(providerId: string): ProviderLike<M, C, O> | undefined;
}

interface ProviderResponseLike {
  status: number;
  headers?: Record<string, string>;
}

interface ProviderResponseOptions<R extends ProviderResponseLike = ProviderResponseLike, M = unknown> {
  onResponse?: (response: R, model: M) => void | Promise<void>;
}

/**
 * Give one provider attempt a private response-metadata cell.
 *
 * The provider/model pair is not a request identifier: two calls can be in
 * flight for the same model, and FIFO metadata lets either call consume the
 * other's headers. Wrapping the attempt's own `onResponse` callback makes the
 * transport invocation itself the correlation boundary. Only error responses
 * are retained, and `take` consumes them exactly once.
 */
export function captureGatewayAttemptResponse<
  R extends ProviderResponseLike,
  M,
  O extends ProviderResponseOptions<R, M>,
>(options: O): { options: O; take: () => Omit<GatewayWaitInput, "text"> | undefined; clear: () => void } {
  let metadata: Omit<GatewayWaitInput, "text"> | undefined;
  const original = options.onResponse;
  const captured = {
    ...options,
    onResponse: async (response: R, model: M) => {
      metadata = response.status >= 400 ? { status: response.status, headers: response.headers } : undefined;
      await original?.(response, model);
    },
  } as O;
  return {
    options: captured,
    take: () => {
      const value = metadata;
      metadata = undefined;
      return value;
    },
    clear: () => {
      metadata = undefined;
    },
  };
}

export interface InstallDeps<M, O, C = unknown> {
  /** Build the stream handed back to Pi. `createAssistantMessageEventStream`. */
  createStream(): RetrySink<RetryableEvent, RetryableResult> & AttemptStream<RetryableEvent, RetryableResult>;
  /**
   * Honour a reported wait — normally the shared admission cooldown. Receives
   * the stream's own abort signal so escape ends the hold for THIS turn while
   * the cooldown stays standing for every other caller.
   */
  hold(signal: GatewayWaitSignal, attempt: number, abort: AbortSignal | undefined, model: M): Promise<void>;
  onHold?: (info: Parameters<NonNullable<GatewayStreamRetryOptions["onHold"]>>[0], model: M) => void;
  /**
   * Called when a stream first produces output. Exposed so a caller keeping its
   * own consecutive-hold count resets it on the same evidence this module does.
   */
  onProgress?: (model: M) => void;
  /** Turn a thrown transport failure into an assistant error message. */
  errorMessage(model: M, error: unknown): RetryableResult;
  /** Read the turn's abort signal off the provider options. */
  signalOf?(options: O | undefined): AbortSignal | undefined;
  maxEscalatedWaitMs?: number;
  /**
   * Fit every attempt's request body to the gateway's cap before sending (see
   * src/request/bodyBudget.ts). Omitted, requests are sent as built.
   */
  requestBodyBudget?: RequestBodyBudgetConfig;
  /**
   * Thinking off for Pi summaries and near-full contexts on gateways that
   * accept `reasoning_effort: "none"` (see src/request/thinkingPolicy.ts).
   * Omitted, payloads are sent as built.
   */
  thinkingPolicy?: ThinkingOffConfig;
  /**
   * Awaited before each provider call is sent, with the call's abort signal:
   * the after-output retry takes the wait it owes here, so Esc ends it at once.
   * "aborted" ends the call as aborted without sending anything.
   */
  beforeSend?: (model: M, signal: AbortSignal | undefined, context: C) => Promise<"go" | "aborted">;
  maxAttempts?: number;
  maxElapsedMs?: number;
  now?: () => number;
}

export type InstallResult =
  | "installed"
  | "already-installed"
  /** No such provider in the registry (nothing to wrap). */
  | "no-provider"
  /** The provider exposes no `streamSimple` to delegate to. */
  | "no-base-stream"
  /** `registerProvider` rejected the config; the session is left untouched. */
  | "failed";

const installed = new Set<string>();

/** Forget every installation (tests only). */
export function resetGatewayStreamRetry(): void {
  installed.clear();
}

/** Whether a `(provider, api)` pair is already wrapped. */
export function isGatewayStreamRetryInstalled(providerId: string, api: string): boolean {
  return installed.has(`${providerId}:${api}`);
}

/** Every wrapped `provider:api` pair, for `/gateway` to report. */
export function installedGatewayStreamRetries(): string[] {
  return [...installed];
}

/**
 * Is the wrapper still the provider's live stream handler?
 *
 * Distinct from `isGatewayStreamRetryInstalled`, which reports what this module
 * did. Another extension registering the same provider afterwards replaces our
 * handler without telling us, and reporting stale bookkeeping as live coverage
 * would tell an operator they have unbounded waiting when they do not.
 */
export function isGatewayStreamRetryLive<M, C, O>(host: ProviderHost<M, C, O>, providerId: string): boolean {
  const streamSimple = host.getProvider(providerId)?.streamSimple as
    | (((...args: never[]) => unknown) & { __piEngineeringGatewayRetry?: boolean })
    | undefined;
  return streamSimple?.__piEngineeringGatewayRetry === true;
}

/**
 * Wrap `target`'s `streamSimple` so gateway saturation is waited out inside a
 * single Pi attempt. Idempotent per `(provider, api)`.
 */
export function installGatewayStreamRetry<M, C, O>(
  host: ProviderHost<M, C, O>,
  target: { provider: string; api: string },
  deps: InstallDeps<M, O, C>,
): InstallResult {
  const key = `${target.provider}:${target.api}`;
  if (installed.has(key)) return "already-installed";

  // A provider another extension registered via `registerNativeProvider` needs
  // the other install path entirely: `registerProvider` DELETES it
  // (model-runtime.js:562), which silently empties its model catalogue. Checked
  // against a real registry, not assumed — a built-in keeps all its models
  // across `registerProvider`, a native extension provider loses every one.
  const native = host.getRegisteredNativeProvider?.(target.provider);
  const base = native ?? host.getProvider(target.provider);
  if (!base) return "no-provider";
  // Captured BEFORE registration: this reference reaches the real transport.
  const providerStream = base.streamSimple?.bind(base);
  if (!providerStream) return "no-base-stream";
  // Innermost: the thinking policy sees the context actually sent (after the
  // body budget has fitted it) and edits the provider payload.
  const rawStream: typeof providerStream = deps.thinkingPolicy
    ? (streamWithThinkingPolicy<ModelLike, BudgetContext, O, RetryableEvent, RetryableResult>(
        providerStream as never,
        deps.thinkingPolicy,
      ) as unknown as typeof providerStream)
    : providerStream;
  // The body guard sits inside the retry pump: each attempt is fitted, and an
  // unsendable request surfaces as a non-gateway error the pump never retries.
  const budget = deps.requestBodyBudget;
  const baseStream: typeof rawStream = budget
    ? (streamWithinRequestBudget<ModelLike, BudgetContext, O, RetryableEvent, RetryableResult>(rawStream as never, {
        config: budget,
        errorResult: (model, error) => deps.errorMessage(model as M, error),
      }) as unknown as typeof rawStream)
    : rawStream;

  // Consecutive saturated attempts for THIS provider, across provider calls.
  // The agent loop issues one call per tool round-trip and an outage outlives a
  // turn, so an escalation scoped to a single call would restart at the base
  // wait every few seconds — exactly the busy-wait it exists to prevent. A
  // stream that completes normally means capacity is back, so it resets.
  let consecutiveHolds = 0;

  /**
   * Marker so an installation can be VERIFIED rather than assumed.
   *
   * The `installed` set records what this module did, not what the registry
   * currently holds: another extension re-registering the provider replaces our
   * handler, and the set would still claim it is wrapped — leaving `/gateway`
   * reporting unbounded waiting that is no longer installed.
   */
  const WRAPPED = "__piEngineeringGatewayRetry";

  const streamSimple = (model: M, context: C, options?: O) => {
    const out = deps.createStream();
    const signal = deps.signalOf?.(options);
    let responseCapture:
      | ReturnType<typeof captureGatewayAttemptResponse<ProviderResponseLike, unknown, ProviderResponseOptions>>
      | undefined;
    void (async () => {
      if (deps.beforeSend && (await deps.beforeSend(model, signal, context)) === "aborted") {
        const aborted = { ...deps.errorMessage(model, new Error("Request aborted")), stopReason: "aborted" };
        out.push({ type: "error", reason: "aborted", error: aborted } as RetryableEvent);
        out.end(aborted);
        return;
      }
      await pumpWithGatewayRetry(
        () => {
          responseCapture = captureGatewayAttemptResponse(
            (options ?? {}) as ProviderResponseOptions<ProviderResponseLike, unknown>,
          );
          return baseStream(model, context, responseCapture.options as O);
        },
        out,
        {
          hold: (waitSignal, attempt) => {
            consecutiveHolds++;
            return deps.hold(waitSignal, attempt, signal, model);
          },
          priorHolds: consecutiveHolds,
          // Synchronous, unlike the outcome: the agent loop starts its next
          // provider call before a `.then` on this pump would run.
          onProgress: () => {
            responseCapture?.clear();
            consecutiveHolds = 0;
            deps.onProgress?.(model);
          },
          ...(deps.onHold ? { onHold: (info) => deps.onHold?.(info, model) } : {}),
          ...(signal ? { signal } : {}),
          ...(deps.maxEscalatedWaitMs != null ? { maxEscalatedWaitMs: deps.maxEscalatedWaitMs } : {}),
          ...(deps.maxAttempts != null ? { maxAttempts: deps.maxAttempts } : {}),
          ...(deps.maxElapsedMs != null ? { maxElapsedMs: deps.maxElapsedMs } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          response: () => responseCapture?.take(),
        },
      );
    })().catch((error: unknown) => {
      // A throw that is not gateway backpressure. Pi expects a terminal event,
      // never a rejected promise, so report it the way `lazyStream` does.
      const message = deps.errorMessage(model, error);
      out.push({ type: "error", reason: "error", error: message } as RetryableEvent);
      out.end(message);
    });
    return out;
  };

  Object.defineProperty(streamSimple, WRAPPED, { value: true, enumerable: false });

  try {
    if (native) {
      // Re-register the SAME provider with only its transport swapped, so its
      // models, auth and login flow are carried over untouched. Copying via the
      // prototype keeps class-based providers working. `registerProvider` with
      // a single provider argument is the native overload — the two-argument
      // form is what would have deleted this provider.
      const wrapped = Object.assign(Object.create(Object.getPrototypeOf(native) ?? null), native, { streamSimple });
      host.registerProvider(wrapped);
    } else {
      // Carry any existing extension config forward: registering replaces it.
      const existing = host.getRegisteredProviderConfig?.(target.provider) ?? {};
      host.registerProvider(target.provider, { ...existing, api: target.api, streamSimple });
    }
  } catch {
    // A rejected config must not take the session down — the operator keeps
    // Pi's own (shorter) retry rather than losing the provider entirely.
    return "failed";
  }
  installed.add(key);
  return "installed";
}
