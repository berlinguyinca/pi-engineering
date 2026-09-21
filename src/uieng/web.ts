/**
 * pi-web integration adapter surface (docs/specs/autonomous-ui-engineering).
 *
 * pi-web is EXTERNAL: this module is the stable, normalized event/query
 * adapter it consumes. It does NOT rebuild any pi-web UI. Every function here
 * is pure and deterministic over the uieng domain modules (rubric, evidence,
 * review, exploration, tournament, controller, usability, schemas) so the
 * snapshot/event payloads are reproducible from persisted records.
 *
 * Deliverables:
 *   1. A versioned WebSnapshot builder (one payload for the whole dashboard).
 *   2. Typed event constructors for push integration into pi-web.
 *   3. A stable query-contract adapter interface (interface only).
 */

import type { UiImpactLevel } from "./policy.ts";
import { METRICS_BY_ID, type MetricSeverity, type MetricSource, type RubricAggregate } from "./rubric.ts";
import type { DebtItem, DebtItemStatus, UiQualityState } from "./controller.ts";
import { debtSurface } from "./controller.ts";
import type { DesignFamily, SelectionResult } from "./exploration.ts";
import type { AnalysisResult } from "./evidence.ts";
import type { RootCauseCluster, ReviewerReview } from "./review.ts";
import { disagreementIndex } from "./review.ts";
import type { CanonicalTask, TaskMetrics, ViewportMatrixEntry } from "./usability.ts";
import { evaluateCanonicalTask } from "./usability.ts";
import type { EvaluationBattery, GatedAcceptanceDecision } from "./tournament.ts";
import type { Candidate } from "./schemas.ts";
import type { EvidenceBundle, EvaluationRun, ExecutionProvenance } from "./schemas.ts";

/** Current version of the pi-web snapshot payload. */
export const WEB_SNAPSHOT_VERSION = 1;

/** Stable event type strings pushed to pi-web. */
export const UIENG_EVENT_TYPES = [
  "uieng.evaluation.completed",
  "uieng.finding.mapped",
  "uieng.candidate.accepted",
  "uieng.work.dequeued",
  "uieng.approval.requested",
] as const;
export type UiengEventType = (typeof UIENG_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Snapshot sub-shapes (each maps to one dashboard panel pi-web renders)
// ---------------------------------------------------------------------------

/** One point in a per-metric score trend over evaluation runs. */
export interface ScoreTrendPoint {
  runId: string;
  finishedAt?: string;
  mean_score: number;
  /** metric_id -> 0..1 normalized score for this run. */
  scores: Record<string, number>;
}

/** A before/after EvidenceBundle pair for a screenshot/trace drill-down. */
export interface BeforeAfterPair {
  id: string;
  label?: string;
  before: EvidenceBundle;
  after: EvidenceBundle;
  /** Combined evidence/artifact refs (screenshots, video, traces). */
  refs: string[];
}

/** A canonical usability task's outcome. */
export interface TaskSuccessEntry {
  task: CanonicalTask;
  metrics: TaskMetrics;
  /** True when the task's success criterion was met. */
  success: boolean;
  /** Deterministic per-metric analysis results (from usability.ts). */
  results: AnalysisResult[];
}

/** A causal, provenance-backed explanation of a metric score change. */
export interface MetricDelta {
  metric_id: string;
  metric_name: string;
  baseline: number;
  candidate: number;
  /** candidate - baseline (0..100 scale). */
  delta: number;
  source: MetricSource;
  severity: MetricSeverity;
  /** Who/what produced the candidate score (reproducible). */
  provenance: ExecutionProvenance;
}

/** An item in the autonomous work queue, derived from controller debt. */
export interface WorkQueueItem {
  id: string;
  rootCause: string;
  metricIds: string[];
  impact: number;
  effort: number;
  risk: number;
  status: DebtItemStatus;
  createdAt: string;
  affectedSurface?: string;
  evidenceRefs?: string[];
}

/** A protected change awaiting human/model approval before it may land. */
export interface ProtectedApproval {
  decision: GatedAcceptanceDecision;
  requiresApproval: boolean;
  rationale: string;
  candidateId: string;
  selected_model: string;
}

/** Inputs the pure WebSnapshot builder consumes. */
export interface WebSnapshotInput {
  snapshotId: string;
  createdAt: string;
  missionId: string;
  /** The 60-metric dashboard aggregate (all individual scores retained). */
  dashboard: RubricAggregate;
  /** Per-run score series for trend rendering. */
  trends: ScoreTrendPoint[];
  /** Evidence bundles available for drill-down. */
  evidenceDrillDown: EvidenceBundle[];
  /** Before/after evidence pairs (screenshots + traces). */
  beforeAfter: BeforeAfterPair[];
  /** Ranked finding -> root-cause -> surface mapping. */
  clusters: RootCauseCluster[];
  /** Responsive design families for the design gallery. */
  designGallery: DesignFamily[];
  /** Selection results (chosen directions) from exploration. */
  designSelection: SelectionResult[];
  /** Responsive preview viewports. */
  viewports: ViewportMatrixEntry[];
  /** Competing candidates for side-by-side comparison. */
  candidates: Candidate[];
  /** The evaluation battery the candidates were compared against. */
  evaluationBattery: EvaluationBattery;
  /** Canonical task runs. */
  taskSuccess: TaskSuccessEntry[];
  /** Independent reviewer scores/confidence. */
  reviewerReviews: ReviewerReview[];
  /** Baseline metric scores (0..100) for causal delta computation. */
  baselineScores: Record<string, number>;
  /** Candidate metric scores (0..100) for causal delta computation. */
  candidateScores: Record<string, number>;
  /** Provenance of the candidate evaluation (used in causal deltas). */
  provenance: ExecutionProvenance;
  /** Controller state whose quality debt forms the autonomous work queue. */
  qualityState: UiQualityState;
  /** Acceptance decisions; those requiring approval surface as approvals. */
  approvalDecisions: GatedAcceptanceDecision[];
  /** Impact level of the evaluated change (informational). */
  impactLevel?: UiImpactLevel;
}

/** The versioned, normalized payload pi-web renders. */
export interface WebSnapshot {
  schema_version: number;
  kind: "web_snapshot";
  snapshotId: string;
  createdAt: string;
  missionId: string;
  impactLevel?: UiImpactLevel;
  /** 1. 60-metric dashboard (individual rubric scores retained). */
  dashboard: RubricAggregate;
  /** 2. Score trends. */
  trends: ScoreTrendPoint[];
  /** 3. Evidence drill-down. */
  evidenceDrillDown: EvidenceBundle[];
  /** 4. Before/after screenshots + traces. */
  beforeAfter: BeforeAfterPair[];
  /** 5. Finding -> root-cause -> source mapping. */
  rootCauseMap: RootCauseCluster[];
  /** 6. Design gallery + selection. */
  designGallery: DesignFamily[];
  designSelection: SelectionResult[];
  /** 7. Responsive previews. */
  responsivePreviews: ViewportMatrixEntry[];
  /** 8. Candidate comparisons. */
  candidateComparisons: { candidates: Candidate[]; battery: EvaluationBattery };
  /** 9. Task success. */
  taskSuccess: TaskSuccessEntry[];
  /** 10. Reviewer confidence/disagreement. */
  reviewerConsensus: { reviews: ReviewerReview[]; disagreement: number };
  /** 11. Causal score-change explanations. */
  causalExplanations: MetricDelta[];
  /** 12. Autonomous work queue. */
  workQueue: WorkQueueItem[];
  /** 13. Protected-change approvals. */
  protectedApprovals: ProtectedApproval[];
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function collectBundleRefs(bundles: EvidenceBundle[]): string[] {
  const refs = new Set<string>();
  for (const b of bundles) {
    refs.add(b.id);
    for (const s of b.screenshots) refs.add(s);
    if (b.video) refs.add(b.video);
    for (const trace of b.interaction_traces ?? []) {
      const ref = trace.ref;
      if (typeof ref === "string") refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Deterministically compute per-metric deltas between baseline and candidate
 * score maps. Only metrics present in both maps are compared, and the metric's
 * source/severity are resolved from the rubric registry. The result is sorted
 * by metric_id so the payload is fully reproducible.
 */
export function computeMetricDeltas(
  baseline: Record<string, number>,
  candidate: Record<string, number>,
  provenance: ExecutionProvenance,
): MetricDelta[] {
  const deltas: MetricDelta[] = [];
  for (const metricId of Object.keys(candidate)) {
    const base = baseline[metricId];
    const cand = candidate[metricId];
    if (base === undefined || cand === undefined) continue;
    const metric = METRICS_BY_ID.get(metricId);
    if (!metric) continue;
    const delta = cand - base;
    if (Object.is(delta, -0)) continue;
    deltas.push({
      metric_id: metric.id,
      metric_name: metric.name,
      baseline: base,
      candidate: cand,
      delta,
      source: metric.source,
      severity: metric.severity,
      provenance,
    });
  }
  deltas.sort((a, b) => a.metric_id.localeCompare(b.metric_id));
  return deltas;
}

function toWorkQueue(state: UiQualityState): WorkQueueItem[] {
  return state.qualityDebt
    .map((item: DebtItem): WorkQueueItem => ({
      id: item.id,
      rootCause: item.rootCause,
      metricIds: [...item.metricIds],
      impact: item.impact,
      effort: item.effort,
      risk: item.risk,
      status: item.status,
      createdAt: item.createdAt,
      affectedSurface: item.affectedSurface ?? debtSurface(item),
      evidenceRefs: item.evidenceRefs ? [...item.evidenceRefs] : undefined,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function toProtectedApprovals(decisions: readonly GatedAcceptanceDecision[]): ProtectedApproval[] {
  return decisions
    .filter((d) => d.requiresApproval === true)
    .map((d) => ({
      decision: d,
      requiresApproval: d.requiresApproval,
      rationale: d.rationale,
      candidateId: d.candidate.id,
      selected_model: d.candidate.provenance.selected_model,
    }))
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

/**
 * Build the versioned WebSnapshot payload. Pure and deterministic: given the
 * same inputs it always returns an equivalent payload, so pi-web can cache and
 * diff snapshots reliably.
 */
export function buildWebSnapshot(input: WebSnapshotInput): WebSnapshot {
  const disagreement = clamp01(disagreementIndex(input.reviewerReviews));
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    kind: "web_snapshot",
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    missionId: input.missionId,
    impactLevel: input.impactLevel,
    dashboard: input.dashboard,
    trends: [...input.trends],
    evidenceDrillDown: [...input.evidenceDrillDown],
    beforeAfter: [...input.beforeAfter],
    rootCauseMap: [...input.clusters],
    designGallery: [...input.designGallery],
    designSelection: [...input.designSelection],
    responsivePreviews: [...input.viewports],
    candidateComparisons: {
      candidates: [...input.candidates],
      battery: input.evaluationBattery,
    },
    taskSuccess: [...input.taskSuccess],
    reviewerConsensus: {
      reviews: [...input.reviewerReviews],
      disagreement,
    },
    causalExplanations: computeMetricDeltas(input.baselineScores, input.candidateScores, input.provenance),
    workQueue: toWorkQueue(input.qualityState),
    protectedApprovals: toProtectedApprovals(input.approvalDecisions),
  };
}

// ---------------------------------------------------------------------------
// Typed event constructors for push integration into pi-web
// ---------------------------------------------------------------------------

/** Base envelope shared by every pi-web uieng event. */
export interface UiengEventEnvelope<T extends UiengEventType, P> {
  schema_version: number;
  type: T;
  id: string;
  at: string;
  provenance: ExecutionProvenance;
  payload: P;
}

export interface EvaluationCompletedEvent
  extends UiengEventEnvelope<"uieng.evaluation.completed", { run: EvaluationRun; dashboard: RubricAggregate }> {}
export interface FindingMappedEvent
  extends UiengEventEnvelope<"uieng.finding.mapped", { cluster: RootCauseCluster; surface: string }> {}
export interface CandidateAcceptedEvent
  extends UiengEventEnvelope<"uieng.candidate.accepted", { decision: GatedAcceptanceDecision }> {}
export interface WorkDequeuedEvent
  extends UiengEventEnvelope<"uieng.work.dequeued", { item: DebtItem; state: UiQualityState }> {}
export interface ApprovalRequestedEvent
  extends UiengEventEnvelope<"uieng.approval.requested", { decision: GatedAcceptanceDecision; reason: string }> {}

export type UiengEvent =
  | EvaluationCompletedEvent
  | FindingMappedEvent
  | CandidateAcceptedEvent
  | WorkDequeuedEvent
  | ApprovalRequestedEvent;

interface EventInput {
  id: string;
  at: string;
  provenance: ExecutionProvenance;
}

export function uiengEvaluationCompleted(
  input: EventInput & { run: EvaluationRun; dashboard: RubricAggregate },
): EvaluationCompletedEvent {
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    type: "uieng.evaluation.completed",
    id: input.id,
    at: input.at,
    provenance: input.provenance,
    payload: { run: input.run, dashboard: input.dashboard },
  };
}

export function uiengFindingMapped(
  input: EventInput & { cluster: RootCauseCluster; surface: string },
): FindingMappedEvent {
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    type: "uieng.finding.mapped",
    id: input.id,
    at: input.at,
    provenance: input.provenance,
    payload: { cluster: input.cluster, surface: input.surface },
  };
}

export function uiengCandidateAccepted(
  input: EventInput & { decision: GatedAcceptanceDecision },
): CandidateAcceptedEvent {
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    type: "uieng.candidate.accepted",
    id: input.id,
    at: input.at,
    provenance: input.provenance,
    payload: { decision: input.decision },
  };
}

export function uiengWorkDequeued(input: EventInput & { item: DebtItem; state: UiQualityState }): WorkDequeuedEvent {
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    type: "uieng.work.dequeued",
    id: input.id,
    at: input.at,
    provenance: input.provenance,
    payload: { item: input.item, state: input.state },
  };
}

export function uiengApprovalRequested(
  input: EventInput & { decision: GatedAcceptanceDecision; reason: string },
): ApprovalRequestedEvent {
  return {
    schema_version: WEB_SNAPSHOT_VERSION,
    type: "uieng.approval.requested",
    id: input.id,
    at: input.at,
    provenance: input.provenance,
    payload: { decision: input.decision, reason: input.reason },
  };
}

// ---------------------------------------------------------------------------
// pi-web adapter contract (interface only — pi-web is external, not rebuilt)
// ---------------------------------------------------------------------------

/** Fields pi-web may request from a snapshot; absence means "all". */
export interface PiWebSnapshotQuery {
  snapshotId?: string;
  missionId?: string;
  /** Only return snapshots at/after this ISO timestamp. */
  since?: string;
  /** Subset of snapshot sections to return (deltas only, cheaper). */
  include?: ReadonlyArray<keyof WebSnapshot>;
}

/** Query contract for the autonomous work queue panel. */
export interface PiWebQueueQuery {
  missionId: string;
  status?: DebtItemStatus | "all";
  limit?: number;
}

/** Query contract for pending protected-change approvals. */
export interface PiWebApprovalsQuery {
  missionId: string;
  pendingOnly?: boolean;
}

/**
 * The stable adapter contract pi-web consumes. This is the ONLY seam between
 * the autonomous uieng engine and pi-web; implementers of pi-web satisfy this
 * interface against the uieng domain, and the engine never depends on pi-web.
 * Interface only — no implementation is provided here.
 */
export interface PiWebAdapter {
  readonly name: "pi-web";
  /** Fetch a normalized, versioned dashboard snapshot. */
  getSnapshot(query: PiWebSnapshotQuery): Promise<WebSnapshot>;
  /** Fetch the autonomous work queue for a mission. */
  getWorkQueue(query: PiWebQueueQuery): Promise<WorkQueueItem[]>;
  /** Fetch pending protected-change approvals. */
  getPendingApprovals(query: PiWebApprovalsQuery): Promise<ProtectedApproval[]>;
  /** Push a normalized uieng event into pi-web's ingestion stream. */
  pushEvent(event: UiengEvent): Promise<void>;
}
