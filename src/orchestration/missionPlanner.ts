/**
 * Mission planner (spec 06 + planner-worker contract): turns a non-trivial goal
 * into a bounded task DAG with real write domains by reusing the planner-worker
 * PLANNER_PROMPT and tolerant parser. Trivial or unparsable plans fall back to
 * the single-task path; a malformed plan never blocks a mission.
 */

import { extractStructured, parsePlannerOutput, scopeConflict } from "../plannerWorker/contract.ts";
import { PLANNER_PROMPT } from "../plannerWorker/prompts.ts";
import type { TaskContract } from "../plannerWorker/types.ts";
import type { PlanTaskInput } from "./orchestrator.ts";

export type MissionPlannerMode = "on" | "off" | "auto";

/** PI_MISSION_PLANNER=on|off|auto (default auto). */
export function missionPlannerMode(env: NodeJS.ProcessEnv = process.env): MissionPlannerMode {
  const v = env.PI_MISSION_PLANNER?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : "auto";
}

const LONG_GOAL_WORDS = 30;

/** More than one deliverable implied, a long goal, or several paths/components named. */
export function isNonTrivialGoal(goal: string): boolean {
  const words = goal.trim().split(/\s+/).filter(Boolean).length;
  if (words > LONG_GOAL_WORDS) return true;
  const paths = new Set(goal.match(/(?:[\w.-]+\/)+[\w.*-]*/g) ?? []);
  if (paths.size >= 2) return true;
  const deliverables = goal
    .split(/\b(?:and then|as well as|plus|then)\b|;|,\s*and\s|\band\b/i)
    .filter((p) => p.trim().split(/\s+/).length >= 3);
  return deliverables.length >= 3;
}

export interface MissionPlanResult {
  tasks: PlanTaskInput[];
  /** Why the single-task fallback was used for a planner that was attempted. */
  fallbackReason?: string;
}

export interface MissionPlanInput {
  goal: string;
  mutates: boolean;
  mode: MissionPlannerMode;
  /** The ONE planner LLM call; returns the model's text. */
  runPlanner: (task: string) => Promise<string>;
  single: () => PlanTaskInput;
  acceptanceIds: string[];
}

export const plannerTask = (goal: string): string => `${PLANNER_PROMPT}\n\nMission goal:\n${goal}`;

function contextRef(c: TaskContract): string {
  return JSON.stringify({ relevant_files: c.relevant_files, verification: c.verification, constraints: c.constraints });
}

function toTasks(contracts: TaskContract[], acceptanceIds: string[]): PlanTaskInput[] {
  // Overlapping write domains never run in parallel: serialize the later one
  // behind the earlier unless an ordering already exists.
  const deps = new Map(contracts.map((c) => [c.task_id, new Set(c.depends_on)]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(deps.get(from) ?? [])].some((d) => reaches(d, to, seen));
  };
  contracts.forEach((b, j) => {
    for (const a of contracts.slice(0, j)) {
      if (scopeConflict(a, b) && !reaches(b.task_id, a.task_id) && !reaches(a.task_id, b.task_id)) {
        deps.get(b.task_id)?.add(a.task_id);
      }
    }
  });
  return contracts.map((c) => ({
    task_id: c.task_id,
    kind: "agent",
    role: "implementer",
    objective: [c.objective, ...c.acceptance.map((a) => `Acceptance: ${a}`)].join("\n"),
    mutates_repo: true,
    write_domains: [...c.scope.allowed],
    isolation: "worktree",
    depends_on: [...(deps.get(c.task_id) ?? [])],
    priority: 0,
    execution_requirements: {},
    acceptance_ids: acceptanceIds,
    deliverables: ["implementation", "targeted-tests"],
    checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
    max_attempts: 3,
    failure_policy: "retry",
    context_ref: contextRef(c),
  }));
}

export async function planMission(input: MissionPlanInput): Promise<MissionPlanResult> {
  const attempt = input.mode === "on" || (input.mode === "auto" && isNonTrivialGoal(input.goal));
  if (!attempt || !input.mutates) return { tasks: [input.single()] };
  let parsed: ReturnType<typeof parsePlannerOutput>;
  try {
    const text = await input.runPlanner(plannerTask(input.goal));
    parsed =
      extractStructured(text) === undefined
        ? { ok: false, errors: ["no structured plan in planner output"] }
        : parsePlannerOutput(text);
  } catch (error) {
    return {
      tasks: [input.single()],
      fallbackReason: `planner call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed.ok) return { tasks: [input.single()], fallbackReason: parsed.errors.slice(0, 3).join("; ") };
  if (parsed.plan.contracts.length === 0)
    return { tasks: [input.single()], fallbackReason: "planner returned no contracts" };
  return { tasks: toTasks(parsed.plan.contracts, input.acceptanceIds) };
}
