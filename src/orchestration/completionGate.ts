/**
 * Deterministic completion gate (spec 07).
 *
 * A mission may transition to COMPLETE only if:
 *   - all required gates are satisfied,
 *   - no blocking findings remain,
 *   - no required task is still running,
 *   - validation evidence exists where required,
 *   - independent review evidence exists where required.
 *
 * This is application logic, not a prompt: the model cannot mark a failing
 * mission complete.
 */

import type { MissionStore } from "./missionStore.ts";
import type { CompletionVerdict, Mission, RequiredGate } from "./types.ts";

export interface GateEvidence {
  missionId: string;
  validationsPassed: number;
  reviewsCompleted: number;
  /** Findings keyed by finding_id with status. */
  findings: Array<{ finding_id: string; severity: string; status: string }>;
}

export class CompletionGate {
  private readonly store: MissionStore;

  constructor(store: MissionStore) {
    this.store = store;
  }

  /** Evaluate whether a mission may complete, given current state. */
  evaluate(mission: Mission, evidence: GateEvidence = this.gather(mission.mission_id)): CompletionVerdict {
    const reasons: string[] = [];
    const missingGates: RequiredGate[] = [];
    const tasks = this.store.listTasks(mission.mission_id);

    const running = tasks.filter((t) => ["READY", "RUNNING", "RETRYING", "WAITING", "PENDING"].includes(t.status));
    const failed = tasks.filter((t) => t.status === "FAILED");

    // Required gates.
    for (const gate of mission.required_gates) {
      switch (gate) {
        case "validation":
          if (evidence.validationsPassed === 0) {
            missingGates.push(gate);
            reasons.push("validation gate required but no validation evidence exists");
          }
          break;
        case "independent_review":
          if (evidence.reviewsCompleted === 0) {
            missingGates.push(gate);
            reasons.push("independent review gate required but no review completed");
          }
          break;
        case "security_review":
        case "migration_validation":
        case "compatibility_review":
        case "dependency_validation":
          // These are satisfied when a review/validation of the right role exists.
          if (evidence.reviewsCompleted === 0 && gate !== "migration_validation" && gate !== "dependency_validation") {
            missingGates.push(gate);
            reasons.push(`${gate} gate required but no review evidence exists`);
          } else if (
            (gate === "migration_validation" || gate === "dependency_validation") &&
            evidence.validationsPassed === 0
          ) {
            missingGates.push(gate);
            reasons.push(`${gate} gate required but no validation evidence exists`);
          }
          break;
      }
    }

    // No blocking findings.
    const unresolvedBlocking = evidence.findings.filter(
      (f) => f.severity === "blocking" && f.status !== "resolved",
    ).length;
    if (unresolvedBlocking > 0) {
      reasons.push(`${unresolvedBlocking} blocking finding(s) unresolved`);
    }

    // No running tasks.
    if (running.length > 0) {
      reasons.push(`${running.length} task(s) still running`);
    }

    // No failed tasks.
    if (failed.length > 0) {
      reasons.push(`${failed.length} task(s) failed`);
    }

    return {
      can_complete:
        missingGates.length === 0 && unresolvedBlocking === 0 && running.length === 0 && failed.length === 0,
      reasons,
      missing_gates: missingGates,
      unresolved_findings: unresolvedBlocking,
      running_tasks: running.length,
    };
  }

  /** Gather gate evidence from the store. */
  gather(missionId: string): GateEvidence {
    const executions = this.store.listExecutions(missionId);
    const findings = this.store.listFindings(missionId);
    const validationsPassed = executions.filter((e) => e.backend === "validation" && e.status === "SUCCEEDED").length;
    const reviewsCompleted = executions.filter((e) => e.backend === "review" && e.status === "SUCCEEDED").length;
    return {
      missionId,
      validationsPassed,
      reviewsCompleted,
      findings: findings.map((f) => ({ finding_id: f.finding_id, severity: f.severity, status: f.status })),
    };
  }
}
