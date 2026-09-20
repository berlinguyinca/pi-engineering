/**
 * BAR reconciliation logic (steps .../add-reconciliation-logic).
 *
 * Reconciles requirement state against evidence after each campaign. The
 * reconciliation pass recomputes each requirement's deterministic state and
 * reports deltas. It never promotes to VERIFIED from historical claims or from
 * the implementer's own evidence; VERIFIED requires an independent
 * verifier-supplied classification.
 */

import { classifyRequirement } from "./executor.ts";
import type { AuditReport, BarClassification, BarState, RequirementRecord } from "./types.ts";

export interface ReconcileInput {
  requirements: RequirementRecord[];
  /** Independent-verifier classifications (the only path to VERIFIED/FAILED). */
  classifications?: Array<{ requirementId: string; classification: BarClassification }>;
  blockers?: Record<string, string[]>;
}

export interface ReconcileResult {
  requirements: RequirementRecord[];
  deltas: Array<{ requirementId: string; before: BarState; after: BarState }>;
}

/** Recompute deterministic states and report before/after deltas. */
export function reconcile(inputs: ReconcileInput): ReconcileResult {
  const deltas: ReconcileResult["deltas"] = [];
  const requirements = inputs.requirements.map((req) => {
    const before = req.state;
    const blockers = inputs.blockers?.[req.id] ?? req.blockers;
    const explicit = inputs.classifications?.find((c) => c.requirementId === req.id)?.classification;
    const after = classifyRequirement({ ...req, blockers }, explicit);
    if (after !== before) {
      deltas.push({ requirementId: req.id, before, after });
      return { ...req, state: after, blockers, updatedAt: new Date().toISOString() };
    }
    return { ...req, blockers };
  });
  return { requirements, deltas };
}

/** Build the before/after delta list for an audit report. */
export function reportDeltas(audit: ReconcileResult): AuditReport["beforeAfterDeltas"] {
  return audit.deltas.map((d) => d);
}
