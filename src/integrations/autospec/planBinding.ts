/**
 * Binds an ingested AutoSpec DAG to the T03 plan-review gate.
 *
 * The gate is the same one a standalone Pi plan goes through: same canonical
 * digest, same configured policy, same fail-closed rules. AutoSpec supplying the
 * plan grants no exemption and AutoSpec cannot choose the review mode, adapter or
 * an override: those come only from Pi's own configuration (`plan_review`).
 */

import { canonicalPlanText, planDigestOf } from "../../orchestration/planRecords.ts";
import { type PlanGateInput, type PlanGateResult, gatePlanBeforeWorkers } from "../../orchestration/planReview.ts";
import type { DagIngestResult } from "./dagIngest.ts";

export type AutoSpecPlanOutcome =
  | { status: "rejected"; code: string; message: string }
  | { status: "unreviewed"; planDigest: string; reason: string; ingest: Extract<DagIngestResult, { ok: true }> }
  | { status: "gated"; gate: PlanGateResult; ingest: Extract<DagIngestResult, { ok: true }> };

export interface BindOptions
  extends Pick<PlanGateInput, "ledger" | "adapter" | "policy" | "emitter" | "maxRevisions" | "now" | "replan"> {
  /** `autospec.dag.enabled` from Pi's own config. False refuses the plan (no ingestion unless configured). */
  dagEnabled: boolean;
  /**
   * Whether plan review is configured at all (loadPlanReviewSettings != null).
   * When false the plan is returned `unreviewed` with its digest: nothing is
   * approved, and nothing is recorded as a decision.
   */
  planReviewConfigured: boolean;
}

export async function bindAutoSpecPlan(ingest: DagIngestResult, opts: BindOptions): Promise<AutoSpecPlanOutcome> {
  if (!opts.dagEnabled) {
    return {
      status: "rejected",
      code: "DAG_DISABLED",
      message: "autospec.dag.enabled is not set in Pi's configuration",
    };
  }
  if (!ingest.ok) return { status: "rejected", code: ingest.code, message: ingest.message };
  if (!opts.planReviewConfigured) {
    return {
      status: "unreviewed",
      planDigest: planDigestOf(canonicalPlanText(ingest.goal, ingest.tasks)),
      reason: "plan review is not configured; the AutoSpec plan runs under Pi's normal gates only",
      ingest,
    };
  }
  const gate = await gatePlanBeforeWorkers({
    missionId: ingest.missionId,
    goal: ingest.goal,
    // Both: the stored revision (restart) and the plan about to run are the ingested tasks.
    plan: async () => ingest.tasks,
    current: ingest.tasks,
    ledger: opts.ledger,
    adapter: opts.adapter ?? null,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
    ...(opts.maxRevisions !== undefined ? { maxRevisions: opts.maxRevisions } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.replan ? { replan: opts.replan } : {}),
  });
  return { status: "gated", gate, ingest };
}
