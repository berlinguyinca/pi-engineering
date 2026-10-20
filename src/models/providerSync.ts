/**
 * Keeping provider definitions identical across machines (`/model-sync`).
 *
 * Several machines run Pi against the same gateways, and their `models.json`
 * files drift: a URL moves on one host, a compat flag is fixed on another, a new
 * host starts with a provider missing altogether. This module plans the merge of
 * one canonical, key-free definition into a host's file.
 *
 * Three rules shape it:
 *
 *   * Credentials are per device. The gateway issues one key per machine so that
 *     usage and revocation stay attributable. A canonical definition therefore
 *     never carries a key, and is refused if it does; the host's own `apiKey` is
 *     carried through untouched. A provider the host has no credential for is
 *     reported `needs-key` and left alone rather than half-configured.
 *   * Model lists are not this module's business. `/model-refresh` is the single
 *     editor of a provider's models, because only it knows what the gateway
 *     actually serves. The canonical list is used to seed a provider that has
 *     none yet, and never to overwrite one that does.
 *   * Unknown keys survive. Only the keys the canonical definition names are
 *     replaced; anything a newer Pi understands on the host stays.
 */

import type { ConfiguredModel } from "./catalogPlan.ts";
import type { ModelsConfig } from "./modelsConfig.ts";

/** Keys that must never appear in a canonical definition: it is shared in the clear. */
const SECRET_KEY =
  /^(?:x[-_]?)?api[-_]?key$|^(?:(?:access|refresh|auth)[-_]?)?token$|^(?:client[-_]?)?secret$|^(?:password|authorization|headers|credentials?)$/i;

function assertCredentialFree(value: unknown, providerId: string): void {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`provider ${providerId} contains an invalid URL`);
    }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_KEY.test(key))) {
      throw new Error(`provider ${providerId}: canonical URLs must hold no credential`);
    }
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        throw new Error(`provider ${providerId} carries "${key}": a canonical definition must hold no credential`);
      }
      assertCredentialFree(nested, providerId);
    }
  }
}

export interface CanonicalProvider {
  baseUrl: string;
  /** Seed only: used when the host's provider has no models yet. */
  models?: ConfiguredModel[];
  [key: string]: unknown;
}

export interface CanonicalProviders {
  providers: Record<string, CanonicalProvider>;
}

/** Parse and validate a canonical definition. Throws a message fit to show an operator. */
export function parseCanonicalProviders(text: string): CanonicalProviders {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`canonical providers are not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("canonical providers must be a JSON object");
  }
  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error('canonical providers need a "providers" object');
  }
  const entries = Object.entries(providers as Record<string, unknown>);
  if (entries.length === 0) throw new Error("canonical providers define no providers");

  const out: CanonicalProviders = { providers: {} };
  for (const [id, raw] of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`provider ${id} must be an object`);
    const def = raw as Record<string, unknown>;
    assertCredentialFree(def, id);
    if (typeof def.baseUrl !== "string" || !/^https?:\/\//.test(def.baseUrl)) {
      throw new Error(`provider ${id} needs an http(s) baseUrl`);
    }
    if (def.models !== undefined && !Array.isArray(def.models))
      throw new Error(`provider ${id}: models must be a list`);
    if (Array.isArray(def.models)) {
      for (const model of def.models) {
        if (
          !model ||
          typeof model !== "object" ||
          Array.isArray(model) ||
          typeof model.id !== "string" ||
          !model.id.trim()
        ) {
          throw new Error(`provider ${id}: each model needs a non-empty string id`);
        }
      }
    }
    out.providers[id] = def as CanonicalProvider;
  }
  return out;
}

export type ProviderSyncState = "ok" | "updated" | "needs-key";

export interface ProviderSyncEntry {
  providerId: string;
  state: ProviderSyncState;
  /** Canonical keys whose value differed from the host's (never `models`). */
  changedKeys: string[];
  /** Models copied in because the host's provider had none. */
  seededModels: number;
}

export interface ProviderSyncPlan {
  /** The merged config. Equal (by value) to the input when nothing changed. */
  config: ModelsConfig;
  entries: ProviderSyncEntry[];
  dirty: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Plan the merge of `canonical` into `current`.
 *
 * `hasAuth` answers whether this host already holds a credential for a provider
 * somewhere other than `models.json` (Pi also reads `auth.json` and the
 * environment). Without it, only an `apiKey` in the file counts.
 */
export function planProviderSync(
  current: ModelsConfig,
  canonical: CanonicalProviders,
  hasAuth: (providerId: string) => boolean = () => false,
): ProviderSyncPlan {
  const providers: NonNullable<ModelsConfig["providers"]> = { ...(current.providers ?? {}) };
  const entries: ProviderSyncEntry[] = [];
  let dirty = false;

  for (const [providerId, def] of Object.entries(canonical.providers)) {
    const host = providers[providerId];
    const hostKey = host && typeof host.apiKey === "string" && host.apiKey.length > 0;
    if (!hostKey && !hasAuth(providerId)) {
      entries.push({ providerId, state: "needs-key", changedKeys: [], seededModels: 0 });
      continue;
    }

    const { models: seed, ...settings } = def;
    const next: Record<string, unknown> = { ...(host ?? {}) };
    const changedKeys: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!sameValue(next[key], value)) {
        next[key] = structuredClone(value);
        changedKeys.push(key);
      }
    }

    const hostModels = host?.models;
    let seededModels = 0;
    if ((!Array.isArray(hostModels) || hostModels.length === 0) && Array.isArray(seed) && seed.length > 0) {
      next.models = structuredClone(seed);
      seededModels = seed.length;
    }

    if (changedKeys.length === 0 && seededModels === 0) {
      entries.push({ providerId, state: "ok", changedKeys, seededModels });
      continue;
    }
    providers[providerId] = next as NonNullable<ModelsConfig["providers"]>[string];
    entries.push({ providerId, state: "updated", changedKeys, seededModels });
    dirty = true;
  }

  return { config: dirty ? { ...current, providers } : current, entries, dirty };
}

/** Operator-facing report, one line per provider. */
export function describeProviderSync(plan: ProviderSyncPlan, dryRun: boolean): string[] {
  return plan.entries.map((e) => {
    if (e.state === "needs-key") {
      return `${e.providerId}: needs-key — this host has no credential for it; add this device's own key, then run again`;
    }
    if (e.state === "ok") return `${e.providerId}: ok`;
    const bits: string[] = [];
    if (e.changedKeys.length > 0) bits.push(`settings: ${e.changedKeys.join(", ")}`);
    if (e.seededModels > 0) bits.push(`seeded ${e.seededModels} models`);
    return `${e.providerId}: ${dryRun ? "would update" : "updated"} (${bits.join("; ")})`;
  });
}
