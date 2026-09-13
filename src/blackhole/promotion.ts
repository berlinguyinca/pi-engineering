/**
 * Memory promotion workflow.
 *
 * No auto-promotion of speculative candidate memory: a candidate must be
 * explicitly proposed, then explicitly accepted with evidence, then promoted
 * through the OpenViking abstraction. Every transition emits an audit event
 * (recorded by the caller into the ledger).
 */

import { id } from "../core/ids.ts";
import type { MemoryStore } from "./MemoryStore.ts";
import type { DurableMemoryProvider, DurableMemoryRecord } from "./OpenViking.ts";

export interface PromotionDecision {
  action: "promote" | "reject" | "supersede";
  candidateId: string;
  decidedBy: string;
  note?: string;
}

export interface PromotionOutcome {
  record: DurableMemoryRecord | null;
  state: "promoted" | "rejected" | "superseded";
  candidateId: string;
}

/**
 * Decide a promotion candidate. Evidence-gated: promotion is only allowed when
 * the candidate carries at least one evidence reference (machine evidence, not
 * model confidence) and has been explicitly accepted.
 */
export async function decidePromotion(opts: {
  store: MemoryStore;
  durable: DurableMemoryProvider;
  decision: PromotionDecision;
  now?: () => string;
}): Promise<PromotionOutcome> {
  const { store, durable, decision, now = () => new Date().toISOString() } = opts;
  const candidate = store.getPromotion(decision.candidateId);
  if (!candidate) throw new Error(`promotion candidate not found: ${decision.candidateId}`);

  if (decision.action === "reject") {
    store.decidePromotion(candidate.id, "rejected", decision.decidedBy, decision.note);
    return { record: null, state: "rejected", candidateId: candidate.id };
  }

  if (decision.action === "supersede") {
    store.decidePromotion(candidate.id, "superseded", decision.decidedBy, decision.note);
    return { record: null, state: "superseded", candidateId: candidate.id };
  }

  // promote
  if (candidate.evidenceIds.length === 0) {
    // Evidence-gated: no auto-promotion without evidence (INV-006 analog).
    throw new Error(
      `cannot promote candidate ${candidate.id}: no evidence references. Promotion requires machine evidence.`,
    );
  }
  if (candidate.state !== "proposed") {
    throw new Error(`cannot promote candidate ${candidate.id}: state is ${candidate.state}, expected proposed`);
  }
  store.decidePromotion(candidate.id, "promoted", decision.decidedBy, decision.note);
  const record: DurableMemoryRecord = {
    id: id("dur"),
    text: candidate.text,
    sourceRefs: candidate.sourceRefs,
    promotedFrom: candidate.id,
    evidenceIds: candidate.evidenceIds,
    promotedAt: now(),
    promotedBy: decision.decidedBy,
  };
  await durable.store(record);
  return { record, state: "promoted", candidateId: candidate.id };
}
