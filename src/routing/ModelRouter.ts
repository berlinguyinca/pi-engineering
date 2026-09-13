/**
 * Model routing & diversity (spec §21, backlog B-108 / B-101).
 *
 * A capability-based router that selects a model provider for a worker role.
 * Core remains single-model-capable: if only one provider (or none) is
 * registered, the router degrades gracefully to it. When multiple providers are
 * available, the router:
 *
 *   - picks a provider whose capabilities satisfy the role's requirements;
 *   - honors per-provider quota/capacity (falls back on exhaustion);
 *   - prefers a DIFFERENT provider for separation-of-duties roles (reviewer,
 *     clean-room challenger) to mitigate anchoring/shared-bias (B-101).
 *
 * This is a pure, deterministic, dependency-free decision layer. It does NOT
 * require multiple models (project constraint) — it only exploits them when
 * they exist.
 */
export type Capability = "implement" | "review" | "challenge" | "plan" | "scout" | "test" | "cheap" | "fast";

export type WorkerRoleName =
  | "implementer"
  | "reviewer"
  | "clean-room-challenger"
  | "planner"
  | "scout"
  | "test-designer";

/** Capabilities a role requires. Roles that must be independent of the implementer are marked. */
export const ROLE_CAPABILITIES: Record<WorkerRoleName, { requires: Capability[]; independent: boolean }> = {
  scout: { requires: ["scout", "cheap"], independent: false },
  implementer: { requires: ["implement"], independent: false },
  reviewer: { requires: ["review"], independent: true },
  "clean-room-challenger": { requires: ["challenge"], independent: true },
  planner: { requires: ["plan", "cheap"], independent: false },
  "test-designer": { requires: ["test"], independent: true },
};

export interface ModelProvider {
  /** Stable identifier, e.g. "primary" / "deepseek-v4-flash". */
  id: string;
  name: string;
  capabilities: Capability[];
  /** Remaining quota (tokens or calls); 0 = exhausted. Infinity = unlimited. */
  quota: number;
  /** Optional concrete worker to run this provider's model (falls back to a shared default). */
  worker?: unknown;
}

export interface RouteResult {
  provider: ModelProvider;
  /** True when the router chose a different provider specifically for independence. */
  diversified: boolean;
  /** True when the chosen provider was selected only via fallback (primary was exhausted/ineligible). */
  fallback: boolean;
  reason: string;
}

export interface ModelRouterOptions {
  providers: ModelProvider[];
  /** Which role names are separation-of-duties (diversify away from the implementer). */
  independentRoles?: WorkerRoleName[];
}

/**
 * Deterministic capability + quota router.
 *
 * Selection order for a role:
 *   1. eligible providers (satisfy capabilities AND have remaining quota);
 *   2. for independent roles, prefer an eligible provider whose id differs from
 *      the implementer's selected provider (diversity);
 *   3. tie-break by highest remaining quota, then registration order.
 * Returns null when no provider can serve the role (caller degrades).
 */
export class ModelRouter {
  private readonly providers: ModelProvider[];
  private readonly independentRoles: Set<WorkerRoleName>;

  constructor(opts: ModelRouterOptions) {
    this.providers = opts.providers;
    this.independentRoles = new Set(opts.independentRoles ?? ["reviewer", "clean-room-challenger", "test-designer"]);
  }

  /** Register or replace a provider (id-keyed). */
  register(p: ModelProvider): void {
    const i = this.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) this.providers[i] = p;
    else this.providers.push(p);
  }

  /** Consume quota from a provider; clamps at 0. */
  consume(id: string, amount: number): void {
    const p = this.providers.find((x) => x.id === id);
    if (p && Number.isFinite(p.quota)) p.quota = Math.max(0, p.quota - amount);
  }

  providersSnapshot(): ModelProvider[] {
    return [...this.providers];
  }

  eligibleFor(role: WorkerRoleName, providers: ModelProvider[] = this.providers): ModelProvider[] {
    const { requires } = ROLE_CAPABILITIES[role];
    return providers.filter((p) => requires.every((c) => p.capabilities.includes(c)) && p.quota > 0);
  }

  /**
   * Route a role to a provider. `implementerProviderId` is the provider chosen
   * for the implementer in the same run; independent roles avoid it when an
   * alternative eligible provider exists.
   */
  /** The first registered provider satisfying a role's capabilities (quota ignored). */
  private preferredFor(role: WorkerRoleName): ModelProvider | undefined {
    const { requires } = ROLE_CAPABILITIES[role];
    return this.providers.find((p) => requires.every((c) => p.capabilities.includes(c)));
  }

  route(role: WorkerRoleName, implementerProviderId?: string): RouteResult | null {
    const eligible = this.eligibleFor(role);
    if (eligible.length === 0) return null;
    const { independent } = ROLE_CAPABILITIES[role];
    const diversify = independent && this.independentRoles.has(role) && implementerProviderId !== undefined;
    const preferred = this.preferredFor(role);
    if (diversify) {
      const others = eligible.filter((p) => p.id !== implementerProviderId);
      if (others.length > 0) {
        const pick = this.best(others);
        return {
          provider: pick,
          diversified: true,
          fallback: preferred?.id !== pick.id,
          reason: `diversified away from implementer provider '${implementerProviderId}'`,
        };
      }
    }
    const pick = this.best(eligible);
    // Fallback when the preferred provider was ineligible/exhausted and a
    // lower-preference provider had to serve.
    const fallback = preferred?.id !== pick.id;
    return {
      provider: pick,
      diversified: false,
      fallback,
      reason: fallback
        ? `fallback: preferred '${preferred?.id}' unavailable; used '${pick.id}'`
        : "best eligible provider",
    };
  }

  /** Pick the provider with the highest remaining quota (ties → registration order). */
  private best(providers: ModelProvider[]): ModelProvider {
    return [...providers].sort(
      (a, b) => b.quota - a.quota || this.providers.indexOf(a) - this.providers.indexOf(b),
    )[0]!;
  }
}
