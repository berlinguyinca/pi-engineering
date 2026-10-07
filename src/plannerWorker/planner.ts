/**
 * The planner step (spec §3, §4, §7): mission → validated contract DAG.
 *
 * The planner's raw text is kept as a transcript artifact for the operator and
 * never forwarded to implementers. Invalid output is rejected with the
 * validation errors fed back for a bounded number of attempts.
 */

import { stringify as toYaml } from "yaml";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import { parsePlannerOutput } from "./contract.ts";
import { PLANNER_PROMPT, REPLAN_PROMPT } from "./prompts.ts";
import type { MissionBrief, PlannerOutput, TaskContract } from "./types.ts";

export const PLANNER_TOOLS = ["read", "grep", "find", "ls"];

export interface ModelRef {
  provider: string;
  id: string;
}

/** Replanning input: what is already done and what blocked. */
export interface ReplanRequest {
  passed: string[];
  remaining: TaskContract[];
  blocked: { task_id: string; evidence: string };
}

export type PlannerResult =
  | { ok: true; plan: PlannerOutput; runs: WorkerRun[]; transcript: string }
  | { ok: false; errors: string[]; runs: WorkerRun[]; transcript: string };

/** The planner's structured payload from whichever channel the executor used. */
export function plannerPayload(run: WorkerRun): unknown {
  const s = run.structured;
  if (s && typeof s === "object" && ("contracts" in s || "plan" in s)) return s;
  const d = run.result.details;
  if (d && typeof d === "object" && ("contracts" in d || "plan" in d)) return d;
  return run.result.summary;
}

export async function runPlanner(opts: {
  worker: WorkerExecutor;
  brief: MissionBrief;
  cwd: string;
  model?: ModelRef;
  maxAttempts?: number;
  replan?: ReplanRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PlannerResult> {
  const attempts = Math.max(1, opts.maxAttempts ?? 2);
  const runs: WorkerRun[] = [];
  const transcript: string[] = [];
  let feedback: string[] = [];
  const mission = toYaml({ mission: opts.brief });
  const replan = opts.replan
    ? `\n${toYaml({
        passed_contracts: opts.replan.passed,
        blocked: opts.replan.blocked,
        contracts_to_revise: opts.replan.remaining,
      })}`
    : "";
  for (let i = 0; i < attempts; i++) {
    const task = [
      mission + replan,
      feedback.length > 0
        ? `Your previous plan was rejected by validation. Fix exactly these problems:\n- ${feedback.join("\n- ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const req: WorkerRequest = {
      role: "planner",
      task,
      tools: PLANNER_TOOLS,
      cwd: opts.cwd,
      systemPromptOverride: opts.replan ? REPLAN_PROMPT : PLANNER_PROMPT,
      ...(opts.model ? { modelOverride: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const run = await opts.worker.run(req);
    runs.push(run);
    transcript.push(`## attempt ${i + 1}\n${run.result.summary}`);
    if (run.result.status === "failed") {
      feedback = [run.result.error ?? run.result.summary];
      continue;
    }
    const parsed = parsePlannerOutput(plannerPayload(run), { external: new Set(opts.replan?.passed ?? []) });
    if (parsed.ok) {
      if (opts.replan) {
        const clash = parsed.plan.contracts.filter((c) => opts.replan?.passed.includes(c.task_id));
        if (clash.length > 0) {
          feedback = [`do not re-issue passed contracts: ${clash.map((c) => c.task_id).join(", ")}`];
          continue;
        }
      }
      return { ok: true, plan: parsed.plan, runs, transcript: transcript.join("\n\n") };
    }
    feedback = parsed.errors.slice(0, 12);
  }
  return { ok: false, errors: feedback, runs, transcript: transcript.join("\n\n") };
}
