/**
 * Versioned mission-snapshot publisher (spec 08 §API boundary).
 *
 * The PI WEB plugin is a separate, decoupled package that renders mission
 * state. Rather than importing runtime internals, the runtime PUBLISHES a
 * stable, versioned JSON snapshot to `<repoRoot>/.pi-eng/orchestration-snapshot.json`
 * that the plugin's browser entry reads through the workspace files API.
 *
 * The snapshot shape is the stable public contract. Keep it additive across
 * versions; bump `contractVersion` on a breaking change and feature-detect in
 * the plugin.
 */

import type { MissionProjection } from "./observability/types.ts";
import type { Mission, OrchestrationTask, ReviewFinding } from "./types.ts";

export const MISSION_SNAPSHOT_CONTRACT_VERSION = 2;
export const MISSION_SNAPSHOT_FILENAME = "orchestration-snapshot.json";

/**
 * Additive v2: `observability` was added. Older plugins feature-detect the
 * optional field and continue to render the base mission/task/finding shape.
 */
export interface MissionSnapshotFile {
  contractVersion: number;
  generatedAt: string;
  missions: Array<MissionSnapshotMission>;
}

export interface MissionObservabilitySnapshot {
  progress: { approximatePercent: number; verifiedComplete: boolean; basis: string };
  health: string;
  currentObjective?: string;
  currentActivity?: { type: string; summary: string; workerId?: string } | null;
  workers: { active: number; waiting: number; failed: number };
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  waitingReason?: string;
  completionStatus: string;
  progressHistory: Array<{ at: string; approximatePercent: number; label?: string }>;
  tests: {
    running: boolean;
    completed: number;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failures: string[];
  };
  review: {
    status: string;
    blockingOpen: number;
    findings: Array<{ id: string; severity: string; status: string; summary: string; repaired: boolean }>;
  };
  workerDetails: MissionProjection["workers"];
  activity: MissionProjection["activity"];
  errors: MissionProjection["errors"];
  recovery: MissionProjection["recovery"];
  changes: MissionProjection["changes"];
  artifacts: MissionProjection["artifacts"];
}

export interface MissionSnapshotMission {
  id: string;
  title: string;
  goal: string;
  workflowClass: string;
  status: string;
  riskProfile: string;
  constraints: string[];
  requiredGates: string[];
  acceptanceCriteria: Array<{ criterion: string; status: string }>;
  tasks: Array<MissionSnapshotTask>;
  findings: Array<MissionSnapshotFinding>;
  /** Additive v2 — absent for legacy publishers / pre-observability missions. */
  observability?: MissionObservabilitySnapshot;
}

export interface MissionSnapshotTask {
  id: string;
  kind: string;
  role: string;
  status: string;
  objective: string;
  mutatesRepo: boolean;
  isolation: string;
  dependsOn: string[];
}

export interface MissionSnapshotFinding {
  id: string;
  severity: string;
  status: string;
  summary: string;
  taskId: string | null;
}

/**
 * Build a versioned snapshot from the mission store's raw entities. The shape
 * is deliberately flat/JSON-safe and mirrors what the plugin renders.
 */
function toObservabilitySnapshot(projection: MissionProjection): MissionObservabilitySnapshot {
  return {
    progress: { ...projection.summary.progress },
    health: projection.summary.health,
    currentObjective: projection.summary.currentObjective,
    currentActivity: projection.summary.currentActivity,
    workers: { ...projection.summary.workers },
    lastHeartbeatAt: projection.summary.lastHeartbeatAt,
    lastMeaningfulProgressAt: projection.summary.lastMeaningfulProgressAt,
    waitingReason: projection.summary.waitingReason,
    completionStatus: projection.summary.completionStatus,
    progressHistory: projection.progressHistory.map((p) => ({
      at: p.at,
      approximatePercent: p.approximatePercent,
      label: p.label,
    })),
    tests: {
      running: projection.tests.running,
      completed: projection.tests.completed,
      total: projection.tests.total,
      passed: projection.tests.passed,
      failed: projection.tests.failed,
      skipped: projection.tests.skipped,
      failures: projection.tests.failures,
    },
    review: {
      status: projection.review.status,
      blockingOpen: projection.review.blockingOpen,
      findings: projection.review.findings.map((f) => ({
        id: f.findingId,
        severity: f.severity,
        status: f.status,
        summary: f.summary,
        repaired: f.repaired,
      })),
    },
    workerDetails: projection.workers,
    activity: projection.activity,
    errors: projection.errors,
    recovery: projection.recovery,
    changes: projection.changes,
    artifacts: projection.artifacts,
  };
}

export function buildMissionSnapshot(
  mission: Mission,
  tasks: OrchestrationTask[],
  findings: ReviewFinding[],
  observability?: MissionProjection | null,
): MissionSnapshotMission {
  return {
    id: mission.mission_id,
    title: mission.title,
    goal: mission.goal,
    workflowClass: mission.workflow_class,
    status: mission.status,
    riskProfile: mission.risk_profile,
    constraints: mission.constraints,
    requiredGates: mission.required_gates,
    acceptanceCriteria: mission.acceptance_criteria.map((c) => ({
      criterion: c.criterion,
      status: c.status,
    })),
    tasks: tasks.map((t) => ({
      id: t.task_id,
      kind: t.kind,
      role: t.role,
      status: t.status,
      objective: t.objective,
      mutatesRepo: t.mutates_repo,
      isolation: t.isolation,
      dependsOn: t.depends_on,
    })),
    findings: findings.map((f) => ({
      id: f.finding_id,
      severity: f.severity,
      status: f.status,
      summary: f.summary,
      taskId: f.task_id,
    })),
    ...(observability ? { observability: toObservabilitySnapshot(observability) } : {}),
  };
}

export function buildMissionSnapshotFile(
  missions: Array<{
    mission: Mission;
    tasks: OrchestrationTask[];
    findings: ReviewFinding[];
    observability?: MissionProjection | null;
  }>,
): MissionSnapshotFile {
  return {
    contractVersion: MISSION_SNAPSHOT_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    missions: missions.map((m) => buildMissionSnapshot(m.mission, m.tasks, m.findings, m.observability)),
  };
}
