/**
 * Live model readiness, cached.
 *
 * The gateway's `/models` response carries the two facts that explain a
 * `503 no worker for model` better than any retry counter can:
 *
 *   "x_state": "warm", "slots": 9
 *
 * A model with no free slots is precisely the one that refuses. Both the
 * fallback ranking and `/gateway` want that, and neither should pay for an HTTP
 * round trip per question — a fallback check runs on every hold, and holds
 * arrive in bursts exactly when the gateway is least able to answer extra
 * requests.
 *
 * So readiness is cached with a short TTL and, critically, **a failure is
 * cached as "unknown" rather than retried**: when the gateway is saturated, the
 * health probe is the first thing to fail, and a probe that retries hard under
 * saturation adds load to the problem it is describing.
 */

import { type GatewayModelEntry, fetchGatewayModels } from "./gatewayCatalog.ts";

export interface ModelHealth {
  state?: string;
  slots?: number;
}

export interface HealthProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** How long a reading stays good. Short: this is a liveness signal. */
  ttlMs?: number;
  /** How long to wait before probing again after a failure. */
  errorBackoffMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_HEALTH_TTL_MS = 30_000;
export const DEFAULT_HEALTH_ERROR_BACKOFF_MS = 60_000;

/**
 * Readiness by model id, refreshed on demand and at most once per TTL.
 *
 * `get()` never throws and never blocks on a second in-flight probe: callers
 * are on a latency-sensitive path and an unknown reading is a usable answer
 * (see `isHealthy` — unknown counts as healthy).
 */
export class ModelHealthProvider {
  private readonly opts: HealthProviderOptions;
  private readonly now: () => number;
  private cache = new Map<string, ModelHealth>();
  private freshUntil = 0;
  private inFlight: Promise<void> | undefined;

  constructor(opts: HealthProviderOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Cached readiness for a model. Empty when nothing is known. */
  get(modelId: string): ModelHealth {
    return this.cache.get(modelId) ?? {};
  }

  /** Every cached reading, for reporting. */
  all(): ReadonlyMap<string, ModelHealth> {
    return this.cache;
  }

  /** Whether the current readings are still within their TTL. */
  isFresh(): boolean {
    return this.now() < this.freshUntil;
  }

  /**
   * Refresh if stale. Resolves when readings are as current as they are going
   * to get; never rejects.
   */
  async refresh(): Promise<void> {
    if (this.isFresh()) return;
    // Coalesce: a burst of holds must produce one probe, not one each.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probe(): Promise<void> {
    try {
      const entries = await fetchGatewayModels({
        baseUrl: this.opts.baseUrl,
        ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
        ...(this.opts.headers ? { headers: this.opts.headers } : {}),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      const next = new Map<string, ModelHealth>();
      for (const entry of entries) next.set(entry.id, healthOf(entry));
      this.cache = next;
      this.freshUntil = this.now() + (this.opts.ttlMs ?? DEFAULT_HEALTH_TTL_MS);
    } catch {
      // Back off rather than retry: under saturation this probe is the first
      // thing to fail, and hammering it adds load to the problem it describes.
      // Existing readings are kept — stale readiness beats none.
      this.freshUntil = this.now() + (this.opts.errorBackoffMs ?? DEFAULT_HEALTH_ERROR_BACKOFF_MS);
    }
  }
}

function healthOf(entry: GatewayModelEntry): ModelHealth {
  return {
    ...(entry.state !== undefined ? { state: entry.state } : {}),
    ...(entry.slots !== undefined ? { slots: entry.slots } : {}),
  };
}
