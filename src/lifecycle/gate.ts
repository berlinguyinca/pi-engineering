/**
 * Completion gate (spec §21).
 *
 * The gate is the only thing that may declare work complete. It reads harness
 * produced evidence — snapshots, verification outcomes, routed review reports —
 * and never the parent model's prose. A required item whose evidence is absent,
 * unavailable, or skipped does NOT pass.
 */

import type { EngineeringPolicy } from "./policy.ts";
import type {
  Classification,
  GateEvaluation,
  GateItem,
  GateStatus,
  LifecycleRun,
  ReviewReport,
  VerificationReport,
} from "./types.ts";
import { modelKey } from "./types.ts";

export interface GateInput {
  run: LifecycleRun;
  policy: EngineeringPolicy;
  classification?: Classification;
  /** Meaningful change detected in the repository. */
  changeObserved: boolean;
  /** Review reports for the current round (already deduplicated). */
  reviews: ReviewReport[];
  /** Specialist roles that were required for this change. */
  requiredSpecialists: string[];
  verification?: VerificationReport;
  finalVerification?: VerificationReport;
  specVerification?: ReviewReport;
  /** Fingerprints still unresolved after remediation rounds. */
  unresolvedFingerprints: string[];
  /** The model that produced the change (session model or routed implementer). */
  implementerModel?: string;
  /** Test files present in the change set. */
  testFilesChanged: number;
  implementationComplete?: boolean;
}

const BLOCKING_SEVERITIES = new Set(["blocker", "critical", "high"]);

/** Categories whose implementation is expected to carry a test change. */
const TEST_EXPECTED_CATEGORIES = new Set([
  "feature",
  "bugfix",
  "api",
  "database",
  "backend",
  "runtime_system",
  "migration",
]);

function item(key: string, status: GateStatus, required: boolean, reason: string, blockers: string[] = []): GateItem {
  return { key, status, required, reason, blockers };
}

/** A required item only passes on `passed` or a genuine `not_applicable`. */
function satisfied(i: GateItem): boolean {
  if (!i.required) return true;
  return i.status === "passed" || i.status === "not_applicable";
}

export function evaluateGate(input: GateInput): GateEvaluation {
  const require = input.policy.policies.completion_gate.require;
  const items: GateItem[] = [];
  const cats = new Set(input.classification?.categories ?? []);
  const chatOnly = cats.size > 0 && [...cats].every((c) => c === "chat");

  if (!input.changeObserved || chatOnly) {
    // Nothing was built: there is nothing to review or verify. This is an
    // explicit not-applicable, not a silent pass.
    const reason = chatOnly
      ? "request classified as chat; no engineering change expected"
      : "no repository change detected";
    for (const key of Object.keys(require)) {
      items.push(item(key, "not_applicable", require[key as keyof typeof require], reason));
    }
    return { pass: true, items, blockers: [], evaluatedAt: new Date().toISOString() };
  }

  // 1. Implementation complete — a change exists and was not left mid-flight.
  const implementationComplete = input.implementationComplete ?? input.changeObserved;
  items.push(
    item(
      "implementation_complete",
      implementationComplete ? "passed" : "failed",
      require.implementation_complete,
      implementationComplete ? "change set captured" : "no captured change set",
      implementationComplete ? [] : ["implementation_complete"],
    ),
  );

  // 2. Independent review.
  const independent = input.reviews.filter((r) => r.role !== "spec_verifier");
  if (!input.policy.policies.review.require_independent_review) {
    items.push(
      item(
        "independent_review_pass",
        "skipped",
        require.independent_review_pass,
        "policies.review.require_independent_review is false",
      ),
    );
  } else if (independent.length === 0) {
    items.push(
      item("independent_review_pass", "failed", require.independent_review_pass, "no independent review was executed", [
        "independent_review_pass",
      ]),
    );
  } else {
    const failed = independent.filter((r) => r.verdict === "failed");
    const changesRequested = independent.filter((r) => r.verdict === "request_changes");
    const sameModel = input.policy.policies.review.independent_reviewer
      ? independent.filter((r) => input.implementerModel && modelKey(r.model) === input.implementerModel)
      : [];
    const blockers: string[] = [];
    if (failed.length) blockers.push(`${failed.map((r) => r.role).join(", ")} could not be executed`);
    if (changesRequested.length) {
      const blockingFindings = changesRequested.flatMap((r) =>
        r.findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity)),
      );
      if (blockingFindings.length > input.policy.policies.review.max_blocking_findings_to_pass) {
        blockers.push(
          `${blockingFindings.length} blocking finding(s) from ${changesRequested.map((r) => r.role).join(", ")}`,
        );
      }
    }
    if (sameModel.length)
      blockers.push(
        `${sameModel.map((r) => r.role).join(", ")} ran on the implementing model (${input.implementerModel})`,
      );
    items.push(
      item(
        "independent_review_pass",
        blockers.length ? "failed" : "passed",
        require.independent_review_pass,
        blockers.length
          ? blockers.join("; ")
          : `reviewed by ${independent.map((r) => `${r.role}@${modelKey(r.model)}`).join(", ")}`,
        blockers,
      ),
    );
  }

  // 3. Specialist review.
  if (input.requiredSpecialists.length === 0) {
    items.push(
      item(
        "specialist_review_pass",
        "not_applicable",
        require.specialist_review_pass,
        "no specialist trigger for this change set",
      ),
    );
  } else {
    const byRole = new Map(input.reviews.map((r) => [r.role, r]));
    const missing = input.requiredSpecialists.filter((role) => !byRole.has(role));
    const failedSpecialists = input.requiredSpecialists.filter((role) => byRole.get(role)?.verdict === "failed");
    const requested = input.requiredSpecialists.filter((role) => {
      const report = byRole.get(role);
      return report?.verdict === "request_changes" && report.findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
    });
    const blockers: string[] = [];
    if (missing.length) blockers.push(`missing specialist review: ${missing.join(", ")}`);
    if (failedSpecialists.length) blockers.push(`specialist could not run: ${failedSpecialists.join(", ")}`);
    if (requested.length) blockers.push(`specialist requested changes: ${requested.join(", ")}`);
    items.push(
      item(
        "specialist_review_pass",
        blockers.length ? "failed" : "passed",
        require.specialist_review_pass,
        blockers.length ? blockers.join("; ") : `specialists satisfied: ${input.requiredSpecialists.join(", ")}`,
        blockers,
      ),
    );
  }

  // 4. Implementation verification.
  pushVerification(items, "verification_pass", input.verification, require.verification_pass, "implementation");

  // 5. Spec verification.
  if (!input.specVerification) {
    items.push(
      item(
        "spec_verification_pass",
        "not_applicable",
        require.spec_verification_pass,
        "no specification or requirement set was supplied for this work item",
      ),
    );
  } else if (input.specVerification.verdict === "failed") {
    items.push(
      item(
        "spec_verification_pass",
        "failed",
        require.spec_verification_pass,
        "spec verification could not be executed",
        ["spec_verification_pass"],
      ),
    );
  } else {
    const gaps = input.specVerification.specGaps.filter(
      (g) => g.status !== "unverifiable" || BLOCKING_SEVERITIES.has(g.severity),
    );
    const blocking = gaps.filter((g) => BLOCKING_SEVERITIES.has(g.severity) || g.status === "missing");
    items.push(
      item(
        "spec_verification_pass",
        blocking.length ? "failed" : "passed",
        require.spec_verification_pass,
        blocking.length
          ? `${blocking.length} unmet requirement(s): ${blocking.map((g) => `${g.status}: ${g.requirement}`).join(" | ")}`
          : "all quoted requirements verified as satisfied",
        blocking.length ? ["spec_verification_pass"] : [],
      ),
    );
  }

  // 6. Final verification (after remediation).
  pushVerification(items, "final_verification_pass", input.finalVerification, require.final_verification_pass, "final");

  // 7. Unresolved high-risk findings.
  const unresolvedHigh = input.unresolvedFingerprints;
  items.push(
    item(
      "no_unresolved_high_risk_findings",
      unresolvedHigh.length ? "failed" : "passed",
      require.no_unresolved_high_risk_findings,
      unresolvedHigh.length
        ? `${unresolvedHigh.length} unresolved high-severity finding(s): ${unresolvedHigh.slice(0, 4).join(", ")}`
        : "no unresolved high-severity findings",
      unresolvedHigh.length ? ["no_unresolved_high_risk_findings"] : [],
    ),
  );

  // 8. Tests when required.
  const expectsTests = [...cats].some((c) => TEST_EXPECTED_CATEGORIES.has(c));
  const ranTests = (input.verification?.outcomes ?? []).some(
    (o) => o.spec.kind === "test" && (o.status === "passed" || o.status === "failed"),
  );
  if (!expectsTests) {
    items.push(
      item(
        "tests_when_required",
        "not_applicable",
        require.tests_when_required,
        "change categories do not require new tests",
      ),
    );
  } else if (input.testFilesChanged > 0 || ranTests) {
    items.push(
      item(
        "tests_when_required",
        "passed",
        require.tests_when_required,
        input.testFilesChanged > 0
          ? `${input.testFilesChanged} test file(s) changed`
          : "test suite executed as part of verification",
      ),
    );
  } else {
    items.push(
      item(
        "tests_when_required",
        "failed",
        require.tests_when_required,
        "behaviour-bearing change with no test change and no test command run",
        ["tests_when_required"],
      ),
    );
  }

  const blockers = items
    .filter((i) => !satisfied(i))
    .flatMap((i) => (i.blockers.length ? i.blockers : [`${i.key}: ${i.reason}`]));
  return { pass: blockers.length === 0, items, blockers, evaluatedAt: new Date().toISOString() };
}

function pushVerification(
  items: GateItem[],
  key: string,
  report: VerificationReport | undefined,
  required: boolean,
  stage: string,
): void {
  if (!report) {
    items.push(item(key, "failed", required, `no ${stage} verification evidence recorded`, [key]));
    return;
  }
  if (report.status === "passed") {
    items.push(
      item(
        key,
        "passed",
        required,
        `${stage} checks: ${report.outcomes.map((o) => `${o.spec.name}=${o.status}`).join(", ") || "none required"}`,
      ),
    );
    return;
  }
  if (report.status === "not_applicable") {
    items.push(
      item(key, "not_applicable", required, `no ${stage} verification command is declared for this repository`),
    );
    return;
  }
  if (report.status === "unavailable") {
    items.push(item(key, "unavailable", required, `${stage} verification command is unavailable`, [key]));
    return;
  }
  if (report.status === "skipped") {
    items.push(item(key, "skipped", required, `${stage} verification was skipped`, [key]));
    return;
  }
  items.push(item(key, "failed", required, report.blocking.join("; ") || `${stage} verification failed`, [key]));
}
