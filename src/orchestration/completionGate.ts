import { evidenceIdentitiesEqual, hashCandidateEvidenceIdentity, taskCoverageFingerprint } from "./evidence.ts";
import type { MissionStore } from "./missionStore.ts";
import type { CompletionVerdict, Mission, RequiredGate } from "./types.ts";

export interface GateEvidence {
  missionId: string;
  validationsPassed: number;
  reviewsCompleted: number;
  securityReviewsCompleted: number;
  findings: Array<{ finding_id: string; severity: string; status: string }>;
  recoveredTasks: string[];
  validationProblem?: string;
  reviewProblem?: string;
  acceptanceProblems?: string[];
  activeExecutionProblems?: string[];
  terminalTaskProblems?: string[];
  supersessionProblems?: string[];
}

export class CompletionGate {
  private readonly store: MissionStore;

  constructor(store: MissionStore) {
    this.store = store;
  }

  evaluate(mission: Mission): CompletionVerdict {
    const evidence = this.gather(mission.mission_id);
    const reasons: string[] = [];
    const missingGates: RequiredGate[] = [];
    const tasks = this.store.listTasks(mission.mission_id);
    const running = tasks.filter((task) =>
      ["READY", "RUNNING", "RETRYING", "WAITING", "PENDING"].includes(task.status),
    );
    const superseded = new Set(evidence.recoveredTasks);
    const failed = tasks.filter((task) => task.status === "FAILED" && !superseded.has(task.task_id));

    for (const gate of mission.required_gates) {
      const validationGate =
        gate === "validation" || gate === "migration_validation" || gate === "dependency_validation";
      const reviewGate = gate === "independent_review" || gate === "compatibility_review";
      if (validationGate && evidence.validationsPassed === 0) {
        missingGates.push(gate);
        reasons.push(evidence.validationProblem ?? `${gate} gate required but no current validation evidence exists`);
      } else if (reviewGate && evidence.reviewsCompleted === 0) {
        missingGates.push(gate);
        reasons.push(evidence.reviewProblem ?? `${gate} gate required but no current review evidence exists`);
      } else if (gate === "security_review" && evidence.securityReviewsCompleted === 0) {
        missingGates.push(gate);
        reasons.push(
          evidence.reviewProblem ?? "security_review gate required but no current security review evidence exists",
        );
      }
    }

    const unresolvedBlocking = evidence.findings.filter(
      (finding) => finding.severity === "blocking" && finding.status !== "resolved",
    ).length;
    if (unresolvedBlocking > 0) reasons.push(`${unresolvedBlocking} blocking finding(s) unresolved`);
    if (running.length > 0) reasons.push(`${running.length} task(s) still running`);
    if (failed.length > 0) reasons.push(`${failed.length} task(s) failed`);
    reasons.push(
      ...(evidence.terminalTaskProblems ?? []),
      ...(evidence.supersessionProblems ?? []),
      ...(evidence.activeExecutionProblems ?? []),
      ...(evidence.acceptanceProblems ?? []),
    );

    const structuralProblems =
      (evidence.terminalTaskProblems?.length ?? 0) +
      (evidence.supersessionProblems?.length ?? 0) +
      (evidence.activeExecutionProblems?.length ?? 0) +
      (evidence.acceptanceProblems?.length ?? 0);
    return {
      can_complete:
        missingGates.length === 0 &&
        unresolvedBlocking === 0 &&
        running.length === 0 &&
        failed.length === 0 &&
        structuralProblems === 0,
      reasons: [...new Set(reasons)],
      missing_gates: [...new Set(missingGates)],
      unresolved_findings: unresolvedBlocking,
      running_tasks: running.length,
      superseded_by_recovery: evidence.recoveredTasks,
    };
  }

  gather(missionId: string): GateEvidence {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    const manifest = this.store.getWorkspaceManifest(missionId);
    const multiRepoUnsupported = (manifest?.repositories.length ?? 0) > 1;
    const candidate = multiRepoUnsupported
      ? undefined
      : this.store.getCandidate(missionId, manifest?.repositories[0]?.repoId);
    const currentGeneration =
      this.store.getLatestMissionLease(missionId)?.generation ??
      Math.max(0, ...this.store.listTasks(missionId).map((task) => task.mission_generation ?? 0));
    const candidateCurrent =
      !!candidate &&
      !!manifest &&
      candidate.identity.workspaceManifestHash === manifest.hash &&
      candidate.identity.missionGeneration === currentGeneration &&
      manifest.repositories.some(
        (repository) =>
          repository.repoId === candidate.identity.repoId && repository.baseSha === candidate.identity.baseSha,
      );
    const invalidations = this.store.listEvidenceInvalidations(missionId);
    const invalidated = (identityHash: string, recordedAt: string): boolean =>
      invalidations.some(
        (entry) =>
          hashCandidateEvidenceIdentity(entry.identity) === identityHash &&
          Date.parse(entry.invalidatedAt) >= Date.parse(recordedAt),
      );
    const currentValidation =
      candidateCurrent && candidate
        ? this.store
            .listValidationEvidence(missionId)
            .filter(
              (entry) =>
                entry.identityHash === candidate.identityHash &&
                evidenceIdentitiesEqual(entry.identity, candidate.identity),
            )
            .filter((entry) => !invalidated(entry.identityHash, entry.recordedAt))
            .at(-1)
        : undefined;
    const currentReview =
      candidateCurrent && candidate
        ? this.store
            .listReviewEvidence(missionId)
            .filter(
              (entry) =>
                entry.identityHash === candidate.identityHash &&
                evidenceIdentitiesEqual(entry.identity, candidate.identity),
            )
            .filter((entry) => !invalidated(entry.identityHash, entry.recordedAt))
            .at(-1)
        : undefined;

    const validationOk =
      !!currentValidation &&
      currentValidation.accessible &&
      !currentValidation.noTargets &&
      currentValidation.exitCode === 0;
    const reviewOk =
      !!currentReview &&
      currentReview.accessible &&
      currentReview.outputValid &&
      currentReview.verdict === "approve" &&
      currentReview.findings.every((finding) => finding.severity !== "blocking" || finding.status === "resolved");

    const explicitResults = [
      ...(currentValidation?.acceptanceResults ?? []),
      ...(currentReview?.acceptanceResults ?? []),
    ];
    const acceptanceProblems = mission.acceptance_criteria.flatMap((criterion) => {
      const acceptanceId = criterion.acceptance_id;
      if (!acceptanceId) return [`material acceptance criterion lacks a stable acceptance ID: ${criterion.criterion}`];
      if (!candidateCurrent || !candidate?.identity.acceptanceIds.includes(acceptanceId))
        return [`acceptance ${acceptanceId} lacks current candidate evidence`];
      if (!explicitResults.some((result) => result.acceptanceId === acceptanceId && result.status === "passed"))
        return [`acceptance ${acceptanceId} lacks an explicit current passing result`];
      if (criterion.status !== "passed") return [`acceptance ${acceptanceId} is ${criterion.status}`];
      if (criterion.evidence !== candidate.identityHash)
        return [`acceptance ${acceptanceId} is not bound to current evidence`];
      return [];
    });

    const tasks = this.store.listTasks(missionId);
    const validSuperseded = new Set<string>();
    const supersessionProblems: string[] = [];
    for (const lineage of this.store.listTaskSupersessions(missionId)) {
      const failed = tasks.find((task) => task.task_id === lineage.failedTaskId);
      const replacements = lineage.replacementTaskIds.map((taskId) => tasks.find((task) => task.task_id === taskId));
      const coverage = new Set(replacements.flatMap((task) => task?.acceptance_ids ?? []));
      const valid =
        failed?.status === "FAILED" &&
        failed.repo_id === lineage.repoId &&
        replacements.length > 0 &&
        lineage.coverageFingerprint === (failed ? taskCoverageFingerprint(failed) : "") &&
        replacements.every(
          (task) =>
            task?.status === "SUCCEEDED" &&
            task.repo_id === lineage.repoId &&
            taskCoverageFingerprint(task) === lineage.coverageFingerprint,
        ) &&
        !!candidate &&
        !!currentReview &&
        replacements.every(
          (task) => !!task?.completed_at && Date.parse(currentReview.recordedAt) > Date.parse(task.completed_at),
        ) &&
        lineage.acceptanceIds.every((acceptanceId) => coverage.has(acceptanceId));
      if (valid) validSuperseded.add(lineage.failedTaskId);
      else
        supersessionProblems.push(
          `invalid supersession lineage for ${lineage.failedTaskId}: replacement coverage is not successful`,
        );
    }
    if (validationOk && currentValidation) {
      for (const task of tasks) {
        if (task.kind === "validation" && task.status === "FAILED" && task.task_id !== currentValidation.taskId) {
          validSuperseded.add(task.task_id);
        }
      }
    }
    if (reviewOk && currentReview) {
      for (const task of tasks) {
        if (task.kind === "review" && task.status === "FAILED" && task.task_id !== currentReview.taskId) {
          validSuperseded.add(task.task_id);
        }
      }
    }
    if (validationOk && reviewOk && currentReview) {
      const executions = this.store.listExecutions(missionId);
      const reviewExecution = executions.find((execution) => execution.execution_id === currentReview.executionId);
      const reviewedRecovered = new Set(reviewExecution?.reviewed_recovered ?? []);
      for (const integration of executions) {
        if (integration.backend !== "integration" || integration.status !== "SUCCEEDED") continue;
        for (const recovered of integration.recovered_merged ?? []) {
          if (reviewedRecovered.has(recovered.task_id)) validSuperseded.add(recovered.task_id);
        }
      }
    }

    const terminalTaskProblems = tasks
      .filter((task) => ["BLOCKED", "CANCELED", "SKIPPED"].includes(task.status))
      .filter((task) => !validSuperseded.has(task.task_id))
      .map((task) => `unresolved ${task.status} task ${task.task_id}`);
    const activeExecutionProblems = this.store
      .listExecutions(missionId)
      .filter((execution) => execution.status === "RUNNING")
      .map((execution) => {
        const task = this.store.getTask(execution.task_id);
        const fenced =
          task &&
          execution.mission_generation === task.mission_generation &&
          execution.fencing_token === task.fencing_token &&
          task.assigned_execution_id === execution.execution_id;
        return `${fenced ? "active" : "active unfenced"} execution ${execution.execution_id} can still mutate candidate state`;
      });

    const reviewProblem = !candidateCurrent
      ? multiRepoUnsupported
        ? "multi-repository completion requires repository head-vector evidence"
        : "current review evidence is unavailable because no candidate is recorded"
      : !currentReview
        ? "no current review evidence matches the exact candidate"
        : !currentReview.accessible
          ? "current review evidence is inaccessible"
          : !currentReview.outputValid
            ? "current review evidence is malformed"
            : currentReview.verdict === "request_changes"
              ? "current review requested changes"
              : !reviewOk
                ? "current review has unresolved blocking findings"
                : undefined;
    const validationProblem = !candidateCurrent
      ? multiRepoUnsupported
        ? "multi-repository completion requires repository head-vector evidence"
        : "current validation evidence is unavailable because no candidate is recorded"
      : !currentValidation
        ? "no current validation evidence matches the exact candidate"
        : !currentValidation.accessible
          ? "current validation evidence is inaccessible"
          : currentValidation.noTargets
            ? "no-target validation cannot satisfy a mutation gate"
            : currentValidation.exitCode !== 0
              ? `current validation failed with exit code ${currentValidation.exitCode}`
              : undefined;

    const storedFindings = this.store.listFindings(missionId).map((finding) => ({
      finding_id: finding.finding_id,
      severity: finding.severity,
      status: finding.status,
    }));
    const reviewFindings = (currentReview?.findings ?? []).map((finding, index) => ({
      finding_id: `${currentReview?.evidenceId ?? "review"}:${index}`,
      severity: finding.severity,
      status: finding.status,
    }));
    return {
      missionId,
      validationsPassed: validationOk ? 1 : 0,
      reviewsCompleted: reviewOk ? 1 : 0,
      securityReviewsCompleted:
        reviewOk &&
        !!currentReview &&
        tasks.some(
          (task) =>
            task.task_id === currentReview.taskId &&
            task.kind === "review" &&
            task.role.includes("security") &&
            task.status === "SUCCEEDED",
        )
          ? 1
          : 0,
      findings: [...storedFindings, ...reviewFindings],
      recoveredTasks: [...validSuperseded],
      validationProblem,
      reviewProblem,
      acceptanceProblems: [
        ...(multiRepoUnsupported ? ["multi-repository completion requires repository head-vector evidence"] : []),
        ...this.store.evidenceDiagnostics(missionId).map((problem) => `quarantined evidence: ${problem}`),
        ...acceptanceProblems,
      ],
      activeExecutionProblems,
      terminalTaskProblems,
      supersessionProblems,
    };
  }
}
