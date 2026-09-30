/**
 * Mission worker model routing with takeover (issue #76).
 *
 * Wraps the capability router for orchestrated workers. Models the gateway has
 * confirmed it no longer serves (a worker got `model_not_found`) are kept out
 * of routing for a TTL, so every later attempt, and the recovery probe, move to
 * the next eligible model. The TTL lets a model that comes back be used again.
 * The interactive session model is not routed here and is unaffected.
 */

import type { RoleRouterAdapter } from "../capability/adapter.ts";
import { isRoleName } from "../capability/roles.ts";
import type { ModelRoute, RouteModel } from "../orchestration/realBackends.ts";

/** How long a model confirmed unavailable stays excluded from routing. */
export const MODEL_UNAVAILABLE_TTL_MS = 30 * 60_000;

interface ModelRef {
  provider: string;
  id: string;
}

const modelKey = (model: ModelRef): string => `${model.provider}/${model.id}`;

/** Runtime-wide record of models the gateway confirmed it does not serve. */
export class UnavailableModels {
  private readonly entries = new Map<string, { model: ModelRef; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? MODEL_UNAVAILABLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Record (or refresh) a model as unavailable for the TTL. */
  mark(model: ModelRef): void {
    this.entries.set(modelKey(model), {
      model: { provider: model.provider, id: model.id },
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Models still inside their TTL; expired entries are dropped. */
  list(): ModelRef[] {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    return [...this.entries.values()].map((entry) => entry.model);
  }
}

/**
 * Build the orchestration `routeModel`: route a role through the capability
 * router, excluding the unavailable models plus any caller exclusions. A
 * reviewer placed on the requesting (session) model carries a reduced
 * independence warning.
 */
export function createRouteModel(opts: {
  router: Pick<RoleRouterAdapter, "route">;
  unavailable: UnavailableModels;
  reviewFallbackModel?: ModelRef;
}): RouteModel {
  const requester = opts.reviewFallbackModel;
  return async (role, routeOpts) => {
    if (!isRoleName(role)) return undefined;
    const exclude = [...opts.unavailable.list(), ...(routeOpts?.exclude ?? [])].map((model) => ({
      provider: model.provider,
      id: model.id,
    }));
    try {
      const routed = await opts.router.route(role, {
        ...(requester ? { requester } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      });
      if (role === "reviewer" && routed && requester && modelKey(routed) === modelKey(requester)) {
        return {
          ...routed,
          warning: `Warning: no distinct reviewer model is available; reviewing with ${routed.provider}/${routed.id} in a fresh session with reduced independence.`,
        } satisfies ModelRoute;
      }
      return routed;
    } catch {
      return undefined;
    }
  };
}
