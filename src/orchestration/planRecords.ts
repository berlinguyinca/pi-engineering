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

const norm = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();

const list = (items: readonly string[] | undefined): string => [...new Set(items ?? [])].sort().join(", ");

/**
 * Deterministic text of a plan. Order of tasks is meaningful and kept; set-like
 * fields (domains, acceptance ids, deliverables, dependencies) are sorted so
 * the same plan always yields the same text. Volatile fields (ids minted later,
 * timestamps, priorities) are excluded.
 */
export function canonicalPlanText(goal: string, tasks: readonly PlanTaskInput[]): string {
  const lines = ["# Plan", `goal: ${norm(goal)}`];
  tasks.forEach((task, index) => {
    lines.push(
      "",
      `## task ${task.task_id ?? `t${index + 1}`}`,
      `role: ${task.role}`,
      `objective: ${norm(task.objective)}`,
      `mutates_repo: ${task.mutates_repo ? "true" : "false"}`,
      `write_domains: ${list(task.write_domains)}`,
      `depends_on: ${list(task.depends_on)}`,
      `acceptance_ids: ${list(task.acceptance_ids)}`,
      `deliverables: ${list(task.deliverables)}`,
    );
  });
  return `${lines.join("\n")}\n`;
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
