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
  /**
   * Tasks whose committed work was recovered after a wall-clock timeout: the
   * broker recorded their exact worker commit as merged by a SUCCEEDED
   * integration (`Execution.recovered_merged`), and after that integration a
   * validation SUCCEEDED and a review SUCCEEDED that was explicitly asked to
   * verify the task's objective is fully met (`Execution.reviewed_recovered`).
   * Structured evidence only — integration summaries are prose, never parsed.
   *
   * Conservative by design: a mission with no review step can never supersede
   * a recovered task (a green build does not prove a timed-out worker finished
   * its objective). "After" is store insertion order, which is creation order
   * because post-execution runs integration, validation and review
   * sequentially.
   */
  recoveredTasks: string[];
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
      ) ||
      // Recovery supersede: the worker timed out AFTER committing, the broker
      // merged exactly that commit, and validation + review passed on the
      // result. The FAILED status records a timeout, not a rejected
      // deliverable, so it must not block completion. See gather().
      evidence.recoveredTasks.includes(t.task_id);
    const failed = tasks.filter((t) => t.status === "FAILED" && !superseded(t));
    const supersededByRecovery = tasks
      .filter((t) => t.status === "FAILED" && evidence.recoveredTasks.includes(t.task_id))
      .map((t) => t.task_id);

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
      superseded_by_recovery: supersededByRecovery,
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
    // Insertion order is the chronology (event-sourced store): a recovered
    // merge counts only when a validation and a completeness-noted review both
    // SUCCEEDED after the integration that merged it — evidence from before
    // does not cover it.
    const recoveredTasks: string[] = [];
    executions.forEach((e, i) => {
      if (e.backend !== "integration" || e.status !== "SUCCEEDED" || !e.recovered_merged?.length) return;
      const later = executions.slice(i + 1).filter((x) => x.status === "SUCCEEDED");
      if (!later.some((x) => x.backend === "validation")) return;
      for (const r of e.recovered_merged) {
        if (later.some((x) => x.backend === "review" && x.reviewed_recovered?.includes(r.task_id))) {
          recoveredTasks.push(r.task_id);
        }
      }
    });
    return {
      missionId,
      validationsPassed,
      reviewsCompleted,
      securityReviewsCompleted,
      recoveredTasks,
      findings: findings.map((f) => ({ finding_id: f.finding_id, severity: f.severity, status: f.status })),
    };
  }
}
