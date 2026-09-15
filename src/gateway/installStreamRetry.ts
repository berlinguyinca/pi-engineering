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
  registerProvider(providerId: string, config: Record<string, unknown>): void;
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
  /** Turn a thrown transport failure into an assistant error message. */
  errorMessage(model: M, error: unknown): RetryableResult;
  /** Read the turn's abort signal off the provider options. */
  signalOf?(options: O | undefined): AbortSignal | undefined;
  maxEscalatedWaitMs?: number;
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

  const base = host.getProvider(target.provider);
  if (!base) return "no-provider";
  // Captured BEFORE registration: this reference reaches the real transport.
  const baseStream = base.streamSimple?.bind(base);
  if (!baseStream) return "no-base-stream";

  const streamSimple = (model: M, context: C, options?: O) => {
    const out = deps.createStream();
    const signal = deps.signalOf?.(options);
    void pumpWithGatewayRetry(() => baseStream(model, context, options), out, {
      hold: (waitSignal, attempt) => deps.hold(waitSignal, attempt, signal),
      ...(deps.onHold ? { onHold: deps.onHold } : {}),
      ...(signal ? { signal } : {}),
      ...(deps.maxEscalatedWaitMs != null ? { maxEscalatedWaitMs: deps.maxEscalatedWaitMs } : {}),
    }).catch((error: unknown) => {
      // A throw that is not gateway backpressure. Pi expects a terminal event,
      // never a rejected promise, so report it the way `lazyStream` does.
      const message = deps.errorMessage(model, error);
      out.push({ type: "error", reason: "error", error: message } as RetryableEvent);
      out.end(message);
    });
    return out;
  };

  // Carry any existing extension config forward: registering replaces it.
  const existing = host.getRegisteredProviderConfig?.(target.provider) ?? {};
  try {
    host.registerProvider(target.provider, { ...existing, api: target.api, streamSimple });
  } catch {
    // A rejected config must not take the session down — the operator keeps
    // Pi's own (shorter) retry rather than losing the provider entirely.
    return "failed";
  }
  installed.add(key);
  return "installed";
}
