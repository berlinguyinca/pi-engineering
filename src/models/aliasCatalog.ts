/**
 * Alias-only view of a gateway catalogue.
 *
 * Concrete model ids come and go: a node is preempted, a quant is swapped, a
 * model is renamed. Anything that pins one has to be reconfigured each time.
 * The gateway resolves family names (`qwen3.8-vision`) and operator aliases
 * (`qwen3.8-text`) to whatever is live, so Pi configures only those.
 *
 * Two kinds of alias are used:
 *
 *  - rows the gateway lists with `x_alias` (operator aliases and the prefix
 *    aliases it chooses to list), and
 *  - prefix aliases the gateway resolves but may not list. Their names follow
 *    docs/specs/prefix-aliases.md of the gateway: `<family>`, `<family>-<size>`,
 *    `<family>-<modality>` and `<family>-<size>-<modality>` for the canonical
 *    id `<family>-<size>-modality-<m>-quant-<q>…`.
 *
 * An alias's context window is the SMALLEST window among its members. The
 * gateway picks the best live member and fails over to the next, so a
 * conversation sized for the largest member can land on a smaller one and
 * fail. A window that fits every member is the only one that never does.
 *
 * Pure, like the rest of the catalogue handling: no I/O.
 */

import { type GatewayModelEntry, memberSizes, sizeClassOf } from "./gatewayCatalog.ts";

const SHORT_MODALITIES = new Set(["text", "vision", "audio", "video"]);
const KEYS = new Set(["arch", "variant", "modality", "ctx", "quant", "src"]);

export interface IdFacts {
  family: string;
  size: string;
  modality?: string;
  /** A variant or src id never gives its names to the listing. */
  listable: boolean;
}

/**
 * Parse a canonical id; `undefined` when it is not `<family>-<size>-<key>-<value>…`.
 *
 * Deliberately stricter than `sizeClassOf`, which only describes members of an
 * alias the gateway already named. This one mints names: a name derived from a
 * mis-parsed id is a route the gateway cannot resolve, so an id whose shape is in
 * any doubt yields no alias at all. A wrong answer from `sizeClassOf` only
 * mislabels a model that exists; a wrong answer here configures one that 404s.
 */
export function factsOf(id: string): IdFacts | undefined {
  const parts = id.split("-");
  if (parts.length < 4) return undefined;
  const [family, size, ...rest] = parts as [string, string, ...string[]];
  const qualifiers = new Map<string, string>();
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const key = rest[i]!;
    if (!KEYS.has(key)) return undefined;
    qualifiers.set(key, rest[i + 1]!);
  }
  if (rest.length % 2 !== 0 || !qualifiers.has("modality") || !qualifiers.has("quant")) return undefined;
  const modality = qualifiers.get("modality");
  return {
    family,
    size,
    ...(modality ? { modality } : {}),
    listable: !qualifiers.has("src") && !qualifiers.has("variant"),
  };
}

function isUsable(entry: GatewayModelEntry): boolean {
  // `slots: 0` is the gateway saying nothing can take a request right now.
  return entry.slots === undefined || entry.slots > 0;
}

function smallest(entries: readonly GatewayModelEntry[]): number {
  return Math.min(...entries.map((entry) => entry.contextWindow));
}

/** What exactly one member behind an alias resolves to, for naming and reporting. */
function soleMember(memberIds: readonly string[]): string | undefined {
  return memberIds.length === 1 ? memberIds[0] : undefined;
}

/**
 * Why an alias's name does not tell you which model answers, or `undefined`
 * when the name says it.
 *
 * An alias is a name, not a promise about weights: `qwen3.8-text` is whatever
 * text-modality `qwen3.8` is live, which today is Flash-Next and after a swap
 * could be the 27B. Selecting such a name for a session — or reporting on one —
 * has to reveal what stands behind it now, or "which model am I on?" becomes
 * unanswerable from the configuration.
 */
export function aliasAmbiguity(entry: GatewayModelEntry): string | undefined {
  const members = entry.members ?? [];
  // Read from the members, not from the deduplicated `sizes`: two members can
  // share a class (the q4 and w3a8 quants of one model), and then "every member"
  // is a claim worth making even though one class name covers them.
  const classes = members.map(sizeClassOf);
  const unnamed = classes.filter((c) => c === undefined).length;
  const known = [...new Set(classes.filter((c): c is string => c !== undefined))].sort();
  if (known.length === 0) return undefined;
  if (known.length > 1 || unnamed > 0) {
    const extra = unnamed > 0 ? ` plus ${unnamed} whose id names no class` : "";
    return `its ${members.length} members run ${known.join(", ")}${extra}, so the name cannot say which one answers`;
  }
  const size = known[0]!;
  if (entry.id.toLowerCase().includes(size.toLowerCase())) return undefined;
  const runs = soleMember(members);
  return runs
    ? `it runs ${runs} (${size}), which the name does not say`
    : `every member is ${size}, which the name does not say`;
}

/**
 * The alias names `entries` support, each with its members.
 * Names that are themselves a served id are left out: those resolve exactly.
 */
function derivedAliases(concrete: readonly GatewayModelEntry[]): Map<string, GatewayModelEntry[]> {
  const ids = new Set(concrete.map((entry) => entry.id));
  const names = new Map<string, Set<string>>();
  const add = (name: string, id: string) => {
    if (ids.has(name)) return;
    const members = names.get(name) ?? new Set<string>();
    members.add(id);
    names.set(name, members);
  };
  const byId = new Map(concrete.map((entry) => [entry.id, entry]));
  for (const entry of concrete) {
    const facts = factsOf(entry.id);
    if (!facts?.listable) continue;
    add(facts.family, entry.id);
    add(`${facts.family}-${facts.size}`, entry.id);
    if (facts.modality && SHORT_MODALITIES.has(facts.modality)) {
      add(`${facts.family}-${facts.modality}`, entry.id);
      add(`${facts.family}-${facts.size}-${facts.modality}`, entry.id);
    }
  }
  const out = new Map<string, GatewayModelEntry[]>();
  for (const [name, memberIds] of names) {
    out.set(
      name,
      [...memberIds].map((id) => byId.get(id)!),
    );
  }
  return out;
}

export interface AliasView {
  /** Alias entries only. Empty when the gateway offers nothing to alias. */
  entries: GatewayModelEntry[];
  /** Concrete ids that were dropped, for the refresh report. */
  droppedConcrete: string[];
}

/**
 * Reduce a catalogue to aliases.
 *
 * Returns an empty `entries` list when no alias can be listed or derived, so
 * a gateway with an unfamiliar id scheme keeps working as it did: the caller
 * falls back to the concrete list instead of ending up with no models.
 */
export function aliasView(advertised: readonly GatewayModelEntry[]): AliasView {
  const concrete = advertised.filter((entry) => !entry.alias);
  const byId = new Map(advertised.map((entry) => [entry.id, entry]));
  const out = new Map<string, GatewayModelEntry>();

  // Aliases the gateway lists. A listed alias reports the best member's window;
  // the safe window is the smallest one across the members we can see.
  for (const entry of advertised.filter((e) => e.alias)) {
    const memberIds = entry.members ?? [];
    const members = memberIds.map((id) => byId.get(id)).filter((m): m is GatewayModelEntry => !!m);
    const contextWindow = members.length > 0 ? Math.min(entry.contextWindow, smallest(members)) : entry.contextWindow;
    const backingModel = soleMember(memberIds);
    const sizes = memberSizes(memberIds);
    out.set(entry.id, {
      ...entry,
      origin: "advertised",
      contextWindow,
      ...(members.length > 0 ? { members: members.map((m) => m.id) } : {}),
      // One member is a definite answer; several means the gateway picks per
      // request and no single model may be claimed.
      ...(backingModel ? { backingModel } : {}),
      ...(sizes.length > 0 ? { sizes } : {}),
    });
  }

  // Prefix aliases the gateway resolves without listing them.
  for (const [name, members] of derivedAliases(concrete.filter(isUsable))) {
    if (out.has(name)) continue;
    const best = members.find((m) => m.state === "warm") ?? members[0]!;
    const memberIds = members.map((m) => m.id).sort();
    const backingModel = soleMember(memberIds);
    const sizes = memberSizes(memberIds);
    out.set(name, {
      id: name,
      origin: "derived",
      contextWindow: smallest(members),
      ...(best.state ? { state: best.state } : {}),
      alias: true,
      members: memberIds,
      ...(backingModel ? { backingModel } : {}),
      ...(sizes.length > 0 ? { sizes } : {}),
    });
  }

  const entries = [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, droppedConcrete: entries.length > 0 ? concrete.map((entry) => entry.id) : [] };
}

/** Modalities a route name can select, whatever builds the listing happens to show. */
const ROUTE_MODALITIES = ["text", "vision"];

/** Window assumed for a route nothing in the listing or the configuration describes. */
export const UNKNOWN_ROUTE_WINDOW = 32768;

export interface UnadvertisedRoutes {
  /** Route names to probe; each is a name NO listing covers. */
  entries: GatewayModelEntry[];
  /** Already-configured ids the listing does not cover — probe before deleting. */
  configuredOnly: string[];
}

/**
 * Route names the listing cannot vouch for but the gateway may still serve.
 *
 * The live gateway's `/v1/models` is wrong in both directions: it omits routes
 * that answer a completion (`qwen3.8-27b`, `qwen3.8-27b-text`, `qwen3.8-flash`)
 * and advertises routes that return 404 (`laya`, `laya-text`). Listing-only
 * discovery therefore deletes working models and installs broken ones, so these
 * names are offered to the probe, which is the only evidence that settles it:
 *
 * - every family / size / modality combination the concrete rows imply, in both
 *   modalities — a `-text` route answers even when the only listed build of
 *   that class is a vision one, which is precisely how `qwen3.8-27b-text` was
 *   lost;
 * - every configured id the alias view does not cover, so a route is pruned
 *   only on a probe that says it does not answer, never on a listing that
 *   simply failed to mention it.
 *
 * Nothing here is invented from thin air: each name is built from families and
 * size classes the gateway itself listed, and each is configured only after the
 * gateway answers for it.
 */
export function unadvertisedRouteCandidates(
  advertised: readonly GatewayModelEntry[],
  view: AliasView,
  configured: readonly { id: string; contextWindow?: number }[],
): UnadvertisedRoutes {
  const concrete = advertised.filter((entry) => !entry.alias && isUsable(entry));
  const listedIds = new Set(advertised.map((entry) => entry.id));
  const covered = new Set(view.entries.map((entry) => entry.id));
  const out = new Map<string, GatewayModelEntry>();

  const route = (name: string, want: { family: string; size?: string; modality?: string }): GatewayModelEntry => {
    // `want` describes the NAME being probed, never the row it was derived from:
    // `qwen3.8-flash_next-vision` must not inherit the text modality of the only
    // flash_next builds that are listed, or it would name members it cannot
    // vouch for and the name would claim weights the route may not run.
    // Same class = same family, and same size when the name names one. Modality
    // narrows the MEMBERS we are willing to name, never the window we read: the
    // route may run a build the listing does not show.
    const sameClass = concrete.filter((row) => {
      const facts = factsOf(row.id);
      return !!facts && facts.family === want.family && (!want.size || facts.size === want.size);
    });
    const members = want.modality ? sameClass.filter((row) => factsOf(row.id)?.modality === want.modality) : sameClass;
    const configuredEntry = configured.find((model) => model.id === name);
    const windows = (members.length > 0 ? members : sameClass).map((entry) => entry.contextWindow);
    const memberIds = members.map((entry) => entry.id).sort();
    const backingModel = memberIds.length === 1 ? memberIds[0] : undefined;
    const sizes = memberSizes(memberIds);
    return {
      id: name,
      alias: true,
      origin: "probed",
      // The smallest window in the class, then what was configured, then a
      // deliberately small floor: over-claiming a window loses context silently.
      contextWindow:
        windows.length > 0 ? Math.min(...windows) : (configuredEntry?.contextWindow ?? UNKNOWN_ROUTE_WINDOW),
      ...(memberIds.length > 0 ? { members: memberIds } : {}),
      ...(backingModel ? { backingModel } : {}),
      ...(sizes.length > 0 ? { sizes } : {}),
    };
  };

  for (const entry of concrete) {
    const facts = factsOf(entry.id);
    if (!facts?.listable) continue;
    // The names the gateway might resolve for this class, in both modalities.
    const selectors: Array<{ name: string; want: { family: string; size?: string; modality?: string } }> = [
      { name: facts.family, want: { family: facts.family } },
      { name: `${facts.family}-${facts.size}`, want: { family: facts.family, size: facts.size } },
      ...ROUTE_MODALITIES.flatMap((modality) => [
        { name: `${facts.family}-${modality}`, want: { family: facts.family, modality } },
        {
          name: `${facts.family}-${facts.size}-${modality}`,
          want: { family: facts.family, size: facts.size, modality },
        },
      ]),
    ];
    for (const { name, want } of selectors) {
      // A listed row — alias or concrete — is already judged on its own terms.
      if (covered.has(name) || listedIds.has(name) || out.has(name)) continue;
      out.set(name, route(name, want));
    }
  }

  const configuredOnly: string[] = [];
  for (const model of configured) {
    if (covered.has(model.id) || listedIds.has(model.id) || out.has(model.id)) continue;
    // A configured BUILD id that left the listing is a retired model, not a
    // hidden route: alias mode never configures builds, so it is not probed.
    if (!isRouteName(model.id)) continue;
    configuredOnly.push(model.id);
    out.set(model.id, {
      id: model.id,
      alias: true,
      origin: "probed",
      contextWindow: model.contextWindow ?? UNKNOWN_ROUTE_WINDOW,
    });
  }

  return {
    entries: [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    configuredOnly,
  };
}

/**
 * True when `id` names a route rather than a build.
 *
 * A canonical concrete id (`family-size-modality-X-quant-Y`) names weights that
 * either appear in the listing or do not, so its absence is a real answer. A
 * route name is a handle the gateway may resolve without ever listing, so its
 * absence proves nothing and the entry has to survive until something better
 * than a listing says otherwise.
 */
export function isRouteName(id: string): boolean {
  return factsOf(id) === undefined && /^[a-z0-9][a-z0-9._-]*$/.test(id);
}
