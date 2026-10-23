/**
 * Plan revision, review-policy and review-decision records (T03), plus the pure
 * helpers that make them binding: canonical plan text, its sha256 digest, and
 * the skip | offer | require policy resolution.
 *
 * Nothing here depends on AutoSpec, GitHub, Herdr, InferWeave or Plannotator.
 * The digest is the binding key: a decision is only ever valid for the exact
 * digest it was recorded against.
 */

import { createHash } from "node:crypto";
import type { PlanRiskClass } from "../lifecycle/classification.ts";
import type { PlanTaskInput } from "./orchestrator.ts";

export type PlanReviewMode = "skip" | "offer" | "require";
export const PLAN_REVIEW_MODES: readonly PlanReviewMode[] = ["skip", "offer", "require"];

export type PlanPolicySource = "risk_default" | "policy" | "override";

export interface PlanRevisionRecord {
  missionId: string;
  /** 1-based, contiguous per mission. */
  revision: number;
  /** Hex sha256 over {@link canonicalPlanText}. */
  planDigest: string;
  parentRevision: number | null;
  parentDigest: string | null;
  riskClass: PlanRiskClass;
  complexityScore: number;
  /** Why this revision exists. */
  cause: "initial" | "changes_requested" | "rejected" | "operator";
  planText: string;
  /** The exact tasks the digest covers, so a restart resumes the same plan. */
  tasks: PlanTaskInput[];
  createdAt: string;
}

export interface PlanPolicyRecord {
  missionId: string;
  revision: number;
  planDigest: string;
  mode: PlanReviewMode;
  source: PlanPolicySource;
  riskClass: PlanRiskClass;
  /** What the risk-based default would have been, so an override is auditable. */
  defaultMode: PlanReviewMode;
  reason: string;
  /** Present only for an explicit operator override. */
  overrideReason: string | null;
  operator: string | null;
  recordedAt: string;
}

export type PlanDecisionOutcome =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "skipped"
  | "unavailable"
  | "digest_mismatch";

export interface PlanDecisionRecord {
  missionId: string;
  revision: number;
  planDigest: string;
  outcome: PlanDecisionOutcome;
  mode: PlanReviewMode;
  /** Whether workers may start for this digest on the strength of this record. */
  proceed: boolean;
  externalDecisionId: string | null;
  approvedBy: string | null;
  reason: string;
  annotations: string[];
  decidedAt: string;
}

/** Append-only ledger of plan records. MissionStore implements it durably. */
export interface PlanLedger {
  appendPlanRevision(record: PlanRevisionRecord): void;
  appendPlanPolicy(record: PlanPolicyRecord): void;
  appendPlanDecision(record: PlanDecisionRecord): void;
  listPlanRevisions(missionId: string): PlanRevisionRecord[];
  listPlanPolicies(missionId: string): PlanPolicyRecord[];
  listPlanDecisions(missionId: string): PlanDecisionRecord[];
}

export class MemoryPlanLedger implements PlanLedger {
  private readonly revisions: PlanRevisionRecord[] = [];
  private readonly policies: PlanPolicyRecord[] = [];
  private readonly decisions: PlanDecisionRecord[] = [];
  appendPlanRevision(r: PlanRevisionRecord): void {
    this.revisions.push(structuredClone(r));
  }
  appendPlanPolicy(r: PlanPolicyRecord): void {
    this.policies.push(structuredClone(r));
  }
  appendPlanDecision(r: PlanDecisionRecord): void {
    this.decisions.push(structuredClone(r));
  }
  listPlanRevisions(missionId: string): PlanRevisionRecord[] {
    return this.revisions.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }
  listPlanPolicies(missionId: string): PlanPolicyRecord[] {
    return this.policies.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }
  listPlanDecisions(missionId: string): PlanDecisionRecord[] {
    return this.decisions.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }
}

// ── Canonical text and digest ───────────────────────────────────────────────

/** Task fields whose order is meaningless: sorted and de-duplicated in the canonical form. */
const SET_LIKE = new Set(["write_domains", "depends_on", "acceptance_ids", "deliverables", "required_output_artifacts"]);

function canon(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canon(v));
    if (key && SET_LIKE.has(key)) return [...new Set(items.map((i) => JSON.stringify(i)))].sort().map((j) => JSON.parse(j));
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canon(v, k);
    }
    return out;
  }
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
}

/**
 * Deterministic text of a plan, and the EXACT bytes sent to the reviewer: the
 * digest is taken over this text, so what is reviewed is what runs.
 *
 * The body is JSON (strings are quoted, so `["a, b"]` and `["a", "b"]` can never
 * collide) over EVERY field of every task: keys are sorted, set-like fields
 * (domains, dependencies, acceptance, deliverables) are sorted and de-duplicated,
 * and order of tasks is kept. Only a task_id that the planner chose is included;
 * ids minted later by the orchestrator are not part of the plan.
 */
export function canonicalPlanText(goal: string, tasks: readonly PlanTaskInput[]): string {
  const body = { format: "pi-plan/2", goal: canon(goal.trim()), tasks: tasks.map((t) => canon(t)) };
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

/**
 * Lowercase hex sha256 of the canonical text' UTF-8 bytes. Bare hex (no prefix) so
 * it equals the digest Herdr computes over the same plan bytes.
 */
export function planDigestOf(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

// ── Policy ──────────────────────────────────────────────────────────────────

export class PlanReviewPolicyError extends Error {}

export interface PlanReviewOverride {
  mode: PlanReviewMode;
  /** Mandatory: an override without a reason is refused. */
  reason: string;
  operator?: string;
}

export interface PlanReviewPolicyConfig {
  /** Replaces the built-in risk default for the listed classes. */
  modes?: Partial<Record<PlanRiskClass, PlanReviewMode>>;
  override?: PlanReviewOverride;
}

/** Built-in default: small work is not slowed, big work needs a human gate. */
export const DEFAULT_PLAN_REVIEW_MODES: Readonly<Record<PlanRiskClass, PlanReviewMode>> = {
  low: "skip",
  medium: "offer",
  high: "require",
  critical: "require",
};

export interface ResolvedPlanPolicy {
  mode: PlanReviewMode;
  source: PlanPolicySource;
  defaultMode: PlanReviewMode;
  reason: string;
  overrideReason: string | null;
  operator: string | null;
}

export function resolvePlanReviewPolicy(
  riskClass: PlanRiskClass,
  config: PlanReviewPolicyConfig = {},
): ResolvedPlanPolicy {
  const builtin = DEFAULT_PLAN_REVIEW_MODES[riskClass];
  const configured = config.modes?.[riskClass];
  const defaultMode = configured ?? builtin;
  const ov = config.override;
  if (ov) {
    if (!PLAN_REVIEW_MODES.includes(ov.mode)) throw new PlanReviewPolicyError(`invalid override mode "${ov.mode}"`);
    const why = typeof ov.reason === "string" ? ov.reason.trim() : "";
    if (!why) throw new PlanReviewPolicyError("a plan review override requires a non-empty reason");
    return {
      mode: ov.mode,
      source: "override",
      defaultMode,
      reason: `operator override ${defaultMode} -> ${ov.mode} at risk ${riskClass}: ${why}`,
      overrideReason: why,
      operator: ov.operator?.trim() || null,
    };
  }
  if (configured !== undefined && !PLAN_REVIEW_MODES.includes(configured)) {
    throw new PlanReviewPolicyError(`invalid policy mode "${configured}" for risk ${riskClass}`);
  }
  return {
    mode: defaultMode,
    source: configured ? "policy" : "risk_default",
    defaultMode,
    reason: `${configured ? "policy" : "risk default"}: ${defaultMode} at risk ${riskClass}`,
    overrideReason: null,
    operator: null,
  };
}
