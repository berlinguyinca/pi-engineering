/**
 * Per role/model accounting (spec §22, §25). Collected, never acted on:
 * learned routing is explicitly out of scope; this is the evidence for it.
 */

import type { WorkerRun } from "../workers/WorkerExecutor.ts";
import type { PlannerWorkerRole, RoleModelMetrics } from "./types.ts";

export type MetricOutcome = "ok" | "failed" | "retry" | "review_failed" | "accepted" | "rejected" | "escalated";

export class RoleModelTelemetry {
  private readonly rows = new Map<string, RoleModelMetrics>();

  private row(role: PlannerWorkerRole, model: string): RoleModelMetrics {
    const key = `${role}\u0000${model}`;
    let r = this.rows.get(key);
    if (!r) {
      r = {
        role,
        model,
        invocations: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        wall_time_ms: 0,
        tool_calls: 0,
        retries: 0,
        failures: 0,
        review_failures: 0,
        accepted_tasks: 0,
        rejected_tasks: 0,
        escalations: 0,
      };
      this.rows.set(key, r);
    }
    return r;
  }

  /** Record one worker invocation. */
  invocation(role: PlannerWorkerRole, model: string, run: WorkerRun, wallMs: number): void {
    const r = this.row(role, model);
    r.invocations += 1;
    r.prompt_tokens += run.usage?.input ?? 0;
    r.completion_tokens += run.usage?.output ?? 0;
    r.cached_tokens += run.usage?.cacheRead ?? 0;
    r.tool_calls += run.toolCalls ?? 0;
    r.wall_time_ms += wallMs;
    if (run.result.status === "failed") r.failures += 1;
  }

  count(role: PlannerWorkerRole, model: string, outcome: MetricOutcome): void {
    const r = this.row(role, model);
    if (outcome === "retry") r.retries += 1;
    else if (outcome === "failed") r.failures += 1;
    else if (outcome === "review_failed") r.review_failures += 1;
    else if (outcome === "accepted") r.accepted_tasks += 1;
    else if (outcome === "rejected") r.rejected_tasks += 1;
    else if (outcome === "escalated") r.escalations += 1;
  }

  list(): RoleModelMetrics[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  totals(): { prompt_tokens: number; completion_tokens: number; tool_calls: number; invocations: number } {
    let prompt_tokens = 0;
    let completion_tokens = 0;
    let tool_calls = 0;
    let invocations = 0;
    for (const r of this.rows.values()) {
      prompt_tokens += r.prompt_tokens;
      completion_tokens += r.completion_tokens;
      tool_calls += r.tool_calls;
      invocations += r.invocations;
    }
    return { prompt_tokens, completion_tokens, tool_calls, invocations };
  }
}
