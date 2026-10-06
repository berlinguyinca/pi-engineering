import { createHash } from "node:crypto";
import type {
  FailureCategory,
  FailureClassification,
  OrchestrationTask,
  RecoveryAction,
  RecoveryDecision,
  TaskCheckpoint,
  WorkspaceManifest,
} from "./types.ts";

export interface FailureEvidence {
  missionId: string;
  taskId?: string | null;
  executionId?: string | null;
  summary: string;
  evidenceRefs?: string[];
  providerStatus?: number;
  providerCode?: string;
  observedAt?: string;
  category?: FailureCategory;
}

export interface RecoveryPlannerOptions {
  missionCeiling?: number;
  strategyMaxAttempts?: number;
  decisionTtlMs?: number;
}

export interface RecoveryDecisionInput {
  classification: FailureClassification;
  history: RecoveryDecision[];
  now: number;
  resumptionGeneration?: number;
}

const DEFAULT_ACTIONS: Record<FailureCategory, RecoveryAction> = {
  WORKSPACE_SCOPE_MISMATCH: "REBUILD_WORKSPACE_MANIFEST",
  EVIDENCE_UNAVAILABLE: "RECONSTRUCT_EVIDENCE",
  TASK_BUDGET_EXHAUSTED: "CHECKPOINT_SPLIT_AND_REPLACE",
  PROVIDER_TRANSIENT: "PROBE_AND_BACKOFF",
  PROVIDER_PERMANENT: "STOP",
  INVALID_WORKER_OUTPUT: "REPAIR_WORKER_OUTPUT",
  VALIDATION_FAILED: "CREATE_REPAIR_TASKS",
  REVIEW_FAILED: "CREATE_REPAIR_TASKS",
  IMPLEMENTATION_DEFECT: "CREATE_REPAIR_TASKS",
  MERGE_CONFLICT: "REBUILD_INTEGRATION_CANDIDATE",
  AUTHORIZATION_OR_CREDENTIAL: "STOP",
  REQUIREMENT_AMBIGUITY: "WAIT_FOR_REQUIREMENT",
  ORPHANED_EXECUTION: "FENCE_RECONCILE_AND_RESUME",
  DEADLOCKED_DAG: "REPAIR_BLOCKED_MISSION",
  PERSISTENCE_FAILURE: "PAUSE_FOR_PERSISTENCE",
};

const EXPECTED_CHANGE: Record<RecoveryAction, string> = {
  REBUILD_WORKSPACE_MANIFEST: "rebuild the authorized workspace manifest and rerun role-access probes",
  RECONSTRUCT_EVIDENCE: "reconstruct candidate evidence from Git and durable artifacts",
  CHECKPOINT_SPLIT_AND_REPLACE: "split checkpointed remaining deliverables into bounded replacement tasks",
  PROBE_AND_BACKOFF: "observe a healthy provider probe within the durable outage deadline",
  REPAIR_WORKER_OUTPUT: "produce schema-valid worker output from a fresh bounded attempt",
  CREATE_REPAIR_TASKS: "create bounded replacement tasks that materially change the candidate",
  REBUILD_INTEGRATION_CANDIDATE: "rebuild the isolated integration candidate and rerun integration",
  FENCE_RECONCILE_AND_RESUME: "fence the old owner, reconcile side effects, and resume remaining work",
  WAIT_FOR_REQUIREMENT: "receive clarification for only the affected requirement branch",
  PAUSE_FOR_PERSISTENCE: "restore durable writes before any further mutation",
  REPAIR_BLOCKED_MISSION: "replace unresolved blocked work through an explicit durable repair plan",
  STOP: "no safe automatic material change is available",
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type ReplacementTaskFingerprintSpec = Pick<
  OrchestrationTask,
  | "task_id"
  | "mission_id"
  | "kind"
  | "role"
  | "objective"
  | "depends_on"
  | "priority"
  | "mutates_repo"
  | "write_domains"
  | "isolation"
  | "execution_requirements"
  | "max_attempts"
  | "failure_policy"
  | "repo_id"
  | "acceptance_ids"
  | "deliverables"
  | "execution_budget_ms"
  | "checkpoint_policy"
  | "required_output_artifacts"
  | "candidate_generation"
  | "repair_base_candidate_sha"
>;

export function replacementTaskFingerprintSpec(task: ReplacementTaskFingerprintSpec): ReplacementTaskFingerprintSpec {
  return {
    task_id: task.task_id,
    mission_id: task.mission_id,
    kind: task.kind,
    role: task.role,
    objective: task.objective,
    depends_on: [...task.depends_on],
    priority: task.priority,
    mutates_repo: task.mutates_repo,
    write_domains: [...task.write_domains],
    isolation: task.isolation,
    execution_requirements: structuredClone(task.execution_requirements),
    max_attempts: task.max_attempts,
    failure_policy: task.failure_policy,
    repo_id: task.repo_id,
    acceptance_ids: [...(task.acceptance_ids ?? [])],
    deliverables: [...(task.deliverables ?? [])],
    execution_budget_ms: task.execution_budget_ms,
    checkpoint_policy: task.checkpoint_policy ? { ...task.checkpoint_policy } : undefined,
    required_output_artifacts: [...(task.required_output_artifacts ?? [])],
    candidate_generation: task.candidate_generation,
    repair_base_candidate_sha: task.repair_base_candidate_sha,
  };
}

export function replacementRecoveryFingerprint(input: {
  decision: RecoveryDecision;
  lineage: {
    supersessionId: string;
    failedTaskId: string;
    repoId: string;
    acceptanceIds: string[];
    coverageFingerprint?: string;
    replacementTaskIds: string[];
  };
  replacement: ReplacementTaskFingerprintSpec;
  manifest: WorkspaceManifest;
  checkpoint: TaskCheckpoint | null;
}): string {
  return `sha256:${hash({
    decision: {
      recoveryId: input.decision.recoveryId,
      missionId: input.decision.missionId,
      classificationId: input.decision.classificationId,
      action: input.decision.action,
      expectedMaterialChange: input.decision.expectedMaterialChange,
      attempt: input.decision.attempt,
      maxAttempts: input.decision.maxAttempts,
      deadline: input.decision.deadline,
      nextActionAt: input.decision.nextActionAt,
      decidedAt: input.decision.decidedAt,
      failureFingerprint: input.decision.failureFingerprint,
      blockedEpisodeId: input.decision.blockedEpisodeId,
      resumptionGeneration: input.decision.resumptionGeneration ?? 0,
      startingCandidateIdentityHash: input.decision.startingCandidateIdentityHash,
      startingCandidateContent: input.decision.startingCandidateContent
        ? { ...input.decision.startingCandidateContent }
        : input.decision.startingCandidateContent,
    },
    lineage: {
      supersessionId: input.lineage.supersessionId,
      failedTaskId: input.lineage.failedTaskId,
      repoId: input.lineage.repoId,
      acceptanceIds: [...input.lineage.acceptanceIds],
      coverageFingerprint: input.lineage.coverageFingerprint,
      replacementTaskIds: [...input.lineage.replacementTaskIds],
    },
    replacement: replacementTaskFingerprintSpec(input.replacement),
    manifest: structuredClone(input.manifest),
    checkpoint: input.checkpoint
      ? {
          schemaVersion: 1,
          snapshot: structuredClone(input.checkpoint),
          artifactIdentities: input.checkpoint.artifactRefs.map((ref, index) => ({
            ref,
            hash: input.checkpoint!.artifactHashes[index],
          })),
        }
      : null,
  })}`;
}

function normalizedSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ");
}

export function failureFingerprint(
  evidence: Pick<FailureEvidence, "missionId" | "taskId" | "executionId" | "summary" | "evidenceRefs"> & {
    category: FailureCategory;
  },
): string {
  return `sha256:${hash({
    missionId: evidence.missionId,
    taskId: evidence.taskId ?? null,
    category: evidence.category,
    summary: normalizedSummary(evidence.summary),
    evidenceRefs: [...new Set(evidence.evidenceRefs ?? [])].sort(),
  })}`;
}

export class FailureClassifier {
  classify(evidence: FailureEvidence): FailureClassification {
    const category = evidence.category ?? this.inferCategory(evidence);
    const fingerprint = failureFingerprint({ ...evidence, category });
    return {
      classificationId: `FC-${fingerprint.slice("sha256:".length, "sha256:".length + 20)}`,
      missionId: evidence.missionId,
      taskId: evidence.taskId ?? null,
      executionId: evidence.executionId ?? null,
      category,
      evidenceRefs: [...new Set(evidence.evidenceRefs ?? [])].sort(),
      fingerprint,
      summary: evidence.summary.trim(),
      classifiedAt: evidence.observedAt ?? new Date(0).toISOString(),
    };
  }

  private inferCategory(evidence: FailureEvidence): FailureCategory {
    const summary = normalizedSummary(evidence.summary);
    const providerCode = evidence.providerCode?.trim().toUpperCase();
    if (evidence.providerStatus !== undefined) {
      if ([408, 425, 429, 500, 502, 503, 504].includes(evidence.providerStatus)) {
        return "PROVIDER_TRANSIENT";
      }
      if (evidence.providerStatus >= 400) return "PROVIDER_PERMANENT";
    }
    if (providerCode) {
      if (
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "RATE_LIMITED", "OVERLOADED"].includes(providerCode)
      ) {
        return "PROVIDER_TRANSIENT";
      }
      return "PROVIDER_PERMANENT";
    }
    if (/workspace|scope mismatch|role-access|repository mismatch/.test(summary)) return "WORKSPACE_SCOPE_MISMATCH";
    if (/evidence.*(unavailable|missing|inaccessible)|candidate evidence unavailable/.test(summary)) {
      return "EVIDENCE_UNAVAILABLE";
    }
    if (/budget exhausted|execution budget|deadline exceeded|wall.clock (timeout|limit)/.test(summary)) {
      return "TASK_BUDGET_EXHAUSTED";
    }
    // A lost execution lease ("execution X is no longer authoritative") is an
    // ownership problem, not a credential one; check it before the auth words.
    if (/no longer authoritative|orphan|no owner|stale owner/.test(summary)) return "ORPHANED_EXECUTION";
    // `auth` is anchored: unanchored it matched "authoritative" and "author",
    // turning a recoverable ownership loss into a credential STOP.
    if (
      /invalid.*(api key|credential|model|config)|model.*(not found|does not exist)|\bauth(?:entication|enticate|orization|orize)?\b|unauthorized|forbidden/.test(
        summary,
      )
    ) {
      return /provider|api key|model|config/.test(summary) ? "PROVIDER_PERMANENT" : "AUTHORIZATION_OR_CREDENTIAL";
    }
    if (/429|502|503|504|rate limit|network|econn|temporar|gateway|timeout|connection reset/.test(summary)) {
      return "PROVIDER_TRANSIENT";
    }
    if (/provider/.test(summary)) return "PROVIDER_PERMANENT";
    if (/schema|invalid worker output|malformed output/.test(summary)) return "INVALID_WORKER_OUTPUT";
    if (/validation|test suite|tests? failed|compile|typecheck/.test(summary)) return "VALIDATION_FAILED";
    if (/review|request(ed)? changes/.test(summary)) return "REVIEW_FAILED";
    if (/implementation defect|bug in|defect in/.test(summary)) return "IMPLEMENTATION_DEFECT";
    if (/merge conflict|unmerged|integration conflict/.test(summary)) return "MERGE_CONFLICT";
    if (/authorization|credential|permission|unauthorized|forbidden/.test(summary)) {
      return "AUTHORIZATION_OR_CREDENTIAL";
    }
    if (/requirement|ambiguous|clarification/.test(summary)) return "REQUIREMENT_AMBIGUITY";
    if (/orphan|no owner|stale owner/.test(summary)) return "ORPHANED_EXECUTION";
    if (/deadlock|dependency graph|cyclic dependency/.test(summary)) return "DEADLOCKED_DAG";
    if (/persist|durable write|event store|jsonl/.test(summary)) return "PERSISTENCE_FAILURE";
    return "PROVIDER_PERMANENT";
  }
}

export class RecoveryPlanner {
  private readonly missionCeiling: number;
  private readonly strategyMaxAttempts: number;
  /**
   * OPT-IN recovery deadline. Undefined (the default) means recovery is bounded
   * by attempt counts (mission ceiling, per-fingerprint strategy budget), never
   * by a clock: a 30-minute deadline used to STOP missions whose recovery was
   * simply waiting for the gateway or still progressing.
   */
  private readonly decisionTtlMs: number | undefined;

  constructor(options: RecoveryPlannerOptions = {}) {
    this.missionCeiling = options.missionCeiling ?? 1_000;
    this.strategyMaxAttempts = options.strategyMaxAttempts ?? 2;
    this.decisionTtlMs = options.decisionTtlMs;
    if (
      this.missionCeiling < 1 ||
      this.strategyMaxAttempts < 1 ||
      (this.decisionTtlMs !== undefined && this.decisionTtlMs < 1)
    ) {
      throw new Error("recovery planner budgets and deadline must be positive");
    }
  }

  static defaultAction(category: FailureCategory): RecoveryAction {
    return DEFAULT_ACTIONS[category];
  }

  decide(input: RecoveryDecisionInput): RecoveryDecision {
    const fingerprint = input.classification.fingerprint;
    const fingerprintAttempts = input.history.filter((decision) => decision.failureFingerprint === fingerprint).length;
    const attempt = fingerprintAttempts + 1;
    const resumptionGeneration =
      input.resumptionGeneration ?? Math.max(0, ...input.history.map((decision) => decision.resumptionGeneration ?? 0));
    const durableDeadlines = input.history
      .filter((decision) => (decision.resumptionGeneration ?? 0) === resumptionGeneration)
      .map((decision) => (decision.deadline ? Date.parse(decision.deadline) : Number.NaN))
      .filter(Number.isFinite);
    const durableDeadline =
      durableDeadlines.length > 0
        ? Math.min(...durableDeadlines)
        : this.decisionTtlMs === undefined
          ? undefined
          : input.now + this.decisionTtlMs;
    const missionExhausted = input.history.length >= this.missionCeiling;
    const deadlineExhausted = durableDeadline !== undefined && input.now >= durableDeadline;
    // Provider outages already have a durable probe/relaunch/outage budget.
    // They still consume the mission ceiling, but the generic two-shot schema
    // repair budget must not truncate a healthy long-outage policy.
    const strategyExhausted =
      input.classification.category !== "PROVIDER_TRANSIENT" && fingerprintAttempts >= this.strategyMaxAttempts;
    const defaultAction = RecoveryPlanner.defaultAction(input.classification.category);
    const action = missionExhausted || deadlineExhausted || strategyExhausted ? "STOP" : defaultAction;
    const decidedAt = new Date(input.now).toISOString();
    const deadline = durableDeadline === undefined ? null : new Date(durableDeadline).toISOString();
    const exhaustedReason = missionExhausted
      ? `mission recovery ceiling exhausted (${input.history.length}/${this.missionCeiling})`
      : deadlineExhausted
        ? `mission recovery deadline exhausted at ${deadline}`
        : strategyExhausted
          ? `identical failure fingerprint exhausted its strategy budget (${fingerprintAttempts}/${this.strategyMaxAttempts})`
          : EXPECTED_CHANGE[action];
    const recoveryHash = hash({
      missionId: input.classification.missionId,
      classificationId: input.classification.classificationId,
      fingerprint,
      action,
      attempt,
      deadline,
    });
    return {
      recoveryId: `RCV-${recoveryHash.slice(0, 20)}`,
      missionId: input.classification.missionId,
      classificationId: input.classification.classificationId,
      action,
      expectedMaterialChange: exhaustedReason,
      attempt,
      maxAttempts: this.strategyMaxAttempts,
      deadline,
      nextActionAt: decidedAt,
      status: "planned",
      decidedAt,
      failureFingerprint: fingerprint,
      resumptionGeneration,
    };
  }
}
