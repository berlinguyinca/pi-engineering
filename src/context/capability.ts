/**
 * InferWeave model-capability client core for Pi (spec 02, spec 05).
 *
 * Pi needs two numbers per model — `contextWindow` and `maxTokens` — and the
 * only trustworthy source for a gateway-served model is the gateway itself:
 * InferWeave aggregates what its backends actually serve, and vLLM reports the
 * effective `max_model_len` of a running deployment. This module is the pure
 * decision half of that integration:
 *
 *  - normalize a gateway model record / capability document,
 *  - resolve `contextWindow` through the spec's precedence,
 *  - never invent a large window: the conservative floor is 128 000 and there
 *    is deliberately no 260K fallback, because that number came from an
 *    admission implementation, not from any model.
 *
 * The I/O half (`client.ts`) does fetch + ETag + single-flight; keeping this
 * half pure means the safety-critical precedence is testable without a network.
 */

/** Conservative floor when nothing trustworthy is known (spec 05). Never 260K. */
export const CONSERVATIVE_FALLBACK_CONTEXT = 128_000;
/** Conservative output floor when the gateway does not advertise an output cap. */
export const CONSERVATIVE_MAX_OUTPUT = 8_192;
/** Numbers that must never appear as a fallback anywhere in this stack. */
export const FORBIDDEN_FALLBACK_CONTEXTS: readonly number[] = [260_000, 262_144];

export type CapabilityFreshness = "fresh" | "stale_usable" | "expired" | "unsupported";

/** A capability as far as this module is concerned: numbers plus provenance. */
export interface ModelCapability {
  modelId: string;
  /** Largest window guaranteed routable across every advertised backend. */
  guaranteedRoutableTokens?: number;
  /** Largest window any single backend can serve. Never used as contextWindow. */
  maxRoutableTokens?: number;
  contextWindow?: number;
  maxModelLen?: number;
  maxOutputTokens?: number;
  theoreticalModelMaxTokens?: number;
  heterogeneous?: boolean;
  generation?: string;
  source?: string;
  observedAt?: number;
  freshness?: CapabilityFreshness;
  /** True when the deployment set has more than one effective context size. */
  warnings: string[];
}

/** An operator's explicit local statement about a model. */
export interface LocalModelOverride {
  modelId: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Required to use a value above the gateway guarantee (spec 02). */
  allowUnsafeOverride?: boolean;
}

export interface ResolvedModelContext {
  modelId: string;
  /** The value to give Pi as `contextWindow`. */
  contextWindow: number;
  /** The value to give Pi as `maxTokens`. */
  maxTokens: number;
  /** Which rule produced the window — shown in diagnostics. */
  basis:
    | "guaranteed_routable_tokens"
    | "context_window"
    | "max_model_len"
    | "local_override"
    | "last_known_good"
    | "conservative_fallback";
  source: string;
  freshness: CapabilityFreshness;
  stale: boolean;
  heterogeneous: boolean;
  generation?: string;
  warnings: string[];
}

function asFiniteInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** Pick the first integer-valued field among `keys`, searching nested paths. */
function firstInt(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const direct = asFiniteInt(source[key]);
    if (direct !== undefined) return direct;
  }
  for (const nestedKey of ["inferweave", "capabilities", "capability"]) {
    const nested = source[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = firstInt(nested as Record<string, unknown>, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function str(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function bool(source: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const v = source[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

function freshnessOf(value: string | undefined): CapabilityFreshness | undefined {
  return value === "fresh" || value === "stale_usable" || value === "expired" || value === "unsupported"
    ? value
    : undefined;
}

/**
 * Normalize one entry of a gateway `/v1/models` response or one capability
 * document. Unknown/invalid fields are ignored rather than trusted, and an
 * entry with no usable context is returned with `warnings` explaining why —
 * callers then decide whether to keep an old value or use the floor.
 */
export function normalizeCapability(entry: unknown): ModelCapability {
  const warnings: string[] = [];
  const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  const extension = (record.inferweave && typeof record.inferweave === "object" ? record.inferweave : record) as Record<
    string,
    unknown
  >;

  const modelId = str(record, ["id", "model", "model_id", "name"]) ?? str(extension, ["model_id", "model"]) ?? "";
  const guaranteed = firstInt(extension, ["guaranteed_routable_tokens", "guaranteed_context_tokens"]);
  const contextWindow = firstInt(record, ["context_window", "x_context_window", "max_context_length"]);
  const maxModelLen = firstInt(record, ["max_model_len"]);
  const maxOutput =
    firstInt(extension, ["max_output_tokens"]) ?? firstInt(record, ["max_output_tokens", "max_tokens", "x_max_tokens"]);
  const theoretical = firstInt(extension, ["theoretical_model_max_tokens", "model_max_context_tokens"]);
  const heterogeneous = bool(extension, ["heterogeneous"]);

  for (const key of ["context_window", "max_model_len", "guaranteed_routable_tokens"]) {
    const raw = record[key] ?? extension[key];
    if (raw !== undefined && asFiniteInt(raw) === undefined) {
      warnings.push(`ignored non-integer ${key}`);
    }
  }

  const derivedMaxRoutable =
    firstInt(extension, ["max_routable_tokens"]) ??
    Math.max(...[guaranteed ?? 0, contextWindow ?? 0, maxModelLen ?? 0, theoretical ?? 0]);

  if (guaranteed === undefined && contextWindow === undefined && maxModelLen === undefined) {
    warnings.push("no context capability present");
  }

  return {
    modelId,
    guaranteedRoutableTokens: guaranteed,
    maxRoutableTokens: derivedMaxRoutable > 0 ? derivedMaxRoutable : undefined,
    contextWindow,
    maxModelLen,
    maxOutputTokens: maxOutput,
    theoreticalModelMaxTokens: theoretical,
    heterogeneous: heterogeneous ?? false,
    generation: str(extension, ["capability_generation", "generation"]) ?? str(record, ["capability_generation"]),
    source:
      str(extension, ["capability_source", "source"]) ??
      (maxModelLen !== undefined
        ? "openai:max_model_len"
        : contextWindow !== undefined
          ? "openai:context_window"
          : "unknown"),
    observedAt: firstInt(extension, ["last_observed_at", "observed_at"]),
    freshness: freshnessOf(str(extension, ["freshness"])),
    warnings,
  };
}

/**
 * Resolve the two numbers Pi needs, in the precedence the spec fixes
 * (guaranteed routable > context_window > max_model_len > explicit local
 * override > fresh last-known-good > conservative floor).
 *
 * Rules that matter:
 *  - an expired capability may not raise the window: it is served marked stale,
 *    and a stale value is only used when it is the freshest thing we have;
 *  - a local override above the gateway guarantee is refused (and the guarantee
 *    is used) unless `allowUnsafeOverride` is set explicitly;
 *  - the floor is 128 000, never 260 000 / 262 144;
 *  - `maxTokens` is clamped so `contextWindow` cannot be pushed past itself.
 */
export function resolveModelContext(
  modelId: string,
  capability: ModelCapability | undefined,
  options: {
    localOverride?: LocalModelOverride;
    lastKnownGood?: { contextWindow: number; maxOutputTokens?: number; observedAt: number; maxAgeSeconds: number };
    now?: number;
  } = {},
): ResolvedModelContext {
  const warnings: string[] = [];
  const freshness: CapabilityFreshness = capability?.freshness ?? "unsupported";
  const expired = freshness === "expired";
  const stale = freshness === "stale_usable" || expired;
  const source = capability?.source ?? "none";

  const guarantee = capability && !expired ? capability.guaranteedRoutableTokens : undefined;
  if (capability && expired && capability.guaranteedRoutableTokens !== undefined) {
    warnings.push("capability expired; its context value may not expand the window");
  }

  let contextWindow: number | undefined;
  let basis: ResolvedModelContext["basis"] | undefined;

  if (guarantee !== undefined) {
    contextWindow = guarantee;
    basis = "guaranteed_routable_tokens";
  } else if (capability?.contextWindow !== undefined && !expired) {
    contextWindow = capability.contextWindow;
    basis = "context_window";
  } else if (capability?.maxModelLen !== undefined && !expired) {
    contextWindow = capability.maxModelLen;
    basis = "max_model_len";
  }

  const override = options.localOverride;
  if (override) {
    if (contextWindow === undefined) {
      contextWindow = override.contextWindow;
      basis = "local_override";
    } else if (override.contextWindow > contextWindow) {
      if (override.allowUnsafeOverride) {
        warnings.push(
          `unsafe override: using ${override.contextWindow} tokens above the guaranteed ${contextWindow}; routability is now the operator's claim`,
        );
        contextWindow = override.contextWindow;
        basis = "local_override";
      } else {
        warnings.push(
          `local override ${override.contextWindow} exceeds guaranteed ${contextWindow}; ignored until allowUnsafeOverride is set`,
        );
      }
    } else {
      // A smaller override is always safe: it can only refuse more, never route
      // an impossible request.
      contextWindow = override.contextWindow;
      basis = "local_override";
    }
  }

  if (contextWindow === undefined) {
    const lkg = options.lastKnownGood;
    if (lkg) {
      const age = Math.max(0, (options.now ?? Math.floor(Date.now() / 1000)) - lkg.observedAt);
      if (age <= lkg.maxAgeSeconds) {
        contextWindow = lkg.contextWindow;
        basis = "last_known_good";
        warnings.push(`using last-known-good ${lkg.contextWindow} tokens (age ${age}s)`);
      } else {
        warnings.push(`last-known-good value is ${age}s old, past the ${lkg.maxAgeSeconds}s bound`);
      }
    }
  }

  if (contextWindow === undefined) {
    contextWindow = CONSERVATIVE_FALLBACK_CONTEXT;
    basis = "conservative_fallback";
    warnings.push(`no trustworthy capability; using the ${CONSERVATIVE_FALLBACK_CONTEXT} token floor`);
  }

  if (FORBIDDEN_FALLBACK_CONTEXTS.includes(contextWindow) && basis === "conservative_fallback") {
    // Defensive: a floor must never come from the retired admission number.
    contextWindow = CONSERVATIVE_FALLBACK_CONTEXT;
  }

  const advertisedOutput =
    capability?.maxOutputTokens ?? (basis === "local_override" ? override?.maxOutputTokens : undefined);
  let maxTokens = advertisedOutput ?? CONSERVATIVE_MAX_OUTPUT;
  if (maxTokens >= contextWindow) {
    // Leave the window usable: an output cap that eats the context is a
    // misconfiguration, not a capability.
    maxTokens = Math.max(1_024, Math.floor(contextWindow / 4));
    warnings.push("output cap exceeded the context window; clamped to a quarter of it");
  }

  return {
    modelId,
    contextWindow,
    maxTokens,
    basis: basis ?? "conservative_fallback",
    source,
    freshness,
    stale,
    heterogeneous: capability?.heterogeneous ?? false,
    generation: capability?.generation,
    warnings: [...warnings, ...(capability?.warnings ?? [])],
  };
}

/**
 * Compact `143k/262k` rendering for the status bar: whole thousands below a
 * million, one decimal above, no trailing `.0`.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  const millions = (tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1);
  return `${millions.endsWith(".0") ? millions.slice(0, -2) : millions}M`;
}
