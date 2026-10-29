import { createHash } from "node:crypto";
import type { ExecutionOutcome } from "./broker.ts";
import type {
  AlreadySatisfied,
  Execution,
  FailureCategory,
  FailureClassification,
  OrchestrationTask,
  RecoveryAction,
  RecoveryDecision,
  TaskCheckpoint,
  WorkspaceManifest,
  ZeroToolWait,
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
  /** Structured counters behind `waitReason` for a zero-tool-call provider wait. */
  zeroToolWait?: ZeroToolWait;
  resumptionGeneration?: number;
  /**
   * The caller re-evaluates the mission on a clock (the supervisor), so an
   * exhausted attempt count must end in a durable STOP even for failures that
   * are otherwise waited out; a park would be re-planned every tick, forever.
   * Callers that bound their own retries (the scheduler) leave this unset.
   */
  exhaustionIsTerminal?: boolean;
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
  // (#416) The disk suspend interrupts work exactly like a lost owner does:
  // the fence/reconcile primitive resumes from the last checkpoint, so the
  // in-flight task continues instead of being re-reasoned from scratch.
  DISK_SUSPENDED: "FENCE_RECONCILE_AND_RESUME",
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
  // (#416) A disk outage is waited out, never counted against the strategy
  // budget — the same principle as #112 for gateway capacity: the identical
  // failure IS what "waiting for free space" looks like.
  DISK_SUSPENDED: "PROBE_AND_BACKOFF",
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
 * An integration run whose verification stages ran and failed (no conflict).
 * The structured flag decides; the runner's own failure text is the fallback
 * for an outcome that lost the flag in persistence.
 */
function integrationChecksFailed(outcome: ExecutionOutcome | undefined): boolean {
  if (!outcome || outcome.exitStatus === "conflict") return false;
  return outcome.checksFailed === true || /^verification failed at stage:/.test(outcome.error ?? "");
}

/** A request_changes review whose findings the backend kept on the mission record (never after a mutation or an unreadable approval). */
function reviewKeptFindings(outcome: ExecutionOutcome | undefined): boolean {
  const review = outcome?.reviewEvidence;
  return review?.verdict === "request_changes" && review.findings.length > 0 && (outcome?.findings?.length ?? 0) > 0;
}

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
      // A request_changes verdict whose findings were kept is the reviewer's own
      // statement, even if its envelope was sloppy: those findings drive repair.
      if (reviewKeptFindings(outcome)) return true;
      // Otherwise unreadable reviewer output is not a verdict: the review must re-run.
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
    if (integrationChecksFailed(outcome)) return true;
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

/** Prefix of the error a gate backend sets when its model's output could not be read; the gate re-runs. */
export const INVALID_WORKER_OUTPUT_PREFIX = "INVALID_WORKER_OUTPUT";

/**
 * Machine-readable marker the completion gate writes into an empty-candidate
 * reason when a worker asserted that the objective needs no change.
 *
 * Matched FIRST in classification, before every prose pattern. It is an explicit
 * marker rather than an inference, and the worker's free-text reason and proof
 * are interpolated into the same string — so prose patterns must not get a turn
 * at it: an assertion whose text happens to mention a timeout or a review is not
 * a PROVIDER_TRANSIENT or a REVIEW_FAILED. Lower-cased because classification
 * normalizes the summary.
 */
export const ALREADY_SATISFIED_MARKER = "already_satisfied";

/**
 * Marker clause appended to a `loop_prevented` failure when the worker is a
 * MUTATING role that made NO changes vs base.
 *
 * Unlike {@link ALREADY_SATISFIED_MARKER}, this is NOT a worker assertion — the
 * worker was killed by the loop guard before it could report. But the
 * observable facts (a mutating task, prevented from making progress, nothing
 * committed) are exactly the "nothing to do" signature, and without this the
 * bare `loop_prevented` failure matches no classifier rule and is auto-retried
 * or auto-repaired — a weak implementer that cannot conclude "already
 * satisfied" (and so never emits the success-only marker) spirals forever,
 * each repair task re-discovering the same wall. Routing this to
 * REQUIREMENT_AMBIGUITY parks the mission for the operator instead.
 */
export const NO_CHANGE_LOOP_PREVENTED_MARKER = "loop_prevented_no_change_vs_base";

/**
 * The most recent evidenced `already_satisfied` assertion among a mission's
 * successful MUTATING executions.
 *
 * Deliberately narrow. A failed, canceled or read-only run asserting that the
 * objective needs no change is not evidence — only a worker that was asked to
 * change this repository, and succeeded, may say it needed no changing. Shared by
 * the completion gate and the orchestrator's integration check so both read the
 * same fact the same way; the empty-candidate case is not the only place a
 * no-change mission dead-ends, and two definitions would drift.
 */
export function latestAlreadySatisfied(
  tasks: ReadonlyArray<Pick<OrchestrationTask, "task_id" | "mutates_repo" | "repo_id">>,
  executions: ReadonlyArray<Pick<Execution, "task_id" | "status" | "already_satisfied">>,
): AlreadySatisfied | undefined {
  const mutators = new Set(tasks.filter((task) => task.mutates_repo).map((task) => task.task_id));
  if (mutators.size === 0) return undefined;
  return executions
    .filter((execution) => mutators.has(execution.task_id) && execution.status === "SUCCEEDED")
    .filter((execution) => execution.already_satisfied)
    .at(-1)?.already_satisfied;
}

/** The marker clause appended to a no-change failure so recovery stops repairing it. */
export function alreadySatisfiedClause(assertion: AlreadySatisfied): string {
  return (
    ` — ${ALREADY_SATISFIED_MARKER}: a worker asserted the objective needs no change` +
    ` (reason: ${assertion.reason}; proof: ${assertion.proof})`
  );
}

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
    // Integration checks that ran and failed are a defect in the code (repair
    // it); MERGE_CONFLICT (rebuild the candidate) is only for a real conflict.
    const category = kind === "integration" && integrationChecksFailed(outcome) ? "VALIDATION_FAILED" : gateCategory;
    return classifier.classify({ ...evidence, category });
  }
  if (
    kind === "review" &&
    outcome?.reviewEvidence &&
    !outcome.reviewEvidence.outputValid &&
    !reviewKeptFindings(outcome)
  ) {
    return classifier.classify({ ...evidence, category: "PROVIDER_TRANSIENT" });
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
    //
    // Neither may it turn a no-change mission into a repair task. The gate and
    // integration paths hand in a category outright, so matching the marker only
    // inside inferRecognizedCategory would never have run: the loop that consumed
    // a mission for a day was classified REVIEW_FAILED by exactly such a supplied
    // category, over a summary that already said the work was proved done. The
    // marker is appended in two places only — an empty candidate and an
    // integration that produced no change — so it cannot arrive on a summary that
    // reports a real defect on real changed code.
    const summary = normalizedSummary(evidence.summary);
    const category =
      evidence.category !== undefined && LOST_OWNERSHIP.test(summary)
        ? "ORPHANED_EXECUTION"
        : summary.includes(ALREADY_SATISFIED_MARKER) || summary.includes(NO_CHANGE_LOOP_PREVENTED_MARKER)
          ? "REQUIREMENT_AMBIGUITY"
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
    // An explicit "the objective needs no change" assertion is a question for the
    // operator, not a defect to repair. Checking it ahead of the provider status
    // below is deliberate: this is the one signal that is machine-asserted rather
    // than inferred, and routing it to PROVIDER_* would restart the exact loop it
    // exists to end. REQUIREMENT_AMBIGUITY parks the mission for the operator.
    if (summary.includes(ALREADY_SATISFIED_MARKER)) return "REQUIREMENT_AMBIGUITY";
    // A mutating worker prevented from making progress with nothing committed is
    // a question for the operator, not a defect to repair: an implementer that
    // cannot reach the success-only `already_satisfied` assertion otherwise
    // spirals through repair tasks forever (see NO_CHANGE_LOOP_PREVENTED_MARKER).
    if (summary.includes(NO_CHANGE_LOOP_PREVENTED_MARKER)) return "REQUIREMENT_AMBIGUITY";
    // The worker compacted once and the prompt still overflows the model's
    // window (issue #180): replaying it never helps; split the task instead.
    if (/context[_ ]overflow/.test(summary)) return "TASK_BUDGET_EXHAUSTED";
    // (#416) Disk-pressure signatures: ENOSPC kills worker writes, checkpoints
    // and durable appends with "no space left on device". Route to the
    // disk-suspend capacity wait (resume from the last checkpoint; never
    // terminal by count). Ahead of provider statuses on purpose: an ENOSPC
    // surfaced through an HTTP 500 or a worker error is still a disk outage,
    // not provider trouble.
    if (/enospc|no space left on device|disk (?:full|pressure|space)|storage pressure|disk[- ]suspend/.test(summary))
      return "DISK_SUSPENDED";
    // A gateway capacity hold or backpressure is the serving side being
    // saturated, whatever the HTTP status: a saturated edge answers 400 with a
    // `fix_request`/`upstream_error` envelope (type `inferweave_backpressure`,
    // `request_state: unknown`) that LOOKS like a request defect but clears
    // when capacity returns. It must be waited out (PROBE_AND_BACKOFF) and
    // re-dispatched — ideally to a fallback model — never routed to
    // CREATE_REPAIR_TASKS, which burns the repair budget re-issuing the same
    // doomed request (observed: MSN-MypLoa, MSN-U1iY7E).
    if (
      /inferweave_backpressure|backpressure|no capacity right now|has no capacity|capacity (?:hold|unavailable)|gateway capacity|overloaded/.test(
        summary,
      )
    )
      return "PROVIDER_TRANSIENT";
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
    const resumptionGeneration =
      input.resumptionGeneration ?? Math.max(0, ...input.history.map((decision) => decision.resumptionGeneration ?? 0));
    // The strategy budget is per resumption: a durable stop is terminal until
    // the operator resumes, and a resume starts a fresh budget instead of
    // inheriting (and endlessly growing) the count of every earlier episode.
    const fingerprintAttempts = input.history.filter(
      (decision) =>
        decision.failureFingerprint === fingerprint && (decision.resumptionGeneration ?? 0) === resumptionGeneration,
    ).length;
    const attempt = fingerprintAttempts + 1;
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
    // For a clock-driven caller an attempt-count ceiling is terminal for every
    // category: further automatic attempts only burn leases and events until the
    // operator resumes. A clock deadline says nothing about whether capacity
    // returned, so it (and any caller bounding its own retries) still parks.
    const countExhaustedForCaller = input.exhaustionIsTerminal === true && (missionExhausted || strategyExhausted);
    const parksOnCapacity = capacityWait !== undefined && !countExhaustedForCaller;
    const action: RecoveryAction = !budgetExhausted ? defaultAction : parksOnCapacity ? capacityWait : "STOP";
    const decidedAt = new Date(input.now).toISOString();
    // Parking on an expired deadline would re-diagnose as an expired wait on
    // the next tick, so a capacity park after the deadline carries no deadline:
    // it ends when its condition changes or the operator cancels.
    const parkedDeadline = parksOnCapacity && durableDeadline !== undefined && input.now >= durableDeadline;
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
      : parksOnCapacity
        ? `${budgetReason}; the mission parks instead of stopping: ${EXPECTED_CHANGE[capacityWait]}`
        : (OPERATOR_QUESTIONS[input.classification.category] ?? budgetReason);
    // When automatic recovery is exhausted and there is no capacity wait to
    // park on, the mission must pause for an operator decision. Surface concrete,
    // category-specific guidance (instead of a silent STOP) so the operator sees
    // exactly what happened and which levers are available. This is carried in
    // operatorGuidance, leaving expectedMaterialChange (the budget reason) intact
    // for downstream consumers and tests.
    const operatorGuidance =
      budgetExhausted && !parksOnCapacity
        ? (ESCALATION_GUIDANCE[input.classification.category] ?? budgetReason)
        : undefined;
    const recoveryHash = hash({
      missionId: input.classification.missionId,
      classificationId: input.classification.classificationId,
      fingerprint,
      action,
      attempt,
      deadline,
      // A resumed mission restarts its attempt count, so the generation keeps ids distinct.
      ...(resumptionGeneration > 0 ? { resumptionGeneration } : {}),
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
      ...(action === "PROBE_AND_BACKOFF" && input.zeroToolWait ? { zeroToolWait: input.zeroToolWait } : {}),
    };
  }
}

/**
 * What a finished recovery attempt actually did: the action that ran, how it
 * settled, and the gate's current verdict. Reports the live outcome rather than
 * the previous stop's resume condition.
 */
export function describeRecoveryOutcome(
  decision: Pick<RecoveryDecision, "action" | "status"> | undefined,
  verdict: { can_complete: boolean; reasons: string[] },
): string {
  const ran = decision ? `${decision.action} ${decision.status}` : "no recovery action was started";
  const gate = verdict.can_complete
    ? "gate can complete"
    : `gate blocked: ${verdict.reasons.join("; ") || "no reason reported"}`;
  return `${ran}; ${gate}`;
}
