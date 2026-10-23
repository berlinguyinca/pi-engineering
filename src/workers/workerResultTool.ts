import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerResult } from "../core/types.ts";
import { safeGitOrThrow } from "../git/safeGit.ts";

/** Message the worker sees when it reports `completed` for a mutating role with nothing to show. */
export const NO_CHANGES_VS_BASE =
  "no changes vs base: commit your work or report blocked/partial with a reason. If the objective is ALREADY met " +
  "and needs no change, do not repeat this report — call worker_result with already_satisfied: { reason, proof }, " +
  "proof being a commit sha, file, test, artifact or PR the operator can check.";

/**
 * Compare the harvestable tree, not the number of commits: empty commits and
 * reverted changes cannot substantiate completion. Git failures are unknown
 * evidence and must propagate so the worker can report blocked instead.
 */
export async function hasNoChangesVsBase(cwd: string, baseRef: string): Promise<boolean> {
  try {
    const base = await safeGitOrThrow(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], {
      cwd,
      trust: "operator",
    });
    try {
      await safeGitOrThrow(["diff", "--quiet", base.stdout.trim(), "--"], { cwd, trust: "operator" });
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
  description:
    "Return your final bounded structured result. Use this as your LAST action when your task is complete. " +
    "If you find the objective is already met and needs no change, report it with already_satisfied: { reason, proof } " +
    "rather than repeating a no-change completion (which is rejected).",
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
    /**
     * "The objective is already met by the current state — there is nothing to
     * change." This exists because of how a worker discovers that. When it finds
     * the work already done (merged to base, fixed in an earlier commit, already
     * satisfied), its only truthful report is `completed` with no diff — and the
     * no-changes guard used to THROW that report away. The worker then repeated
     * the identical answer until the loop guard killed the session
     * (`agent.loop_prevented after 0 identical no-progress turns`), recovery read
     * the failure as an IMPLEMENTATION_DEFECT, and another repair task was
     * dispatched to rediscover the same fact — forever, because no path could
     * conclude "nothing to do". Both fields are required so this cannot become a
     * way to finish with no evidence: `proof` must be checkable by the operator.
     */
    already_satisfied: Type.Optional(
      Type.Object(
        {
          reason: Type.String({ description: "Why the objective needs no change", maxLength: 2000 }),
          proof: Type.String({
            description: "A reference the operator can check: commit sha, file, test, artifact, PR",
            maxLength: 2000,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  }),

  async execute(_toolCallId, params) {
    const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);
    const partial = params.status === "partial";
    const details: Record<string, unknown> = params.details ?? {};
    const assertion = validAlreadySatisfied(params.already_satisfied);
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
      details: assertion
        ? { ...(partial ? { ...details, partial: true } : details), already_satisfied: assertion }
        : partial
          ? { ...details, partial: true }
          : details,
    };
    return {
      content: [
        {
          type: "text",
          text: assertion
            ? `Result recorded: ${result.status} — already satisfied, nothing to change. Reason: ${assertion.reason}\nProof: ${assertion.proof}`
            : `Result recorded: ${result.status}`,
        },
      ],
      details: result,
      terminate: true,
    };
  },
});

/**
 * An `already_satisfied` assertion counts only when it carries both a reason and
 * a checkable proof; a blank or whitespace-only field is no assertion, so the
 * caller falls back to the ordinary no-changes rejection rather than letting an
 * empty object close out a mutating task.
 */
function validAlreadySatisfied(value: unknown): { reason: string; proof: string } | undefined {
  const raw = value as { reason?: unknown; proof?: unknown } | undefined;
  if (!raw) return undefined;
  const reason = String(raw.reason ?? "").trim();
  const proof = String(raw.proof ?? "").trim();
  return reason.length > 0 && proof.length > 0 ? { reason, proof } : undefined;
}

/**
 * The worker_result tool, optionally guarded: with a `guard`, a `completed`
 * report over a worktree with no changes vs `baseRef` is an error result (the
 * session continues) instead of a terminating result.
 *
 * The one exception is an explicit, evidenced `already_satisfied` assertion.
 * Throwing at that report is what turned "the work is already done" into a
 * non-terminating task: the worker restated the same conclusion, the guard threw
 * again, and the session died on the loop guard (`agent.loop_prevented after 0
 * identical no-progress turns`) to be re-dispatched by recovery as an
 * implementation defect. A no-op must be a legal ANSWER, not a legal escape from
 * doing work — which is why it is accepted only with a reason and a checkable
 * proof, and is carried on the result so it stays visible downstream.
 */
export function createWorkerResultTool(guard?: { cwd: string; baseRef: string }): typeof workerResultTool {
  if (!guard) return workerResultTool;
  return {
    ...workerResultTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (
        (params as { status?: string }).status === "completed" &&
        !validAlreadySatisfied((params as { already_satisfied?: unknown }).already_satisfied) &&
        (await hasNoChangesVsBase(guard.cwd, guard.baseRef))
      ) {
        throw new Error(NO_CHANGES_VS_BASE);
      }
      return workerResultTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
