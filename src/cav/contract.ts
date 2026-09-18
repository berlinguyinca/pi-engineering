/**
 * CAV-05 Acceptance Contracts: translate specs into executable user journeys
 * with stable requirement IDs.
 *
 * An acceptance contract binds a requirement ID to a deterministic journey:
 * a sequence of named steps, each with a predicate that must hold, plus an
 * optional browser interaction. Contracts are protected artifacts — they may
 * not be silently rewritten by an implementer to make a failing check pass
 * (PROTECTED_ARTIFACTS contract).
 */
import type { Page } from "playwright";

export interface JourneyStep {
  id: string;
  description: string;
  /** Deterministic predicate (no browser) — must return true. */
  assert?: () => boolean;
  /** Browser predicate against a live page. */
  page?: (page: Page) => Promise<boolean>;
  /** Optional browser interaction before the assertion. */
  act?: (page: Page) => Promise<void>;
}

export interface AcceptanceContract {
  /** Stable requirement ID, e.g. "AC-PANEL-01". */
  requirementId: string;
  title: string;
  /** Path this contract protects (protected artifact). */
  protectedPath: string;
  journey: JourneyStep[];
}

export interface JourneyResult {
  requirementId: string;
  passed: boolean;
  steps: Array<{ id: string; passed: boolean; error: string | null }>;
  blockers: string[];
}

/** Run a deterministic journey; fails closed on the first failing step. */
export async function runJourney(contract: AcceptanceContract, opts?: { page?: Page }): Promise<JourneyResult> {
  const steps: JourneyResult["steps"] = [];
  const blockers: string[] = [];
  let passed = true;
  for (const step of contract.journey) {
    let stepPassed = false;
    let error: string | null = null;
    try {
      if (step.act && opts?.page) await step.act(opts.page);
      if (step.assert) {
        stepPassed = step.assert() === true;
      } else if (step.page && opts?.page) {
        stepPassed = (await step.page(opts.page)) === true;
      } else {
        error = "step has no assertion and no page available";
      }
    } catch (e) {
      error = String(e);
    }
    if (error) stepPassed = false;
    steps.push({ id: step.id, passed: stepPassed, error });
    if (!stepPassed) {
      passed = false;
      blockers.push(`${step.id}: ${error ?? "assertion failed"} (${step.description})`);
      break;
    }
  }
  return { requirementId: contract.requirementId, passed, steps, blockers };
}
