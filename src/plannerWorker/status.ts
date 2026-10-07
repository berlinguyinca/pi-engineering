/**
 * Operator views over persisted planner/worker state (spec §22, §26):
 * `/engineering-status`, `/engineering-plan`, `/engineering-workers`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { dagLayers } from "./contract.ts";
import type { ContractState, ModelTransitionEvent, PlannerOutput, RoleModelMetrics } from "./types.ts";

export interface PersistedState {
  mission_id: string;
  status: string;
  contracts: ContractState[];
  transitions: ModelTransitionEvent[];
  stalled_events: Array<{ task_id: string; reasons: string[] }>;
  metrics: RoleModelMetrics[];
  replans: number;
  plan: PlannerOutput;
  integration_branch: string | null;
  failure_reason: string | null;
  updated_at: string;
}

/** The most recently updated mission state under `dir`, if any. */
export async function latestState(dir: string): Promise<PersistedState | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let best: { path: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(dir, e.name, "state.json");
    const s = await stat(path).catch(() => null);
    if (s && (!best || s.mtimeMs > best.mtime)) best = { path, mtime: s.mtimeMs };
  }
  if (!best) return null;
  try {
    return JSON.parse(await readFile(best.path, "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

function lastModel(state: PersistedState, role: string): string {
  const t = [...state.transitions].reverse().find((e) => e.role === role);
  return t?.to ?? "-";
}

const ACTIVE = new Set(["running", "reviewing", "needs_fix", "escalated"]);

export function renderStatus(state: PersistedState, mode: string): string {
  const planned = state.contracts.length > 0;
  const reviewing = state.contracts.some((c) => c.status === "reviewing");
  const attempts = state.contracts.reduce((n, c) => n + c.attempt, 0);
  const escalations = state.contracts.filter((c) => c.rung === "escalated").length;
  const lines = [
    `Mission: ${state.mission_id} [${state.status}]  mode=${mode}`,
    "",
    "Planner:",
    `  ${lastModel(state, "planner")}`,
    `  ${planned ? "complete" : "planning"}${state.replans ? ` (${state.replans} replan${state.replans > 1 ? "s" : ""})` : ""}`,
    "",
    "Workers:",
    ...state.contracts.map(
      (c) => `  ${c.contract.task_id} → ${c.last_model ?? "-"} → ${c.status === "pending" ? "waiting" : c.status}`,
    ),
    "",
    "Reviewer:",
    `  ${lastModel(state, "reviewer")}`,
    `  ${reviewing ? "reviewing" : "idle"}`,
    "",
    `Local attempts: ${attempts}`,
    `Escalations: ${escalations}`,
  ];
  if (state.stalled_events.length > 0) {
    lines.push(`Stalled: ${state.stalled_events.map((s) => `${s.task_id} (${s.reasons.join(", ")})`).join("; ")}`);
  }
  if (state.failure_reason) lines.push(`Reason: ${state.failure_reason}`);
  if (state.integration_branch) lines.push(`Branch: ${state.integration_branch}`);
  return lines.join("\n");
}

export function renderPlan(state: PersistedState): string {
  if (state.plan.contracts.length === 0) return `Mission ${state.mission_id}: no plan yet.`;
  const byId = new Map(state.contracts.map((c) => [c.contract.task_id, c]));
  const lines = [`Mission ${state.mission_id} — ${state.plan.contracts.length} contracts`];
  if (state.plan.decisions.length > 0) lines.push(`Decisions: ${state.plan.decisions.join("; ")}`);
  let layers: string[][];
  try {
    layers = dagLayers(state.plan.contracts).map((l) => l.map((c) => c.task_id));
  } catch {
    layers = [state.plan.contracts.map((c) => c.task_id)];
  }
  layers.forEach((layer, i) => {
    lines.push(`Layer ${i + 1}${layer.length > 1 ? " (parallel)" : ""}:`);
    for (const id of layer) {
      const c = state.plan.contracts.find((x) => x.task_id === id)!;
      const s = byId.get(id)?.status ?? "superseded";
      lines.push(`  [${s}] ${id} (${c.risk}) ${c.objective}`);
      if (c.depends_on.length > 0) lines.push(`      after: ${c.depends_on.join(", ")}`);
      lines.push(`      scope: ${c.scope.allowed.join(", ")}`);
    }
  });
  return lines.join("\n");
}

export function renderWorkers(state: PersistedState): string {
  const lines = ["Contracts:"];
  for (const c of state.contracts) {
    lines.push(
      `  ${c.contract.task_id}: ${c.status} rung=${c.rung} attempts=${c.attempt} model=${c.last_model ?? "-"}${c.worktree && ACTIVE.has(c.status) ? ` worktree=${c.worktree}` : ""}`,
    );
  }
  lines.push("", "Per role/model:");
  lines.push(
    "  role         model                         calls  in/out tok   cached  tools  wall s  retry fail revfail ok  rej  esc",
  );
  for (const m of state.metrics) {
    lines.push(
      `  ${m.role.padEnd(12)} ${m.model.slice(0, 29).padEnd(29)} ${String(m.invocations).padStart(5)}  ${`${m.prompt_tokens}/${m.completion_tokens}`.padStart(11)} ${String(m.cached_tokens).padStart(7)} ${String(m.tool_calls).padStart(6)} ${(m.wall_time_ms / 1000).toFixed(1).padStart(7)} ${String(m.retries).padStart(6)} ${String(m.failures).padStart(4)} ${String(m.review_failures).padStart(7)} ${String(m.accepted_tasks).padStart(3)} ${String(m.rejected_tasks).padStart(4)} ${String(m.escalations).padStart(4)}`,
    );
  }
  const transitions = state.transitions.slice(-8);
  if (transitions.length > 0) {
    lines.push("", "Recent MODEL_TRANSITION events:");
    for (const t of transitions)
      lines.push(`  #${t.seq} ${t.task} ${t.role}: ${t.from ?? "-"} → ${t.to} (${t.reason})`);
  }
  return lines.join("\n");
}
