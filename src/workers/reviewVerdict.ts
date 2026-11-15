import type { WorkerResult } from "../core/types.ts";

/** A delivered `review_result` verdict is a completed review; its summary is bounded. Shared by every executor. */
export function completedReviewResult(structured: unknown): WorkerResult {
  return {
    status: "completed",
    summary: String((structured as { summary?: unknown }).summary ?? "").slice(0, 4000) || "Review recorded.",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
  };
}
