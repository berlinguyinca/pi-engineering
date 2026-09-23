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

import type { GatewayWaitSignal } from "./signals.ts";
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

export interface InstallDeps<M, O> {
  /** Build the stream handed back to Pi. `createAssistantMessageEventStream`. */
  createStream(): RetrySink<RetryableEvent, RetryableResult> & AttemptStream<RetryableEvent, RetryableResult>;
  /**
   * Honour a reported wait — normally the shared admission cooldown. Receives
   * the stream's own abort signal so escape ends the hold for THIS turn while
   * the cooldown stays standing for every other caller.
   */
  hold(signal: GatewayWaitSignal, attempt: number, abort: AbortSignal | undefined): Promise<void>;
  onHold?: GatewayStreamRetryOptions["onHold"];
  /**
   * Called when a stream first produces output. Exposed so a caller keeping its
   * own consecutive-hold count resets it on the same evidence this module does.
   */
  onProgress?: () => void;
  /** Turn a thrown transport failure into an assistant error message. */
  errorMessage(model: M, error: unknown): RetryableResult;
  /** Read the turn's abort signal off the provider options. */
  signalOf?(options: O | undefined): AbortSignal | undefined;
  maxEscalatedWaitMs?: number;
  maxAttempts?: number;
  maxElapsedMs?: number;
  now?: () => number;
  response?: GatewayStreamRetryOptions["response"];
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
  deps: InstallDeps<M, O>,
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
  const baseStream = base.streamSimple?.bind(base);
  if (!baseStream) return "no-base-stream";

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
    void pumpWithGatewayRetry(() => baseStream(model, context, options), out, {
      hold: (waitSignal, attempt) => {
        consecutiveHolds++;
        return deps.hold(waitSignal, attempt, signal);
      },
      priorHolds: consecutiveHolds,
      // Synchronous, unlike the outcome: the agent loop starts its next
      // provider call before a `.then` on this pump would run.
      onProgress: () => {
        consecutiveHolds = 0;
        deps.onProgress?.();
      },
      ...(deps.onHold ? { onHold: deps.onHold } : {}),
      ...(signal ? { signal } : {}),
      ...(deps.maxEscalatedWaitMs != null ? { maxEscalatedWaitMs: deps.maxEscalatedWaitMs } : {}),
      ...(deps.maxAttempts != null ? { maxAttempts: deps.maxAttempts } : {}),
      ...(deps.maxElapsedMs != null ? { maxElapsedMs: deps.maxElapsedMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.response ? { response: deps.response } : {}),
    }).catch((error: unknown) => {
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
