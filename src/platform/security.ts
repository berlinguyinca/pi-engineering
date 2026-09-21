/**
 * Security, permissions & Docker (spec 11) — pi-engineering-owned policy.
 *
 * Enforces:
 *  - identity/project authorization (a principal may act only in projects it
 *    is allowed to touch; the control API cannot bypass worker policy);
 *  - capability ceilings (a child's allowed capability set is the INTERSECTION
 *    of its own allowance and its parent/run ceiling);
 *  - a high-risk approval gate: high-risk operations require approval even
 *    under autonomous mode.
 */

import type { RiskClass } from "./types.ts";

export interface Principal {
  id: string;
  /** Projects this principal may act in. Empty = no access. */
  allowedProjectIds: string[];
  /** Capabilities this principal holds (tool/action names). */
  capabilities: string[];
}

export class ProjectAuth {
  private readonly principals = new Map<string, Principal>();

  register(principal: Principal): void {
    this.principals.set(principal.id, principal);
  }

  get(principalId: string): Principal | undefined {
    return this.principals.get(principalId);
  }

  /** True when the principal may act in the project. */
  canAccess(principalId: string, projectId: string): boolean {
    const p = this.principals.get(principalId);
    return p ? p.allowedProjectIds.includes(projectId) : false;
  }

  /** Effective capability set for a principal in a project, capped by the ceiling. */
  effectiveCapabilities(principalId: string, projectId: string, ceiling: string[] | null): string[] {
    if (!this.canAccess(principalId, projectId)) return [];
    const p = this.principals.get(principalId)!;
    const own = new Set(p.capabilities);
    // A child can never exceed its ceiling: intersect with the ceiling.
    const capped = ceiling ? [...own].filter((c) => ceiling.includes(c)) : [...own];
    return capped;
  }
}

export type HighRiskAction = "deploy" | "database_migration" | "secret_access" | "force_push" | "merge";

/** Actions that may require approval even under autonomous mode. */
export const HIGH_RISK_ACTIONS: HighRiskAction[] = [
  "deploy",
  "database_migration",
  "secret_access",
  "force_push",
  "merge",
];

export interface ApprovalGateOptions {
  /** True when the run is autonomous (bypasses interactive approval). */
  autonomous?: boolean;
  /** Actions exempt from the high-risk gate (explicit operator override). */
  exempt?: HighRiskAction[];
}

export class HighRiskApprovalGate {
  /**
   * Standing exemptions, configured by the operator up front.
   *
   * Distinct from an approval, which is now single-use: `approve()` used to
   * push into this same list, so one operator approval of `deploy` permitted
   * every future deploy for the lifetime of the gate. Approval was per action
   * TYPE when the only useful thing to approve is an action INSTANCE.
   */
  private readonly exempt: HighRiskAction[];
  /** Approvals granted and not yet spent, by operation id. */
  private readonly granted = new Map<HighRiskAction, Set<string>>();

  constructor(opts: ApprovalGateOptions = {}) {
    this.exempt = opts.exempt ?? [];
    // `autonomous` is deliberately not stored. It was stored and never read,
    // so the test asserting "requires approval even under autonomous mode"
    // could not fail — it would have passed with the flag removed. The
    // behaviour it describes is the behaviour below, unconditionally.
    void opts.autonomous;
  }

  /**
   * True when the action may proceed without a fresh approval.
   *
   * `operationId` identifies the concrete operation. Omit it only for a
   * question about the action type in general ("would a deploy need
   * approval?"), which can never be answered "yes, already approved".
   */
  isPermitted(action: HighRiskAction, operationId?: string): boolean {
    if (this.exempt.includes(action)) return true;
    if (!HIGH_RISK_ACTIONS.includes(action)) return true;
    if (!operationId) return false;
    return this.granted.get(action)?.has(operationId) === true;
  }

  /**
   * A human/operator explicitly approved ONE operation.
   *
   * Consumed by the matching `isPermitted`/`consume` pair: approving a deploy
   * permits that deploy, not deploys.
   */
  approve(action: HighRiskAction, operationId: string): void {
    const set = this.granted.get(action) ?? new Set<string>();
    set.add(operationId);
    this.granted.set(action, set);
  }

  /** Spend an approval: true once, false every time after. */
  consume(action: HighRiskAction, operationId: string): boolean {
    if (this.exempt.includes(action)) return true;
    if (!HIGH_RISK_ACTIONS.includes(action)) return true;
    const set = this.granted.get(action);
    if (!set?.has(operationId)) return false;
    set.delete(operationId);
    return true;
  }
}

/** Risk classification helper for a change. */
export function classifyRisk(changedPaths: string[], touchesSecrets: boolean, touchesDeploy: boolean): RiskClass {
  if (touchesSecrets || touchesDeploy) return "high";
  const sensitive = changedPaths.some((p) =>
    /(^|\/)(secrets?|\.env|credentials?|deploy|infra|migrations?)(\/|$)/i.test(p),
  );
  if (sensitive) return "high";
  return "medium";
}
