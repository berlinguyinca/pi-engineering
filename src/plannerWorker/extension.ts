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

import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRoleRouter } from "../capability/adapter.ts";
import type { RoleName } from "../capability/roles.ts";
import { loadMissionLimits } from "../lifecycle/policy.ts";
import { workerInactivityMs } from "../orchestration/broker.ts";
import type { MissionAttentionSnapshot } from "../runtime/herdr/MissionAttentionReporter.ts";
import { RuntimeSession } from "../runtime/isolation/RuntimeSession.ts";
import { describeModelChoice, sessionModelChoice } from "../runtime/operatorModelPin.ts";
import type { WorkerExecutor } from "../workers/WorkerExecutor.ts";
import { startPlannerDisplay } from "./activity.ts";
import {
  type PlannerWorkerConfig,
  effectiveMode,
  loadPlannerWorkerConfig,
  plannerWorkerDir,
  writeStoredMode,
} from "./config.ts";
import { type PlannerWorkerEvent, PlannerWorkerExecutor } from "./executor.ts";
import { RouteEventFollower, fetchCatalog } from "./gateway.ts";
import { runHandoff } from "./handoffCommand.ts";
import { chooseExecutionMode } from "./mode.ts";
import { RoleResolver } from "./resolver.ts";
import { STATIC_ROUTER_ROLE } from "./roles.ts";
import {
  applySessionSwitchDecision,
  decideSessionSwitch,
  persistSessionHandoff,
  sessionBranchMessages,
} from "./sessionHandoff.ts";
import { latestState, renderPlan, renderStatus, renderWorkers } from "./status.ts";
import { TransitionLog } from "./transitions.ts";
import { ENGINEERING_MODES, type EngineeringMode, type MissionBrief, type PlannerWorkerReport } from "./types.ts";

/** What the integration needs from the engineering runtime. */
export interface PlannerWorkerHost {
  repoRoot: string;
  worker: WorkerExecutor;
  /** In-memory attention transition tracking; only terminal/stalled states publish to HerdR. */
  reportAttention?: (snapshot: MissionAttentionSnapshot) => void;
  /** Operator-control lines (pause, model pin) of live orchestration missions. */
  missionControlLines?: () => string[];
}

export interface PlannerWorkerIntegration {
  /** Run `request` in planner-worker mode when selected; false lets `/mission` continue. */
  runIfSelected(request: string, ctx: ExtensionCommandContext): Promise<boolean>;
  /** Resume an interrupted planner-worker mission (`PW-…`); false when it is not one. */
  resumeIfOwned(missionId: string, ctx: ExtensionCommandContext): Promise<boolean>;
  /** The mode decision of the latest `runIfSelected` call (for the mission record). */
  lastDecision(): { mode: string; reason: string } | null;
}

/**
 * A fresh mission id: the start second plus a random suffix, so two missions
 * started in the same second never share a state directory or branches.
 */
export function newMissionId(at: Date = new Date()): string {
  const stamp = at
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `PW-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** This session's operator pin (Pi `/model`), read at every role resolution. */
function currentOperatorPin(): { provider: string; id: string } | null {
  const choice = sessionModelChoice(RuntimeSession.current().sessionId);
  return choice?.kind === "pin" ? { provider: choice.pin.provider, id: choice.pin.id } : null;
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
  return { text: renderWorkers(state, args.trim()), level: "info" };
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
    ["workers", "Inspect planner/worker live activity, recent events and results: /engineering-workers [task]."],
  ];
  for (const [name, description] of commands) {
    pi.registerCommand(`engineering-${name}`, {
      description,
      handler: async (args, ctx) => {
        const host = await deps.host(ctx);
        const { repoRoot } = host;
        const config = await loadPlannerWorkerConfig(repoRoot);
        const out = await engineeringCommand(name, args, repoRoot, config);
        // Which model this session's missions run on (the operator pin, if any),
        // and every live mission an operator paused or pinned.
        const text =
          name === "status"
            ? [
                describeModelChoice(sessionModelChoice(RuntimeSession.current().sessionId)),
                ...(host.missionControlLines?.() ?? []),
                out.text,
              ].join("\n")
            : out.text;
        ctx.ui.notify(text, out.level);
      },
    });
  }

  // Manual handoff (Unit B2): build a bounded HandoffArtifact for the latest
  // plan and drive it prepared → committed (aborted on failure).
  pi.registerCommand("handoff", {
    description: "Drive a manual handoff: build a bounded HandoffArtifact for the latest plan and commit it.",
    handler: async (args, ctx) => {
      const host = await deps.host(ctx);
      const state = await latestState(plannerWorkerDir(host.repoRoot));
      const contracts = state?.plan.contracts ?? [];
      const contract = contracts.find((c) => c.task_id === args.trim()) ?? contracts[0];
      if (!contract) {
        ctx.ui.notify("No planner-worker plan to hand off yet.", "info");
        return;
      }
      const brief: MissionBrief = {
        mission_id: state?.mission_id ?? "unknown",
        summary: `Mission ${state?.mission_id ?? "unknown"}: ${contracts.length} contracts`,
        architectural_context: state?.plan.architectural_context ?? [],
        acceptance_criteria: [],
        constraints: [],
      };
      const result = runHandoff({
        kind: "planner_to_worker",
        brief,
        plan: {
          decisions: state?.plan.decisions ?? [],
          architectural_context: state?.plan.architectural_context ?? [],
        },
        contract,
        from: "planner",
        to: "implementer",
      });
      if (result.state === "committed" && result.artifact) {
        ctx.ui.notify(`Handoff committed for ${contract.task_id} (${result.artifact.token_estimate} tokens).`, "info");
      } else {
        ctx.ui.notify(`Handoff aborted: ${result.error ?? "unknown"}`, "error");
      }
    },
  });

  // Interactive session switches: same transition log, same context-fit check.
  if (typeof pi.on === "function") {
    pi.on("model_select", async (event, ctx) => {
      const next = event.model;
      if (!next) return;
      const repoRoot = ctx.cwd;
      const log = new TransitionLog({ path: join(plannerWorkerDir(repoRoot), "session-transitions.jsonl") });
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      // Unit C1: prefer a bounded session handoff over native compaction;
      // selective_compaction stays the last-resort fallback.
      const decision = decideSessionSwitch({
        next: { id: next.id, provider: next.provider, contextWindow: next.contextWindow, input: next.input },
        contextTokens: usage?.tokens ?? null,
        sessionId: ctx.sessionManager.getSessionId(),
        messages: sessionBranchMessages(ctx.sessionManager),
      });
      const nextId = `${next.provider}/${next.id}`;
      const from = event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : null;
      if (deps.sessionGuardActive) {
        // Another guard owns the compact-on-switch decision; record the plain
        // transition as before.
        log.record({
          lane: "session",
          from,
          to: nextId,
          reason: `session:${event.source}`,
          task: "session",
          role: "implementer",
          context: "direct",
        });
        await log.flush();
        return;
      }
      await applySessionSwitchDecision(decision, nextId, {
        recordContext: (context, reason) => {
          log.record({
            lane: "session",
            from,
            to: nextId,
            reason: `session:${event.source}:${context}`,
            task: "session",
            role: "implementer",
            context,
          });
        },
        persist: (d) => persistSessionHandoff(repoRoot, d),
        notify: (message, level) => ctx.ui.notify(message, level),
        compact: (options) => ctx.compact(options),
      });
      await log.flush();
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
      operatorPin: currentOperatorPin,
      // A short deadline: the mode decision must not stall /mission.
      loadCatalog: conn ? () => fetchCatalog({ ...conn, timeoutMs: 5_000 }) : async () => [],
      fallback: async (role, exclude, requirements) => {
        router ??= createRoleRouter({ cwd: repoRoot });
        const adapter = await router.catch(() => null);
        return adapter?.route(STATIC_ROUTER_ROLE[role] as RoleName, {
          exclude: exclude.map((id) => ({ provider, id })),
          minContext: requirements.min_context,
          extraRequires: requirements.tools === true ? ["tool_calling"] : [],
        });
      },
    });
    return { resolver, conn };
  }

  let decided: { mode: string; reason: string } | null = null;

  /** Decide whether planner-worker runs; null keeps the existing /mission flow. */
  async function select(request: string, ctx: ExtensionCommandContext) {
    const host = await deps.host(ctx);
    const config = await loadPlannerWorkerConfig(host.repoRoot);
    const requested = await effectiveMode(host.repoRoot, config);
    decided = { mode: "single", reason: "mode is single" };
    if (requested === "single") return null;
    const built = await resolverFor(ctx, host.repoRoot, config);
    if (!built) return null;
    const decision = await chooseExecutionMode(requested, request, built.resolver);
    decided = decision;
    if (decision.mode === "single") return null;
    return { host, config, ...built, reason: decision.reason };
  }

  async function executorFor(
    ctx: ExtensionCommandContext,
    host: PlannerWorkerHost,
    config: PlannerWorkerConfig,
    built: { resolver: RoleResolver; conn: { baseUrl: string; apiKey?: string } | null },
    missionId: string,
    onEvent: (event: PlannerWorkerEvent) => void,
  ): Promise<PlannerWorkerExecutor> {
    // Same hung-worker window as every other mission worker: the environment
    // override wins, then `limits.worker_inactivity_ms`, then 1 h.
    const limits = await loadMissionLimits(host.repoRoot);
    const executor = new PlannerWorkerExecutor({
      repoRoot: host.repoRoot,
      worker: host.worker,
      resolver: built.resolver,
      stateDir: join(plannerWorkerDir(host.repoRoot), missionId),
      concurrency: config.concurrency,
      ladder: config.ladder,
      convergence: config.convergence,
      workerInactivityMs: process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS
        ? workerInactivityMs()
        : limits.worker_inactivity_ms,
      ...(built.conn ? { routeEvents: new RouteEventFollower(built.conn) } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onEvent: (event) => {
        onEvent(event);
        const stalled =
          event.type === "stalled" ||
          executor.liveSnapshot().activity.some((worker) => worker.ended_at === null && worker.status === "stalled");
        attention(host, { missionId, title: missionId, state: "running", health: stalled ? "stalled" : "active" });
      },
    });
    return executor;
  }

  function attention(host: PlannerWorkerHost, snapshot: MissionAttentionSnapshot): void {
    try {
      host.reportAttention?.(snapshot);
    } catch {
      /* Observers do not control the mission. */
    }
  }

  async function report(
    ctx: ExtensionCommandContext,
    host: PlannerWorkerHost,
    missionId: string,
    executor: PlannerWorkerExecutor,
    work: () => Promise<PlannerWorkerReport>,
  ) {
    let r: PlannerWorkerReport;
    try {
      r = await work();
    } catch (error) {
      if (executor.hasStartedExecution)
        attention(host, {
          missionId,
          title: missionId,
          state: ctx.signal?.aborted ? "canceled" : "failed",
          health: "failed",
        });
      ctx.ui.notify(
        `planner-worker ${executor.hasStartedExecution ? "mission failed" : "request refused"}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    attention(host, {
      missionId,
      title: missionId,
      state: ctx.signal?.aborted ? "canceled" : r.status,
      health:
        r.status === "stalled" || r.status === "escalated" ? "stalled" : r.status === "rejected" ? "failed" : r.status,
    });
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
    lastDecision: () => decided,
    async runIfSelected(request, ctx) {
      // Any failure while deciding falls back to the existing orchestrator.
      decided = null;
      const selected = await select(request, ctx).catch(() => null);
      if (!selected) return false;
      const missionId = newMissionId();
      let display: ReturnType<typeof startPlannerDisplay> | undefined;
      const executor = await executorFor(ctx, selected.host, selected.config, selected, missionId, (event) =>
        display?.event(event),
      );
      display = startPlannerDisplay(ctx.ui, missionId, () => executor.liveSnapshot());
      try {
        await report(ctx, selected.host, missionId, executor, () =>
          executor.run({
            mission_id: missionId,
            summary: request,
            architectural_context: [],
            acceptance_criteria: [],
            constraints: [],
          }),
        );
      } finally {
        display.stop();
      }
      return true;
    },

    async resumeIfOwned(missionId, ctx) {
      if (!/^PW-[\w.-]+$/.test(missionId)) return false;
      const host = await deps.host(ctx);
      const stateDir = join(plannerWorkerDir(host.repoRoot), missionId);
      if (!(await stat(join(stateDir, "state.json")).catch(() => null))) return false;
      const config = await loadPlannerWorkerConfig(host.repoRoot);
      const built = (await resolverFor(ctx, host.repoRoot, config)) ?? {
        resolver: new RoleResolver({ provider: "default", config: config.roles, operatorPin: currentOperatorPin }),
        conn: null,
      };
      let display: ReturnType<typeof startPlannerDisplay> | undefined;
      const executor = await executorFor(ctx, host, config, built, missionId, (event) => display?.event(event));
      display = startPlannerDisplay(ctx.ui, missionId, () => executor.liveSnapshot());
      try {
        await report(ctx, host, missionId, executor, () => executor.resume());
      } finally {
        display.stop();
      }
      return true;
    },
  };
}
