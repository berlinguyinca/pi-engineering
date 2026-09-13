import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerResult } from "../core/types.ts";

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
  description:
    "Return your final bounded structured result. Use this as your LAST action when your task is complete.",
  promptSnippet: "Emit your final bounded structured result as a terminating tool result",
  promptGuidelines: [
    "Call worker_result as your final action when the task is complete.",
    "After calling worker_result, do not emit another assistant response.",
  ],
  // Bounds are enforced at the schema level (not just by prompt convention) so
  // a chatty worker cannot blow a downstream caller's context budget.
  parameters: Type.Object({
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")], {
      description: "Overall outcome",
    }),
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
    details: Type.Optional(
      Type.Any({ description: "Role-specific structured payload, e.g. candidate_id" }),
    ),
  }),

  async execute(_toolCallId, params) {
    const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);
    const result: WorkerResult = {
      status: params.status,
      summary: cap(String(params.summary), 4000),
      claims: (params.claims ?? []).slice(0, 20).map((c: { claim?: string; evidence?: string }) => ({
        claim: cap(String(c?.claim ?? ""), 4000),
        evidence: cap(String(c?.evidence ?? "agent-claim"), 1000),
      })),
      evidence_refs: (params.evidence_refs ?? []).slice(0, 20).map((r: string) => cap(String(r), 1000)),
      new_hypotheses: (params.new_hypotheses ?? []).slice(0, 20).map((h: string) => cap(String(h), 1000)),
      proposed_tasks: (params.proposed_tasks ?? []).slice(0, 20).map((t: string) => cap(String(t), 1000)),
      details: params.details ?? {},
    };
    return {
      content: [{ type: "text", text: `Result recorded: ${result.status}` }],
      details: result,
      terminate: true,
    };
  },
});
