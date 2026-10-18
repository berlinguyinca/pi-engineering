import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerResult } from "../core/types.ts";

const exec = promisify(execFile);

/** Message the worker sees when it reports `completed` for a mutating role with nothing to show. */
export const NO_CHANGES_VS_BASE = "no changes vs base: commit your work or report blocked/partial with a reason";

/**
 * Compare the harvestable tree, not the number of commits: empty commits and
 * reverted changes cannot substantiate completion. Git failures are unknown
 * evidence and must propagate so the worker can report blocked instead.
 */
export async function hasNoChangesVsBase(cwd: string, baseRef: string): Promise<boolean> {
  try {
    const base = await exec("git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], { cwd });
    try {
      await exec("git", ["diff", "--quiet", "--no-ext-diff", "--no-textconv", base.stdout.trim(), "--"], { cwd });
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
    return true;
  } catch {
    throw new Error("cannot verify worktree changes: restore Git access and a valid base or report blocked/partial");
  }
}

/**
 * The terminating structured-result tool (spec §17.3 worker output contract).
 *
 * Every delegated worker calls this as its final action. It produces a bounded,
 * machine-readable result via tool parameters, avoiding fragile JSON-in-text
 * parsing and keeping responses small.
 */
export const workerResultTool = defineTool({
  name: "worker_result",
  label: "Worker Result",
  description: "Return your final bounded structured result. Use this as your LAST action when your task is complete.",
  promptSnippet: "Emit your final bounded structured result as a terminating tool result",
  promptGuidelines: [
    "Call worker_result as your final action when the task is complete.",
    "After calling worker_result, do not emit another assistant response.",
  ],
  // Bounds are enforced at the schema level (not just by prompt convention) so
  // a chatty worker cannot blow a downstream caller's context budget.
  parameters: Type.Object({
    status: Type.Union(
      [Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked"), Type.Literal("failed")],
      {
        description:
          "Overall outcome. Use partial (with a reason in the summary and done/remaining in details) when some deliverables are done and others are not.",
      },
    ),
    summary: Type.String({ description: "One-paragraph summary (bounded)", maxLength: 4000 }),
    claims: Type.Array(
      Type.Object({
        claim: Type.String({ maxLength: 4000 }),
        evidence: Type.String({ description: "Evidence reference or 'agent-claim' if unverified", maxLength: 1000 }),
      }),
      { description: "Facts you established, with evidence", maxItems: 20 },
    ),
    evidence_refs: Type.Array(Type.String({ maxLength: 1000 }), {
      description: "Evidence/artifact ids you produced",
      maxItems: 20,
    }),
    new_hypotheses: Type.Array(Type.String({ maxLength: 1000 }), {
      description: "Unverified hypotheses; keep small",
      maxItems: 20,
    }),
    proposed_tasks: Type.Array(Type.String({ maxLength: 1000 }), {
      description: "Suggested follow-up tasks",
      maxItems: 20,
    }),
    details: Type.Optional(Type.Any({ description: "Role-specific structured payload, e.g. candidate_id" })),
  }),

  async execute(_toolCallId, params) {
    const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);
    const partial = params.status === "partial";
    const details: Record<string, unknown> = params.details ?? {};
    const result: WorkerResult = {
      // A partial report is a blocked result that says so: callers keep the
      // three-state contract and the worker's own commits stay recoverable.
      status: params.status === "partial" ? "blocked" : params.status,
      summary: cap(String(params.summary), 4000),
      claims: (params.claims ?? []).slice(0, 20).map((c: { claim?: string; evidence?: string }) => ({
        claim: cap(String(c?.claim ?? ""), 4000),
        evidence: cap(String(c?.evidence ?? "agent-claim"), 1000),
      })),
      evidence_refs: (params.evidence_refs ?? []).slice(0, 20).map((r: string) => cap(String(r), 1000)),
      new_hypotheses: (params.new_hypotheses ?? []).slice(0, 20).map((h: string) => cap(String(h), 1000)),
      proposed_tasks: (params.proposed_tasks ?? []).slice(0, 20).map((t: string) => cap(String(t), 1000)),
      details: partial ? { ...details, partial: true } : details,
    };
    return {
      content: [{ type: "text", text: `Result recorded: ${result.status}` }],
      details: result,
      terminate: true,
    };
  },
});

/**
 * The worker_result tool, optionally guarded: with a `guard`, a `completed`
 * report over a worktree with no changes vs `baseRef` is an error result (the
 * session continues) instead of a terminating result.
 */
export function createWorkerResultTool(guard?: { cwd: string; baseRef: string }): typeof workerResultTool {
  if (!guard) return workerResultTool;
  return {
    ...workerResultTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (
        (params as { status?: string }).status === "completed" &&
        (await hasNoChangesVsBase(guard.cwd, guard.baseRef))
      ) {
        throw new Error(NO_CHANGES_VS_BASE);
      }
      return workerResultTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
