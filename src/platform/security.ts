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
  private readonly autonomous: boolean;
  private readonly exempt: HighRiskAction[];

  constructor(opts: ApprovalGateOptions = {}) {
    this.autonomous = opts.autonomous ?? false;
    this.exempt = opts.exempt ?? [];
  }

  /** True when the action may proceed without an approval. */
  isPermitted(action: HighRiskAction): boolean {
    if (this.exempt.includes(action)) return true;
    // High-risk actions require approval even under autonomous mode.
    return !HIGH_RISK_ACTIONS.includes(action);
  }

  /** A human/operator explicitly approved the action (clears the gate). */
  approve(action: HighRiskAction): void {
    if (!this.exempt.includes(action)) this.exempt.push(action);
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
