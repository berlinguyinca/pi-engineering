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
import { ROLE_REQUIREMENTS, type RoleName, isRoleName, routerRoleFor } from "../capability/roles.ts";
import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { ModelRoute, RouteModel } from "../orchestration/realBackends.ts";
import type { RecoveryProbe } from "../resilience/probe.ts";
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
  /**
   * Models the gateway confirmed gone (404 model_not_found, or pruned from the
   * local runtime). Survives the TTL until an attempt on the model succeeds.
   */
  private readonly confirmed = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? MODEL_UNAVAILABLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record (or refresh) a model as unavailable for the TTL; logged when a
   * context is given. `confirmed` only for a gateway-confirmed absence: a
   * heuristic mark (e.g. a 503 on an unlisted model, which may be an alias
   * that still routes) must never outlive its TTL.
   */
  mark(model: ModelRef, context?: ModelUnavailableContext, opts: { confirmed?: boolean } = {}): void {
    const key = modelKey(model);
    if (opts.confirmed) this.confirmed.add(key);
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

  /**
   * Re-mark a model that was once confirmed unavailable and is still not
   * listed. After the TTL expires during a long pause the probe resolves back
   * to it; its unlisted answer is enough to exclude it again, without a 404.
   * A model never confirmed gone (e.g. an unlisted alias that still routes) is
   * left alone.
   */
  refreshIfConfirmed(model: ModelRef): void {
    if (this.confirmed.has(modelKey(model))) this.mark(model);
  }

  /** An attempt on the model succeeded: it is served again. */
  clear(model: ModelRef): void {
    this.entries.delete(modelKey(model));
    this.confirmed.delete(modelKey(model));
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
 *
 * A mission's operator pin (`operatorPin`) wins over role pins and the
 * router's ranking for EVERY worker role, unless the router knows the pinned
 * model cannot serve the role (missing capability, too small a context,
 * unhealthy, or reserved by separation of duties); then the role is routed as
 * usual and the result says why the pin was not used.
 */
export function createRouteModel(opts: {
  router?: Pick<RoleRouterAdapter, "route"> & Partial<Pick<RoleRouterAdapter, "select">>;
  unavailable: UnavailableModels;
  reviewFallbackModel?: ModelRef;
  /** The operator pin a mission dispatches with (adopted at this boundary). */
  operatorPin?: (missionId: string) => ModelRef | null | undefined;
}): RouteModel {
  const requester = opts.reviewFallbackModel;
  return async (role, routeOpts) => {
    const exclude = [...opts.unavailable.list(), ...(routeOpts?.exclude ?? [])].map((model) => ({
      provider: model.provider,
      id: model.id,
    }));
    const pin = routeOpts?.missionId ? opts.operatorPin?.(routeOpts.missionId) : undefined;
    let pinRefused: string | undefined;
    if (pin && !exclude.some((model) => modelKey(model) === modelKey(pin))) {
      const refusal = await pinRefusal(opts.router, routerRoleFor(role) ?? "implementer", pin, {
        ...(requester ? { requester } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      });
      if (!refusal) return { provider: pin.provider, id: pin.id, operatorPin: true } satisfies ModelRoute;
      pinRefused = `operator pin ${modelKey(pin)} cannot serve ${role} (${refusal})`;
    }
    const routed = await routeRole(opts.router, role, routeOpts?.replacement || !!pinRefused, requester, exclude);
    if (!pinRefused) return routed;
    if (!routed) return undefined;
    const notice = `${pinRefused}; using ${modelKey(routed)} for this role`;
    return { ...routed, warning: routed.warning ? `${notice}. ${routed.warning}` : notice };
  };
}

/** Why the router says the pinned model cannot take `role`; undefined when it can (or nothing is known). */
async function pinRefusal(
  router: (Pick<RoleRouterAdapter, "route"> & Partial<Pick<RoleRouterAdapter, "select">>) | undefined,
  role: RoleName,
  pin: ModelRef,
  query: { requester?: ModelRef; exclude?: ModelRef[] },
): Promise<string | undefined> {
  if (!router?.select) return undefined;
  try {
    const decision = await router.select(role, { ...query, taskOverride: modelKey(pin) });
    if (decision.selected && modelKey(decision.selected) === modelKey(pin)) return undefined;
    const rejection = decision.rejected.find((entry) => modelKey(entry.model) === modelKey(pin));
    // A model the router never discovered is the operator's word against no
    // evidence: honour the pin.
    return rejection ? rejection.reason : undefined;
  } catch {
    return undefined;
  }
}

async function routeRole(
  router: Pick<RoleRouterAdapter, "route"> | undefined,
  role: string,
  replacement: boolean,
  requester: ModelRef | undefined,
  exclude: ModelRef[],
): Promise<ModelRoute | undefined> {
  // Native roles are routed as always. Any other worker role keeps running on
  // the executor default and is mapped onto a router role only to choose a
  // replacement for a model that is gone (or that a pin could not serve).
  const routerRole = isRoleName(role) ? role : replacement ? routerRoleFor(role) : undefined;
  if (!routerRole || !router) return undefined;
  try {
    const routed = await router.route(routerRole, {
      ...(requester ? { requester } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    });
    if (ROLE_REQUIREMENTS[routerRole].independent && routed && requester && modelKey(routed) === modelKey(requester)) {
      return {
        ...routed,
        warning: `Warning: no distinct reviewer model is available; reviewing with ${modelKey(routed)} in a fresh session with reduced independence.`,
      } satisfies ModelRoute;
    }
    return routed;
  } catch {
    return undefined;
  }
}

/**
 * Make a mission recovery probe follow the unavailable-model record: a model
 * the scheduler reports unavailable gets a TTL-only mark (so routing, and with
 * it the probe's own target, move on), and a gateway-confirmed model the probe
 * still finds unlisted is re-marked when its TTL has run out.
 */
export function followUnavailableModels(probe: RecoveryProbe, unavailable: UnavailableModels): RecoveryProbe {
  return {
    probe: async () => {
      const result = await probe.probe();
      if (result.model_unlisted && result.model_id && result.model_provider) {
        unavailable.refreshIfConfirmed({ provider: result.model_provider, id: result.model_id });
      }
      return result;
    },
    reportModelUnavailable: (model, context) => unavailable.mark(model, context),
  };
}
