/**
 * Capability-aware routing adapter (selective merge of the lifecycle spec's
 * model-router feature, WITHOUT the auto-invoking engineering harness).
 *
 * Wires discovery → registry → policy → RoleRouter and exposes `routeRole` to
 * produce a worker `modelOverride` ({provider, id}) so a caller can place each
 * role (implementer, reviewer, specialist, ...) on a specific provider model.
 *
 * This is the standalone, non-competing surface of the capability router: it
 * selects models; it does NOT own an engineering lifecycle or auto-invoke any
 * workflow. Callers decide when to route.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type LoadPolicyOptions, loadPolicy } from "../lifecycle/policy.ts";
import type { ModelRef, RoutingDecision } from "../lifecycle/types.ts";
import { registerLocalProviders } from "../workers/localProviders.ts";
import { AgentModelsFileSource, PiModelRuntimeSource, mergeRecords } from "./discovery.ts";
import { ModelCapabilityRegistry } from "./registry.ts";
import { RoleRouter, type RouteQuery } from "./router.ts";

export interface RouteAdapterOptions {
  cwd: string;
  agentDir?: string;
  /** Optional pre-built ModelRuntime (shares discovery with execution). */
  modelRuntime?: ModelRuntime;
  allowModelNetwork?: boolean;
  policy?: LoadPolicyOptions;
  /** Override layers (role -> "provider/id"). */
  overrides?: RoleRouter["overrides"] extends infer O ? O : never;
}

/** A ready-to-use capability router bound to discovered models + policy. */
export interface RoleRouterAdapter {
  readonly router: RoleRouter;
  readonly registry: ModelCapabilityRegistry;
  /** Route a role and return a worker `modelOverride`, or undefined when unroutable. */
  route(
    role: RouteQuery["role"],
    query?: Omit<RouteQuery, "role">,
  ): Promise<{ provider: string; id: string } | undefined>;
  /** Full explainable decision for a role (candidates, rejections, rationale). */
  select(role: RouteQuery["role"], query?: Omit<RouteQuery, "role">): Promise<RoutingDecision>;
}

/**
 * Build a capability router from discovered models + loaded policy. Does not
 * start any lifecycle or auto-invoke any work.
 */
export async function createRoleRouter(opts: RouteAdapterOptions): Promise<RoleRouterAdapter> {
  const agentDir = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const policy = (await loadPolicy(opts.policy ?? { cwd: opts.cwd, agentDir })).policy;

  let runtime = opts.modelRuntime;
  if (!runtime) {
    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: opts.allowModelNetwork ?? false,
    });
  }
  await registerLocalProviders(runtime).catch(() => {});

  const context = { cwd: opts.cwd, agentDir };
  const sources = [new PiModelRuntimeSource(runtime), new AgentModelsFileSource()];
  const registry = await ModelCapabilityRegistry.open({
    sources,
    context,
    file: join(agentDir, "capability-cache.json"),
    // The models.json source advertises every catalog model as available, but
    // the execution ModelRuntime may not actually register all of them (local
    // provider hold-outs for no-tool models, stale catalog entries, renamed
    // ids). Availability must be truthful to the runtime, or the router routes
    // a role to a model the worker cannot run and the task dies with zero
    // tokens before any work happens. Demote in place on every inventory load
    // and refresh so the correction survives TTL re-discovery.
    onInventory: (records) => {
      const runnable = new Set(
        runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`),
      );
      for (const rec of records) {
        if (!runnable.has(`${rec.provider}/${rec.id}`)) {
          rec.available = false;
          rec.healthy = false;
          rec.healthReason = "not registered in the execution ModelRuntime";
        }
      }
    },
  });
  await registry.ensureFresh();

  const router = new RoleRouter({ registry, policy, overrides: opts.overrides });

  return {
    router,
    registry,
    async select(role, query) {
      return router.select({ ...(query ?? {}), role });
    },
    async route(role, query) {
      const decision = await router.select({ ...(query ?? {}), role });
      const selected: ModelRef | undefined = decision.selected;
      if (!selected) return undefined;
      return { provider: selected.provider, id: selected.id };
    },
  };
}

// Keep mergeRecords available to callers that assemble their own inventory.
export { mergeRecords };
