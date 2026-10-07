/**
 * Role → model resolution (spec §2, §9, §15, §27).
 *
 * A role is a capability requirement plus soft preferences, never a model id:
 *
 *   1. a logical alias the gateway advertises (it picks the backing runtime);
 *   2. otherwise a concrete catalogue model advertising the role's capability
 *      (or matching its preferred family), ranked by readiness and load;
 *   3. otherwise the static role routing (engineering.yaml `routing.roles`
 *      pins through the capability router);
 *   4. otherwise nothing — the executor's default model (single-model hosts).
 *
 * Separation of duties: callers pass the models already serving roles that
 * must differ (planner vs implementer, implementer vs reviewer); a different
 * model is chosen whenever an alternative exists.
 */

import { type CatalogModel, capabilityQuery } from "./gateway.ts";
import type { ModelRef } from "./planner.ts";
import type { PlannerWorkerRole } from "./types.ts";

export interface RoleConfig {
  /** Capability the role requests (e.g. `coding.implementation`). */
  capability: string;
  /** Logical route name; defaults to the capability with dots as dashes. */
  alias?: string;
  /** Soft preference for a model family (deployment-defined tag). */
  preferred_family?: string;
  /** Minimum context window the role needs. */
  min_context?: number;
  /** Role needs tool calling. */
  tools?: boolean;
}

/** Spec §2 defaults. Families are preferences only; nothing here is a model id. */
export const DEFAULT_ROLE_CONFIG: Readonly<Record<PlannerWorkerRole, RoleConfig>> = {
  planner: { capability: "coding.planning", preferred_family: "qwen-flash" },
  researcher: { capability: "coding.analysis", preferred_family: "qwen-flash" },
  implementer: { capability: "coding.implementation", preferred_family: "qwen-27b" },
  reviewer: { capability: "coding.review", preferred_family: "qwen-flash" },
  debugger: { capability: "coding.debugging", preferred_family: "qwen-flash" },
  fixer: { capability: "coding.implementation", preferred_family: "qwen-27b" },
  escalation: { capability: "coding.escalation" },
};

/** Roles that must not share a model when alternatives exist. */
export const MUST_DIFFER: ReadonlyArray<[PlannerWorkerRole, PlannerWorkerRole]> = [
  ["planner", "implementer"],
  ["implementer", "reviewer"],
  ["fixer", "reviewer"],
  ["implementer", "escalation"],
];

export function aliasFor(cfg: RoleConfig): string {
  return cfg.alias ?? cfg.capability.replaceAll(".", "-");
}

export interface ResolvedRole {
  role: PlannerWorkerRole;
  model: ModelRef;
  via: "alias" | "capability" | "family" | "query" | "static" | "operator_pin";
  /** Concrete model behind an alias, when the gateway advertises it. */
  backing?: string;
  contextWindow?: number;
  entry?: CatalogModel;
  notes: string[];
}

const UNUSABLE_STATES = new Set(["unavailable", "draining", "lost", "failed", "offline"]);

export function usable(m: CatalogModel): boolean {
  return !UNUSABLE_STATES.has(m.state ?? "");
}

/** Family match without naming models: config tag equals the advertised family, or every tag token is in the id. */
export function familyMatches(m: CatalogModel, family: string | undefined): boolean {
  if (!family) return false;
  const f = family.toLowerCase();
  if (m.family?.toLowerCase() === f) return true;
  const id = m.id.toLowerCase();
  return f
    .split(/[-_\s]+/)
    .filter(Boolean)
    .every((tok) => id.includes(tok));
}

function identity(m: CatalogModel): string {
  return m.backing ?? m.id;
}

export interface ResolveContext {
  catalog: CatalogModel[];
  config: Readonly<Record<PlannerWorkerRole, RoleConfig>>;
  /** Pi provider name the gateway's models are registered under. */
  provider: string;
  /** Concrete model ids serving roles this one must differ from. */
  avoid?: readonly string[];
  /** Model ids known unavailable right now (failure-aware switching). */
  exclude?: readonly string[];
  /** Static routing (engineering.yaml pins via the capability router). */
  fallback?: (role: PlannerWorkerRole, exclude: readonly string[]) => Promise<ModelRef | undefined>;
}

function score(m: CatalogModel, cfg: RoleConfig): number {
  let s = 0;
  if (m.capabilities.includes(cfg.capability)) s += 4;
  if (familyMatches(m, cfg.preferred_family)) s += 3;
  if (m.state === "hot" || m.state === "warm" || m.state === "ready") s += 1;
  if (m.state === "loading" || m.state === "cold") s -= 1;
  s -= Math.max(0, Math.min(1, m.load ?? 0));
  return s;
}

export async function resolveRole(role: PlannerWorkerRole, ctx: ResolveContext): Promise<ResolvedRole | null> {
  const cfg = ctx.config[role];
  const avoid = new Set(ctx.avoid ?? []);
  const exclude = new Set(ctx.exclude ?? []);
  const notes: string[] = [];
  const fits = (m: CatalogModel) =>
    usable(m) &&
    !exclude.has(m.id) &&
    !exclude.has(identity(m)) &&
    (cfg.min_context === undefined || m.contextWindow === undefined || m.contextWindow >= cfg.min_context) &&
    (cfg.tools !== true || m.tools !== false);

  // 1. Logical alias: the gateway owns the binding.
  const alias = aliasFor(cfg);
  const aliasEntry = ctx.catalog.find((m) => m.id === alias && fits(m));
  const concrete = ctx.catalog.filter((m) => !m.alias && fits(m));
  if (aliasEntry) {
    const clash = aliasEntry.backing !== undefined && avoid.has(aliasEntry.backing);
    const alternative = clash && concrete.some((m) => !avoid.has(m.id) && m.capabilities.includes(cfg.capability));
    if (!alternative) {
      if (clash)
        notes.push(
          `alias ${alias} is backed by ${aliasEntry.backing}, which also serves a role it must differ from; no alternative`,
        );
      return {
        role,
        model: { provider: ctx.provider, id: aliasEntry.id },
        via: "alias",
        ...(aliasEntry.backing ? { backing: aliasEntry.backing } : {}),
        ...(aliasEntry.contextWindow !== undefined ? { contextWindow: aliasEntry.contextWindow } : {}),
        entry: aliasEntry,
        notes,
      };
    }
    notes.push(`alias ${alias} skipped: its backing model serves a role it must differ from`);
  }
  // A concrete model may advertise serving the alias even when the alias itself is not listed.
  const servingAlias = concrete.filter((m) => m.aliases.includes(alias));

  // 2. Capability / family match on concrete models.
  const anyCapabilities = ctx.catalog.some((m) => m.capabilities.length > 0);
  const candidates = (servingAlias.length > 0 ? servingAlias : concrete).filter(
    (m) =>
      m.capabilities.includes(cfg.capability) || familyMatches(m, cfg.preferred_family) || servingAlias.includes(m),
  );
  const ranked = [...candidates].sort((a, b) => score(b, cfg) - score(a, cfg) || a.id.localeCompare(b.id));
  const distinct = ranked.filter((m) => !avoid.has(m.id));
  const pick = distinct[0] ?? ranked[0];
  if (pick) {
    if (!distinct[0]) notes.push(`no model distinct from ${[...avoid].join(", ")} serves ${cfg.capability}`);
    return {
      role,
      model: { provider: ctx.provider, id: pick.id },
      via: pick.capabilities.includes(cfg.capability) || servingAlias.includes(pick) ? "capability" : "family",
      ...(pick.contextWindow !== undefined ? { contextWindow: pick.contextWindow } : {}),
      entry: pick,
      notes,
    };
  }
  if (!anyCapabilities) notes.push("gateway advertises no capabilities; using static role routing");

  // 2b. A gateway that speaks capabilities may serve a model it does not list
  //     yet (restorable): ask it directly with a capability query.
  const query = anyCapabilities
    ? capabilityQuery({
        capabilities: [cfg.capability],
        ...(cfg.min_context !== undefined ? { minimumContext: cfg.min_context } : {}),
        ...(cfg.preferred_family ? { family: cfg.preferred_family } : {}),
      })
    : null;
  if (query && !exclude.has(query)) {
    notes.push(`no listed model serves ${cfg.capability}; asking the gateway with ${query}`);
    return { role, model: { provider: ctx.provider, id: query }, via: "query", notes };
  }

  // 3. Static role routing.
  const fallback = await ctx.fallback?.(role, [...exclude]).catch(() => undefined);
  if (fallback) {
    const entry = ctx.catalog.find((m) => m.id === fallback.id);
    return {
      role,
      model: fallback,
      via: "static",
      ...(entry?.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry ? { entry } : {}),
      notes,
    };
  }
  return null;
}

/** Concrete identity of a resolution (backing model when an alias). */
export function servedIdentity(r: ResolvedRole): string {
  return r.backing ?? r.model.id;
}

/** Roles that `role` must differ from. */
export function mustDifferFrom(role: PlannerWorkerRole): PlannerWorkerRole[] {
  return MUST_DIFFER.flatMap(([a, b]) => (a === role ? [b] : b === role ? [a] : []));
}

/** Map a planner/worker role onto the capability router's static roles. */
export const STATIC_ROUTER_ROLE: Readonly<Record<PlannerWorkerRole, string>> = {
  planner: "planner",
  researcher: "planner",
  implementer: "implementer",
  reviewer: "reviewer",
  debugger: "planner",
  fixer: "implementer",
  escalation: "orchestrator",
};
