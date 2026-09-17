/**
 * InferWeave capability client for Pi (spec 02).
 *
 * The property that stops this becoming a load problem for the gateway:
 *  - one shared client per process, so N subagents do not mean N pollers;
 *  - single-flight: concurrent callers await the same in-flight refresh;
 *  - ETag/`If-None-Match`, so an unchanged capability generation costs a 304;
 *  - `AbortSignal` is threaded through, so a cancelled Pi turn does not leave a
 *    hanging refresh;
 *  - stale-if-error: a failed refresh keeps serving the last good value, marked
 *    stale, and only the *age* decides when it stops being usable.
 *
 * Transport is injected, so tests and non-HTTP embeds never touch the network.
 */

import {
  type LocalModelOverride,
  type ModelCapability,
  type ResolvedModelContext,
  normalizeCapability,
  resolveModelContext,
} from "./capability.ts";

/**
 * Bound on how many model ids the cache may hold. A gateway that lists a
 * pathological model count must not grow this process without limit; the
 * eviction target is the longest-fetched id (Map insertion order), which is
 * the least likely to be re-requested next.
 */
const MAX_CACHED_MODELS = 1_024;

export interface CapabilityFetchResult {
  status: number;
  etag?: string;
  body?: unknown;
}

export type CapabilityTransport = (
  url: string,
  init: { signal?: AbortSignal; etag?: string },
) => Promise<CapabilityFetchResult>;

export interface CapabilityClientOptions {
  /** Gateway base URL, e.g. `http://100.94.72.5:8787`. */
  baseUrl: string;
  transport: CapabilityTransport;
  /** How long a fresh capability is trusted. */
  ttlSeconds: number;
  /** How long a stale capability may still be served on error. */
  staleIfErrorSeconds: number;
  /** Refresh timeout; the request is aborted, not left dangling. */
  timeoutMs: number;
  now?: () => number;
}

interface InflightRefresh {
  promise: Promise<ModelCapability | undefined>;
  waiters: number;
  controller: AbortController;
}

interface CacheEntry {
  capability?: ModelCapability;
  etag?: string;
  fetchedAt: number;
  lastError?: string;
}

export class CapabilityUnavailableError extends Error {
  readonly modelId: string;

  constructor(modelId: string, message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
    this.modelId = modelId;
  }
}

export class InferWeaveCapabilityClient {
  private readonly options: Required<Pick<CapabilityClientOptions, "now">> & CapabilityClientOptions;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightRefresh>();

  constructor(options: CapabilityClientOptions) {
    // `now` must be defaulted after the spread, and with `??`: a caller that
    // passes `now: undefined` explicitly (which is what an optional dependency
    // looks like) would otherwise overwrite the default with undefined.
    this.options = { ...options, now: options.now ?? (() => Math.floor(Date.now() / 1000)) };
  }

  /** Cache write with a bound: a new id evicts the oldest, an update never does. */
  private storeEntry(modelId: string, entry: CacheEntry): void {
    if (!this.cache.has(modelId) && this.cache.size >= MAX_CACHED_MODELS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(modelId, entry);
  }

  /**
   * Resolve Pi's two numbers for a model. Never throws for a capability we have
   * a usable value for; a network failure degrades to stale-if-error and then
   * to the caller's last-known-good/floor policy inside `resolveModelContext`.
   */
  async resolve(modelId: string, overrides?: LocalModelOverride, signal?: AbortSignal): Promise<ResolvedModelContext> {
    const capability = await this.capability(modelId, signal);
    const entry = this.cache.get(modelId);
    return resolveModelContext(modelId, capability, {
      localOverride: overrides,
      lastKnownGood:
        entry?.capability && entry.capability.guaranteedRoutableTokens !== undefined
          ? {
              contextWindow: entry.capability.guaranteedRoutableTokens,
              maxOutputTokens: entry.capability.maxOutputTokens,
              observedAt: entry.fetchedAt,
              maxAgeSeconds: this.options.staleIfErrorSeconds,
            }
          : undefined,
      now: this.options.now(),
    });
  }

  /** The normalized capability for a model, refreshing when needed. */
  async capability(modelId: string, signal?: AbortSignal): Promise<ModelCapability | undefined> {
    const now = this.options.now();
    const cached = this.cache.get(modelId);
    if (cached?.capability && now - cached.fetchedAt < this.options.ttlSeconds) {
      return cached.capability;
    }
    const existing = this.inflight.get(modelId);
    if (existing) {
      // Joining someone else's refresh. This caller may stop waiting without
      // cancelling work the others still need.
      existing.waiters += 1;
      return this.awaitOrCancel(existing, signal);
    }

    const entry: InflightRefresh = { promise: undefined as never, waiters: 1, controller: new AbortController() };
    const refresh = this.refresh(modelId, entry.controller.signal).finally(() => {
      this.inflight.delete(modelId);
    });
    entry.promise = refresh;
    this.inflight.set(modelId, entry);
    // The fetch dies only when the last caller who cared has gone; one caller
    // giving up must not poison a shared refresh.
    return this.awaitOrCancel(entry, signal, () => entry.controller.abort());
  }

  /**
   * Wait for an in-flight refresh, or resolve with nothing when the caller's
   * signal fires. Stopping the wait is not the same as stopping the fetch:
   * with one shared client per process, a cancelled Pi turn must not take the
   * refresh down with it for everybody else. The fetch is abandoned only when
   * the last waiter leaves, so cancellation still stops work nobody wants.
   */
  private awaitOrCancel(
    entry: InflightRefresh,
    signal: AbortSignal | undefined,
    onLastWaiterLeft?: () => void,
  ): Promise<ModelCapability | undefined> {
    if (!signal) return entry.promise;
    const leave = () => {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters === 0) onLastWaiterLeft?.();
    };
    if (signal.aborted) {
      leave();
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        leave();
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (capability) => {
          signal.removeEventListener("abort", onAbort);
          resolve(capability);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(undefined);
        },
      );
    });
  }

  /** Force a refresh now (Pi's `refreshModels` hook calls this). */
  async refresh(modelId: string, signal?: AbortSignal): Promise<ModelCapability | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort);
    const entry: CacheEntry = this.cache.get(modelId) ?? { fetchedAt: 0 };

    try {
      const result = await this.options.transport(
        `${this.options.baseUrl}/v1/models/${encodeURIComponent(modelId)}/capabilities`,
        {
          signal: controller.signal,
          etag: entry.etag,
        },
      );
      if (result.status === 304 && entry.capability) {
        entry.fetchedAt = this.options.now();
        entry.lastError = undefined;
        this.storeEntry(modelId, entry);
        return entry.capability;
      }
      if (result.status >= 200 && result.status < 300 && result.body) {
        const capability = normalizeCapability(result.body);
        const saysNothing =
          !capability.modelId &&
          capability.guaranteedRoutableTokens === undefined &&
          capability.contextWindow === undefined &&
          capability.maxModelLen === undefined;
        if (saysNothing) {
          // A 200 that says nothing about context is a non-answer, not an
          // answer of "zero": wiping the last-known-good here would turn a
          // flaky gateway response into a floor, on every subsequent call.
          entry.lastError = "200 with no capability fields";
          this.storeEntry(modelId, entry);
          return entry.capability;
        }
        // The gateway's own freshness wins; a body that claims nothing fresh is
        // served as-is so the caller can see the staleness rather than a lie.
        this.storeEntry(modelId, { capability, etag: result.etag, fetchedAt: this.options.now() });
        return capability;
      }
      if (result.status === 404) {
        // No capability for this id: do not invent one, but do not lose the old
        // value either — the caller's precedence rules decide.
        entry.lastError = "404";
        this.storeEntry(modelId, entry);
        return entry.capability;
      }
      throw new CapabilityUnavailableError(modelId, `capability endpoint returned ${result.status}`);
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.storeEntry(modelId, entry);
      // Stale-if-error: hand back what we have, marked by its age. The resolver
      // turns an expired value into an override-or-floor decision.
      if (entry.capability) {
        const age = this.options.now() - entry.fetchedAt;
        const freshness = age <= this.options.staleIfErrorSeconds ? "stale_usable" : "expired";
        return { ...entry.capability, freshness };
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * The cached capability as a last-known-good candidate, without triggering a
   * refresh. A stale-but-known number beats a floor when it is inside the age
   * bound, and the age bound is the caller's to decide.
   */
  peekLastKnownGood(
    modelId: string,
  ): { contextWindow: number; maxOutputTokens?: number; observedAt: number; maxAgeSeconds: number } | undefined {
    const entry = this.cache.get(modelId);
    const guarantee = entry?.capability?.guaranteedRoutableTokens;
    if (!entry || guarantee === undefined) return undefined;
    return {
      contextWindow: guarantee,
      maxOutputTokens: entry.capability?.maxOutputTokens,
      observedAt: entry.fetchedAt,
      maxAgeSeconds: this.options.staleIfErrorSeconds,
    };
  }

  /** Drop cached state (used by tests and on gateway reconfiguration). */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /** Cheap diagnostic view, safe to render. */
  inspect(): Array<{
    modelId: string;
    ageSeconds: number;
    etag?: string;
    lastError?: string;
    capability?: ModelCapability;
  }> {
    const now = this.options.now();
    return [...this.cache.entries()].map(([modelId, entry]) => ({
      modelId,
      ageSeconds: now - entry.fetchedAt,
      etag: entry.etag,
      lastError: entry.lastError,
      capability: entry.capability,
    }));
  }
}

/**
 * Build the model list Pi should expose for a gateway, using the guaranteed
 * routable window (never the largest window any backend happens to have).
 */
export function modelsFromListing(
  listing: unknown,
  resolve: (modelId: string, capability: ModelCapability) => ResolvedModelContext,
): Array<{ id: string; contextWindow: number; maxTokens: number }> {
  const data = (listing && typeof listing === "object" ? (listing as { data?: unknown }).data : undefined) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(data)) return [];
  const models: Array<{ id: string; contextWindow: number; maxTokens: number }> = [];
  for (const entry of data) {
    const capability = normalizeCapability(entry);
    if (!capability.modelId) continue;
    const resolved = resolve(capability.modelId, capability);
    models.push({ id: capability.modelId, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens });
  }
  return models;
}
