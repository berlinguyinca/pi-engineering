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
    // Try the readiness endpoints in preference order.
    for (const path of ["/ready", "/health", "/v1/models"]) {
      const ok = await this.tryEndpoint(path);
      if (ok) return { healthy: true, authoritative: true };
    }
    return { healthy: false, reason: "gateway readiness endpoints unavailable", authoritative: true };
  }

  private async tryEndpoint(path: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
