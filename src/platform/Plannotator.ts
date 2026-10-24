/**
 * Plannotator integration adapter (spec 03).
 *
 * Plannotator is an EXTERNAL plan gate. pi-engineering implements only the
 * adapter side: plan handoff, decision ingestion, persisted correlation and
 * policy. It does NOT implement a replacement Plannotator UI/service.
 *
 * Modes:
 *  - interactive: hand the plan to the external Plannotator and wait for
 *    approve / annotate / reject;
 *  - autonomous: bypass Plannotator explicitly, recording the policy decision
 *    in an audit log — it never fakes an approval;
 *  - policy: invoke Plannotator only for configured risk classes; low-risk
 *    plans are auto-approved by policy;
 *  - disabled: no invocation; the decision is recorded as `not_required`.
 *
 * Recovery belongs to pi-engineering only for its OWN pending run/plan
 * correlation state: a pending decision survives restart (see `pendingPlans`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { id } from "../core/ids.ts";
import type { RiskClass } from "./types.ts";

/** The external Plannotator's decision for a plan. */
export type PlannotatorDecision = "approved" | "rejected" | "annotated";

export interface PlanProposal {
  runId: string;
  planRef: string;
  goal: string;
  riskClass: RiskClass;
  /** Hex sha256 over the canonical plan text; the binding key of a decision (T03). */
  planDigest?: string;
  /** The exact plan text the digest was computed over. */
  planText?: string;
  /** Plan revision number within the run. */
  revision?: number;
}

export interface PlanDecision {
  runId: string;
  decision: "approved" | "rejected" | "annotated" | "bypassed" | "none";
  mode: "interactive" | "autonomous" | "policy" | "disabled";
  externalDecisionId: string | null;
  approvedBy: string | null;
  reason: string | null;
  annotations: string[];
  decidedAt: string;
  /** The plan digest this decision is bound to (T03). Absent on legacy records. */
  planDigest?: string | null;
  revision?: number | null;
  /** Review-record state for digest-bound reviews (T03); `decision` is "none" unless `decided`. */
  state?: "pending" | "decided" | "unavailable" | "digest_mismatch";
}

function lastWhere<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return items[i];
  return undefined;
}

/**
 * Transport to the EXTERNAL Plannotator. pi-engineering supplies an HTTP
 * transport in production; tests inject a fake so the adapter is deterministic.
 */
export interface PlannotatorTransport {
  /** Submit a plan and wait for the external decision (interactive). */
  submitPlan(plan: PlanProposal): Promise<{
    decision: PlannotatorDecision;
    externalDecisionId: string | null;
    approvedBy?: string | null;
    annotations?: string[];
    /** The digest the reviewer actually decided on, when it echoes one. */
    planDigest?: string | null;
  }>;
  /**
   * Optional: look up an already-submitted plan's decision (null = still
   * pending). Used to resume after a restart without resubmitting.
   */
  fetchDecision?(plan: PlanProposal): Promise<{
    decision: PlannotatorDecision;
    externalDecisionId: string | null;
    approvedBy?: string | null;
    annotations?: string[];
    planDigest?: string | null;
  } | null>;
}

/** In-memory pending-plan store; the WorkGraph persists correlation. */
export interface PendingPlanStore {
  add(decision: PlanDecision): void;
  all(): PlanDecision[];
  byRun(runId: string): PlanDecision | undefined;
}

/**
 * Durable pending-plan store: an append-only JSONL file, replayed on open, so a
 * pending (or decided) plan survives a restart. A torn last line is ignored.
 */
export class FilePendingPlanStore implements PendingPlanStore {
  private readonly plans: PlanDecision[] = [];
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.plans.push(JSON.parse(line) as PlanDecision);
      } catch {
        // torn tail from a crash mid-append
      }
    }
  }
  add(decision: PlanDecision): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(decision)}\n`, { mode: 0o600 });
    this.plans.push(decision);
  }
  all(): PlanDecision[] {
    return this.plans.slice();
  }
  byRun(runId: string): PlanDecision | undefined {
    return lastWhere(this.plans, (p) => p.runId === runId);
  }
}

/** What a plan review concluded for ONE digest. */
export type PlanReviewOutcome = "approved" | "changes_requested" | "rejected" | "unavailable" | "digest_mismatch";

export interface PlanReviewResult {
  outcome: PlanReviewOutcome;
  decision: PlanDecision;
  /** Why this outcome, e.g. the timeout or the mismatching digest. */
  reason: string;
}

class MemoryPendingStore implements PendingPlanStore {
  private readonly plans: PlanDecision[] = [];
  add(decision: PlanDecision): void {
    this.plans.push(decision);
  }
  all(): PlanDecision[] {
    return this.plans.slice();
  }
  byRun(runId: string): PlanDecision | undefined {
    return lastWhere(this.plans, (p) => p.runId === runId);
  }
}

/** Audit trail for explicit autonomous bypasses (never fakes approval). */
export interface BypassAudit {
  record(entry: { runId: string; planRef: string; reason: string; mode: string }): void;
  entries(): Array<{ runId: string; planRef: string; reason: string; mode: string }>;
}

class MemoryBypassAudit implements BypassAudit {
  private readonly log: Array<{ runId: string; planRef: string; reason: string; mode: string }> = [];
  record(entry: { runId: string; planRef: string; reason: string; mode: string }): void {
    this.log.push(entry);
  }
  entries(): Array<{ runId: string; planRef: string; reason: string; mode: string }> {
    return this.log.slice();
  }
}

export interface PlannotatorOptions {
  /** Transport to the external Plannotator; required for interactive/policy modes. */
  transport?: PlannotatorTransport | null;
  /** Risk classes that trigger an external invocation in "policy" mode. */
  policyRiskClasses?: RiskClass[];
  /** Human who approves (interactive). */
  operator?: string | null;
  store?: PendingPlanStore;
  audit?: BypassAudit;
  /**
   * Require a digest echo from the reviewer for approvals. A transport that
   * cannot echo (a test fake) leaves this off; the Herdr bridge turns it on.
   */
  requireDigestEcho?: boolean;
  /** How long the external gate may hold a plan before silence becomes a rejection. */
  decisionTimeoutMs?: number;
}

export class PlannotatorAdapter {
  private readonly transport: PlannotatorTransport | null;
  private readonly policyRiskClasses: RiskClass[];
  private readonly requireDigestEcho: boolean;
  private readonly store: PendingPlanStore;
  private readonly audit: BypassAudit;
  private readonly decisionTimeoutMs: number;

  constructor(opts: PlannotatorOptions = {}) {
    this.transport = opts.transport ?? null;
    this.policyRiskClasses = opts.policyRiskClasses ?? ["high", "critical"];
    this.requireDigestEcho = opts.requireDigestEcho ?? false;
    this.store = opts.store ?? new MemoryPendingStore();
    this.audit = opts.audit ?? new MemoryBypassAudit();
    this.decisionTimeoutMs = opts.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  }

  /** Pending plan decisions (survives restart when backed by a durable store). */
  pendingPlans(): PlanDecision[] {
    return this.store.all();
  }

  getDecision(runId: string): PlanDecision | undefined {
    return this.store.byRun(runId);
  }

  /**
   * Request a decision for a plan under the configured mode.
   * Returns the correlated decision and records it in the pending store.
   */
  async requestDecision(
    plan: PlanProposal,
    mode: "interactive" | "autonomous" | "policy" | "disabled",
  ): Promise<PlanDecision> {
    const decidedAt = new Date().toISOString();

    if (mode === "disabled") {
      return this.record({
        runId: plan.runId,
        decision: "none",
        mode,
        externalDecisionId: null,
        approvedBy: null,
        reason: "Plannotator disabled by configuration",
        annotations: [],
        decidedAt,
      });
    }

    if (mode === "autonomous") {
      // Explicit bypass: record the policy decision, never fake an approval.
      this.audit.record({ runId: plan.runId, planRef: plan.planRef, reason: "autonomous mode", mode });
      return this.record({
        runId: plan.runId,
        decision: "bypassed",
        mode,
        externalDecisionId: null,
        approvedBy: null,
        reason: "autonomous mode: explicit bypass, approval not faked",
        annotations: [],
        decidedAt,
      });
    }

    const shouldInvoke = mode === "interactive" || this.policyRiskClasses.includes(plan.riskClass);
    if (!shouldInvoke) {
      // Policy mode, low risk: auto-approved by policy.
      return this.record({
        runId: plan.runId,
        decision: "approved",
        mode,
        externalDecisionId: null,
        approvedBy: "policy",
        reason: `risk ${plan.riskClass} below policy gate; auto-approved`,
        annotations: [],
        decidedAt,
      });
    }

    // interactive / policy-with-high-risk: consult the external Plannotator.
    if (!this.transport) {
      throw new Error(`Plannotator ${mode} mode requires a transport to the external Plannotator; none configured.`);
    }
    // Bounded, because an external gate that hangs otherwise parks the run
    // forever — and validated, because whatever it returns is written straight
    // into a persisted approval record that the control plane then serves. An
    // arbitrary `decision` string used to pass, and `annotations` was stored
    // without checking it was an array of bounded strings.
    let result: Awaited<ReturnType<PlannotatorTransport["submitPlan"]>>;
    try {
      result = await withDeadline(this.transport.submitPlan(plan), this.decisionTimeoutMs);
    } catch (err) {
      // A gate that did not answer is NOT an approval. Recording the absence
      // of a decision is the safe reading of silence.
      return this.record({
        runId: plan.runId,
        decision: "rejected",
        mode,
        externalDecisionId: null,
        approvedBy: null,
        reason: err instanceof Error ? err.message : "plan gate did not answer",
        annotations: [],
        decidedAt,
      });
    }
    return this.record({
      runId: plan.runId,
      decision: validDecision(result.decision),
      mode,
      externalDecisionId: boundedString(result.externalDecisionId, MAX_DECISION_ID),
      approvedBy: boundedString(result.approvedBy, MAX_FIELD),
      reason: null,
      annotations: boundedAnnotations(result.annotations),
      decidedAt,
    });
  }

  /** The latest record for exactly this run and digest (never another digest's). */
  decisionFor(runId: string, planDigest: string): PlanDecision | undefined {
    return lastWhere(this.store.all(), (p) => p.runId === runId && p.planDigest === planDigest);
  }

  /**
   * Ask the external Plannotator to review ONE plan digest (T03; modes
   * offer|require are chosen by policy elsewhere). Rules:
   *  - the request is written to the store BEFORE the call, so a restart finds
   *    it pending and resumes instead of losing it;
   *  - a decision is only ever read back for the same digest; one that echoes a
   *    different digest is `digest_mismatch` and authorises nothing;
   *  - a gate that is missing, errors or times out is `unavailable`, never an
   *    approval or a rejection (the caller decides: block for require);
   *  - approved / rejected / annotated are final for that digest and are
   *    returned from the store without asking again.
   */
  async reviewPlan(plan: PlanProposal & { planDigest: string }): Promise<PlanReviewResult> {
    const base = {
      runId: plan.runId,
      mode: "interactive" as const,
      planDigest: plan.planDigest,
      revision: plan.revision ?? null,
    };
    const prior = this.decisionFor(plan.runId, plan.planDigest);
    if (prior?.state === "decided" && prior.decision !== "none" && prior.decision !== "bypassed") {
      return {
        outcome:
          prior.decision === "approved" ? "approved" : prior.decision === "rejected" ? "rejected" : "changes_requested",
        decision: { ...prior },
        reason: "decision already recorded for this plan digest",
      };
    }
    if (!this.transport) return this.unavailable(base, "no Plannotator transport configured");

    if (prior?.state !== "pending") {
      this.store.add({
        ...base,
        decision: "none",
        state: "pending",
        externalDecisionId: null,
        approvedBy: null,
        reason: "awaiting external decision",
        annotations: [],
        decidedAt: new Date().toISOString(),
      });
    }

    let result: Awaited<ReturnType<PlannotatorTransport["submitPlan"]>> | null;
    try {
      const resume = prior?.state === "pending" && this.transport.fetchDecision;
      result = await withDeadline(
        resume ? this.transport.fetchDecision!(plan) : this.transport.submitPlan(plan),
        this.decisionTimeoutMs,
      );
      if (result === null) {
        // Resumed and still undecided: submit once (idempotent by digest).
        result = await withDeadline(this.transport.submitPlan(plan), this.decisionTimeoutMs);
      }
    } catch (err) {
      return this.unavailable(base, err instanceof Error ? err.message : "plan gate did not answer");
    }

    const echoed = typeof result.planDigest === "string" && result.planDigest !== "" ? result.planDigest : null;
    const noEcho = echoed === null && this.requireDigestEcho && validDecision(result.decision) === "approved";
    if (noEcho || (echoed !== null && echoed !== plan.planDigest)) {
      const reason = noEcho
        ? `approval did not echo the plan digest ${plan.planDigest}`
        : `decision is bound to ${echoed}, not ${plan.planDigest}`;
      const decision = this.record({
        ...base,
        decision: "none",
        state: "digest_mismatch",
        externalDecisionId: boundedString(result.externalDecisionId, MAX_DECISION_ID),
        approvedBy: null,
        reason: `digest_mismatch: ${reason}`,
        annotations: [],
        decidedAt: new Date().toISOString(),
      });
      return { outcome: "digest_mismatch", decision, reason };
    }
    const verdict = validDecision(result.decision);
    const decision = this.record({
      ...base,
      decision: verdict,
      state: "decided",
      externalDecisionId: boundedString(result.externalDecisionId, MAX_DECISION_ID),
      approvedBy: boundedString(result.approvedBy, MAX_FIELD),
      reason: null,
      annotations: boundedAnnotations(result.annotations),
      decidedAt: new Date().toISOString(),
    });
    return {
      outcome: verdict === "approved" ? "approved" : verdict === "rejected" ? "rejected" : "changes_requested",
      decision,
      reason: `Plannotator ${verdict}`,
    };
  }

  private unavailable(
    base: { runId: string; mode: "interactive"; planDigest: string; revision: number | null },
    reason: string,
  ): PlanReviewResult {
    const decision = this.record({
      ...base,
      decision: "none",
      state: "unavailable",
      externalDecisionId: null,
      approvedBy: null,
      reason,
      annotations: [],
      decidedAt: new Date().toISOString(),
    });
    return { outcome: "unavailable", decision, reason };
  }

  private record(d: Omit<PlanDecision, "runId"> & { runId: string }): PlanDecision {
    const decision: PlanDecision = { ...d };
    this.store.add(decision);
    return { ...decision };
  }
}

/** Longest an external gate may hold a plan before its silence is a rejection. */
export const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60_000;
const MAX_DECISION_ID = 256;
const MAX_FIELD = 256;
const MAX_ANNOTATIONS = 100;
const MAX_ANNOTATION_LENGTH = 4_096;

/** Reject if `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`plan gate did not answer within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Only the three decisions this model defines; anything else is a rejection. */
function validDecision(value: unknown): PlanDecision["decision"] {
  return value === "approved" || value === "rejected" || value === "annotated" ? value : "rejected";
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function boundedAnnotations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, MAX_ANNOTATIONS)
    .map((entry) => entry.slice(0, MAX_ANNOTATION_LENGTH));
}

/** A no-op id generator re-export to keep plan refs stable within the module. */
export const newPlanRef = (): string => id("PLAN");
