/**
 * Pre-implementation plan gate (T03).
 *
 * Sits between "the planner produced tasks" and "workers start":
 *
 *   assess complexity/risk -> record plan revision (sha256 digest)
 *     -> resolve review mode (skip | offer | require; explicit override recorded)
 *     -> optional Plannotator review bound to THAT digest
 *     -> proceed with the approved tasks, or block / replan.
 *
 * Fail-closed rules:
 *  - a decision is only valid for the digest it was recorded against; approving
 *    digest A never lets digest B through;
 *  - `require` + Plannotator missing / erroring / timing out blocks (no workers);
 *  - `offer` + Plannotator unavailable proceeds, with the skip recorded;
 *  - changes requested / annotated is never an approval: it makes a NEW revision
 *    (new digest) that needs a fresh decision;
 *  - everything is idempotent per mission, so a restart resumes where it was.
 *
 * Needs none of AutoSpec, GitHub, Herdr, InferWeave or Plannotator to run:
 * `skip` (and `offer`/`require` without a gate) are decided locally.
 */

import { type PlanRiskClass, assessComplexity } from "../lifecycle/classification.ts";
import type { PlannotatorAdapter } from "../platform/Plannotator.ts";
import type { EnvelopeDraft, EvidenceRef } from "../runtime/herdr/envelope.ts";
import type { PlanTaskInput } from "./orchestrator.ts";
import {
  type PlanArtifactRef,
  type PlanDecisionOutcome,
  type PlanDecisionRecord,
  type PlanLedger,
  type PlanPolicyRecord,
  type PlanReviewMode,
  type PlanReviewPolicyConfig,
  type PlanRevisionRecord,
  canonicalPlanText,
  planDigestOf,
  resolvePlanReviewPolicy,
} from "./planRecords.ts";

/** The slice of EnvelopeStore the gate needs; optional, absent means no emission. */
export interface PlanLineageEmitter {
  stage(draft: EnvelopeDraft): Promise<unknown>;
}

export interface PlanFeedback {
  annotations: string[];
  revision: PlanRevisionRecord;
  outcome: "changes_requested";
}

export interface PlanGateInput {
  missionId: string;
  goal: string;
  /** Produces the first plan. Not called when the ledger already holds a revision (restart). */
  plan: () => Promise<PlanTaskInput[]>;
  /**
   * The plan the caller will actually run, when it is already known (a
   * submission). If its digest differs from the ledger's latest revision, a new
   * revision (parent = that one) is minted and needs its own decision: the gate
   * binds to what will run, never to what was stored for the same mission id.
   */
  current?: PlanTaskInput[];
  /** Produces a revised plan from reviewer feedback; without it, changes requested blocks. */
  replan?: (feedback: PlanFeedback) => Promise<PlanTaskInput[]>;
  ledger: PlanLedger;
  /** The external review gate; null/undefined means "unavailable". */
  adapter?: PlannotatorAdapter | null;
  policy?: PlanReviewPolicyConfig;
  emitter?: PlanLineageEmitter | null;
  /** An existing registry ref for this plan, recorded on the revisions this call mints. Read-only for Pi. */
  planArtifactRef?: PlanArtifactRef;
  /** Revisions allowed per mission before the gate blocks (default 3). */
  maxRevisions?: number;
  now?: () => Date;
}

export type PlanBlockCode =
  | "plannotator_unavailable"
  | "plan_rejected"
  | "changes_requested"
  | "digest_mismatch"
  | "max_revisions"
  | "replan_unchanged";

export type PlanGateResult =
  | {
      status: "proceed";
      tasks: PlanTaskInput[];
      revision: number;
      planDigest: string;
      mode: PlanReviewMode;
      outcome: PlanDecisionOutcome;
      riskClass: PlanRiskClass;
      complexityScore: number;
      reason: string;
    }
  | {
      status: "blocked";
      code: PlanBlockCode;
      tasks: [];
      revision: number;
      planDigest: string;
      mode: PlanReviewMode;
      riskClass: PlanRiskClass;
      complexityScore: number;
      reason: string;
    };

const DEFAULT_MAX_REVISIONS = 3;

/** Repo-relative path stand-ins for a plan's write domains, so path rules can fire. */
function pathsOf(tasks: readonly PlanTaskInput[]): { path: string; added: boolean; deleted: boolean }[] {
  const seen = new Set<string>();
  for (const task of tasks)
    for (const domain of task.write_domains ?? []) {
      // "src/auth/**" stands for a path under that directory, so keep the slash
      // the directory rules (auth/, migrations/, ...) look for.
      const trimmed = domain.replace(/^\.\//, "");
      const star = trimmed.search(/\*/);
      const path = star < 0 ? trimmed : trimmed.slice(0, star).replace(/[^/]*$/, "");
      if (path) seen.add(path);
    }
  return [...seen].sort().map((path) => ({ path, added: false, deleted: false }));
}

export function assessPlan(goal: string, tasks: readonly PlanTaskInput[]) {
  return assessComplexity({
    request: goal,
    files: pathsOf(tasks),
    mutates: tasks.some((t) => t.mutates_repo),
    taskCount: tasks.length,
  });
}

const lastOf = <T>(items: T[]): T | undefined => items[items.length - 1];
const short = (digest: string): string => digest.slice(0, 12);

/** Run the gate. Never throws for a policy outcome; blocking is a returned status. */
export async function gatePlanBeforeWorkers(input: PlanGateInput): Promise<PlanGateResult> {
  const now = input.now ?? (() => new Date());
  const maxRevisions = input.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const { ledger, missionId } = input;

  const create = async (
    tasks: PlanTaskInput[],
    parent: PlanRevisionRecord | null,
    cause: PlanRevisionRecord["cause"],
  ): Promise<PlanRevisionRecord> => {
    const planText = canonicalPlanText(input.goal, tasks);
    const assessment = assessPlan(input.goal, tasks);
    const record: PlanRevisionRecord = {
      missionId,
      revision: (parent?.revision ?? 0) + 1,
      planDigest: planDigestOf(planText),
      parentRevision: parent?.revision ?? null,
      parentDigest: parent?.planDigest ?? null,
      riskClass: assessment.riskClass,
      complexityScore: assessment.score,
      cause,
      planText,
      tasks: structuredClone(tasks),
      createdAt: now().toISOString(),
      ...(validArtifactRef(input.planArtifactRef) ? { planArtifactRef: { ...input.planArtifactRef } } : {}),
    };
    ledger.appendPlanRevision(record);
    await emitRevision(input.emitter, record, parent);
    return record;
  };

  let rev = lastOf(ledger.listPlanRevisions(missionId));
  if (!rev) rev = await create(await input.plan(), null, "initial");
  else if (input.current && planDigestOf(canonicalPlanText(input.goal, input.current)) !== rev.planDigest) {
    rev = await create(input.current, rev, "operator");
  }

  for (;;) {
    const decisions = ledger.listPlanDecisions(missionId).filter((d) => d.planDigest === rev!.planDigest);
    const prior = lastOf(decisions);
    const base = {
      revision: rev.revision,
      planDigest: rev.planDigest,
      riskClass: rev.riskClass,
      complexityScore: rev.complexityScore,
    };

    // Restart / replay: a recorded go-ahead for exactly this digest is final.
    if (prior?.proceed && satisfiesCurrentPolicy(prior, rev, input.policy)) {
      return {
        status: "proceed",
        tasks: rev.tasks,
        mode: prior.mode,
        outcome: prior.outcome,
        reason: prior.reason,
        ...base,
      };
    }

    let decision: PlanDecisionRecord;
    if (prior?.outcome === "changes_requested") {
      decision = prior;
    } else {
      decision = await review(input, rev, now);
    }

    if (decision.proceed) {
      return {
        status: "proceed",
        tasks: rev.tasks,
        mode: decision.mode,
        outcome: decision.outcome,
        reason: decision.reason,
        ...base,
      };
    }

    if (decision.outcome === "changes_requested") {
      if (!input.replan) {
        return blocked("changes_requested", decision, base, "changes requested and no replanner is configured");
      }
      if (rev.revision >= maxRevisions) {
        return blocked("max_revisions", decision, base, `still not approved after ${rev.revision} revision(s)`);
      }
      const tasks = await input.replan({
        annotations: decision.annotations,
        revision: rev,
        outcome: "changes_requested",
      });
      const next = await create(tasks, rev, "changes_requested");
      if (next.planDigest === rev.planDigest) {
        return blocked(
          "replan_unchanged",
          decision,
          base,
          "the replan produced an identical plan; it needs a fresh decision on a changed plan",
        );
      }
      rev = next;
      continue;
    }

    const code: PlanBlockCode =
      decision.outcome === "rejected"
        ? "plan_rejected"
        : decision.outcome === "digest_mismatch"
          ? "digest_mismatch"
          : "plannotator_unavailable";
    return blocked(code, decision, base, decision.reason);
  }
}

const MODE_RANK: Record<PlanReviewMode, number> = { skip: 0, offer: 1, require: 2 };

/**
 * A recorded approval stands. A recorded skip (policy skip, or offer with the
 * reviewer unavailable) only stands while the CURRENT policy for this risk is no
 * stricter than the mode it was recorded under.
 */
function satisfiesCurrentPolicy(
  prior: PlanDecisionRecord,
  rev: PlanRevisionRecord,
  policy: PlanReviewPolicyConfig | undefined,
): boolean {
  if (prior.outcome === "approved") return true;
  return MODE_RANK[resolvePlanReviewPolicy(rev.riskClass, policy).mode] <= MODE_RANK[prior.mode];
}

function blocked(
  code: PlanBlockCode,
  decision: PlanDecisionRecord,
  base: { revision: number; planDigest: string; riskClass: PlanRiskClass; complexityScore: number },
  why: string,
): PlanGateResult {
  return {
    status: "blocked",
    code,
    tasks: [],
    mode: decision.mode,
    reason: `plan revision ${base.revision} (${short(base.planDigest)}) blocked: ${why}`,
    ...base,
  };
}

async function review(input: PlanGateInput, rev: PlanRevisionRecord, now: () => Date): Promise<PlanDecisionRecord> {
  const { ledger, missionId } = input;
  const resolved = resolvePlanReviewPolicy(rev.riskClass, input.policy);
  const lastPolicy = lastOf(ledger.listPlanPolicies(missionId).filter((p) => p.planDigest === rev.planDigest));
  if (
    !lastPolicy ||
    lastPolicy.mode !== resolved.mode ||
    lastPolicy.source !== resolved.source ||
    lastPolicy.overrideReason !== resolved.overrideReason
  ) {
    const policy: PlanPolicyRecord = {
      missionId,
      revision: rev.revision,
      planDigest: rev.planDigest,
      mode: resolved.mode,
      source: resolved.source,
      riskClass: rev.riskClass,
      defaultMode: resolved.defaultMode,
      reason: resolved.reason,
      overrideReason: resolved.overrideReason,
      operator: resolved.operator,
      recordedAt: now().toISOString(),
    };
    ledger.appendPlanPolicy(policy);
  }
  const mode = resolved.mode;
  const stamp = (): string => now().toISOString();
  const record = async (
    d: Omit<PlanDecisionRecord, "missionId" | "revision" | "planDigest" | "mode" | "decidedAt">,
  ) => {
    const full: PlanDecisionRecord = {
      missionId,
      revision: rev.revision,
      planDigest: rev.planDigest,
      mode,
      decidedAt: stamp(),
      ...d,
    };
    ledger.appendPlanDecision(full);
    await emitDecision(input.emitter, full, rev);
    return full;
  };

  if (mode === "skip") {
    return record({
      outcome: "skipped",
      proceed: true,
      externalDecisionId: null,
      approvedBy: null,
      reason: `review skipped: ${resolved.reason}`,
      annotations: [],
    });
  }

  const result = input.adapter
    ? await input.adapter.reviewPlan({
        runId: missionId,
        planRef: `plan:${missionId}/${rev.revision}`,
        goal: input.goal,
        riskClass: rev.riskClass,
        planDigest: rev.planDigest,
        planText: rev.planText,
        revision: rev.revision,
      })
    : null;
  const outcome = result?.outcome ?? "unavailable";
  const why = result?.reason ?? "no Plannotator adapter configured";
  const external = {
    externalDecisionId: result?.decision.externalDecisionId ?? null,
    approvedBy: result?.decision.approvedBy ?? null,
    annotations: result?.decision.annotations ?? [],
  };

  if (outcome === "approved") return record({ outcome, proceed: true, reason: why, ...external });
  if (outcome === "changes_requested") {
    return record({ outcome, proceed: false, reason: `Plannotator requested changes: ${why}`, ...external });
  }
  if (outcome === "rejected")
    return record({ outcome, proceed: false, reason: `Plannotator rejected the plan: ${why}`, ...external });

  // unavailable | digest_mismatch: nothing authorises this digest.
  if (mode === "offer") {
    return record({
      outcome: "skipped",
      proceed: true,
      reason: `offer: review not obtained (${outcome}: ${why}); proceeding, skip recorded`,
      ...external,
      approvedBy: null,
    });
  }
  return record({
    outcome,
    proceed: false,
    reason: `require: Plannotator ${outcome === "digest_mismatch" ? "answered for another plan digest" : "unavailable"} (${why}); failing closed`,
    ...external,
    approvedBy: null,
  });
}

// ── Lineage emission (only when an emitter is configured) ────────────────────

const planNode = (missionId: string, revision: number): string => `plan:${missionId}/${revision}`;

async function safeStage(emitter: PlanLineageEmitter | null | undefined, draft: EnvelopeDraft): Promise<void> {
  if (!emitter) return;
  try {
    await emitter.stage(draft);
  } catch {
    // Emission is best effort: a control-plane or disk problem never blocks planning.
  }
}

function validArtifactRef(ref: PlanArtifactRef | undefined): ref is PlanArtifactRef {
  return (
    !!ref &&
    typeof ref.id === "string" &&
    ref.id.trim() !== "" &&
    typeof ref.version === "string" &&
    ref.version.trim() !== ""
  );
}

async function emitRevision(
  emitter: PlanLineageEmitter | null | undefined,
  rev: PlanRevisionRecord,
  parent: PlanRevisionRecord | null,
): Promise<void> {
  if (!emitter) return;
  const node = planNode(rev.missionId, rev.revision);
  const common = { occurred_at: rev.createdAt, entity_type: "lineage", mission_id: rev.missionId };
  const evidence: EvidenceRef[] = [{ kind: "plan", uri: node, digest: rev.planDigest, revision: String(rev.revision) }];
  const key = `${rev.missionId}-r${rev.revision}-${short(rev.planDigest)}`;
  await safeStage(emitter, {
    ...common,
    event_id: `plan-${key}-node`,
    entity_id: node,
    event_type: "node.upsert",
    payload: {
      node_type: "plan",
      node_id: node,
      label: `plan revision ${rev.revision}`,
      state: "proposed",
      attrs: {
        plan_digest: rev.planDigest,
        revision: rev.revision,
        risk_class: rev.riskClass,
        complexity_score: rev.complexityScore,
        cause: rev.cause,
        ...(validArtifactRef(rev.planArtifactRef)
          ? { plan_artifact_id: rev.planArtifactRef.id, plan_artifact_version: rev.planArtifactRef.version }
          : {}),
      },
    },
    evidence_refs: evidence,
  });
  // The `produced` edge needs both endpoints to exist in the graph: make sure the mission is there (a bare ensure:
  // a richer upsert by whoever knows the title wins and is never overwritten by this one).
  await safeStage(emitter, {
    ...common,
    event_id: `plan-${rev.missionId}-mission`,
    entity_id: `mission:${rev.missionId}`,
    event_type: "node.upsert",
    payload: { node_type: "mission", node_id: `mission:${rev.missionId}` },
  });
  await safeStage(emitter, {
    ...common,
    event_id: `plan-${key}-produced`,
    entity_id: node,
    event_type: "edge.add",
    payload: {
      edge_type: "produced",
      from_id: `mission:${rev.missionId}`,
      to_id: node,
      attrs: { plan_digest: rev.planDigest },
    },
  });
  if (parent) {
    const parentNode = planNode(parent.missionId, parent.revision);
    await safeStage(emitter, {
      ...common,
      event_id: `plan-${key}-supersedes`,
      entity_id: node,
      event_type: "edge.add",
      payload: {
        edge_type: "supersession",
        from_id: node,
        to_id: parentNode,
        attrs: { plan_digest: rev.planDigest, parent_digest: parent.planDigest },
      },
    });
    await safeStage(emitter, {
      ...common,
      event_id: `plan-${missionIdKey(parent)}-superseded`,
      entity_id: parentNode,
      event_type: "node.state",
      payload: { node_id: parentNode, state: "superseded", reason: `replaced by revision ${rev.revision}` },
    });
  }
}

const missionIdKey = (r: PlanRevisionRecord): string => `${r.missionId}-r${r.revision}-${short(r.planDigest)}`;

async function emitDecision(
  emitter: PlanLineageEmitter | null | undefined,
  d: PlanDecisionRecord,
  rev: PlanRevisionRecord,
): Promise<void> {
  if (!emitter) return;
  const node = planNode(d.missionId, d.revision);
  const common = { occurred_at: d.decidedAt, entity_type: "lineage", mission_id: d.missionId };
  const key = `${missionIdKey(rev)}-${d.outcome}`;
  const state = d.proceed ? (d.outcome === "approved" ? "approved" : "proceeding") : d.outcome;
  await safeStage(emitter, {
    ...common,
    event_id: `plan-${key}-state`,
    entity_id: node,
    event_type: "node.state",
    payload: { node_id: node, state, reason: d.reason },
  });
  // A `reviewed` edge exists only when a reviewer actually answered for this digest.
  if (d.outcome === "approved" || d.outcome === "changes_requested" || d.outcome === "rejected") {
    const reviewer = `review:plannotator/${d.missionId}/${d.revision}`;
    await safeStage(emitter, {
      ...common,
      event_id: `plan-${key}-reviewer`,
      entity_id: reviewer,
      event_type: "node.upsert",
      payload: { node_type: "review", node_id: reviewer, label: "plan review", state: d.outcome },
    });
    await safeStage(emitter, {
      ...common,
      event_id: `plan-${key}-reviewed`,
      entity_id: node,
      event_type: "edge.add",
      payload: {
        edge_type: "reviewed",
        from_id: reviewer,
        to_id: node,
        attrs: { plan_digest: d.planDigest, decision: d.outcome, mode: d.mode },
      },
      evidence_refs: [{ kind: "plan", uri: node, digest: d.planDigest, revision: String(d.revision) }],
    });
  }
}
