/**
 * Mission planner (spec 06 + planner-worker contract): turns a non-trivial goal
 * into a bounded task DAG with real write domains by reusing the planner-worker
 * PLANNER_PROMPT and tolerant parser. Trivial or unparsable plans fall back to
 * the single-task path; a malformed plan never blocks a mission.
 */

import { DIRECTORY_DENY, extractStructured, parsePlannerOutput, scopeConflict } from "../plannerWorker/contract.ts";
import { PLANNER_PROMPT } from "../plannerWorker/prompts.ts";
import type { TaskContract } from "../plannerWorker/types.ts";
import { type PlanTaskInput, intersectWriteDomains } from "./orchestrator.ts";

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
  /**
   * The planner explicitly reported the goal as ambiguous (blocked, with a
   * question). Only then are `tasks` empty so the operator is asked; a
   * malformed plan never sets this.
   */
  clarification?: string;
  /** Planner intent the parser could not honour (e.g. contradictory deny globs), for a minor finding. */
  notes?: string[];
}

/** What the planner worker returned: its worker_result, or plain model text. */
export type PlannerRunOutput =
  | string
  | {
      status?: string;
      summary: string;
      details?: unknown;
      proposed_tasks?: readonly unknown[];
    };

/** Every place the planner worker may have put its contract plan, best first. */
function plannerCandidates(output: PlannerRunOutput): unknown[] {
  if (typeof output === "string") return [output];
  const proposed = (output.proposed_tasks ?? []).map((t) => (typeof t === "string" ? extractStructured(t) : t));
  return [
    output.details,
    // Top-level `contracts` on the result itself.
    { contracts: (output as { contracts?: unknown }).contracts },
    ...(proposed.length > 0 ? [{ contracts: proposed }] : []),
    // Fenced / raw JSON in the summary, the pre-contract way.
    output.summary,
  ].filter(
    (c) =>
      c !== undefined &&
      c !== null &&
      c !== "" &&
      !(typeof c === "object" && "contracts" in c && (c as { contracts?: unknown }).contracts === undefined),
  );
}

/**
 * The planner explicitly reports the goal as ambiguous: a `clarification_question`
 * in its details, or a blocked status whose summary is itself a question. A
 * blocked planner without a question (a tool failure) is not an ambiguous goal.
 */
function clarificationOf(output: PlannerRunOutput): string | undefined {
  if (typeof output === "string") return undefined;
  const d = output.details;
  const asked =
    d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>).clarification_question : undefined;
  if (typeof asked === "string" && asked.trim()) return asked.trim();
  const status = output.status?.toLowerCase();
  const summary = output.summary.trim();
  if ((status === "blocked" || status === "needs_clarification") && summary.endsWith("?")) return summary;
  return undefined;
}

/** The planner call failed in a way worth one retry (gateway/network), not a bad plan. */
export class PlannerTransientError extends Error {}

export const DEFAULT_PLANNER_TIMEOUT_MS = 600_000;

/** PI_MISSION_PLANNER_TIMEOUT_MS bounds the one planner call (default 10 minutes). */
export function plannerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_MISSION_PLANNER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PLANNER_TIMEOUT_MS;
}

const prefixOf = (glob: string): string =>
  glob
    .replace(/^\.\//, "")
    .replace(/\/?\*\*.*$/, "")
    .replace(/\/$/, "");
const under = (path: string, root: string): boolean => root === "" || path === root || path.startsWith(`${root}/`);

/**
 * Write domains a task may keep: bounded repository-relative globs, minus the
 * contract's forbidden globs and read-only roots, inside the manifest's
 * writable domains. Returns the kept domains and what was rejected.
 */
export function scopeTaskDomains(
  c: TaskContract,
  opts: { writableDomains?: string[]; readOnlyPrefixes?: string[] },
): { kept: string[]; rejected: string[] } {
  const rejected: string[] = [];
  let kept: string[] = [];
  // Only a literal path or a literal directory glob ("dir/**", "dir/*") bars a
  // whole subtree; a suffix pattern ("src/**.js") is not a directory root.
  const forbidden = c.scope.forbidden.filter((g) => DIRECTORY_DENY.test(g)).map(prefixOf);
  const readOnly = (opts.readOnlyPrefixes ?? []).map(prefixOf);
  for (const glob of c.scope.allowed) {
    const prefix = prefixOf(glob);
    const escapes = glob.startsWith("/") || /^[A-Za-z]:/.test(glob) || prefix.split("/").includes("..");
    const barred = [...forbidden, ...readOnly].some((root) => root !== "" && under(prefix, root));
    if (escapes || barred || prefix === ".git" || prefix.startsWith(".git/")) rejected.push(glob);
    else kept.push(glob);
  }
  if (opts.writableDomains) {
    const inside = intersectWriteDomains(kept, opts.writableDomains);
    for (const glob of kept)
      if (!inside.some((d) => under(prefixOf(d), prefixOf(glob)) || under(prefixOf(glob), prefixOf(d))))
        rejected.push(glob);
    kept = inside;
  }
  return { kept, rejected };
}

export interface MissionPlanInput {
  /** Manifest writable domains for the repository, when a manifest exists. */
  writableDomains?: string[];
  /** Repository-relative prefixes of read-only / excluded roots. */
  readOnlyPrefixes?: string[];
  goal: string;
  mutates: boolean;
  mode: MissionPlannerMode;
  /** The ONE planner LLM call; returns the worker result (or the model's text). */
  runPlanner: (task: string) => Promise<PlannerRunOutput>;
  single: () => PlanTaskInput;
  acceptanceIds: string[];
}

export const plannerTask = (goal: string): string => `${PLANNER_PROMPT}\n\nMission goal:\n${goal}`;

function contextRef(c: TaskContract): string {
  return JSON.stringify({ relevant_files: c.relevant_files, verification: c.verification, constraints: c.constraints });
}

function toTasks(contracts: TaskContract[], acceptanceIds: string[], domains: Map<string, string[]>): PlanTaskInput[] {
  // Overlapping write domains never run in parallel: serialize the later one
  // behind the earlier unless an ordering already exists.
  const conflicts = (a: TaskContract, b: TaskContract): boolean =>
    scopeConflict(
      { ...a, scope: { ...a.scope, allowed: domains.get(a.task_id) ?? a.scope.allowed } },
      { ...b, scope: { ...b.scope, allowed: domains.get(b.task_id) ?? b.scope.allowed } },
    );
  const deps = new Map(contracts.map((c) => [c.task_id, new Set(c.depends_on)]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(deps.get(from) ?? [])].some((d) => reaches(d, to, seen));
  };
  contracts.forEach((b, j) => {
    for (const a of contracts.slice(0, j)) {
      if (conflicts(a, b) && !reaches(b.task_id, a.task_id) && !reaches(a.task_id, b.task_id)) {
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
    write_domains: domains.get(c.task_id) ?? [...c.scope.allowed],
    isolation: "worktree",
    depends_on: [...(deps.get(c.task_id) ?? [])],
    priority: 0,
    // P3: carry the planner's per-task requirement (model / capabilities) so
    // the broker records it and the router can route the task on it.
    execution_requirements: c.execution
      ? {
          ...(c.execution.model ? { model: c.execution.model } : {}),
          ...(c.execution.capabilities?.length ? { capabilities: [...c.execution.capabilities] } : {}),
        }
      : {},
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
  const fallback = (reason: string): MissionPlanResult => ({ tasks: [input.single()], fallbackReason: reason });
  let output: PlannerRunOutput = "";
  for (let attemptNo = 0; ; attemptNo++) {
    try {
      output = await input.runPlanner(plannerTask(input.goal));
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PlannerTransientError && attemptNo === 0) continue;
      return fallback(
        `${error instanceof PlannerTransientError ? "transient planner failure after one retry" : "planner call failed"}: ${message}`,
      );
    }
  }
  let parsed: Extract<ReturnType<typeof parsePlannerOutput>, { ok: true }> | undefined;
  const errors: string[] = [];
  for (const candidate of plannerCandidates(output)) {
    if (typeof candidate === "string" && extractStructured(candidate) === undefined) continue;
    const attempt = parsePlannerOutput(candidate);
    if (attempt.ok) {
      parsed = attempt;
      break;
    }
    errors.push(...attempt.errors);
  }
  if (!parsed) {
    const asked = clarificationOf(output);
    if (asked) return { tasks: [], clarification: asked };
    return fallback(
      `malformed plan: ${(errors.length > 0 ? errors : ["no structured plan in planner output"]).slice(0, 3).join("; ")}`,
    );
  }
  if (parsed.plan.contracts.length === 0) return fallback("planner returned no contracts");
  const domains = new Map<string, string[]>();
  for (const c of parsed.plan.contracts) {
    const { kept, rejected } = scopeTaskDomains(c, input);
    if (kept.length === 0) {
      return fallback(`task ${c.task_id} has no writable domain; rejected: ${rejected.join(", ") || "(none)"}`);
    }
    domains.set(c.task_id, kept);
  }
  const ignored = parsed.plan.contracts.flatMap((c) =>
    c.ignored_forbidden?.length
      ? [`${c.task_id}: ignored deny globs that contradict its allowed scope: ${c.ignored_forbidden.join(", ")}`]
      : [],
  );
  return {
    tasks: toTasks(parsed.plan.contracts, input.acceptanceIds, domains),
    ...(ignored.length > 0 ? { notes: ignored } : {}),
  };
}
