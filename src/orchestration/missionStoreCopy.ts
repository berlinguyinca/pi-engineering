/**
 * Defensive copy and patch-validation helpers for MissionStore (moved verbatim
 * out of missionStore.ts).
 */

import { id } from "../core/ids.ts";
import {
  MISSION_UPDATE_FIELDS,
  type MissionRevisionFence,
  type MissionTransitionOptions,
  type MissionUpdatePatch,
  TASK_TRANSITION_METADATA_FIELDS,
} from "./missionStoreTypes.ts";
import type {
  CandidateEvidenceIdentity,
  CandidateRevision,
  EvidenceInvalidation,
  Execution,
  FailureClassification,
  Mission,
  MissionStop,
  OrchestrationTask,
  RecoveryDecision,
  ReviewEvidence,
  TaskCheckpoint,
  TaskSupersession,
  TaskTransitionMetadata,
  ValidationEvidence,
  WorkspaceManifest,
} from "./types.ts";

export function candidateKey(missionId: string, repoId: string): string {
  return `${missionId}\u0000${repoId}`;
}

/** A caller-owned copy: no array or record in it aliases the store's state. */
export function copyExecution(ex: Execution): Execution {
  return {
    ...ex,
    usage: structuredClone(ex.usage),
    logs: [...ex.logs],
    artifact_refs: [...ex.artifact_refs],
    ...(ex.recovered_merged ? { recovered_merged: ex.recovered_merged.map((r) => ({ ...r })) } : {}),
    ...(ex.reviewed_recovered ? { reviewed_recovered: [...ex.reviewed_recovered] } : {}),
    ...(ex.already_satisfied ? { already_satisfied: { ...ex.already_satisfied } } : {}),
  };
}

export function copyMission(mission: Mission): Mission {
  return {
    ...mission,
    constraints: [...mission.constraints],
    acceptance_criteria: mission.acceptance_criteria.map((criterion) => ({
      ...criterion,
    })),
    task_ids: [...mission.task_ids],
    artifact_refs: [...mission.artifact_refs],
    decision_refs: [...mission.decision_refs],
    required_gates: [...mission.required_gates],
    ...(mission.operator_model_pin ? { operator_model_pin: { ...mission.operator_model_pin } } : {}),
  };
}

export function copyTask(task: OrchestrationTask): OrchestrationTask {
  return {
    ...task,
    depends_on: [...task.depends_on],
    write_domains: [...task.write_domains],
    execution_requirements: structuredClone(task.execution_requirements),
    artifacts: [...task.artifacts],
    steer_requests: [...task.steer_requests],
    ...(task.acceptance_ids ? { acceptance_ids: [...task.acceptance_ids] } : {}),
    ...(task.deliverables ? { deliverables: [...task.deliverables] } : {}),
    ...(task.checkpoint_policy ? { checkpoint_policy: { ...task.checkpoint_policy } } : {}),
    ...(task.required_output_artifacts ? { required_output_artifacts: [...task.required_output_artifacts] } : {}),
    ...(task.recovery_authority ? { recovery_authority: { ...task.recovery_authority } } : {}),
  };
}

export function copyWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    ...manifest,
    authorizedRoots: manifest.authorizedRoots.map((root) => ({ ...root })),
    repositories: manifest.repositories.map((repository) => ({
      ...repository,
      writableDomains: [...repository.writableDomains],
    })),
    dependencyEdges: manifest.dependencyEdges.map((edge) => ({ ...edge })),
  };
}

export function copyTaskCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  return {
    ...checkpoint,
    committedChanges: [...checkpoint.committedChanges],
    preservedUncommittedChanges: [...checkpoint.preservedUncommittedChanges],
    completedDeliverables: [...checkpoint.completedDeliverables],
    remainingDeliverables: [...checkpoint.remainingDeliverables],
    acceptanceIds: [...checkpoint.acceptanceIds],
    validationEvidenceRefs: [...checkpoint.validationEvidenceRefs],
    artifactRefs: [...checkpoint.artifactRefs],
    artifactHashes: [...checkpoint.artifactHashes],
    ...(checkpoint.handoff ? { handoff: structuredClone(checkpoint.handoff) } : {}),
  };
}

export function copyFailureClassification(classification: FailureClassification): FailureClassification {
  return { ...classification, evidenceRefs: [...classification.evidenceRefs] };
}

export function copyTaskSupersession(supersession: TaskSupersession): TaskSupersession {
  return {
    ...supersession,
    replacementTaskIds: [...supersession.replacementTaskIds],
    acceptanceIds: [...supersession.acceptanceIds],
    ...(supersession.expectedReplacementFingerprints
      ? {
          expectedReplacementFingerprints: {
            ...supersession.expectedReplacementFingerprints,
          },
        }
      : {}),
  };
}

export function copyRecoveryDecision(decision: RecoveryDecision): RecoveryDecision {
  return {
    ...decision,
    ...(decision.startingCandidateContent
      ? { startingCandidateContent: { ...decision.startingCandidateContent } }
      : {}),
  };
}

export function copyEvidenceInvalidation(invalidation: EvidenceInvalidation): EvidenceInvalidation {
  return {
    ...invalidation,
    identity: {
      ...invalidation.identity,
      acceptanceIds: [...invalidation.identity.acceptanceIds],
      artifactHashes: [...invalidation.identity.artifactHashes],
    },
  };
}

export function copyEvidenceIdentity(identity: CandidateEvidenceIdentity): CandidateEvidenceIdentity {
  return {
    ...identity,
    acceptanceIds: [...identity.acceptanceIds],
    artifactHashes: [...identity.artifactHashes],
  };
}

export function copyCandidateRevision(candidate: CandidateRevision): CandidateRevision {
  return {
    ...candidate,
    identity: copyEvidenceIdentity(candidate.identity),
    reconstructedFrom: candidate.reconstructedFrom ? { ...candidate.reconstructedFrom } : undefined,
  };
}

export function copyValidationEvidence(evidence: ValidationEvidence): ValidationEvidence {
  return {
    ...evidence,
    identity: copyEvidenceIdentity(evidence.identity),
    testSummary: structuredClone(evidence.testSummary),
    acceptanceResults: evidence.acceptanceResults?.map((result) => ({
      ...result,
    })),
  };
}

export function copyReviewEvidence(evidence: ReviewEvidence): ReviewEvidence {
  return {
    ...evidence,
    identity: copyEvidenceIdentity(evidence.identity),
    findings: evidence.findings.map((finding) => ({ ...finding })),
    acceptanceResults: evidence.acceptanceResults?.map((result) => ({
      ...result,
    })),
  };
}

export function copyMissionStop(stop: MissionStop): MissionStop {
  return {
    ...stop,
    preservedWork: [...stop.preservedWork],
    attemptedRecoveries: [...stop.attemptedRecoveries],
    ...(stop.queue ? { queue: { ...stop.queue } } : {}),
    ...(stop.settlementIdentity ? { settlementIdentity: { ...stop.settlementIdentity } } : {}),
  };
}

export function settlementIdentityMatches(
  actual: MissionStop["settlementIdentity"],
  expected: MissionRevisionFence,
): boolean {
  return (
    actual?.revision === expected.revision &&
    actual.status === expected.status &&
    actual.resumptionGeneration === expected.resumptionGeneration &&
    actual.blockedEpisodeId === expected.blockedEpisodeId
  );
}

export function validateMissionUpdatePatch(patch: MissionUpdatePatch): MissionUpdatePatch {
  for (const key of Object.keys(patch)) {
    if (!MISSION_UPDATE_FIELDS.has(key as keyof MissionUpdatePatch)) {
      throw new Error(`unsupported mission update field ${key}`);
    }
  }
  return {
    ...(patch.constraints !== undefined ? { constraints: [...patch.constraints] } : {}),
    ...(patch.artifact_refs !== undefined ? { artifact_refs: [...patch.artifact_refs] } : {}),
    ...(patch.decision_refs !== undefined ? { decision_refs: [...patch.decision_refs] } : {}),
    ...(patch.required_gates !== undefined ? { required_gates: [...patch.required_gates] } : {}),
    ...(patch.operator_model_decided_at !== undefined
      ? {
          operator_model_decided_at:
            patch.operator_model_decided_at === null ? null : String(patch.operator_model_decided_at),
        }
      : {}),
    ...(patch.execution_mode !== undefined
      ? { execution_mode: { mode: String(patch.execution_mode.mode), reason: String(patch.execution_mode.reason) } }
      : {}),
    ...(patch.operator_paused_at !== undefined
      ? { operator_paused_at: patch.operator_paused_at === null ? null : String(patch.operator_paused_at) }
      : {}),
    ...(patch.operator_model_pin !== undefined
      ? {
          operator_model_pin: patch.operator_model_pin
            ? {
                provider: String(patch.operator_model_pin.provider),
                id: String(patch.operator_model_pin.id),
                set_at: String(patch.operator_model_pin.set_at),
              }
            : null,
        }
      : {}),
  };
}

export function validateMissionTransitionOptions(options: MissionTransitionOptions): MissionTransitionOptions {
  for (const key of Object.keys(options)) {
    if (key !== "recoveryDecisionId") throw new Error(`unsupported mission transition option ${key}`);
  }
  if (options.recoveryDecisionId !== undefined && typeof options.recoveryDecisionId !== "string") {
    throw new Error("mission transition recoveryDecisionId must be a string");
  }
  return options.recoveryDecisionId === undefined ? {} : { recoveryDecisionId: options.recoveryDecisionId };
}

export function validateTaskTransitionMetadata(metadata: TaskTransitionMetadata): TaskTransitionMetadata {
  for (const key of Object.keys(metadata)) {
    if (!TASK_TRANSITION_METADATA_FIELDS.has(key as keyof TaskTransitionMetadata)) {
      throw new Error(`unsupported task transition metadata field ${key}`);
    }
  }

  const copy: TaskTransitionMetadata = {};
  if (metadata.attempt !== undefined) {
    if (!Number.isInteger(metadata.attempt) || metadata.attempt < 0) {
      throw new Error("task transition attempt must be a non-negative integer");
    }
    copy.attempt = metadata.attempt;
  }
  if (metadata.assigned_execution_id !== undefined) {
    if (metadata.assigned_execution_id !== null && typeof metadata.assigned_execution_id !== "string") {
      throw new Error("task transition assigned_execution_id must be a string or null");
    }
    copy.assigned_execution_id = metadata.assigned_execution_id;
  }
  if (metadata.failure_reason !== undefined) {
    if (typeof metadata.failure_reason !== "string") {
      throw new Error("task transition failure_reason must be a string");
    }
    copy.failure_reason = metadata.failure_reason;
  }
  return copy;
}
