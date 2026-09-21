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
import type { CompletionVerdict, Mission, OrchestrationTask, RequiredGate } from "./types.ts";

export interface GateEvidence {
  missionId: string;
  validationsPassed: number;
  reviewsCompleted: number;
  /**
   * Successful reviews performed by a security reviewer. Counted separately so a
   * generic reviewer cannot satisfy a `security_review` gate (spec 07).
   */
  securityReviewsCompleted: number;
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
    // A FAILED task only blocks while it stands. Each repair round creates a NEW
    // validation / integration / review task, so counting every historical
    // failure would keep the gate closed even after the repaired work passed,
    // making the mission unrecoverable. A failure is superseded once a later task
    // of the same kind and role succeeded.
    // Insertion order is the real chronology (the store is event-sourced). Only
    // timestamps are not enough: created_at has millisecond resolution, so a task
    // that fails immediately AFTER a success can share its timestamp, and a
    // timestamp-only comparison would mask that late failure.
    const order = new Map<string, number>();
    tasks.forEach((t, i) => order.set(t.task_id, i));
    const superseded = (t: OrchestrationTask): boolean =>
      tasks.some(
        (o) =>
          o.task_id !== t.task_id &&
          o.kind === t.kind &&
          o.role === t.role &&
          o.status === "SUCCEEDED" &&
          (order.get(o.task_id) ?? -1) > (order.get(t.task_id) ?? -1),
      );
    const failed = tasks.filter((t) => t.status === "FAILED" && !superseded(t));

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
          // A generic reviewer must not satisfy a security gate.
          if (evidence.securityReviewsCompleted === 0) {
            missingGates.push(gate);
            reasons.push("security_review gate required but no security review completed");
          }
          break;
        case "migration_validation":
        case "compatibility_review":
        case "dependency_validation":
          // These are satisfied when a review/validation of the right kind exists.
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
    const tasks = this.store.listTasks(missionId);
    const validationsPassed = executions.filter((e) => e.backend === "validation" && e.status === "SUCCEEDED").length;
    const reviewsCompleted = executions.filter((e) => e.backend === "review" && e.status === "SUCCEEDED").length;
    const securityReviewsCompleted = tasks.filter(
      (t) => t.kind === "review" && t.status === "SUCCEEDED" && t.role.includes("security"),
    ).length;
    return {
      missionId,
      validationsPassed,
      reviewsCompleted,
      securityReviewsCompleted,
      findings: findings.map((f) => ({ finding_id: f.finding_id, severity: f.severity, status: f.status })),
    };
  }
}
