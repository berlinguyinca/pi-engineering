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
import { ROLE_REQUIREMENTS, routerRoleFor } from "../capability/roles.ts";
import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { ModelRoute, RouteModel } from "../orchestration/realBackends.ts";
import { emitTelemetry } from "../telemetry/sink.ts";

/** How long a model confirmed unavailable stays excluded from routing. */
export const MODEL_UNAVAILABLE_TTL_MS = 30 * 60_000;

/** Why and where a model was found unavailable (for the operator log). */
export interface ModelUnavailableContext {
  missionId?: string;
  taskId?: string;
  reason: string;
}

/** Runtime-wide record of models the gateway confirmed it does not serve. */
export class UnavailableModels {
  private readonly entries = new Map<string, { model: ModelRef; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? MODEL_UNAVAILABLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Record (or refresh) a model as unavailable for the TTL; logged when a context is given. */
  mark(model: ModelRef, context?: ModelUnavailableContext): void {
    const key = modelKey(model);
    this.entries.set(key, {
      model: { provider: model.provider, id: model.id },
      expiresAt: this.now() + this.ttlMs,
    });
    if (!context) return;
    emitTelemetry({
      level: "warning",
      text: `model ${key} is not served; routing avoids it for ${Math.round(this.ttlMs / 60_000)} min (mission ${context.missionId ?? "-"}, task ${context.taskId ?? "-"}): ${context.reason}`,
      key: `model-unavailable:${key}`,
      detail: { model: key, ...context },
    });
  }

  /** True while the model is inside its TTL. */
  has(model: ModelRef): boolean {
    return this.list().some((entry) => modelKey(entry) === modelKey(model));
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
 * Build the orchestration `routeModel`: route a worker role (mapped onto the
 * router's roles) through the capability router, excluding the unavailable
 * models plus any caller exclusions. An independent (review) role placed on
 * the requesting session model carries a reduced-independence warning.
 */
export function createRouteModel(opts: {
  router: Pick<RoleRouterAdapter, "route">;
  unavailable: UnavailableModels;
  reviewFallbackModel?: ModelRef;
}): RouteModel {
  const requester = opts.reviewFallbackModel;
  return async (role, routeOpts) => {
    const routerRole = routerRoleFor(role);
    if (!routerRole) return undefined;
    const exclude = [...opts.unavailable.list(), ...(routeOpts?.exclude ?? [])].map((model) => ({
      provider: model.provider,
      id: model.id,
    }));
    try {
      const routed = await opts.router.route(routerRole, {
        ...(requester ? { requester } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      });
      if (
        ROLE_REQUIREMENTS[routerRole].independent &&
        routed &&
        requester &&
        modelKey(routed) === modelKey(requester)
      ) {
        return {
          ...routed,
          warning: `Warning: no distinct reviewer model is available; reviewing with ${modelKey(routed)} in a fresh session with reduced independence.`,
        } satisfies ModelRoute;
      }
      return routed;
    } catch {
      return undefined;
    }
  };
}
