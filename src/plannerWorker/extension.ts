/**
 * Pi wiring for the planner/worker execution mode (spec §12, §26):
 *
 *   /engineering-mode [auto|planner-worker|single]
 *   /engineering-status   /engineering-plan   /engineering-workers
 *
 * plus `runIfSelected`, which `/mission` calls first: when the effective mode
 * (auto → nontrivial mission with distinct planner/implementer models) selects
 * planner-worker, the mission runs here on the runtime's own WorkerExecutor;
 * otherwise `/mission` continues with the existing single-model orchestrator.
 *
 * Interactive model switches stay Pi's own (`model_select`); they are recorded
 * as MODEL_TRANSITION events in the same log and checked for context fit.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRoleRouter } from "../capability/adapter.ts";
import type { RoleName } from "../capability/roles.ts";
import type { WorkerExecutor } from "../workers/WorkerExecutor.ts";
import {
  type PlannerWorkerConfig,
  effectiveMode,
  loadPlannerWorkerConfig,
  plannerWorkerDir,
  writeStoredMode,
} from "./config.ts";
import { PlannerWorkerExecutor } from "./executor.ts";
import { RouteEventFollower, fetchCatalog } from "./gateway.ts";
import { chooseExecutionMode } from "./mode.ts";
import { RoleResolver } from "./resolver.ts";
import { STATIC_ROUTER_ROLE } from "./roles.ts";
import { assessSessionSwitch } from "./sessionSwitch.ts";
import { latestState, renderPlan, renderStatus, renderWorkers } from "./status.ts";
import { TransitionLog } from "./transitions.ts";
import { ENGINEERING_MODES, type EngineeringMode, type PlannerWorkerReport } from "./types.ts";

/** What the integration needs from the engineering runtime. */
export interface PlannerWorkerHost {
  repoRoot: string;
  worker: WorkerExecutor;
}

export interface PlannerWorkerIntegration {
  /** Run `request` in planner-worker mode when selected; false lets `/mission` continue. */
  runIfSelected(request: string, ctx: ExtensionCommandContext): Promise<boolean>;
  /** Resume an interrupted planner-worker mission (`PW-…`); false when it is not one. */
  resumeIfOwned(missionId: string, ctx: ExtensionCommandContext): Promise<boolean>;
}

/** Handle one of the `/engineering-*` commands; returns the operator text. */
export async function engineeringCommand(
  name: "mode" | "status" | "plan" | "workers",
  args: string,
  repoRoot: string,
  config: PlannerWorkerConfig,
): Promise<{ text: string; level: "info" | "error" }> {
  const dir = plannerWorkerDir(repoRoot);
  if (name === "mode") {
    const want = args.trim();
    if (!want) {
      const mode = await effectiveMode(repoRoot, config);
      return { text: `engineering mode: ${mode} (choices: ${ENGINEERING_MODES.join(", ")})`, level: "info" };
    }
    if (!(ENGINEERING_MODES as readonly string[]).includes(want)) {
      return { text: `/engineering-mode ${ENGINEERING_MODES.join("|")}`, level: "error" };
    }
    await writeStoredMode(repoRoot, want as EngineeringMode);
    return { text: `engineering mode set to ${want}`, level: "info" };
  }
  const state = await latestState(dir);
  if (!state) return { text: "No planner-worker mission has run in this repository yet.", level: "info" };
  if (name === "status") return { text: renderStatus(state, await effectiveMode(repoRoot, config)), level: "info" };
  if (name === "plan") return { text: renderPlan(state), level: "info" };
  return { text: renderWorkers(state), level: "info" };
}

/** Gateway connection for the provider whose models serve the roles. */
async function gatewayFor(
  ctx: ExtensionCommandContext,
  provider: string,
): Promise<{ baseUrl: string; apiKey?: string } | null> {
  const registry = ctx.modelRegistry as unknown as
    | { getProviderAuth?: (id: string) => Promise<{ auth: { apiKey?: string; baseUrl?: string } } | undefined> }
    | undefined;
  const auth = await registry?.getProviderAuth?.(provider).catch(() => undefined);
  const baseUrl = auth?.auth.baseUrl ?? (ctx.model?.provider === provider ? ctx.model?.baseUrl : undefined);
  if (!baseUrl) return null;
  return { baseUrl, ...(auth?.auth.apiKey ? { apiKey: auth.auth.apiKey } : {}) };
}

export function registerPlannerWorker(
  pi: ExtensionAPI,
  deps: {
    host: (ctx: ExtensionCommandContext) => Promise<PlannerWorkerHost>;
    /** True when another model-switch guard already compacts on narrower windows. */
    sessionGuardActive?: boolean;
  },
): PlannerWorkerIntegration {
  const commands: Array<["mode" | "status" | "plan" | "workers", string]> = [
    ["mode", "Show or set the engineering execution mode: auto | planner-worker | single."],
    ["status", "Planner/worker mission status: planner, workers, reviewer, attempts, escalations."],
    ["plan", "The current planner/worker contract DAG."],
    ["workers", "Planner/worker contracts and per role/model telemetry."],
  ];
  for (const [name, description] of commands) {
    pi.registerCommand(`engineering-${name}`, {
      description,
      handler: async (args, ctx) => {
        const { repoRoot } = await deps.host(ctx);
        const config = await loadPlannerWorkerConfig(repoRoot);
        const out = await engineeringCommand(name, args, repoRoot, config);
        ctx.ui.notify(out.text, out.level);
      },
    });
  }

  // Interactive session switches: same transition log, same context-fit check.
  if (typeof pi.on === "function") {
    pi.on("model_select", async (event, ctx) => {
      const next = event.model;
      if (!next) return;
      const repoRoot = ctx.cwd;
      const log = new TransitionLog({ path: join(plannerWorkerDir(repoRoot), "session-transitions.jsonl") });
      log.record({
        lane: "session",
        from: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : null,
        to: `${next.provider}/${next.id}`,
        reason: `session:${event.source}`,
        task: "session",
        role: "implementer",
        context: "direct",
      });
      await log.flush();
      if (deps.sessionGuardActive) return;
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      const plan = assessSessionSwitch({
        next: { id: next.id, provider: next.provider, contextWindow: next.contextWindow, input: next.input },
        contextTokens: usage?.tokens ?? null,
      });
      if (plan.outcome === "compact") {
        ctx.ui.notify(`${next.id} holds ${next.contextWindow} tokens; compacting before the next request`, "info");
        ctx.compact({ customInstructions: "Preserve task state, decisions, and open files; compress the rest." });
      } else if (plan.outcome === "reject") {
        ctx.ui.notify(`switch to ${next.id} cannot hold this session: ${plan.reasons.join("; ")}`, "error");
      }
    });
  }

  /** Role resolution for this host: gateway catalogue, then static role pins. */
  async function resolverFor(ctx: ExtensionCommandContext, repoRoot: string, config: PlannerWorkerConfig) {
    const provider = config.provider ?? ctx.model?.provider;
    if (!provider) return null;
    const conn = await gatewayFor(ctx, provider);
    // Static role routing (engineering.yaml pins) is built only if needed.
    let router: ReturnType<typeof createRoleRouter> | null = null;
    const resolver = new RoleResolver({
      provider,
      config: config.roles,
      // A short deadline: the mode decision must not stall /mission.
      loadCatalog: conn ? () => fetchCatalog({ ...conn, timeoutMs: 5_000 }) : async () => [],
      fallback: async (role, exclude) => {
        router ??= createRoleRouter({ cwd: repoRoot });
        const adapter = await router.catch(() => null);
        return adapter?.route(STATIC_ROUTER_ROLE[role] as RoleName, {
          exclude: exclude.map((id) => ({ provider, id })),
        });
      },
    });
    return { resolver, conn };
  }

  /** Decide whether planner-worker runs; null keeps the existing /mission flow. */
  async function select(request: string, ctx: ExtensionCommandContext) {
    const host = await deps.host(ctx);
    const config = await loadPlannerWorkerConfig(host.repoRoot);
    const requested = await effectiveMode(host.repoRoot, config);
    if (requested === "single") return null;
    const built = await resolverFor(ctx, host.repoRoot, config);
    if (!built) return null;
    const decision = await chooseExecutionMode(requested, request, built.resolver);
    if (decision.mode === "single") return null;
    return { host, config, ...built, reason: decision.reason };
  }

  function executorFor(
    ctx: ExtensionCommandContext,
    host: PlannerWorkerHost,
    config: PlannerWorkerConfig,
    built: { resolver: RoleResolver; conn: { baseUrl: string; apiKey?: string } | null },
    missionId: string,
  ): PlannerWorkerExecutor {
    return new PlannerWorkerExecutor({
      repoRoot: host.repoRoot,
      worker: host.worker,
      resolver: built.resolver,
      stateDir: join(plannerWorkerDir(host.repoRoot), missionId),
      concurrency: config.concurrency,
      ladder: config.ladder,
      convergence: config.convergence,
      ...(built.conn ? { routeEvents: new RouteEventFollower(built.conn) } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onEvent: (e) => {
        if (e.type !== "contract" || e.status === "passed" || e.status === "failed" || e.status === "escalated") {
          ctx.ui.notify(
            `[${missionId}] ${e.task_id ? `${e.task_id}: ` : ""}${e.status ?? ""} ${e.text}`.trim(),
            "info",
          );
        }
      },
    });
  }

  async function report(ctx: ExtensionCommandContext, missionId: string, work: () => Promise<PlannerWorkerReport>) {
    let r: PlannerWorkerReport;
    try {
      r = await work();
    } catch (error) {
      ctx.ui.notify(
        `planner-worker mission failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    const passed = r.contracts.filter((c) => c.status === "passed").length;
    ctx.ui.notify(
      [
        `Mission ${missionId} [${r.status}] ${passed}/${r.contracts.length} contracts passed, ${r.transitions.length} model transitions, ${r.replans} replans`,
        r.failure_reason ? `Reason: ${r.failure_reason}` : "",
        r.status === "completed" ? "" : `Resume with /mission resume ${missionId}`,
        "Details: /engineering-status, /engineering-plan, /engineering-workers",
      ]
        .filter(Boolean)
        .join("\n"),
      r.status === "completed" ? "info" : "error",
    );
  }

  return {
    async runIfSelected(request, ctx) {
      // Any failure while deciding falls back to the existing orchestrator.
      const selected = await select(request, ctx).catch(() => null);
      if (!selected) return false;
      ctx.ui.notify(`engineering mode: planner-worker (${selected.reason})`, "info");
      const missionId = `PW-${new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 14)}`;
      const executor = executorFor(ctx, selected.host, selected.config, selected, missionId);
      await report(ctx, missionId, () =>
        executor.run({
          mission_id: missionId,
          summary: request,
          architectural_context: [],
          acceptance_criteria: [],
          constraints: [],
        }),
      );
      return true;
    },

    async resumeIfOwned(missionId, ctx) {
      if (!/^PW-[\w.-]+$/.test(missionId)) return false;
      const host = await deps.host(ctx);
      const stateDir = join(plannerWorkerDir(host.repoRoot), missionId);
      if (!(await stat(join(stateDir, "state.json")).catch(() => null))) return false;
      const config = await loadPlannerWorkerConfig(host.repoRoot);
      const built = (await resolverFor(ctx, host.repoRoot, config)) ?? {
        resolver: new RoleResolver({ provider: "default", config: config.roles }),
        conn: null,
      };
      ctx.ui.notify(`[${missionId}] resuming planner-worker mission`, "info");
      await report(ctx, missionId, () => executorFor(ctx, host, config, built, missionId).resume());
      return true;
    },
  };
}
