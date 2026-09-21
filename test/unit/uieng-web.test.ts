import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEB_SNAPSHOT_VERSION,
  buildWebSnapshot,
  computeMetricDeltas,
  uiengApprovalRequested,
  uiengCandidateAccepted,
  uiengEvaluationCompleted,
  uiengFindingMapped,
  uiengWorkDequeued,
  type PiWebAdapter,
  type PiWebSnapshotQuery,
  type UiengEvent,
  type WebSnapshot,
  type WebSnapshotInput,
} from "../../src/uieng/web.ts";
import { METRICS, aggregateScores, scoreAll } from "../../src/uieng/rubric.ts";
import { clusterRootCauses, disagreementIndex, rankClusters, reviewerRoleById } from "../../src/uieng/review.ts";
import { VIEWPORT_MATRIX, evaluateCanonicalTask } from "../../src/uieng/usability.ts";
import { createQualityState } from "../../src/uieng/controller.ts";
import { changeRequiresApproval } from "../../src/uieng/tournament.ts";
import type {
  Candidate,
  EvaluationRun,
  ExecutionProvenance,
  TaskRequest,
} from "../../src/uieng/schemas.ts";
import type { RootCauseCluster } from "../../src/uieng/review.ts";
import type { DesignFamily } from "../../src/uieng/exploration.ts";
import type { GatedAcceptanceDecision } from "../../src/uieng/tournament.ts";

function taskRequest(): TaskRequest {
  return {
    schema_version: 1,
    kind: "task_request",
    id: "WI-WEB1",
    type: "ui",
    required_capabilities: ["vision"],
    optional_capabilities: [],
    artifacts: [],
    context: "pi-web adapter test",
    latency_class: "interactive",
    quality_class: "high",
    reasoning_class: "deep",
    vision: true,
    image_generation: false,
  };
}

function provenance(model = "candidate"): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: `EXEC-${model}`,
    provider: "test",
    selected_model: model,
  };
}

function candidate(id: string): Candidate {
  return {
    schema_version: 1,
    kind: "candidate",
    id,
    task_request: taskRequest(),
    artifacts: [],
    provenance: provenance(`model-${id}`),
    status: "complete",
  };
}

function finding(id: string, rootCause: string, score: number): {
  schema_version: number;
  kind: "finding";
  id: string;
  rubric: string;
  score: number;
  confidence: number;
  severity: "high";
  evidence: string[];
  root_cause: string;
  affected_code: string[];
} {
  return {
    schema_version: 1,
    kind: "finding",
    id,
    rubric: "visual_hierarchy",
    score,
    confidence: 0.9,
    severity: "high",
    evidence: [`ev-${id}`],
    root_cause: rootCause,
    affected_code: ["src/components/Nav.tsx"],
  };
}

function baseInput(overrides: Partial<WebSnapshotInput> = {}): WebSnapshotInput {
  const scores = scoreAll(
    Object.fromEntries(METRICS.map((m) => [m.id, { score: 70, confidence: 0.8, evidence: [`ev-${m.id}`] }])),
  );
  const dashboard = aggregateScores(scores);
  const clusters = rankClusters(
    clusterRootCauses([
      finding("F1", "spacing tokens inconsistent", 0.4),
      finding("F2", "spacing tokens inconsistent", 0.3),
      finding("F3", "focus outline missing", 0.5),
    ]),
  );
  const gallery: DesignFamily[] = [
    {
      id: "family-H1",
      hypothesisId: "H1",
      devices: ["desktop", "tablet", "phone"],
      states: ["empty", "loading", "error", "normal", "dialog"],
      pages: [
        { key: "overview", name: "Overview / Home" },
        { key: "detail", name: "Entity Detail" },
      ],
      referenceImages: ["diffusion://reference/H1/overview.png"],
      note: "visual ideation reference",
    },
  ];
  const qualityState = createQualityState("M1");
  const candidateA = candidate("CAND-A");
  const accepted = { ...candidateA, status: "complete" as const };
  const approval = {
    schema_version: 1,
    kind: "acceptance_decision" as const,
    id: "AD1",
    candidate: accepted,
    accepted: true,
    rationale: "approval required for schema migration",
    findings: [],
    evaluation: {
      schema_version: 1,
      kind: "evaluation_run" as const,
      id: "ER1",
      task_request: taskRequest(),
      provenance: provenance("evaluator"),
      findings: [],
      started_at: "2026-09-15T00:00:00Z",
      verdict: "pass" as const,
    },
    provenance: provenance("evaluator"),
    decided_at: "2026-09-15T00:00:00Z",
    requiresApproval: changeRequiresApproval("schema migration"),
  } satisfies GatedAcceptanceDecision;

  return {
    snapshotId: "SNAP-1",
    createdAt: "2026-09-15T00:00:00Z",
    missionId: "M1",
    dashboard,
    trends: [
      { runId: "R1", finishedAt: "2026-09-14T00:00:00Z", mean_score: 0.7, scores: { visual_hierarchy: 0.7 } },
      { runId: "R2", finishedAt: "2026-09-15T00:00:00Z", mean_score: 0.8, scores: { visual_hierarchy: 0.8 } },
    ],
    evidenceDrillDown: [],
    beforeAfter: [],
    clusters,
    designGallery: gallery,
    designSelection: [],
    viewports: [...VIEWPORT_MATRIX],
    candidates: [candidateA],
    evaluationBattery: {
      metric_ids: ["visual_hierarchy"],
      tasks: [],
      viewports: [],
      viewport_metric_groups: {},
      scenarios: [],
    },
    taskSuccess: [],
    reviewerReviews: [
      {
        roleId: "diagnosis_architect",
        role: reviewerRoleById("diagnosis_architect"),
        score: 0.8,
        confidence: 0.9,
        findingIds: ["F1", "F2", "F3"],
      },
      {
        roleId: "deterministic",
        role: reviewerRoleById("deterministic"),
        score: 0.6,
        confidence: 0.8,
        findingIds: ["F1", "F2", "F3"],
      },
    ],
    baselineScores: { visual_hierarchy: 60, contrast_ratio: 55 },
    candidateScores: { visual_hierarchy: 75, contrast_ratio: 55 },
    provenance: provenance("evaluator"),
    qualityState,
    approvalDecisions: [approval],
    ...overrides,
  };
}

describe("buildWebSnapshot", () => {
  it("assembles all 13 dashboard sections into a versioned payload", () => {
    const snap: WebSnapshot = buildWebSnapshot(baseInput());
    assert.equal(snap.schema_version, WEB_SNAPSHOT_VERSION);
    assert.equal(snap.kind, "web_snapshot");
    assert.equal(snap.snapshotId, "SNAP-1");
    // 1. 60-metric dashboard retains every individual rubric score.
    assert.equal(snap.dashboard.scores.length, 60);
    assert.equal(snap.dashboard.secondary, true);
    assert.equal(snap.trends.length, 2);
    assert.equal(snap.rootCauseMap.length, 2);
    assert.equal(snap.designGallery.length, 1);
    assert.equal(snap.responsivePreviews.length, VIEWPORT_MATRIX.length);
    assert.equal(snap.candidateComparisons.candidates.length, 1);
    // reviewer consensus computes disagreement deterministically.
    assert.equal(
      snap.reviewerConsensus.disagreement,
      disagreementIndex([
        { roleId: "diagnosis_architect", score: 0.8, confidence: 0.9 },
        { roleId: "deterministic", score: 0.6, confidence: 0.8 },
      ]),
    );
    // causal deltas computed from baseline vs candidate score maps.
    const delta = snap.causalExplanations.find((d) => d.metric_id === "visual_hierarchy");
    assert.ok(delta);
    assert.equal(delta?.delta, 15);
    assert.equal(delta?.baseline, 60);
    assert.equal(delta?.candidate, 75);
    assert.equal(delta?.provenance.selected_model, "evaluator");
    // protected approvals only include decisions requiring approval.
    assert.equal(snap.protectedApprovals.length, 1);
    assert.equal(snap.protectedApprovals[0]?.requiresApproval, true);
    assert.equal(snap.protectedApprovals[0]?.candidateId, "CAND-A");
  });

  it("exposes the autonomous work queue derived from controller quality debt", () => {
    const state = createQualityState("M1");
    const snap = buildWebSnapshot(baseInput({ qualityState: state }));
    assert.equal(snap.workQueue.length, state.qualityDebt.length);
    assert.ok(Array.isArray(snap.workQueue));
  });

  it("computes per-metric deltas deterministically and sorted by metric id", () => {
    const deltas = computeMetricDeltas({ contrast: 50, visual_hierarchy: 60 }, { contrast: 90, visual_hierarchy: 75 }, provenance("evaluator"));
    const ids = deltas.map((d) => d.metric_id);
    assert.deepEqual(ids, [...ids].sort());
    const contrast = deltas.find((d) => d.metric_id === "contrast");
    assert.equal(contrast?.delta, 40);
    // metric not present on both sides is skipped.
    const filtered = computeMetricDeltas({ only_base: 1 }, { visual_hierarchy: 10 }, provenance("evaluator"));
    assert.equal(filtered.length, 0);
  });
});

describe("uieng event constructors", () => {
  const at = "2026-09-15T00:00:00Z";
  const prov = provenance("evaluator");

  it("constructs an evaluation.completed event", () => {
    const run: EvaluationRun = {
      schema_version: 1,
      kind: "evaluation_run",
      id: "ER-EV",
      task_request: taskRequest(),
      provenance: prov,
      findings: [],
      started_at: at,
      verdict: "pass",
    };
    const ev = uiengEvaluationCompleted({ id: "E1", at, provenance: prov, run, dashboard: baseInput().dashboard });
    assert.equal(ev.type, "uieng.evaluation.completed");
    assert.equal(ev.payload.run.id, "ER-EV");
    assert.equal(ev.provenance.selected_model, "evaluator");
  });

  it("constructs a finding.mapped event", () => {
    const cluster: RootCauseCluster = {
      rootCause: "spacing tokens inconsistent",
      findings: [finding("F1", "spacing tokens inconsistent", 0.4)],
      affectedSurface: "src/components/Nav.tsx",
      impact: 0.4,
      confidence: 0.9,
      leverage: 1,
      expectedGain: 0.3,
      effort: "low",
      risk: "low",
    };
    const ev = uiengFindingMapped({ id: "E2", at, provenance: prov, cluster, surface: "Nav" });
    assert.equal(ev.type, "uieng.finding.mapped");
    assert.equal(ev.payload.surface, "Nav");
    assert.equal(ev.payload.cluster.rootCause, "spacing tokens inconsistent");
  });

  it("constructs a candidate.accepted event", () => {
    const decision = baseInput().approvalDecisions[0] as GatedAcceptanceDecision;
    const ev = uiengCandidateAccepted({ id: "E3", at, provenance: prov, decision });
    assert.equal(ev.type, "uieng.candidate.accepted");
    assert.equal(ev.payload.decision.candidate.id, "CAND-A");
  });

  it("constructs a work.dequeued event", () => {
    const item = {
      id: "DEBT-1",
      rootCause: "spacing tokens inconsistent",
      metricIds: ["spacing"],
      impact: 0.5,
      effort: 0.3,
      risk: 0.2,
      createdAt: "2026-09-15T00:00:00Z",
      status: "open" as const,
    };
    const state = createQualityState("M1", { debt: [item] });
    const ev = uiengWorkDequeued({ id: "E4", at, provenance: prov, item, state });
    assert.equal(ev.type, "uieng.work.dequeued");
    assert.equal(ev.payload.item.id, item.id);
  });

  it("constructs an approval.requested event", () => {
    const decision = baseInput().approvalDecisions[0] as GatedAcceptanceDecision;
    const ev = uiengApprovalRequested({ id: "E5", at, provenance: prov, decision, reason: "schema migration" });
    assert.equal(ev.type, "uieng.approval.requested");
    assert.equal(ev.payload.reason, "schema migration");
    assert.equal(ev.provenance.selected_model, "evaluator");
  });

  it("all event envelopes carry schema_version, type, id, at, provenance", () => {
    const state = createQualityState("M1");
    const item = state.qualityDebt[0]!;
    const decision = baseInput().approvalDecisions[0] as GatedAcceptanceDecision;
    const events: UiengEvent[] = [
      uiengEvaluationCompleted({ id: "E1", at, provenance: prov, run: baseInput().approvalDecisions[0]!.evaluation, dashboard: baseInput().dashboard }),
      uiengFindingMapped({ id: "E2", at, provenance: prov, cluster: baseInput().clusters[0]!, surface: "Nav" }),
      uiengCandidateAccepted({ id: "E3", at, provenance: prov, decision }),
      uiengWorkDequeued({ id: "E4", at, provenance: prov, item, state }),
      uiengApprovalRequested({ id: "E5", at, provenance: prov, decision, reason: "x" }),
    ];
    for (const e of events) {
      assert.equal(e.schema_version, WEB_SNAPSHOT_VERSION);
      assert.equal(typeof e.id, "string");
      assert.equal(e.at, at);
      assert.equal(e.provenance.selected_model, "evaluator");
    }
  });
});

describe("PiWebAdapter contract", () => {
  it("documents the stable query contract without an implementation", () => {
    const query: PiWebSnapshotQuery = { missionId: "M1", since: "2026-01-01T00:00:00Z", include: ["dashboard", "workQueue"] };
    assert.equal(query.missionId, "M1");
    assert.deepEqual(query.include, ["dashboard", "workQueue"]);
    // The interface is structural; a minimal conforming object type-checks.
    const adapter = {
      name: "pi-web",
      getSnapshot: async (q: PiWebSnapshotQuery): Promise<WebSnapshot> => buildWebSnapshot(baseInput({ snapshotId: q.snapshotId ?? "SNAP-Q" })),
      getWorkQueue: async () => [],
      getPendingApprovals: async () => [],
      pushEvent: async () => undefined,
    } satisfies PiWebAdapter;
    assert.equal(adapter.name, "pi-web");
  });
});
