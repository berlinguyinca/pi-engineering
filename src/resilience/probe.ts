/**
 * Recovery probe (resilience spec §14).
 *
 * A lightweight health/readiness check — NOT a full prompt re-send. Prefer
 * `GET /health`, `GET /ready`, `GET /v1/models`, or a gateway-specific
 * readiness endpoint. A probe answers: gateway reachable, scheduler available,
 * model resolvable, capacity available, model loading/relocating.
 *
 * The probe is a thin adapter; the MissionSupervisor owns the retry loop around
 * it. Implementations must be fast and must not consume inference quota.
 */

/** Structured probe result. */
export interface ProbeResult {
  healthy: boolean;
  /** Machine-readable readiness reason when unhealthy (e.g. "relocating"). */
  reason?: string;
  /** Gateway-reported scheduler state when known. */
  scheduler_state?: string;
  /** Suggested wait (ms) when the gateway supplies one. */
  retry_after_ms?: number;
  /** True when the probe is authoritative (real health check vs. default). */
  authoritative?: boolean;
}

/** A probe adapter: answer "is the gateway ready for a real request?" */
export interface RecoveryProbe {
  probe(): Promise<ProbeResult>;
}

/** A probe that always reports healthy — used when no real gateway is present. */
export function healthyProbe(): RecoveryProbe {
  return { probe: async () => ({ healthy: true, authoritative: true }) };
}

/**
 * A probe that always reports unhealthy with a fixed reason — useful for
 * fault-injection and for tests.
 */
export function failingProbe(reason = "gateway unavailable"): RecoveryProbe {
  return { probe: async () => ({ healthy: false, reason, authoritative: true }) };
}

/** An HTTP-based probe for a gateway base URL. */
export class HttpRecoveryProbe implements RecoveryProbe {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: {
    baseUrl: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl =
      opts.fetchImpl ?? ((typeof globalThis !== "undefined" ? globalThis.fetch : undefined) as typeof fetch);
    this.now = opts.now ?? (() => Date.now());
  }

  async probe(): Promise<ProbeResult> {
    // InferWeave's /healthz answers 503 "degraded" whenever ANY model lacks
    // workers, so for it an answer at all means the gateway is reachable.
    // The generic endpoints must answer 2xx.
    for (const [path, anyAnswer] of [
      ["/healthz", true],
      ["/ready", false],
      ["/health", false],
      ["/v1/models", false],
    ] as const) {
      const ok = await this.tryEndpoint(path, anyAnswer);
      if (ok) return { healthy: true, authoritative: true };
    }
    return { healthy: false, reason: "gateway readiness endpoints unavailable", authoritative: true };
  }

  private async tryEndpoint(path: string, anyAnswer: boolean): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal });
      await res.body?.cancel().catch(() => {});
      return anyAnswer ? res.status !== 404 : res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Where the catalogue probe asks, and for which model. */
export interface CatalogProbeTarget {
  /** The provider's OpenAI-compatible base URL, e.g. https://llm.example/v1. */
  baseUrl: string;
  /** The client token the gateway requires for /models. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** The mission's model; when set it must be listed (with capacity). */
  modelId?: string;
}

/**
 * The default mission recovery probe: an authenticated `GET {baseUrl}/models`
 * — the same request the model catalogue uses — healthy iff the gateway
 * answers AND lists the mission's model with capacity (`slots` absent or > 0).
 *
 * Unlike a bare health endpoint it answers the question a paused mission has:
 * "can MY model be served again?". An InferWeave `/healthz` reports degraded
 * whenever any model lacks workers, and its `/v1/models` refuses a request
 * without the client token, so an unauthenticated probe never says healthy.
 *
 * The target is resolved on every probe (the routed model can change); an
 * unresolvable target is reported as non-authoritative, which the scheduler
 * never treats as a recovery.
 */
export class CatalogRecoveryProbe implements RecoveryProbe {
  private readonly resolve: () => Promise<CatalogProbeTarget | undefined>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    resolve: () => Promise<CatalogProbeTarget | undefined>;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.resolve = opts.resolve;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  async probe(): Promise<ProbeResult> {
    let target: CatalogProbeTarget | undefined;
    try {
      target = await this.resolve();
    } catch {
      target = undefined;
    }
    if (!target) return { healthy: true, authoritative: false, reason: "no gateway target to probe" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${target.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: {
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
          ...(target.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { healthy: false, reason: `gateway /models answered ${res.status}`, authoritative: true };
      }
      const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
      if (!target.modelId) return { healthy: true, authoritative: true };
      const rows = Array.isArray(body?.data) ? (body.data as Array<Record<string, unknown>>) : [];
      const row = rows.find((r) => r && typeof r === "object" && r.id === target.modelId);
      if (!row) return { healthy: false, reason: `model ${target.modelId} is not served`, authoritative: true };
      if (typeof row.slots === "number" && row.slots <= 0) {
        return { healthy: false, reason: `model ${target.modelId} has no capacity (0 slots)`, authoritative: true };
      }
      return { healthy: true, authoritative: true };
    } catch (err) {
      return {
        healthy: false,
        reason: `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
        authoritative: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The slice of Pi's ModelRuntime the probe target needs. */
export interface ProbeModelRuntime {
  getModel(provider: string, id: string): { baseUrl?: string; id: string } | undefined;
  getAuth(model: never): Promise<{ auth?: { apiKey?: string; headers?: unknown; baseUrl?: string } } | undefined>;
}

/**
 * Resolve the catalogue probe's target from the worker's own ModelRuntime —
 * the same base URL and credentials the model calls use. Undefined when the
 * model is unknown or has no base URL.
 */
export async function resolveCatalogProbeTarget(
  runtime: ProbeModelRuntime,
  ref: { provider: string; id: string },
): Promise<CatalogProbeTarget | undefined> {
  const model = runtime.getModel(ref.provider, ref.id);
  if (!model) return undefined;
  const auth = await runtime.getAuth(model as never).catch(() => undefined);
  const baseUrl = auth?.auth?.baseUrl ?? model.baseUrl;
  if (!baseUrl) return undefined;
  const headers = auth?.auth?.headers;
  return {
    baseUrl,
    ...(auth?.auth?.apiKey ? { apiKey: auth.auth.apiKey } : {}),
    ...(headers && typeof headers === "object" && Object.keys(headers).length > 0
      ? { headers: headers as Record<string, string> }
      : {}),
    modelId: ref.id,
  };
}
