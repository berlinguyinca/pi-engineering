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
  /**
   * The gateway answered but does not list the mission's model. Unlike an
   * outage this may never clear (the model was removed) or may not matter (a
   * legacy alias that still routes), so the scheduler lets a verification
   * attempt through after a few of these rather than waiting forever.
   */
  model_unlisted?: boolean;
  /** The model the probe asked about, when it resolved one. */
  model_id?: string;
  /** That model's provider, when known. */
  model_provider?: string;
}

/** A probe adapter: answer "is the gateway ready for a real request?" */
export interface RecoveryProbe {
  probe(): Promise<ProbeResult>;
  /**
   * Optional: the scheduler found a model unavailable (an attempt let through
   * for an unlisted model still failed). A routing-aware probe records it so
   * its next target, and the next attempt, move to another model.
   */
  reportModelUnavailable?(
    model: { provider: string; id: string },
    context: { missionId?: string; taskId?: string; reason: string },
  ): void;
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
  /** The model's provider, reported with an unlisted answer. */
  provider?: string;
}

/**
 * The default mission recovery probe: an authenticated `GET {baseUrl}/models`
 * — the same request the model catalogue uses — followed by InferWeave's
 * read-only `/iw/v1/admission` report. Catalogue `slots` is a configured
 * ceiling, not remaining capacity. Recovery needs a matching model report.
 * Both the Go model-keyed report and Rust model-array report are supported.
 * Immediate model-level headroom permits a retry; caller/global admission can
 * still refuse it. Plain OpenAI catalogues retain their availability check.
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
      const headers = {
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        ...(target.headers ?? {}),
      };
      const res = await this.fetchImpl(`${target.baseUrl.replace(/\/+$/, "")}/models`, {
        headers,
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
      if (!row) {
        return {
          healthy: false,
          reason: `model ${target.modelId} is not served`,
          authoritative: true,
          model_unlisted: true,
          model_id: target.modelId,
          ...(target.provider ? { model_provider: target.provider } : {}),
        };
      }
      if (typeof row.slots === "number" && row.slots <= 0) {
        return { healthy: false, reason: `model ${target.modelId} has no capacity (0 slots)`, authoritative: true };
      }
      // InferWeave concrete rows identify their owner and advertise slots;
      // route rows can omit slots. Keep ordinary OpenAI providers independent
      // of this optional adapter, while never interpreting an IW ceiling as free.
      const hasAdmissionReport =
        target.provider === "inferweave" ||
        row.owned_by === "inferweave" ||
        "slots" in row ||
        "x_state" in row ||
        "x_alias" in row;
      if (!hasAdmissionReport) return { healthy: true, authoritative: true };
      const unknownCapacity: ProbeResult = {
        healthy: false,
        authoritative: false,
        reason: `model ${target.modelId} capacity unknown: no valid model-level admission report`,
      };
      // /iw is a sibling of /v1, including for gateways mounted under a prefix.
      const admissionUrl = `${target.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/iw/v1/admission`;
      const admission = await this.fetchImpl(admissionUrl, { headers, signal: controller.signal });
      if (!admission.ok) {
        await admission.body?.cancel().catch(() => {});
        return unknownCapacity;
      }
      const report = (await admission.json().catch(() => null)) as { models?: unknown } | null;
      if (report && !Array.isArray(report.models) && typeof report.models === "object") {
        return goAdmissionReadiness(report as Record<string, unknown>, target.modelId, row, rows);
      }
      const models = Array.isArray(report?.models) ? (report.models as Array<Record<string, unknown>>) : [];
      const measured = models.find(
        (m) =>
          m &&
          typeof m === "object" &&
          (m.model === target.modelId || (Array.isArray(m.aliases) && m.aliases.includes(target.modelId))),
      );
      const count = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      if (
        !measured ||
        !count(measured.ceiling) ||
        !count(measured.active) ||
        !count(measured.queued) ||
        !count(measured.queueCapacity)
      ) {
        return unknownCapacity;
      }
      const directHeadroom = measured.queued === 0 && measured.active < measured.ceiling;
      if (!directHeadroom) {
        return {
          healthy: false,
          authoritative: true,
          reason:
            measured.queueCapacity > 0 && measured.queued >= measured.queueCapacity
              ? `model ${target.modelId} queue full (${measured.queued}/${measured.queueCapacity})`
              : `model ${target.modelId} has no immediate model-level capacity (${measured.active}/${measured.ceiling} active, ${measured.queued} queued)`,
        };
      }
      return {
        healthy: true,
        authoritative: true,
        reason: `model ${target.modelId} has model-level active headroom; caller admission is not reported`,
      };
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

/** Read the deployed Go gateway's model-keyed admission snapshot. */
function goAdmissionReadiness(
  report: Record<string, unknown>,
  modelId: string,
  catalogRow: Record<string, unknown>,
  catalog: Array<Record<string, unknown>>,
): ProbeResult {
  const unknown: ProbeResult = {
    healthy: false,
    authoritative: false,
    reason: `model ${modelId} capacity unknown: no fresh known model-level admission report`,
  };
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (report.enabled !== true || typeof report.closed !== "boolean") return unknown;
  if (report.closed) return { healthy: false, authoritative: true, reason: "gateway admission is closed" };
  const models = object(report.models);
  if (!models) return unknown;
  const candidates = new Set([modelId]);
  if (typeof catalogRow.x_backing_model === "string") candidates.add(catalogRow.x_backing_model);
  for (const row of catalog) {
    if (row && typeof row.id === "string" && Array.isArray(row.x_aliases) && row.x_aliases.includes(modelId)) {
      candidates.add(row.id);
    }
  }
  const matching = [...candidates].filter((id) => Object.hasOwn(models, id));
  if (matching.length !== 1) return unknown;
  const canonical = matching[0]!;
  const measured = object(models[canonical]);
  if (!measured || measured.capacity_known !== true) return unknown;
  // The Go gateway itself rejects observations aged 90 seconds or in the future.
  // `capacity_updated_at` is the oldest constituent sample, not report generation.
  const updated =
    typeof measured.capacity_updated_at === "string" ? Date.parse(measured.capacity_updated_at) : Number.NaN;
  const age = Date.now() - updated;
  if (!Number.isFinite(age) || age < 0 || age >= 90_000) return unknown;
  if (
    !count(measured.capacity) ||
    !count(measured.available) ||
    measured.available > measured.capacity ||
    !count(measured.active) ||
    !count(measured.queued) ||
    !count(measured.active_limit) ||
    !count(measured.queue_limit)
  ) {
    return unknown;
  }
  // Idle model rows can carry zero placeholder policy limits. Diagnostics,
  // when present, supplies the effective policy independently of live entries.
  const diagnostics = object(report.diagnostics);
  const policy = object(diagnostics?.policy);
  const overrides = object(policy?.model_overrides);
  const modelPolicy = object(overrides?.[canonical]) ?? object(policy?.model_default);
  const activeLimit = count(modelPolicy?.active) && modelPolicy.active > 0 ? modelPolicy.active : measured.active_limit;
  if (activeLimit === 0 && measured.active > 0) return unknown;
  const global = object(object(policy?.scope_limits)?.global);
  if (
    count(global?.active) &&
    global.active > 0 &&
    count(report.active) &&
    report.active + (count(report.selecting) ? report.selecting : 0) >= global.active
  ) {
    return { healthy: false, authoritative: true, reason: "gateway global active admission limit is occupied" };
  }
  if (measured.queued > 0 || measured.available === 0 || (activeLimit > 0 && measured.active >= activeLimit)) {
    return {
      healthy: false,
      authoritative: true,
      reason:
        measured.queue_limit > 0 && measured.queued >= measured.queue_limit
          ? `model ${modelId} queue full (${measured.queued}/${measured.queue_limit})`
          : `model ${modelId} has no immediate model-level capacity (${measured.available} available, ${measured.queued} queued)`,
    };
  }
  return {
    healthy: true,
    authoritative: true,
    reason: `model ${modelId} has model-level active headroom; caller admission is not reported`,
  };
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
    provider: ref.provider,
  };
}
