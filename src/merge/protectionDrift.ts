/**
 * Branch protection drift detection (spec §31, issue #306).
 *
 * A pure, testable decision function that compares the desired branch protection
 * on `main` against the actual protection snapshot. Nothing in the repository
 * models branch protection, so this module is the single place that can tell
 * whether the required gates on main were weakened (CI-006, SEC-003).
 *
 * The function performs no I/O and never mutates its input: it returns a
 * {@link ProtectionDriftResult} describing whether the protection is still
 * enforced, has been weakened, or is unknown because no snapshot is available.
 * All applicable reasons are collected in a fixed order.
 */
export interface BranchProtectionSnapshot {
  requiredStatusChecks: readonly string[];
  strict: boolean;
  requiredApprovingReviews: number;
  enforceAdmins: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

export type ProtectionDriftStatus = "enforced" | "weakened" | "unknown";

export interface ProtectionDriftResult {
  status: ProtectionDriftStatus;
  reasons: string[];
  missingChecks: string[];
  weakenedFields: string[];
}

export interface ProtectionDriftInput {
  desired: BranchProtectionSnapshot;
  actual: BranchProtectionSnapshot | null;
  requiredChecks: readonly string[];
}

/**
 * Evaluate drift between desired and actual branch protection.
 *
 * Rules (all applicable reasons are collected in this fixed order; the named
 * field is appended to `weakenedFields` alongside each reason):
 *
 * 0. If `actual` is null the result is `unknown` and evaluation stops.
 * 1. `checks` is `requiredChecks` followed by `desired.requiredStatusChecks`,
 *    de-duplicated keeping first occurrence. Every check not present in
 *    `actual.requiredStatusChecks` is added to `missingChecks` and reported.
 * 2. Strict status checks disabled.
 * 3. Required approving reviews lowered.
 * 4. Enforce admins disabled.
 * 5. Force pushes allowed.
 * 6. Deletions allowed.
 * 7. Any reason above makes the status `weakened`, otherwise `enforced`.
 *
 * Extra protections in the actual snapshot are fine. The function never sorts,
 * never mutates inputs, returns fresh arrays, and never throws.
 */
export function evaluateProtectionDrift(input: ProtectionDriftInput): ProtectionDriftResult {
  // Rule 0: no actual snapshot -> unknown.
  if (input.actual === null) {
    return { status: "unknown", reasons: ["branch protection unavailable"], missingChecks: [], weakenedFields: [] };
  }

  const reasons: string[] = [];
  const missingChecks: string[] = [];
  const weakenedFields: string[] = [];

  const actual = input.actual;
  const desired = input.desired;

  // Rule 1: required checks, de-duplicated keeping first occurrence.
  const checks: string[] = [];
  for (const name of [...input.requiredChecks, ...desired.requiredStatusChecks]) {
    if (!checks.includes(name)) {
      checks.push(name);
    }
  }
  for (const name of checks) {
    if (!actual.requiredStatusChecks.includes(name)) {
      missingChecks.push(name);
      reasons.push(`required check ${name} not enforced`);
      if (!weakenedFields.includes("requiredStatusChecks")) {
        weakenedFields.push("requiredStatusChecks");
      }
    }
  }

  // Rule 2: strict status checks disabled.
  if (desired.strict && !actual.strict) {
    reasons.push("strict status checks disabled");
    weakenedFields.push("strict");
  }

  // Rule 3: required approving reviews lowered.
  if (actual.requiredApprovingReviews < desired.requiredApprovingReviews) {
    reasons.push(
      `required approving reviews lowered from ${desired.requiredApprovingReviews} to ${actual.requiredApprovingReviews}`,
    );
    weakenedFields.push("requiredApprovingReviews");
  }

  // Rule 4: enforce admins disabled.
  if (desired.enforceAdmins && !actual.enforceAdmins) {
    reasons.push("enforce admins disabled");
    weakenedFields.push("enforceAdmins");
  }

  // Rule 5: force pushes allowed.
  if (!desired.allowForcePushes && actual.allowForcePushes) {
    reasons.push("force pushes allowed");
    weakenedFields.push("allowForcePushes");
  }

  // Rule 6: deletions allowed.
  if (!desired.allowDeletions && actual.allowDeletions) {
    reasons.push("deletions allowed");
    weakenedFields.push("allowDeletions");
  }

  // Rule 7: status.
  return {
    status: reasons.length > 0 ? "weakened" : "enforced",
    reasons,
    missingChecks,
    weakenedFields,
  };
}
