import { createHash } from "node:crypto";
import type { ExecutionOutcome } from "./broker.ts";
import type {
  Execution,
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

/** Safety ceiling applied to an identical failure fingerprint by default. */
export const DEFAULT_STRATEGY_MAX_ATTEMPTS = 8;

/** The mission-wide durable recovery decision ceiling used by default. */
export const DEFAULT_MISSION_RECOVERY_CEILING = 1_000;

export interface RecoveryPlannerOptions {
  missionCeiling?: number;
  strategyMaxAttempts?: number;
  decisionTtlMs?: number;
}

export interface RecoveryDecisionInput {
  classification: FailureClassification;
  history: RecoveryDecision[];
  now: number;
  /** When the planned wait ends (epoch ms); defaults to `now`. */
  nextActionAt?: number;
  /** Operator-facing reason for a PROBE_AND_BACKOFF wait; replaces the generic expected change. */
  waitReason?: string;
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

/**
 * Failures the pipeline can only wait out. Gateway capacity, lost execution
 * ownership, missing evidence and failed durable writes all become a durable
 * WAIT/PROBE when the attempt budget runs out: they are never terminal by
 * COUNT, because on a saturated deployment the identical failure is what
 * waiting for capacity looks like (issue #112).
 */
const CAPACITY_WAIT_ACTIONS: Partial<Record<FailureCategory, RecoveryAction>> = {
  PROVIDER_TRANSIENT: "PROBE_AND_BACKOFF",
  PROVIDER_PERMANENT: "PROBE_AND_BACKOFF",
  ORPHANED_EXECUTION: "PROBE_AND_BACKOFF",
  EVIDENCE_UNAVAILABLE: "PROBE_AND_BACKOFF",
  PERSISTENCE_FAILURE: "PAUSE_FOR_PERSISTENCE",
};

/** Failures no automatic action can resolve: they must ask the operator. */
const OPERATOR_QUESTIONS: Partial<Record<FailureCategory, string>> = {
  REQUIREMENT_AMBIGUITY:
    "operator question: which requirement is authoritative for this mission, and what should it do next?",
  AUTHORIZATION_OR_CREDENTIAL:
    "operator question: which credential or authorization must be restored before this mission touches the repository again?",
  WORKSPACE_SCOPE_MISMATCH:
    "operator question: which workspace roots and repository roles is this mission authorized to use?",
};

/**
 * Concrete, actionable operator guidance surfaced when a mission's recovery
 * budget is exhausted on a failure there is no capacity wait for. Kept separate
 * from OPERATOR_QUESTIONS so a budget-exhausted decision still reports its
 * budget reason in expectedMaterialChange (tests and downstream consumers rely
 * on that) while also carrying actionable next steps for the operator.
 */
const ESCALATION_GUIDANCE: Partial<Record<FailureCategory, string>> = {
  MERGE_CONFLICT:
    "preserved work conflicts with commits merged upstream. The worker was deliberately based on the mission's original base (not a newer commit) so a real conflict is surfaced rather than masked. Options: (a) rebase the preserved branch onto the current main head and re-integrate, (b) discard the conflicting branch, or (c) raise the recovery budget to retry from the originally bound incumbent base.",
  VALIDATION_FAILED:
    "the repository's own checks do not pass on the candidate. Options: (a) let a repair task fix the failing checks, or (b) raise the recovery budget to retry the failing step.",
  REVIEW_FAILED:
    "the candidate did not pass review. Options: (a) let a repair task address the review findings, or (b) raise the recovery budget to retry review.",
  IMPLEMENTATION_DEFECT:
    "the candidate carries an implementation defect. Options: (a) let a repair task fix it, or (b) raise the recovery budget to retry.",
  DEADLOCKED_DAG:
    "the task graph is blocked with no automatic repair. Options: (a) replace the blocked work through an explicit repair plan, or (b) cancel the mission.",
  TASK_BUDGET_EXHAUSTED:
    "the task exhausted its attempt budget. Options: (a) split the remaining deliverables into bounded replacement tasks, or (b) raise the task budget.",
  REQUIREMENT_AMBIGUITY: OPERATOR_QUESTIONS.REQUIREMENT_AMBIGUITY,
  AUTHORIZATION_OR_CREDENTIAL: OPERATOR_QUESTIONS.AUTHORIZATION_OR_CREDENTIAL,
  WORKSPACE_SCOPE_MISMATCH: OPERATOR_QUESTIONS.WORKSPACE_SCOPE_MISMATCH,
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

/**
 * Why a task failed, in operator terms. The task's own failure_reason wins;
 * when none was recorded (the common case in the audited missions) fall back to
 * the last attempt's execution outcome, then to that task's latest failure
 * classification. Never returns an empty or placeholder string.
 */
export function taskFailureReason(
  task: Pick<OrchestrationTask, "task_id" | "failure_reason">,
  executions: ReadonlyArray<Pick<Execution, "execution_id" | "task_id" | "status" | "exit_status">> = [],
  classifications: ReadonlyArray<Pick<FailureClassification, "taskId" | "category" | "summary">> = [],
): string {
  const recorded = task.failure_reason?.trim();
  if (recorded) return recorded;
  const attempts = executions.filter((execution) => execution.task_id === task.task_id);
  const last = [...attempts].reverse().find((execution) => execution.status !== "SUCCEEDED") ?? attempts.at(-1);
  if (last) {
    const outcome = [...new Set([last.exit_status?.trim(), last.status].filter((value): value is string => !!value))];
    return `execution ${last.execution_id} ended ${outcome.join(" ")}`;
  }
  const classification = classifications.filter((entry) => entry.taskId === task.task_id).at(-1);
  if (classification?.summary.trim()) return `${classification.category}: ${classification.summary.trim()}`;
  return `task ${task.task_id} failed without a recorded reason`;
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

/** Categories that say the gate's infrastructure failed, not that the candidate did. */
const GATE_INFRASTRUCTURE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "PROVIDER_TRANSIENT",
  "PROVIDER_PERMANENT",
  "INVALID_WORKER_OUTPUT",
  "ORPHANED_EXECUTION",
  "EVIDENCE_UNAVAILABLE",
]);

/**
 * Whether a failed gate task actually ran and reported a verdict about the
 * candidate: a review verdict with request_changes or blocking findings, a
 * validation run whose checks exited non-zero, or a real merge conflict.
 * Verdict evidence decides when the backend supplied it; otherwise only text
 * matching a known provider/infrastructure signature (or no text at all) is
 * treated as a gate that never reported. Only these cases may carry the gate
 * category (REVIEW_FAILED / VALIDATION_FAILED / MERGE_CONFLICT).
 */
export function gateReportedVerdict(
  classifier: FailureClassifier,
  kind: OrchestrationTask["kind"],
  evidence: FailureEvidence,
  outcome?: ExecutionOutcome,
): boolean {
  if (kind === "review") {
    const review = outcome?.reviewEvidence;
    if (review) {
      return (
        review.outputValid &&
        review.accessible &&
        (review.verdict === "request_changes" || review.findings.some((finding) => finding.severity === "blocking"))
      );
    }
    if (outcome?.findings?.some((finding) => finding.severity === "blocking")) return true;
  } else if (kind === "validation") {
    const validation = outcome?.validationEvidence;
    if (validation) return validation.accessible && !validation.noTargets && validation.exitCode !== 0;
  } else if (kind === "integration") {
    if (outcome?.exitStatus === "conflict" || /conflict/i.test(evidence.summary)) return true;
  }
  // Judge the backend's own words, not a "backend reported ..." wrapper.
  const reported = outcome ? [outcome.error, outcome.summary].filter(Boolean).join(": ") : evidence.summary;
  if (!reported.trim()) return false;
  // A missing repository-scoped git provider is a wiring fault of the gate, not a provider outage.
  if (/git provider/i.test(reported)) return true;
  const recognized = classifier.inferRecognizedCategory({ ...evidence, summary: reported });
  return recognized === undefined || !GATE_INFRASTRUCTURE_CATEGORIES.has(recognized);
}

/**
 * The transport-level failure texts a legacy gate failure must carry before it
 * is re-read as a provider failure: connection loss, a cut stream, a model
 * restart, a gateway capacity hold, or a grammar refusal. Loose words such as
 * "timeout" or "network" can come from a real review or test output.
 */
export const GATE_TRANSPORT_SIGNATURE =
  /connection error|connection closed|stream ended without (?:a )?finish_reason|model[_ ]superseded|gateway capacity hold|capacity hold:|http 400.*grammar|failed to parse grammar|failed to initialize samplers/i;

const GATE_FAILURE_CATEGORY: Partial<Record<OrchestrationTask["kind"], FailureCategory>> = {
  validation: "VALIDATION_FAILED",
  review: "REVIEW_FAILED",
  integration: "MERGE_CONFLICT",
};

/**
 * Classify a failed validation/review/integration task. The gate category is
 * applied only when the gate reported a verdict; any other failure keeps the
 * category inferred from what actually happened, and a gate whose output was
 * malformed is a provider-side failure, not a defect in the candidate.
 */
export function classifyGateFailure(
  classifier: FailureClassifier,
  kind: OrchestrationTask["kind"],
  evidence: FailureEvidence,
  outcome?: ExecutionOutcome,
): FailureClassification {
  const gateCategory = GATE_FAILURE_CATEGORY[kind];
  if (gateCategory && gateReportedVerdict(classifier, kind, evidence, outcome)) {
    return classifier.classify({ ...evidence, category: gateCategory });
  }
  const inferred = classifier.classify(evidence);
  return gateCategory && inferred.category === "INVALID_WORKER_OUTPUT"
    ? classifier.classify({ ...evidence, category: "PROVIDER_TRANSIENT" })
    : inferred;
}

/** A lost execution lease: the work is ownerless, whatever the caller believes. */
const LOST_OWNERSHIP = /no longer authoritative/;

export class FailureClassifier {
  classify(evidence: FailureEvidence): FailureClassification {
    // Ownership loss is never an authorization stop. A caller that supplies a
    // category (a backend wrapping a fenced execution in its own error) must
    // not be able to turn "execution EXE-x is no longer authoritative" into an
    // AUTHORIZATION_OR_CREDENTIAL STOP.
    const category =
      evidence.category !== undefined && LOST_OWNERSHIP.test(normalizedSummary(evidence.summary))
        ? "ORPHANED_EXECUTION"
        : (evidence.category ?? this.inferCategory(evidence));
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
    return this.inferRecognizedCategory(evidence) ?? "PROVIDER_TRANSIENT";
  }

  /**
   * The category a known failure signature maps to, or undefined when the text
   * matches no signature. Gate tasks use this to tell "the provider died" from
   * "the gate ran and reported a defect" when no verdict evidence exists.
   */
  inferRecognizedCategory(evidence: FailureEvidence): FailureCategory | undefined {
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
    // A restarted model switch, a gateway capacity hold and a grammar rejection
    // are the serving side failing, whatever role's task they interrupted.
    if (
      /model[_ ]superseded|gateway capacity hold|capacity hold:|http 400.*grammar|failed to parse grammar|failed to initialize samplers/.test(
        summary,
      )
    )
      return "PROVIDER_TRANSIENT";
    if (/workspace|scope mismatch|role-access|repository mismatch/.test(summary)) return "WORKSPACE_SCOPE_MISMATCH";
    if (/evidence.*(unavailable|missing|inaccessible)|candidate evidence unavailable/.test(summary)) {
      return "EVIDENCE_UNAVAILABLE";
    }
    if (/budget exhausted|execution budget|deadline exceeded|wall.clock (timeout|limit)/.test(summary)) {
      return "TASK_BUDGET_EXHAUSTED";
    }
    // A lost execution lease ("execution X is no longer authoritative") is an
    // ownership problem, not a credential one; that exact phrase is checked
    // before the credential words. Loose ownership words ("orphan", "stale
    // owner") are checked after them: "401 Unauthorized while pushing the
    // orphaned branch" is a credential stop, not an ownership loss.
    if (/no longer authoritative/.test(summary)) return "ORPHANED_EXECUTION";
    // `auth` is anchored (optionally as OAuth): unanchored it matched
    // "authoritative" and "author", turning an ownership loss into a STOP.
    if (
      /invalid.*(api key|credential|model|config)|model.*(not found|does not exist)|\bo?auth(?:entication|enticate|orization|orize|orized)?\b|unauthori[sz]ed|forbidden|\b40[13]\b|credential|\btoken (?:expired|revoked|invalid)|\b(?:expired|revoked|invalid) (?:access |refresh |bearer )?token\b/.test(
        summary,
      )
    ) {
      return /provider|api key|model|config/.test(summary) ? "PROVIDER_PERMANENT" : "AUTHORIZATION_OR_CREDENTIAL";
    }
    if (/orphan|no owner|stale owner/.test(summary)) return "ORPHANED_EXECUTION";
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
    // Transport-capacity failures carry no status code and no provider word, so
    // they used to reach the fallback below. They are the most common gateway
    // saturation signature ("Worker failed after 5 attempt(s): Connection
    // error.", "Stream ended without finish_reason"), and a capacity failure is
    // waited out, never stopped (issue #112).
    if (
      /connection error|connection closed|stream ended without (?:a )?finish_reason|no worker_result|(?:missing|empty) worker_result/.test(
        summary,
      )
    ) {
      return "PROVIDER_TRANSIENT";
    }
    return undefined;
  }
}

export class RecoveryPlanner {
  private readonly missionCeiling: number;
  /**
   * A SAFETY ceiling on identical-fingerprint attempts, never a terminal
   * decision by itself: exhausting it parks a failure the pipeline can wait out
   * on a durable wait/probe, and only asks the operator for a category no
   * automatic action can resolve. It used to be 2, which turned two identical
   * gateway-capacity fingerprints into a permanent STOP.
   */
  private readonly strategyMaxAttempts: number;
  /**
   * OPT-IN recovery deadline. Undefined (the default) means recovery is bounded
   * by attempt counts (mission ceiling, per-fingerprint strategy budget), never
   * by a clock: a 30-minute deadline used to STOP missions whose recovery was
   * simply waiting for the gateway or still progressing.
   */
  private readonly decisionTtlMs: number | undefined;

  constructor(options: RecoveryPlannerOptions = {}) {
    this.missionCeiling = options.missionCeiling ?? DEFAULT_MISSION_RECOVERY_CEILING;
    this.strategyMaxAttempts = options.strategyMaxAttempts ?? DEFAULT_STRATEGY_MAX_ATTEMPTS;
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
    const strategyExhausted = fingerprintAttempts >= this.strategyMaxAttempts;
    const budgetExhausted = missionExhausted || deadlineExhausted || strategyExhausted;
    const defaultAction = RecoveryPlanner.defaultAction(input.classification.category);
    // A repeated fingerprint is never terminal by count for a failure the
    // pipeline can only wait out: the identical fingerprint is what a saturated
    // gateway looks like while the mission waits for capacity. Those park on a
    // durable wait/probe (deadline-aware: the wait carries the durable deadline
    // when the policy configures one) so a later tick resumes them.
    const capacityWait = CAPACITY_WAIT_ACTIONS[input.classification.category];
    const action: RecoveryAction = !budgetExhausted ? defaultAction : (capacityWait ?? "STOP");
    const decidedAt = new Date(input.now).toISOString();
    // Parking on an expired deadline would re-diagnose as an expired wait on
    // the next tick, so a capacity park after the deadline carries no deadline:
    // it ends when its condition changes or the operator cancels.
    const parkedDeadline = capacityWait !== undefined && durableDeadline !== undefined && input.now >= durableDeadline;
    const durableDeadlineAt = durableDeadline === undefined ? null : new Date(durableDeadline).toISOString();
    const deadline = parkedDeadline ? null : durableDeadlineAt;
    const budgetReason = missionExhausted
      ? `mission recovery ceiling exhausted (${input.history.length}/${this.missionCeiling})`
      : deadlineExhausted
        ? `mission recovery deadline exhausted at ${durableDeadlineAt}`
        : strategyExhausted
          ? `identical failure fingerprint exhausted its strategy budget (${fingerprintAttempts}/${this.strategyMaxAttempts})`
          : EXPECTED_CHANGE[action];
    const exhaustedReason = !budgetExhausted
      ? EXPECTED_CHANGE[action]
      : capacityWait !== undefined
        ? `${budgetReason}; the mission parks instead of stopping: ${EXPECTED_CHANGE[capacityWait]}`
        : (OPERATOR_QUESTIONS[input.classification.category] ?? budgetReason);
    // When automatic recovery is exhausted and there is no capacity wait to
    // park on, the mission must pause for an operator decision. Surface concrete,
    // category-specific guidance (instead of a silent STOP) so the operator sees
    // exactly what happened and which levers are available. This is carried in
    // operatorGuidance, leaving expectedMaterialChange (the budget reason) intact
    // for downstream consumers and tests.
    const operatorGuidance =
      budgetExhausted && capacityWait === undefined
        ? (ESCALATION_GUIDANCE[input.classification.category] ?? budgetReason)
        : undefined;
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
      expectedMaterialChange: action === "PROBE_AND_BACKOFF" && input.waitReason ? input.waitReason : exhaustedReason,
      attempt,
      maxAttempts: this.strategyMaxAttempts,
      deadline,
      nextActionAt: new Date(input.nextActionAt ?? input.now).toISOString(),
      status: "planned",
      decidedAt,
      failureFingerprint: fingerprint,
      resumptionGeneration,
      operatorGuidance,
    };
  }
}
