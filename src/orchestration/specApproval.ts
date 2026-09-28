/**
 * Durable autonomous-spec-approval contract (design 2026-09-28).
 *
 * Generates a durable structured specification for a material mission, reviews
 * it in a fresh context, refines within a bounded budget, and approves ONLY the
 * exact reviewed revision + normalized plan. Approval authorizes execution; it
 * never satisfies implementation validation, candidate review, or completion.
 *
 * The controller is mission-local and backed by an append-only SpecStore. The
 * deterministic core (canonical hashing, strict validation, preservation/scope
 * checks, eligibility, invalidation) is side-effect free and independently
 * unit-tested; the controller drives the state machine against injected
 * author/reviewer/refiner backends and the durable store.
 */

import { createHash } from "node:crypto";
import type {
  SpecAuthorBackend,
  SpecRefinerBackend,
  SpecReviewerBackend,
  SpecWorkerModel,
} from "./specBackends.ts";

export type SpecStage = "draft" | "review" | "refine" | "approve" | "materialize";
export type SpecReviewVerdict = "approve" | "request_changes";
export type SpecIndependenceMode = "fresh_context" | "same_model_reduced";

export const DEFAULT_SEMANTIC_REFINEMENT_LIMIT = 2;

/** Immutable user/workspace authority that refinement must never weaken. */
export interface ProtectedUserCriteria {
  userRequest: string;
  constraints: string[];
  /** Protected user acceptance ID/text pairs. */
  acceptance: Array<{ id: string; text: string }>;
  requiredGates: string[];
  workspace: {
    manifestHash: string;
    manifestGeneration: number;
    repositoryId: string;
    repositoryRoot: string;
    baseSha: string;
  };
  policyVersion: string;
}

/** One normalized, validated, planned task in the approved plan. */
export interface SpecPlannedTask {
  task_id: string;
  kind: string;
  role: string;
  objective: string;
  repo_id: string;
  depends_on: string[];
  mutates_repo: boolean;
  write_domains: string[];
  acceptance_ids: string[];
  deliverables: string[];
  execution_budget_ms: number;
  isolation: "none" | "worktree";
}

/** Immutable, durable spec revision. */
export interface MissionSpecRevision {
  missionId: string;
  revisionId: string;
  revisionNumber: number;
  predecessorId: string | null;
  protected: ProtectedUserCriteria;
  derivedAcceptance: string[];
  designSummary: string;
  testObligations: string[];
  assumptions: string[];
  risks: string[];
  nonGoals: string[];
  plan: SpecPlannedTask[];
  semanticSpecHash: string;
  planHash: string;
  fullRecordHash: string;
  authorSession: string | null;
  authorModel: string | null;
  createdAt: string;
}

export interface SpecStageAttempt {
  missionId: string;
  stage: SpecStage;
  attemptNumber: number;
  inputRevisionHash: string | null;
  ownershipGeneration: number;
  fencingToken: number;
  session: string | null;
  model: string | null;
  provider: string | null;
  startedAt: string;
  deadlineAt: string;
  endedAt: string | null;
  outcome: "running" | "succeeded" | "failed" | "cancelled";
  errorClassification: string | null;
  artifactRefs: string[];
}

export interface SpecReviewFinding {
  severity: "blocking" | "major" | "minor";
  title: string;
  detail: string;
  acceptanceId?: string;
}

export interface SpecReviewProposal {
  designSummary?: string;
  testObligations?: string[];
  assumptions?: string[];
  risks?: string[];
  nonGoals?: string[];
  derivedAcceptance?: string[];
  plan?: SpecPlannedTask[];
}

/** Reviewer output bound to the exact spec + plan it evaluated. */
export interface SpecReviewEvidence {
  missionId: string;
  reviewId: string;
  revisionId: string;
  semanticSpecHash: string;
  planHash: string;
  verdict: SpecReviewVerdict;
  findings: SpecReviewFinding[];
  proposedAdjustments: string[];
  uncoveredRisks: string[];
  scopeViolations: string[];
  acceptanceResults: Array<{ acceptanceId: string; result: "covered" | "uncovered" | "not_applicable" }>;
  summary: string;
  confidence: number;
  reviewerSession: string;
  reviewerModel: string;
  provider: string;
  independenceMode: SpecIndependenceMode;
  reviewedAt: string;
}

/** Exact-revision policy authorization to enter the execution pipeline. */
export interface SpecApproval {
  missionId: string;
  approvalId: string;
  revisionId: string;
  semanticSpecHash: string;
  planHash: string;
  acceptanceHash: string;
  workspaceIdentityHash: string;
  baseSha: string;
  policyVersion: string;
  reviewIds: string[];
  actor: "policy";
  rationale: string;
  approvedAt: string;
}

export interface SpecWorkflowState {
  missionId: string;
  phase: SpecStage | "idle" | "stopped";
  revisionNumber: number;
  semanticSpecHash: string | null;
  planHash: string | null;
  semanticRoundsUsed: number;
  semanticRoundsLimit: number;
  activeStage: SpecStageAttempt | null;
  overallDeadlineAt: string | null;
  approval: SpecApproval | null;
  invalidatedApprovalId: string | null;
  warning: string | null;
  nextAction: string;
  nextActionAt: string | null;
  stopReason: string | null;
  resumeCondition: string | null;
}

export class SpecApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SpecApprovalError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Canonical serialization and hashing                                 */
/* ------------------------------------------------------------------ */

/**
 * Deep-canonicalize a value for stable hashing: object keys are byte-sorted
 * recursively, and arrays are treated as unordered collections (deduplicated
 * and byte-sorted) so semantically-equivalent refinements compare equal.
 */
export function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sorted = value
      .map((entry) => canonicalSort(entry))
      .map((entry) => JSON.stringify(entry))
      .sort()
      .filter((entry, index, all) => index === 0 || entry !== all[index - 1]);
    return sorted.map((entry) => JSON.parse(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      out[key] = canonicalSort(item);
    }
    return out;
  }
  return value;
}

export function sha256(input: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalSort(input))).digest("hex")}`;
}

/** Protected requirement + design content only; excludes plan, ids, provenance, timestamps. */
export function computeSemanticSpecHash(
  protectedInputs: ProtectedUserCriteria,
  derivedAcceptance: string[],
  designSummary: string,
  testObligations: string[],
  assumptions: string[],
  risks: string[],
  nonGoals: string[],
): string {
  return sha256({
    protected: protectedInputs,
    derivedAcceptance,
    designSummary,
    testObligations,
    assumptions,
    risks,
    nonGoals,
  });
}

/** Deterministically-ordered normalized planned tasks only. */
export function computePlanHash(plan: SpecPlannedTask[]): string {
  return sha256(plan.map((task) => taskIdentity(task)));
}

function taskIdentity(task: SpecPlannedTask): Record<string, unknown> {
  return {
    acceptance_ids: task.acceptance_ids,
    depends_on: task.depends_on,
    deliverables: task.deliverables,
    execution_budget_ms: task.execution_budget_ms,
    kind: task.kind,
    mutates_repo: task.mutates_repo,
    objective: task.objective,
    repo_id: task.repo_id,
    role: task.role,
    write_domains: task.write_domains,
  };
}

export function computeFullRecordHash(revision: Omit<MissionSpecRevision, "fullRecordHash">): string {
  return sha256(revision);
}

/**
 * Stable deterministic task ID derived from mission ID, semantic spec hash,
 * repository ID, and the normalized task ordinal.
 */
export function stableTaskId(missionId: string, semanticSpecHash: string, repositoryId: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([missionId, semanticSpecHash, repositoryId, ordinal]))
    .digest("hex")
    .slice(0, 16);
  return `TSK-${digest}`;
}

/** Deterministic fingerprint of the normalized blocking-finding set (plateau detection). */
export function blockingFindingFingerprint(findings: SpecReviewFinding[]): string {
  return sha256(findings.filter((finding) => finding.severity === "blocking"));
}

/* ------------------------------------------------------------------ */
/* Strict output validation                                            */
/* ------------------------------------------------------------------ */

export interface SpecScopeEnvelope {
  repositoryId: string;
  repositoryRoot: string;
  writableDomains: string[];
  baseSha: string;
}

export interface PlannedTaskInput {
  task_id?: string;
  kind: string;
  role: string;
  objective: string;
  repo_id?: string;
  depends_on?: string[];
  mutates_repo: boolean;
  write_domains?: string[];
  acceptance_ids?: string[];
  deliverables?: string[];
  execution_budget_ms?: number;
  isolation?: "none" | "worktree";
}

/** Validate raw planned tasks strictly; throws SpecApprovalError on any violation. */
export function validatePlannedTasks(
  raw: unknown,
  envelope: SpecScopeEnvelope,
  acceptanceIds: string[],
  maxDeliverablesPerTask = 4,
): SpecPlannedTask[] {
  if (!Array.isArray(raw)) throw new SpecApprovalError("MALFORMED_PLAN", "planned tasks must be an array");
  const allowedAcceptance = new Set(acceptanceIds);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new SpecApprovalError("MALFORMED_PLAN", `task at ordinal ${index} is not an object`);
    }
    const task = entry as PlannedTaskInput;
    const objective = task.objective?.trim();
    const kind = task.kind?.trim();
    const role = task.role?.trim();
    if (!objective || !kind || !role) {
      throw new SpecApprovalError("MALFORMED_PLAN", `task at ordinal ${index} requires objective/kind/role`);
    }
    const repoId = task.repo_id?.trim() || envelope.repositoryId;
    if (repoId !== envelope.repositoryId) {
      throw new SpecApprovalError(
        "SCOPE_VIOLATION",
        `task at ordinal ${index} targets repository ${repoId} outside the approved envelope ${envelope.repositoryId}`,
      );
    }
    const writeDomains = [...(task.write_domains ?? [])].map((domain) => domain.trim());
    if (task.mutates_repo && !writeDomainWithin(writeDomains, envelope.writableDomains)) {
      throw new SpecApprovalError(
        "WRITE_DOMAIN_OUTSIDE_REPOSITORY",
        `task at ordinal ${index} writes ${writeDomains.join(", ")} outside ${envelope.writableDomains.join(", ")}`,
      );
    }
    const acceptanceIdsForTask = [...(task.acceptance_ids ?? [])];
    for (const acceptanceId of acceptanceIdsForTask) {
      if (!allowedAcceptance.has(acceptanceId)) {
        throw new SpecApprovalError("UNKNOWN_ACCEPTANCE", `task covers unknown acceptance ID ${acceptanceId}`);
      }
    }
    const deliverables = (task.deliverables?.length ? task.deliverables : [objective]).map((item) => item.trim());
    if (deliverables.length > maxDeliverablesPerTask) {
      throw new SpecApprovalError(
        "DECOMPOSITION_REQUIRED",
        `task at ordinal ${index} has ${deliverables.length} deliverables (max ${maxDeliverablesPerTask})`,
      );
    }
    const executionBudget = Number.isFinite(task.execution_budget_ms) && (task.execution_budget_ms ?? 0) > 0
      ? task.execution_budget_ms!
      : 30 * 60_000;
    const taskId = task.task_id?.trim() || stableTaskId("", "", envelope.repositoryId, index);
    if (seen.has(taskId)) throw new SpecApprovalError("DUPLICATE_TASK_ID", `task ID ${taskId} repeated`);
    seen.add(taskId);
    return {
      task_id: taskId,
      kind,
      role,
      objective,
      repo_id: repoId,
      depends_on: [...(task.depends_on ?? [])],
      mutates_repo: Boolean(task.mutates_repo),
      write_domains: writeDomains,
      acceptance_ids: acceptanceIdsForTask,
      deliverables,
      execution_budget_ms: executionBudget,
      isolation: task.isolation ?? (task.mutates_repo ? "worktree" : "none"),
    };
  });
}

/** Check every covered acceptance criterion is present in the plan. */
export function coverageComplete(plan: SpecPlannedTask[], acceptanceIds: string[]): boolean {
  const covered = new Set(plan.flatMap((task) => task.acceptance_ids));
  return acceptanceIds.every((acceptanceId) => covered.has(acceptanceId));
}

function writeDomainWithin(requested: string[], authorized: string[]): boolean {
  if (requested.length === 0) return true;
  return requested.every((domain) => {
    const target = domain.replaceAll("\\", "/").replace(/\/$/, "").split("/");
    return authorized.some((allowed) => {
      const prefix = allowed.replaceAll("\\", "/").replace(/\/$/, "").split("/");
      const recursive = prefix.at(-1) === "**";
      const base = recursive ? prefix.slice(0, -1) : prefix;
      if (!recursive && target.length !== base.length) return false;
      if (target.length < base.length) return false;
      return base.every((segment, index) => target[index] === segment);
    });
  });
}

/** Strict reviewer-output validation; throws SpecApprovalError when malformed. */
export function validateReviewResult(raw: unknown, allowedAcceptanceIds: string[]): SpecReviewEvidence["acceptanceResults"] {
  if (!raw || typeof raw !== "object") throw new SpecApprovalError("MALFORMED_REVIEW", "review result must be an object");
  const result = raw as {
    verdict?: unknown;
    findings?: unknown;
    acceptanceResults?: unknown;
    reviewerSession?: unknown;
    reviewerModel?: unknown;
    provider?: unknown;
  };
  if (result.verdict !== "approve" && result.verdict !== "request_changes") {
    throw new SpecApprovalError("MALFORMED_REVIEW", "review verdict must be approve or request_changes");
  }
  if (!Array.isArray(result.acceptanceResults)) {
    throw new SpecApprovalError("INCOMPLETE_REVIEW", "review must give an explicit result for every acceptance ID");
  }
  const allowed = new Set(allowedAcceptanceIds);
  const seen = new Set<string>();
  const acceptanceResults = result.acceptanceResults.map((entry) => {
    if (!entry || typeof entry !== "object") throw new SpecApprovalError("MALFORMED_REVIEW", "malformed acceptance result");
    const value = entry as { acceptanceId?: unknown; result?: unknown };
    const acceptanceId = String(value.acceptanceId ?? "").trim();
    if (!allowed.has(acceptanceId) || seen.has(acceptanceId)) {
      throw new SpecApprovalError("UNKNOWN_ACCEPTANCE", `invalid acceptance result ID ${acceptanceId}`);
    }
    if (value.result !== "covered" && value.result !== "uncovered" && value.result !== "not_applicable") {
      throw new SpecApprovalError("MALFORMED_REVIEW", `invalid acceptance result status ${value.result}`);
    }
    seen.add(acceptanceId);
    return { acceptanceId, result: value.result };
  });
  if (allowedAcceptanceIds.some((acceptanceId) => !seen.has(acceptanceId))) {
    throw new SpecApprovalError("INCOMPLETE_REVIEW", "review omitted a required acceptance result");
  }
  if (!result.findings || !Array.isArray(result.findings)) {
    throw new SpecApprovalError("MALFORMED_REVIEW", "review must include a findings array");
  }
  if (!result.reviewerSession || !result.reviewerModel || !result.provider) {
    throw new SpecApprovalError("INVENTED_PROVENANCE", "review must carry reviewer session, model, and provider provenance");
  }
  return acceptanceResults;
}

/** Requirement preservation: a refinement may add detail but never weaken protected inputs. */
export function preservesProtectedInputs(prior: ProtectedUserCriteria, refined: ProtectedUserCriteria): boolean {
  return (
    prior.userRequest === refined.userRequest &&
    prior.policyVersion === refined.policyVersion &&
    prior.workspace.manifestHash === refined.workspace.manifestHash &&
    prior.workspace.manifestGeneration === refined.workspace.manifestGeneration &&
    prior.workspace.repositoryId === refined.workspace.repositoryId &&
    prior.workspace.repositoryRoot === refined.workspace.repositoryRoot &&
    prior.workspace.baseSha === refined.workspace.baseSha &&
    setEqual(prior.constraints, refined.constraints) &&
    setEqual(prior.requiredGates, refined.requiredGates) &&
    acceptanceEqual(prior.acceptance, refined.acceptance)
  );
}

function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const item of sa) if (!sb.has(item)) return false;
  return true;
}

function acceptanceEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false;
  const byIdA = new Map(a.map((entry) => [entry.id, entry.text]));
  return b.every((entry) => byIdA.get(entry.id) === entry.text);
}

/** Approval eligibility: exact revision + normalized plan, complete coverage, clean provenance. */
export function approvalEligible(
  revision: MissionSpecRevision,
  review: SpecReviewEvidence,
  acceptanceIds: string[],
  policyVersion: string,
): boolean {
  if (review.verdict !== "approve") return false;
  if (review.semanticSpecHash !== revision.semanticSpecHash || review.planHash !== revision.planHash) return false;
  if (!coverageComplete(revision.plan, acceptanceIds)) return false;
  if (revision.protected.policyVersion !== policyVersion) return false;
  if (review.independenceMode !== "fresh_context" && review.independenceMode !== "same_model_reduced") return false;
  return true;
}

export function acceptanceHash(acceptance: Array<{ id: string; text: string }>): string {
  return sha256(acceptance);
}

export function workspaceIdentityHash(workspace: ProtectedUserCriteria["workspace"]): string {
  return sha256(workspace);
}

/** A previously-bound approval is invalidated when any bound input changes. */
export function approvalInvalidated(
  approval: SpecApproval,
  protectedInputs: ProtectedUserCriteria,
  planHash: string,
): string | null {
  if (protectedInputs.policyVersion !== approval.policyVersion) return "POLICY_VERSION";
  if (protectedInputs.workspace.baseSha !== approval.baseSha) return "BASE_SHA";
  if (workspaceIdentityHash(protectedInputs.workspace) !== approval.workspaceIdentityHash) return "WORKSPACE_IDENTITY";
  if (acceptanceHash(protectedInputs.acceptance) !== approval.acceptanceHash) return "ACCEPTANCE";
  if (planHash !== approval.planHash) return "NORMALIZED_PLAN";
  return null;
}

/* ------------------------------------------------------------------ */
/* Durable store abstraction                                           */
/* ------------------------------------------------------------------ */

export interface SpecMaterializeResult {
  created: string[];
  reused: string[];
  mismatched: string[];
  ready: boolean;
}

export interface SpecStore {
  getWorkflowState(missionId: string): SpecWorkflowState | null;
  getCurrentRevision(missionId: string): MissionSpecRevision | null;
  getLatestReview(missionId: string): SpecReviewEvidence | null;
  getApproval(missionId: string): SpecApproval | null;
  appendStage(stage: SpecStageAttempt): Promise<void>;
  appendRevision(revision: MissionSpecRevision): Promise<void>;
  appendReview(review: SpecReviewEvidence): Promise<void>;
  appendApproval(approval: SpecApproval): Promise<void>;
  invalidateApproval(missionId: string, approvalId: string, reason: string, newFencingToken: number): Promise<void>;
  materializeTasks(missionId: string, revision: MissionSpecRevision, approval: SpecApproval): Promise<SpecMaterializeResult>;
  /** Optional durable state projection hook. */
  persistWorkflowState?(state: SpecWorkflowState): void;
  listTasks(missionId: string): Array<{ task_id: string; approval_id?: string; semantic_spec_hash?: string }>;
}

/** In-memory durable store for tests and the standalone controller. */
export class MemorySpecStore implements SpecStore {
  private readonly revisions = new Map<string, MissionSpecRevision>();
  private readonly reviews = new Map<string, SpecReviewEvidence>();
  private readonly approvals = new Map<string, SpecApproval>();
  private readonly invalidated = new Map<string, { approvalId: string; reason: string; fencingToken: number }>();
  private readonly stages: SpecStageAttempt[] = [];
  private readonly tasks: Array<{ task_id: string; approval_id: string; semantic_spec_hash: string }> = [];
  private readonly states = new Map<string, SpecWorkflowState>();

  getWorkflowState(missionId: string): SpecWorkflowState | null {
    return this.states.get(missionId) ?? null;
  }
  getCurrentRevision(missionId: string): MissionSpecRevision | null {
    let latest: MissionSpecRevision | null = null;
    for (const revision of this.revisions.values()) {
      if (revision.missionId !== missionId) continue;
      if (!latest || revision.revisionNumber > latest.revisionNumber) latest = revision;
    }
    return latest;
  }
  getLatestReview(missionId: string): SpecReviewEvidence | null {
    let latest: SpecReviewEvidence | null = null;
    for (const review of this.reviews.values()) {
      if (review.missionId !== missionId) continue;
      if (!latest || review.reviewedAt > latest.reviewedAt) latest = review;
    }
    return latest;
  }
  getApproval(missionId: string): SpecApproval | null {
    return this.approvals.get(missionId) ?? null;
  }
  async appendStage(stage: SpecStageAttempt): Promise<void> {
    this.stages.push(stage);
  }
  async appendRevision(revision: MissionSpecRevision): Promise<void> {
    this.revisions.set(revision.revisionId, revision);
  }
  async appendReview(review: SpecReviewEvidence): Promise<void> {
    this.reviews.set(review.reviewId, review);
  }
  async appendApproval(approval: SpecApproval): Promise<void> {
    this.approvals.set(approval.missionId, approval);
  }
  async invalidateApproval(missionId: string, approvalId: string, reason: string, fencingToken: number): Promise<void> {
    if (this.approvals.get(missionId)?.approvalId === approvalId) this.approvals.delete(missionId);
    this.invalidated.set(missionId, { approvalId, reason, fencingToken });
  }
  async materializeTasks(
    missionId: string,
    revision: MissionSpecRevision,
    approval: SpecApproval,
  ): Promise<SpecMaterializeResult> {
    const existing = new Map(this.tasks.map((task) => [task.task_id, task]));
    const result: SpecMaterializeResult = { created: [], reused: [], mismatched: [], ready: false };
    let mismatched = false;
    for (const task of revision.plan) {
      const existingTask = existing.get(task.task_id);
      if (existingTask) {
        if (existingTask.approval_id !== approval.approvalId || existingTask.semantic_spec_hash !== approval.semanticSpecHash) {
          result.mismatched.push(task.task_id);
          mismatched = true;
        } else {
          result.reused.push(task.task_id);
        }
      } else {
        this.tasks.push({
          task_id: task.task_id,
          approval_id: approval.approvalId,
          semantic_spec_hash: approval.semanticSpecHash,
        });
        result.created.push(task.task_id);
      }
    }
    result.ready = !mismatched;
    return result;
  }
  listTasks(missionId: string): Array<{ task_id: string; approval_id: string; semantic_spec_hash: string }> {
    return this.tasks.filter((task) => task.approval_id === this.approvals.get(missionId)?.approvalId);
  }

  setState(state: SpecWorkflowState): void {
    this.states.set(state.missionId, state);
  }
  stagesFor(missionId: string): SpecStageAttempt[] {
    return this.stages.filter((stage) => stage.missionId === missionId);
  }
  invalidatedFor(missionId: string) {
    return this.invalidated.get(missionId) ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Bounded controller state machine                                    */
/* ------------------------------------------------------------------ */


export interface SpecControllerInput {
  missionId: string;
  protectedInputs: ProtectedUserCriteria;
  acceptanceIds: string[];
  envelope: SpecScopeEnvelope;
  store: SpecStore;
  author: SpecAuthorBackend;
  reviewer: SpecReviewerBackend;
  refiner: SpecRefinerBackend;
  authorModel: SpecWorkerModel;
  reviewerModel: SpecWorkerModel | null;
  semanticRoundsLimit?: number;
  stageDeadlineMs?: number;
  overallDeadlineMs?: number;
  now?: () => string;
  /** Deterministic task-id base when the plan has no stable IDs yet. */
  semanticRoundsUsed?: number;
}

export interface SpecControllerResult {
  approved: boolean;
  revision: MissionSpecRevision | null;
  approval: SpecApproval | null;
  materialized: SpecMaterializeResult | null;
  state: SpecWorkflowState;
  stopReason: string | null;
  resumeCondition: string | null;
}

/**
 * Drives draft -> review -> (refine)* -> approve -> materialize. Replay resumes
 * from the last durable boundary; budgets/deadlines never reset on restart.
 */
export class SpecApprovalController {
  private readonly missionId: string;
  private readonly protectedInputs: ProtectedUserCriteria;
  private readonly acceptanceIds: string[];
  private readonly envelope: SpecScopeEnvelope;
  private readonly store: SpecStore;
  private readonly author: SpecAuthorBackend;
  private readonly reviewer: SpecReviewerBackend;
  private readonly refiner: SpecRefinerBackend;
  private readonly authorModel: SpecWorkerModel;
  private readonly reviewerModel: SpecWorkerModel | null;
  private readonly semanticRoundsLimit: number;
  private readonly stageDeadlineMs: number;
  private readonly overallDeadlineMs: number;
  private readonly now: () => string;
  private readonly semanticRoundsUsed: number;
  private state: SpecWorkflowState;
  private attemptCounter = 0;

  constructor(input: SpecControllerInput) {
    this.missionId = input.missionId;
    this.protectedInputs = input.protectedInputs;
    this.acceptanceIds = input.acceptanceIds;
    this.envelope = input.envelope;
    this.store = input.store;
    this.author = input.author;
    this.reviewer = input.reviewer;
    this.refiner = input.refiner;
    this.authorModel = input.authorModel;
    this.reviewerModel = input.reviewerModel;
    this.semanticRoundsLimit = input.semanticRoundsLimit ?? DEFAULT_SEMANTIC_REFINEMENT_LIMIT;
    this.stageDeadlineMs = input.stageDeadlineMs ?? 5 * 60_000;
    this.overallDeadlineMs = input.overallDeadlineMs ?? 40 * 60_000;
    this.now = input.now ?? (() => new Date().toISOString());
    this.semanticRoundsUsed = input.semanticRoundsUsed ?? 0;
    this.state = input.store.getWorkflowState(this.missionId) ?? {
      missionId: this.missionId,
      phase: "idle",
      revisionNumber: 0,
      semanticSpecHash: null,
      planHash: null,
      semanticRoundsUsed: this.semanticRoundsUsed,
      semanticRoundsLimit: this.semanticRoundsLimit,
      activeStage: null,
      overallDeadlineAt: null,
      approval: null,
      invalidatedApprovalId: null,
      warning: null,
      nextAction: "draft",
      nextActionAt: null,
      stopReason: null,
      resumeCondition: null,
    };
  }

  async run(): Promise<SpecControllerResult> {
    // Replay: already approved + materialized -> done.
    const existingApproval = this.store.getApproval(this.missionId);
    if (existingApproval) {
      const invalidated = approvalInvalidated(existingApproval, this.protectedInputs, this.computePlanHash());
      if (!invalidated) {
        const revision = this.store.getCurrentRevision(this.missionId);
        const materialized = revision
          ? await this.store.materializeTasks(this.missionId, revision, existingApproval)
          : null;
        this.state = { ...this.state, phase: "materialize", approval: existingApproval };
        return {
          approved: true,
          revision,
          approval: existingApproval,
          materialized,
          state: this.state,
          stopReason: null,
          resumeCondition: null,
        };
      }
      // Invalidate stale approval atomically before further dispatch.
      await this.store.invalidateApproval(this.missionId, existingApproval.approvalId, invalidated, this.attemptCounter);
      this.state = { ...this.state, invalidatedApprovalId: existingApproval.approvalId, approval: null };
    }

    const startedAt = this.now();
    const overallDeadline = new Date(new Date(startedAt).getTime() + this.overallDeadlineMs).toISOString();
    if (!this.state.overallDeadlineAt) this.state = { ...this.state, overallDeadlineAt: overallDeadline };

    // Resume from the last durable boundary: use the current revision if present.
    let revision = this.store.getCurrentRevision(this.missionId);

    if (!revision) {
      revision = await this.draft();
    }

    let review = this.store.getLatestReview(this.missionId);
    let roundsUsed = this.state.semanticRoundsUsed;
    let previousBlockingFingerprint: string | null = null;
    let previousSemanticHash: string | null = null;

    while (true) {
      if (new Date(this.now()).getTime() > new Date(this.state.overallDeadlineAt!).getTime()) {
        return this.stop(
          "SPEC_DEADLINE_EXHAUSTED",
          "Autonomous spec approval exceeded its overall deadline without reaching approval",
        );
      }

      if (!review || review.revisionId !== revision.revisionId) {
        review = await this.reviewRevision(revision);
      }

      if (review.verdict === "approve") {
        const eligible = approvalEligible(revision, review, this.acceptanceIds, this.protectedInputs.policyVersion);
        if (!eligible) {
          return this.stop(
            "REVIEW_INELIGIBLE",
            "Review approved but did not meet the deterministic eligibility policy",
          );
        }
        const approval = await this.approve(revision, review);
        const materialized = await this.store.materializeTasks(this.missionId, revision, approval);
        if (!materialized.ready) {
          return this.stop(
            "MATERIALIZATION_MISMATCH",
            `task materialization stopped: mismatched ${materialized.mismatched.join(", ")}`,
          );
        }
        this.state = { ...this.state, phase: "materialize", approval, revisionNumber: revision.revisionNumber };
        this.persistState();
        return {
          approved: true,
          revision,
          approval,
          materialized,
          state: this.state,
          stopReason: null,
          resumeCondition: null,
        };
      }

      // request_changes
      if (roundsUsed >= this.semanticRoundsLimit) {
        return this.stop(
          "REFINEMENT_EXHAUSTED",
          `Semantic refinement budget exhausted after ${this.semanticRoundsLimit} round(s) with review still requesting changes`,
        );
      }
      const currentBlockingFingerprint = blockingFindingFingerprint(review.findings);
      const noSemanticChange = previousSemanticHash !== null && previousSemanticHash === revision.semanticSpecHash;
      if (noSemanticChange && previousBlockingFingerprint !== null && currentBlockingFingerprint === previousBlockingFingerprint) {
        return this.stop(
          "REFINEMENT_PLATEAU",
          "Refinement plateaued: identical semantic spec hash and unchanged blocking findings persisted across a round",
        );
      }
      previousBlockingFingerprint = currentBlockingFingerprint;
      previousSemanticHash = revision.semanticSpecHash;

      roundsUsed += 1;
      this.state = { ...this.state, semanticRoundsUsed: roundsUsed };
      revision = await this.refine(revision, review);
      review = null; // force a fresh review of the new revision
      this.persistState();
    }
  }

  private computePlanHash(): string {
    const revision = this.store.getCurrentRevision(this.missionId);
    return revision ? revision.planHash : "";
  }

  private async draft(): Promise<MissionSpecRevision> {
    const attempt = this.beginStage("draft");
    const sessionId = this.sessionIdFor("spec-author");
    const deadlineAt = this.deadline(attempt);
    const result = await this.author.draft({
      missionId: this.missionId,
      protectedInputs: this.protectedInputs,
      model: this.authorModel,
      sessionId,
      deadlineAt,
    });
    if (!result.ok || !result.draft) {
      throw new SpecApprovalError("AUTHOR_FAILED", result.error ?? "spec author produced no draft");
    }
    const draft = result.draft;
    const plan = validatePlannedTasks(draft.proposedTasks, this.envelope, this.acceptanceIds);
    const semanticSpecHash = computeSemanticSpecHash(
      this.protectedInputs,
      draft.derivedAcceptance,
      draft.designSummary,
      draft.testObligations,
      draft.assumptions,
      draft.risks,
      draft.nonGoals,
    );
    const planHash = computePlanHash(plan);
    const revision: MissionSpecRevision = {
      missionId: this.missionId,
      revisionId: `SPCREV-${this.attemptCounter++}`,
      revisionNumber: this.state.revisionNumber + 1,
      predecessorId: this.store.getCurrentRevision(this.missionId)?.revisionId ?? null,
      protected: this.protectedInputs,
      derivedAcceptance: draft.derivedAcceptance,
      designSummary: draft.designSummary,
      testObligations: draft.testObligations,
      assumptions: draft.assumptions,
      risks: draft.risks,
      nonGoals: draft.nonGoals,
      plan,
      semanticSpecHash,
      planHash,
      fullRecordHash: "",
      authorSession: sessionId,
      authorModel: result.modelId,
      createdAt: this.now(),
    };
    revision.fullRecordHash = computeFullRecordHash(revision);
    await this.store.appendRevision(revision);
    this.state = {
      ...this.state,
      phase: "draft",
      revisionNumber: revision.revisionNumber,
      semanticSpecHash,
      planHash,
      nextAction: "review",
    };
    this.persistState();
    return revision;
  }

  private async reviewRevision(revision: MissionSpecRevision): Promise<SpecReviewEvidence> {
    const attempt = this.beginStage("review");
    const sessionId = this.sessionIdFor("spec-reviewer");
    const deadlineAt = this.deadline(attempt);
    const { model, independenceMode } = this.resolveReviewerModel();
    if (!model || !model.id) {
      throw new SpecApprovalError("REVIEWER_MODEL_UNAVAILABLE", "no usable model identity exists for review");
    }
    const result = await this.reviewer.review({
      missionId: this.missionId,
      revision,
      acceptanceIds: this.acceptanceIds,
      model,
      independenceMode,
      sessionId,
      deadlineAt,
    });
    if (!result.ok) {
      throw new SpecApprovalError("REVIEW_FAILED", result.error ?? "spec reviewer produced no verdict");
    }
    const acceptanceResults = validateReviewResult(
      {
        verdict: result.verdict,
        findings: result.findings,
        acceptanceResults: result.acceptanceResults,
        reviewerSession: sessionId,
        reviewerModel: result.modelId,
        provider: model.provider,
      },
      this.acceptanceIds,
    );
    const review: SpecReviewEvidence = {
      missionId: this.missionId,
      reviewId: `SPCREVW-${this.attemptCounter++}`,
      revisionId: revision.revisionId,
      semanticSpecHash: revision.semanticSpecHash,
      planHash: revision.planHash,
      verdict: result.verdict!,
      findings: (result.findings ?? []).map(normalizeFinding),
      proposedAdjustments: result.proposedAdjustments ?? [],
      uncoveredRisks: result.uncoveredRisks ?? [],
      scopeViolations: result.scopeViolations ?? [],
      acceptanceResults,
      summary: result.summary ?? "",
      confidence: result.confidence ?? 0,
      reviewerSession: sessionId,
      reviewerModel: result.modelId,
      provider: model.provider,
      independenceMode,
      reviewedAt: this.now(),
    };
    await this.store.appendReview(review);
    this.state = {
      ...this.state,
      phase: "review",
      warning: independenceMode === "same_model_reduced" ? "same-model review has reduced independence" : null,
      nextAction: review.verdict === "approve" ? "approve" : "refine",
    };
    this.persistState();
    return review;
  }

  private async refine(revision: MissionSpecRevision, review: SpecReviewEvidence): Promise<MissionSpecRevision> {
    const attempt = this.beginStage("refine");
    const sessionId = this.sessionIdFor("spec-refiner");
    const deadlineAt = this.deadline(attempt);
    const result = await this.refiner.refine({
      missionId: this.missionId,
      revision,
      review,
      protectedInputs: this.protectedInputs,
      model: this.authorModel,
      sessionId,
      deadlineAt,
    });
    if (!result.ok || !result.draft) {
      throw new SpecApprovalError("REFINER_FAILED", result.error ?? "spec refiner produced no draft");
    }
    const draft = result.draft;
    const plan = validatePlannedTasks(draft.proposedTasks, this.envelope, this.acceptanceIds);
    const semanticSpecHash = computeSemanticSpecHash(
      this.protectedInputs,
      draft.derivedAcceptance,
      draft.designSummary,
      draft.testObligations,
      draft.assumptions,
      draft.risks,
      draft.nonGoals,
    );
    const planHash = computePlanHash(plan);
    const refined: MissionSpecRevision = {
      missionId: this.missionId,
      revisionId: `SPCREV-${this.attemptCounter++}`,
      revisionNumber: revision.revisionNumber + 1,
      predecessorId: revision.revisionId,
      protected: this.protectedInputs,
      derivedAcceptance: draft.derivedAcceptance,
      designSummary: draft.designSummary,
      testObligations: draft.testObligations,
      assumptions: draft.assumptions,
      risks: draft.risks,
      nonGoals: draft.nonGoals,
      plan,
      semanticSpecHash,
      planHash,
      fullRecordHash: "",
      authorSession: sessionId,
      authorModel: result.modelId,
      createdAt: this.now(),
    };
    if (!preservesProtectedInputs(this.protectedInputs, refined.protected)) {
      throw new SpecApprovalError("REQUIREMENT_WEAKENED", "refinement weakened a protected input");
    }
    refined.fullRecordHash = computeFullRecordHash(refined);
    await this.store.appendRevision(refined);
    this.state = {
      ...this.state,
      phase: "refine",
      revisionNumber: refined.revisionNumber,
      semanticSpecHash,
      planHash,
      nextAction: "review",
    };
    this.persistState();
    return refined;
  }

  private async approve(revision: MissionSpecRevision, review: SpecReviewEvidence): Promise<SpecApproval> {
    const approval: SpecApproval = {
      missionId: this.missionId,
      approvalId: `SPCAPPR-${this.attemptCounter++}`,
      revisionId: revision.revisionId,
      semanticSpecHash: revision.semanticSpecHash,
      planHash: revision.planHash,
      acceptanceHash: acceptanceHash(this.protectedInputs.acceptance),
      workspaceIdentityHash: workspaceIdentityHash(this.protectedInputs.workspace),
      baseSha: this.protectedInputs.workspace.baseSha,
      policyVersion: this.protectedInputs.policyVersion,
      reviewIds: [review.reviewId],
      actor: "policy",
      rationale: "Deterministic approval policy passed for the exact reviewed revision and normalized plan",
      approvedAt: this.now(),
    };
    await this.store.appendApproval(approval);
    this.state = { ...this.state, phase: "approve", approval, nextAction: "materialize" };
    this.persistState();
    return approval;
  }

  private resolveReviewerModel(): { model: SpecWorkerModel | null; independenceMode: "fresh_context" | "same_model_reduced" } {
    if (!this.reviewerModel || !this.reviewerModel.id) {
      // No distinct reviewer model: current model in a new session, reduced independence.
      return { model: this.authorModel, independenceMode: "same_model_reduced" };
    }
    if (this.reviewerModel.id !== this.authorModel.id) {
      return { model: this.reviewerModel, independenceMode: "fresh_context" };
    }
    return { model: this.authorModel, independenceMode: "same_model_reduced" };
  }

  private beginStage(stage: SpecStage): SpecStageAttempt {
    const attemptNumber = ++this.attemptCounter;
    const startedAt = this.now();
    const deadlineAt = new Date(new Date(startedAt).getTime() + this.stageDeadlineMs).toISOString();
    const attempt: SpecStageAttempt = {
      missionId: this.missionId,
      stage,
      attemptNumber,
      inputRevisionHash: this.store.getCurrentRevision(this.missionId)?.semanticSpecHash ?? null,
      ownershipGeneration: 0,
      fencingToken: attemptNumber,
      session: null,
      model: null,
      provider: null,
      startedAt,
      deadlineAt,
      endedAt: null,
      outcome: "running",
      errorClassification: null,
      artifactRefs: [],
    };
    void this.store.appendStage(attempt);
    this.state = { ...this.state, activeStage: attempt };
    return attempt;
  }

  private deadline(attempt: SpecStageAttempt): string {
    return attempt.deadlineAt;
  }

  private sessionIdFor(role: "spec-author" | "spec-reviewer" | "spec-refiner"): string {
    return `${this.missionId}:${role}:${this.attemptCounter}:${this.now()}`;
  }

  private stop(stopReason: string, resumeCondition: string): SpecControllerResult {
    this.state = {
      ...this.state,
      phase: "stopped",
      stopReason,
      resumeCondition,
      nextAction: "stop",
    };
    this.persistState();
    return {
      approved: false,
      revision: this.store.getCurrentRevision(this.missionId),
      approval: null,
      materialized: null,
      state: this.state,
      stopReason,
      resumeCondition,
    };
  }

  private persistState(): void {
    this.store.persistWorkflowState?.(this.state);
    if (this.store instanceof MemorySpecStore) this.store.setState(this.state);
  }
}

function normalizeFinding(raw: Record<string, unknown>): SpecReviewFinding {
  const severity = raw.severity === "major" ? "major" : raw.severity === "minor" ? "minor" : "blocking";
  return {
    severity,
    title: String(raw.title ?? ""),
    detail: String(raw.detail ?? ""),
    acceptanceId: typeof raw.acceptanceId === "string" ? raw.acceptanceId : undefined,
  };
}
