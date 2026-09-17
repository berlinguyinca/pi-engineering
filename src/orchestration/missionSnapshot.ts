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

import type { Mission, OrchestrationTask, ReviewFinding } from "./types.ts";

export const MISSION_SNAPSHOT_CONTRACT_VERSION = 1;
export const MISSION_SNAPSHOT_FILENAME = "orchestration-snapshot.json";

export interface MissionSnapshotFile {
  contractVersion: number;
  generatedAt: string;
  missions: Array<MissionSnapshotMission>;
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
export function buildMissionSnapshot(
  mission: Mission,
  tasks: OrchestrationTask[],
  findings: ReviewFinding[],
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
  };
}

export function buildMissionSnapshotFile(
  missions: Array<{ mission: Mission; tasks: OrchestrationTask[]; findings: ReviewFinding[] }>,
): MissionSnapshotFile {
  return {
    contractVersion: MISSION_SNAPSHOT_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    missions: missions.map((m) => buildMissionSnapshot(m.mission, m.tasks, m.findings)),
  };
}
