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
  parameters: Type.Object({
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")], {
      description: "Overall outcome",
    }),
    summary: Type.String({ description: "One-paragraph summary (bounded)" }),
    claims: Type.Array(
      Type.Object({
        claim: Type.String(),
        evidence: Type.String({ description: "Evidence reference or 'agent-claim' if unverified" }),
      }),
      { description: "Facts you established, with evidence" },
    ),
    evidence_refs: Type.Array(Type.String(), { description: "Evidence/artifact ids you produced" }),
    new_hypotheses: Type.Array(Type.String(), { description: "Unverified hypotheses; keep small" }),
    proposed_tasks: Type.Array(Type.String(), { description: "Suggested follow-up tasks" }),
    details: Type.Optional(
      Type.Any({ description: "Role-specific structured payload, e.g. candidate_id" }),
    ),
  }),

  async execute(_toolCallId, params) {
    const result: WorkerResult = {
      status: params.status,
      summary: params.summary,
      claims: params.claims,
      evidence_refs: params.evidence_refs,
      new_hypotheses: params.new_hypotheses,
      proposed_tasks: params.proposed_tasks,
      details: params.details ?? {},
    };
    return {
      content: [{ type: "text", text: `Result recorded: ${params.status}` }],
      details: result,
      terminate: true,
    };
  },
});
