/**
 * CAV-15 Model Routing: route implement/review/vision/planner tasks through
 * distinct model capabilities.
 *
 * Reconciles with the existing capability router (src/capability/adapter.ts)
 * and the standing routing decision (DECISION-UKyKbi, DECISION-RQ4OGM):
 * implementer, reviewer, planner and vision roles must run on DIFFERENT models
 * so review is genuinely independent, and vision review uses a vision-capable
 * model.
 *
 * Model ids are never hard-coded here (autospec R-MODEL, issue #157): a role is
 * routed to a CANONICAL id read from the gateway catalogue by capability and
 * family. Route aliases are not canonical ids and are never chosen. No eligible
 * model is an explicit BLOCKED result, never a default name.
 */
import { sameFamily } from "../capability/modelRecord.ts";
import { CAPABILITY_MAP } from "../inference/inferweaveCapabilities.ts";
import type { GatewayModelEntry } from "../models/gatewayCatalog.ts";

export type CavRole = "implementer" | "reviewer" | "planner" | "vision";

export interface CavRoute {
  provider: string;
  id: string;
  reason: string;
  /** Family from the catalogue, when it advertised one. */
  family?: string;
}

/** No catalogue model can serve the role; the caller must wait or stop, not guess a name. */
export interface CavBlocked {
  status: "BLOCKED";
  role: CavRole;
  reason: string;
}

export function isBlocked(result: CavRoute | CavBlocked): result is CavBlocked {
  return (result as CavBlocked).status === "BLOCKED";
}

/**
 * Models never routed to by default. deepseek-v4.1-flash stays out until
 * InferWeave #538 is fixed (spec R-MODEL); an explicit `exclude` replaces this
 * list and an explicit override still wins.
 */
export const DEFAULT_EXCLUDE: readonly string[] = ["deepseek-v4.1-flash"];

/** Provider the routes are served from unless the caller says otherwise. */
export const DEFAULT_PROVIDER = "metabolomics";

/** Smallest per-request context a coding role may be routed to. */
export const DEFAULT_MIN_CONTEXT_TOKENS = 32_768;

/** Gateway capability a model must advertise for each role. */
const ROLE_CAPABILITY: Record<CavRole, string> = {
  implementer: CAPABILITY_MAP.implementer!,
  reviewer: CAPABILITY_MAP.reviewer!,
  planner: CAPABILITY_MAP.planner!,
  vision: "vision",
};

/** Roles that drive tools and so need a tool-calling model. */
const TOOL_ROLES: ReadonlySet<CavRole> = new Set(["implementer", "reviewer"]);

export interface RouteOptions {
  /** Per-role model id that replaces the catalogue choice. Overrides win over everything else. */
  overrides?: Partial<Record<CavRole, string>>;
  /** Model ids never chosen. Replaces {@link DEFAULT_EXCLUDE} when given. */
  exclude?: readonly string[];
  /** Family of the implementer's model; a reviewer must come from a different one. */
  implementerFamily?: string | undefined;
  provider?: string;
  minContextTokens?: number;
}

function supportsTools(entry: GatewayModelEntry): boolean {
  return entry.tools === true || entry.capabilities?.includes("tool_use") === true;
}

/** Warm first, then more slots, then a larger window, then id (a total order). */
function byPreference(a: GatewayModelEntry, b: GatewayModelEntry): number {
  const warm = Number(b.state === "warm") - Number(a.state === "warm");
  if (warm !== 0) return warm;
  const slots = (b.slots ?? 0) - (a.slots ?? 0);
  if (slots !== 0) return slots;
  const window = b.contextWindow - a.contextWindow;
  if (window !== 0) return window;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function routeRole(
  role: CavRole,
  catalog: readonly GatewayModelEntry[],
  opts: RouteOptions = {},
): CavRoute | CavBlocked {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const overrideId = opts.overrides?.[role];
  if (overrideId) {
    const family = catalog.find((e) => e.id === overrideId)?.family;
    return {
      provider,
      id: overrideId,
      reason: `${role} (overridden to ${overrideId})`,
      ...(family ? { family } : {}),
    };
  }
  const exclude = new Set(opts.exclude ?? DEFAULT_EXCLUDE);
  const capability = ROLE_CAPABILITY[role];
  const minContext = opts.minContextTokens ?? DEFAULT_MIN_CONTEXT_TOKENS;
  let qualified = catalog.filter(
    (e) =>
      !e.alias &&
      !exclude.has(e.id) &&
      e.capabilities?.includes(capability) === true &&
      e.contextWindow >= minContext &&
      (!TOOL_ROLES.has(role) || supportsTools(e)),
  );
  if (role === "reviewer") {
    // Independence is shown, not assumed: both families must be known and differ.
    const implementer = opts.implementerFamily;
    qualified = implementer ? qualified.filter((e) => e.family !== undefined && e.family !== implementer) : [];
    if (!implementer) {
      return {
        status: "BLOCKED",
        role,
        reason: "no eligible model: the implementer's family is unknown, so reviewer independence cannot be shown",
      };
    }
  }
  const chosen = [...qualified].sort(byPreference)[0];
  if (!chosen) {
    return {
      status: "BLOCKED",
      role,
      reason: `no eligible model in the catalogue holds ${capability}${role === "reviewer" ? " from a family other than the implementer's" : ""}`,
    };
  }
  return {
    provider,
    id: chosen.id,
    reason: `${role}: catalogue model holding ${capability}${chosen.family ? ` (family ${chosen.family})` : ""}`,
    ...(chosen.family ? { family: chosen.family } : {}),
  };
}

/**
 * Distinctness check: the reviewer must not share the implementer's model
 * FAMILY (two ids of one family are one author for review purposes). A family
 * that cannot be established is never distinct.
 */
export function assertReviewerDistinct(implementerId: string, reviewerId: string): boolean {
  return !sameFamily(implementerId, reviewerId);
}

/** Vision review must use a vision-capable model. */
export function assertVisionCapable(role: CavRole, modelId: string): boolean {
  if (role !== "vision") return true;
  return /vision/i.test(modelId);
}
