/**
 * `planner_worker:` section of the layered engineering policy
 * (~/.pi/agent/engineering.yaml < .pi/engineering.yaml < env), plus the
 * per-repository execution mode chosen with `/engineering-mode`.
 *
 *   planner_worker:
 *     mode: auto                 # auto | planner-worker | single
 *     provider: <pi provider>    # gateway provider whose models serve the roles
 *     concurrency: 2
 *     roles:
 *       implementer: { capability: coding.implementation, alias: coding-implementation, preferred_family: <tag> }
 *     escalation: { max_local_attempts: 2, max_diagnosed_attempts: 1, max_escalation_attempts: 1, max_replans: 2 }
 *     convergence: { stall_after: 2 }
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPolicy } from "../lifecycle/policy.ts";
import { DEFAULT_ROLE_CONFIG, type RoleConfig } from "./roles.ts";
import {
  type ConvergenceConfig,
  DEFAULT_CONVERGENCE,
  DEFAULT_ESCALATION_LADDER,
  ENGINEERING_MODES,
  type EngineeringMode,
  type EscalationLadder,
  PLANNER_WORKER_ROLES,
  type PlannerWorkerRole,
} from "./types.ts";

export interface PlannerWorkerConfig {
  mode: EngineeringMode;
  provider?: string;
  concurrency: number;
  roles: Record<PlannerWorkerRole, RoleConfig>;
  ladder: EscalationLadder;
  convergence: ConvergenceConfig;
  issues: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function posInt(v: unknown, fallback: number, path: string, issues: string[], min = 0): number {
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= 100) return v;
  issues.push(`${path} must be an integer >= ${min}; using ${fallback}`);
  return fallback;
}

/** Validate a raw `planner_worker` object; invalid fields fall back with an issue. */
export function parsePlannerWorkerConfig(raw: unknown): PlannerWorkerConfig {
  const issues: string[] = [];
  const r = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) issues.push("planner_worker must be a mapping");
  let mode: EngineeringMode = "auto";
  if (r.mode !== undefined) {
    if ((ENGINEERING_MODES as readonly unknown[]).includes(r.mode)) mode = r.mode as EngineeringMode;
    else issues.push(`planner_worker.mode must be one of ${ENGINEERING_MODES.join("|")}`);
  }
  const roles = { ...DEFAULT_ROLE_CONFIG } as Record<PlannerWorkerRole, RoleConfig>;
  const rawRoles = isRecord(r.roles) ? r.roles : {};
  for (const [name, value] of Object.entries(rawRoles)) {
    if (!(PLANNER_WORKER_ROLES as readonly string[]).includes(name)) {
      issues.push(`planner_worker.roles.${name} is not a planner/worker role`);
      continue;
    }
    if (!isRecord(value)) continue;
    const role = name as PlannerWorkerRole;
    const merged: RoleConfig = { ...roles[role] };
    if (typeof value.capability === "string" && value.capability) merged.capability = value.capability;
    if (typeof value.alias === "string" && value.alias) merged.alias = value.alias;
    if (typeof value.preferred_family === "string") merged.preferred_family = value.preferred_family;
    if (typeof value.min_context === "number") merged.min_context = value.min_context;
    if (typeof value.tools === "boolean") merged.tools = value.tools;
    roles[role] = merged;
  }
  const e = isRecord(r.escalation) ? r.escalation : {};
  const ladder: EscalationLadder = {
    max_local_attempts: posInt(
      e.max_local_attempts,
      DEFAULT_ESCALATION_LADDER.max_local_attempts,
      "escalation.max_local_attempts",
      issues,
      1,
    ),
    max_diagnosed_attempts: posInt(
      e.max_diagnosed_attempts,
      DEFAULT_ESCALATION_LADDER.max_diagnosed_attempts,
      "escalation.max_diagnosed_attempts",
      issues,
    ),
    max_escalation_attempts: posInt(
      e.max_escalation_attempts,
      DEFAULT_ESCALATION_LADDER.max_escalation_attempts,
      "escalation.max_escalation_attempts",
      issues,
    ),
    max_replans: posInt(e.max_replans, DEFAULT_ESCALATION_LADDER.max_replans, "escalation.max_replans", issues),
  };
  const c = isRecord(r.convergence) ? r.convergence : {};
  const convergence: ConvergenceConfig = {
    stall_after: posInt(c.stall_after, DEFAULT_CONVERGENCE.stall_after, "convergence.stall_after", issues, 1),
  };
  return {
    mode,
    ...(typeof r.provider === "string" && r.provider ? { provider: r.provider } : {}),
    concurrency: posInt(r.concurrency, 2, "planner_worker.concurrency", issues, 1),
    roles,
    ladder,
    convergence,
    issues,
  };
}

export async function loadPlannerWorkerConfig(cwd: string, agentDir?: string): Promise<PlannerWorkerConfig> {
  const { policy } = await loadPolicy({ cwd, ...(agentDir ? { agentDir } : {}) });
  return parsePlannerWorkerConfig((policy as unknown as Record<string, unknown>).planner_worker);
}

/** Where planner/worker state lives for a repository. */
export function plannerWorkerDir(repoRoot: string): string {
  return join(repoRoot, ".pi-eng", "planner-worker");
}

/** The mode stored by `/engineering-mode`, if any. */
export async function readStoredMode(repoRoot: string): Promise<EngineeringMode | null> {
  try {
    const raw = JSON.parse(await readFile(join(plannerWorkerDir(repoRoot), "mode.json"), "utf8")) as { mode?: unknown };
    return (ENGINEERING_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as EngineeringMode) : null;
  } catch {
    return null;
  }
}

export async function writeStoredMode(repoRoot: string, mode: EngineeringMode): Promise<void> {
  await mkdir(plannerWorkerDir(repoRoot), { recursive: true });
  await writeFile(join(plannerWorkerDir(repoRoot), "mode.json"), `${JSON.stringify({ mode }, null, 2)}\n`);
}

/** Effective mode: `/engineering-mode` choice > config > auto. */
export async function effectiveMode(repoRoot: string, config: PlannerWorkerConfig): Promise<EngineeringMode> {
  return (await readStoredMode(repoRoot)) ?? config.mode;
}
