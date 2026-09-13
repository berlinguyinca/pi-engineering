/**
 * Budget manager (spec §23, backlog B-110).
 *
 * Token-budget escalation + marginal-value stopping for orchestration loops.
 *
 *   - `budgetFor(role, round)`: returns a target token budget for a role at a
 *     given round. Budgets escalate from a base toward a hard cap when the
 *     marginal value of additional spend is positive.
 *   - `shouldStop(marginalValue, spent, budget)`: applies marginal-value
 *     stopping — stop spending when the latest increment produced no new
 *     evidence/findings (marginal value ~ 0) and we have exceeded a minimum.
 *
 * Deterministic and dependency-free; the caller supplies measured marginal
 * value (e.g. new findings count from the last round).
 */
export type BudgetRole = "scout" | "implementer" | "reviewer" | "planner";

export interface BudgetSpec {
  /** Starting target tokens. */
  base: number;
  /** Absolute hard cap a role may escalate to. */
  hardCap: number;
  /** Tokens added per escalation step. */
  step: number;
  /** Escalation only if marginal value per token stays above this threshold. */
  marginalThreshold: number;
}

export const DEFAULT_BUDGETS: Record<BudgetRole, BudgetSpec> = {
  scout: { base: 10_000, hardCap: 24_000, step: 4_000, marginalThreshold: 0.05 },
  implementer: { base: 16_000, hardCap: 40_000, step: 8_000, marginalThreshold: 0.05 },
  reviewer: { base: 10_000, hardCap: 24_000, step: 4_000, marginalThreshold: 0.05 },
  planner: { base: 10_000, hardCap: 24_000, step: 4_000, marginalThreshold: 0.05 },
};

export interface BudgetState {
  role: BudgetRole;
  spec: BudgetSpec;
  current: number;
  spent: number;
  escalationLevel: number;
}

export class BudgetManager {
  private readonly specs: Record<BudgetRole, BudgetSpec>;

  constructor(specs: Partial<Record<BudgetRole, BudgetSpec>> = {}) {
    this.specs = { ...DEFAULT_BUDGETS, ...specs };
  }

  spec(role: BudgetRole): BudgetSpec {
    return this.specs[role];
  }

  /**
   * Budget for a role at a round. Round 0 = base. Escalates one step per round
   * up to hardCap when marginal value supports it.
   */
  budgetFor(role: BudgetRole, round: number, lastMarginalValue: number): number {
    const spec = this.specs[role];
    let budget = spec.base;
    for (let r = 1; r <= round; r++) {
      if (lastMarginalValue / (budget || 1) < spec.marginalThreshold) break;
      budget = Math.min(spec.hardCap, budget + spec.step);
    }
    return budget;
  }

  /**
   * Marginal-value stopping: return true when the last increment produced no
   * meaningful new value (e.g. zero new findings/evidence), we've spent at
   * least `minSpend`, and the value-per-token has collapsed.
   */
  shouldStop(marginalValue: number, spent: number, role: BudgetRole, minSpend = 0): boolean {
    const spec = this.specs[role];
    if (spent < Math.max(minSpend, spec.base)) return false; // never stop before base spend
    if (marginalValue > 0) return false; // still producing new value
    return true;
  }

  createState(role: BudgetRole, spent = 0): BudgetState {
    const spec = this.specs[role];
    return { role, spec, current: spec.base, spent, escalationLevel: 0 };
  }
}
