/**
 * InferWeave provider integration for Pi (spec 02).
 *
 * Uses Pi's supported dynamic-provider surface — `pi.registerProvider(name, {
 * refreshModels })` — so nothing in Pi core is patched. The shape of the
 * integration:
 *
 *  - `refreshModels` reads the gateway's model listing and each model's
 *    capability document, and hands Pi `contextWindow` = guaranteed routable
 *    context and `maxTokens` = advertised output maximum;
 *  - one shared `CapabilityClient` per process, so a fan-out of subagents does
 *    not become a stampede on `/v1/models`;
 *  - refresh is bounded by a timeout and the caller's `signal`, revalidates with
 *    an ETag, and serves stale-if-error inside the configured age bound;
 *  - a model the gateway says nothing about keeps the conservative floor rather
 *    than a made-up 260K.
 */

import {
  CONSERVATIVE_FALLBACK_CONTEXT,
  type LocalModelOverride,
  type ModelCapability,
  type ResolvedModelContext,
  normalizeCapability,
  resolveModelContext,
} from "./capability.ts";
import {
  type CapabilityFetchResult,
  type CapabilityTransport,
  CapabilityUnavailableError,
  InferWeaveCapabilityClient,
  modelsFromListing,
} from "./client.ts";

export interface InferweaveConfig {
  enabled: boolean;
  /** Gateway base URL including the `/v1` suffix, e.g. `http://gw:8787/v1`. */
  baseUrl: string;
  /** Provider id to register (Pi shows this in /model). */
  providerName: string;
  /** API key literal or env reference; the gateway may not require one. */
  apiKey: string;
  ttlSeconds: number;
  staleIfErrorSeconds: number;
  timeoutMs: number;
  /**
   * Cap on per-model capability lookups during one `refreshModels`, so a
   * gateway that lists 40 models without publishing capabilities cannot turn a
   * refresh into 40 requests.
   */
  maxCapabilityLookups: number;
  /** Explicit per-model windows; unsafe expansions need the flag. */
  overrides: Record<string, LocalModelOverride>;
}

export const DEFAULT_INFERWEAVE_CONFIG: InferweaveConfig = {
  enabled: false,
  baseUrl: "",
  providerName: "inferweave",
  apiKey: "inferweave",
  ttlSeconds: 300,
  staleIfErrorSeconds: 3_600,
  timeoutMs: 5_000,
  maxCapabilityLookups: 8,
  overrides: {},
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function int(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * `INFERWEAVE_BASE_URL` enables the integration; leaving it unset keeps the
 * harness inert, which is the safe default for anyone not running a gateway.
 *
 * `INFERWEAVE_MODEL_CONTEXT` is the operator override list, formatted
 * `model=context[:maxOutput[:unsafe]]`, comma-separated.
 */
export function inferweaveConfigFromEnv(env: Record<string, string | undefined> = process.env): InferweaveConfig {
  const base = DEFAULT_INFERWEAVE_CONFIG;
  // The base URL is the gateway ROOT. Operators write it both ways — the
  // OpenAI habit appends /v1 — so strip a trailing /v1 here and let the
  // request paths carry it explicitly. Without this, one spelling works the
  // listing and breaks the capability document, and the other the reverse.
  const baseUrl = (env.INFERWEAVE_BASE_URL ?? base.baseUrl).trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return {
    enabled: baseUrl.length > 0 && bool(env.INFERWEAVE_ENABLED, true),
    baseUrl,
    providerName: (env.INFERWEAVE_PROVIDER ?? base.providerName).trim() || base.providerName,
    apiKey: (env.INFERWEAVE_API_KEY ?? base.apiKey).trim(),
    ttlSeconds: int(env.INFERWEAVE_TTL_SECONDS, base.ttlSeconds),
    staleIfErrorSeconds: int(env.INFERWEAVE_STALE_SECONDS, base.staleIfErrorSeconds),
    timeoutMs: int(env.INFERWEAVE_TIMEOUT_MS, base.timeoutMs),
    maxCapabilityLookups: int(env.INFERWEAVE_MAX_CAPABILITY_LOOKUPS, base.maxCapabilityLookups),
    overrides: parseOverrides(env.INFERWEAVE_MODEL_CONTEXT),
  };
}

export function parseOverrides(raw: string | undefined): Record<string, LocalModelOverride> {
  const overrides: Record<string, LocalModelOverride> = {};
  if (!raw) return overrides;
  for (const entry of raw.split(",")) {
    // Two spellings are accepted, because operators write both:
    //   model:262144:32768:unsafe   and   model=262144:32768:unsafe
    // Whitespace around any field is tolerated. A malformed entry is skipped
    // whole, never half-applied: a dropped "unsafe" flag would silently turn
    // an unsafe override into a rejected one (or the reverse).
    const fields = entry
      .split(/[=:]/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const [modelId, windowRaw, outputRaw, flag] = fields;
    const contextWindow = Number(windowRaw);
    if (!modelId || !Number.isFinite(contextWindow) || contextWindow < 1_024) continue;
    overrides[modelId] = {
      modelId,
      contextWindow: Math.floor(contextWindow),
      maxOutputTokens: Number.isFinite(Number(outputRaw)) ? Math.floor(Number(outputRaw)) : undefined,
      allowUnsafeOverride: flag === "unsafe",
    };
  }
  return overrides;
}

/** `fetch`-backed transport with ETag revalidation and abort support. */
export const httpTransport: CapabilityTransport = async (url, init) => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.etag) headers["if-none-match"] = init.etag;
  const response = await fetch(url, { headers, signal: init.signal });
  if (response.status === 304) return { status: 304, etag: response.headers.get("etag") ?? init.etag ?? undefined };
  if (!response.ok) return { status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: response.status };
  }
  return { status: response.status, etag: response.headers.get("etag") ?? undefined, body };
};

/** The Pi model definition shape (subset Pi requires for a provider model). */
export interface PiModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface InferweaveProvider {
  config: InferweaveConfig;
  client: InferWeaveCapabilityClient;
  /** The payload for `pi.registerProvider(name, payload)`. */
  registration: {
    name: string;
    baseUrl: string;
    api: string;
    apiKey: string;
    refreshModels: (context: { signal?: AbortSignal }) => Promise<PiModelDefinition[]>;
  };
  /** The resolved window for a model id, for the status bar and diagnostics. */
  windowFor(modelId: string | undefined): { windowTokens: number; note?: string } | undefined;
  resolved(modelId: string): ResolvedModelContext | undefined;
  diagnostics(modelId?: string): string[];
}

export interface ProviderDeps {
  transport?: CapabilityTransport;
  now?: () => number;
}

/**
 * Build the provider registration plus the resolved-capability view the status
 * bar and `/iw-context` read. `refreshModels` is Pi's own refresh hook; it never
 * throws — a gateway outage yields the floor window with a recorded error, which
 * keeps Pi's model list usable instead of empty.
 */
export function createInferweaveProvider(config: InferweaveConfig, deps: ProviderDeps = {}): InferweaveProvider {
  const transport = deps.transport ?? httpTransport;
  const client = new InferWeaveCapabilityClient({
    baseUrl: config.baseUrl,
    transport,
    ttlSeconds: config.ttlSeconds,
    staleIfErrorSeconds: config.staleIfErrorSeconds,
    timeoutMs: config.timeoutMs,
    now: deps.now,
  });
  const resolvedById = new Map<string, ResolvedModelContext>();
  const definitionsById = new Map<string, PiModelDefinition>();
  const notes = new Map<string, string>();

  const remember = (resolved: ResolvedModelContext): PiModelDefinition => {
    resolvedById.set(resolved.modelId, resolved);
    if (resolved.stale) notes.set(resolved.modelId, "stale capability");
    else if (resolved.basis === "local_override")
      notes.set(resolved.modelId, (resolved.warnings[0] ?? "override").slice(0, 60));
    else if (resolved.basis === "conservative_fallback") notes.set(resolved.modelId, "fallback window");
    else notes.delete(resolved.modelId);
    const definition: PiModelDefinition = {
      id: resolved.modelId,
      name: resolved.modelId,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: resolved.contextWindow,
      maxTokens: resolved.maxTokens,
    };
    definitionsById.set(resolved.modelId, definition);
    return definition;
  };

  const refreshModels = async ({ signal }: { signal?: AbortSignal }): Promise<PiModelDefinition[]> => {
    const listingUrl = `${config.baseUrl}/v1/models`;
    let listing: CapabilityFetchResult;
    try {
      listing = await transport(listingUrl, { signal });
    } catch (error) {
      notes.set("*", `listing refresh failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120));
      return [...definitionsById.values()];
    }
    if (listing.status >= 400 || !listing.body) {
      notes.set("*", `listing returned ${listing.status}`);
      return [...definitionsById.values()];
    }

    // The listing itself carries the capability extension; per-model documents
    // are fetched only for ids the listing did not describe, so a normal refresh
    // is one request.
    const data = (listing.body as { data?: unknown[] }).data ?? [];
    const models: PiModelDefinition[] = [];
    // A gateway listing that carries no capability anywhere would otherwise
    // turn one refresh into one request per model. The budget bounds that: the
    // ids it lists are still registered, on the precedence floor rather than on
    // a discovered number, and the note says so instead of hiding it.
    let lookups = config.maxCapabilityLookups;
    for (const entry of data) {
      const capability = normalizeCapability(entry);
      if (!capability.modelId) continue;
      let full = capability;
      // A document is fetched only when the listing says nothing at all about
      // context. `context_window` alone is already rule 2 of the precedence, so
      // fetching a document for it would be a second request for an answer that
      // is good enough — and one request per listed model per refresh is exactly
      // the stampede this client exists to avoid.
      const saysNothing =
        capability.guaranteedRoutableTokens === undefined &&
        capability.contextWindow === undefined &&
        capability.maxModelLen === undefined;
      if (saysNothing) {
        if (lookups > 0) {
          lookups -= 1;
          const fetched = await client.capability(capability.modelId, signal);
          if (fetched) full = fetched;
        } else if (!notes.has("lookups")) {
          notes.set(
            "lookups",
            `capability lookups capped at ${config.maxCapabilityLookups}; remaining ids use the floor`,
          );
        }
      }
      models.push(
        remember(
          resolveModelContext(capability.modelId, full, {
            localOverride: config.overrides[capability.modelId],
            lastKnownGood: client.peekLastKnownGood(capability.modelId),
          }),
        ),
      );
    }
    return models.length > 0 ? models : modelsFromListingFallback(data, config);
  };

  const modelsFromListingFallback = (data: unknown[], cfg: InferweaveConfig): PiModelDefinition[] =>
    modelsFromListing({ data }, (modelId, capability: ModelCapability) =>
      resolveModelContext(modelId, capability, { localOverride: cfg.overrides[modelId] }),
    ).map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));

  return {
    config,
    client,
    registration: {
      name: config.providerName,
      baseUrl: config.baseUrl,
      api: "openai-completions",
      apiKey: config.apiKey,
      refreshModels,
    },
    windowFor(modelId) {
      if (!modelId) return undefined;
      const resolved = resolvedById.get(modelId);
      if (!resolved) return undefined;
      return { windowTokens: resolved.contextWindow, note: notes.get(modelId) };
    },
    resolved: (modelId) => resolvedById.get(modelId),
    diagnostics(modelId) {
      const lines: string[] = [];
      lines.push(`InferWeave gateway: ${config.baseUrl || "(not configured)"}`);
      lines.push(
        `refresh: ttl=${config.ttlSeconds}s stale-if-error=${config.staleIfErrorSeconds}s timeout=${config.timeoutMs}ms`,
      );
      if (notes.size > 0) {
        for (const [id, note] of notes) lines.push(`${id === "*" ? "listing" : id}: ${note}`);
      }
      const ids = modelId ? [modelId] : [...resolvedById.keys()];
      for (const id of ids) {
        const resolved = resolvedById.get(id);
        if (!resolved) {
          lines.push(`${id}: no resolved capability (floor ${CONSERVATIVE_FALLBACK_CONTEXT} would apply)`);
          continue;
        }
        lines.push(
          `${id}: window=${resolved.contextWindow} (${resolved.basis}) maxTokens=${resolved.maxTokens} ` +
            `generation=${resolved.generation ?? "unknown"} source=${resolved.source} ` +
            `freshness=${resolved.freshness}${resolved.heterogeneous ? " heterogeneous" : ""}`,
        );
        for (const warning of resolved.warnings) lines.push(`  ! ${warning}`);
      }
      for (const entry of client.inspect()) {
        lines.push(
          `cache ${entry.modelId}: age=${entry.ageSeconds}s etag=${entry.etag ?? "-"}${entry.lastError ? ` lastError=${entry.lastError}` : ""}`,
        );
      }
      return lines;
    },
  };
}

export { CapabilityUnavailableError };
