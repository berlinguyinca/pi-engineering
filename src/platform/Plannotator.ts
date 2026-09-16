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

import { id } from "../core/ids.ts";
import type { RiskClass } from "./types.ts";

/** The external Plannotator's decision for a plan. */
export type PlannotatorDecision = "approved" | "rejected" | "annotated";

export interface PlanProposal {
  runId: string;
  planRef: string;
  goal: string;
  riskClass: RiskClass;
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
  }>;
}

/** In-memory pending-plan store; the WorkGraph persists correlation. */
export interface PendingPlanStore {
  add(decision: PlanDecision): void;
  all(): PlanDecision[];
  byRun(runId: string): PlanDecision | undefined;
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
    return this.plans.find((p) => p.runId === runId);
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
  /** How long the external gate may hold a plan before silence becomes a rejection. */
  decisionTimeoutMs?: number;
}

export class PlannotatorAdapter {
  private readonly transport: PlannotatorTransport | null;
  private readonly policyRiskClasses: RiskClass[];
  private readonly operator: string | null;
  private readonly store: PendingPlanStore;
  private readonly audit: BypassAudit;
  private readonly decisionTimeoutMs: number;

  constructor(opts: PlannotatorOptions = {}) {
    this.transport = opts.transport ?? null;
    this.policyRiskClasses = opts.policyRiskClasses ?? ["high", "critical"];
    this.operator = opts.operator ?? null;
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
      approvedBy: boundedString(result.approvedBy, MAX_FIELD) ?? this.operator,
      reason: null,
      annotations: boundedAnnotations(result.annotations),
      decidedAt,
    });
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
