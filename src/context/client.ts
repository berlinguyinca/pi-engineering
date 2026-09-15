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
  private readonly inflight = new Map<string, Promise<ModelCapability | undefined>>();

  constructor(options: CapabilityClientOptions) {
    this.options = { now: () => Math.floor(Date.now() / 1000), ...options };
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
    if (existing) return existing;

    const refresh = this.refresh(modelId, signal).finally(() => this.inflight.delete(modelId));
    this.inflight.set(modelId, refresh);
    return refresh;
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
        this.cache.set(modelId, entry);
        return entry.capability;
      }
      if (result.status >= 200 && result.status < 300 && result.body) {
        const capability = normalizeCapability(result.body);
        // The gateway's own freshness wins; a body that claims nothing fresh is
        // served as-is so the caller can see the staleness rather than a lie.
        this.cache.set(modelId, { capability, etag: result.etag, fetchedAt: this.options.now() });
        return capability;
      }
      if (result.status === 404) {
        // No capability for this id: do not invent one, but do not lose the old
        // value either — the caller's precedence rules decide.
        entry.lastError = "404";
        this.cache.set(modelId, entry);
        return entry.capability;
      }
      throw new CapabilityUnavailableError(modelId, `capability endpoint returned ${result.status}`);
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.cache.set(modelId, entry);
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
