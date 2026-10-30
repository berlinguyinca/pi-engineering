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

import { readFile } from "node:fs/promises";

import { type CanonicalLifecycleState, LIFECYCLE_SCHEMA_VERSION, toCanonical } from "./canonicalLifecycle.ts";
import { type MissionModelSummary, summarizeMissionModels } from "./missionModels.ts";
import type { CanonicalLifecycle } from "./missionStore.ts";
import {
  type ModelErrorRollup,
  type TaskUsage,
  type VerifierStageTiming,
  buildModelErrorRollups,
  buildTaskUsage,
} from "./missionWhy.ts";
import type { MissionProjection } from "./observability/types.ts";
import type {
  Execution,
  FailureClassification,
  Mission,
  MissionStop,
  OrchestrationTask,
  ReviewFinding,
} from "./types.ts";

export const MISSION_SNAPSHOT_CONTRACT_VERSION = 3;
export const MISSION_SNAPSHOT_FILENAME = "orchestration-snapshot.json";

/**
 * Additive v2: `observability` was added. Older plugins feature-detect the
 * optional field and continue to render the base mission/task/finding shape.
 */
/**
 * Additive: `storagePressure` was added (disk-pressure recovery FR-04). Older
 * plugins feature-detect the optional field and continue to render the base
 * mission/task/finding shape. It lets a plugin show the last published
 * snapshot as stale instead of presenting it as current while writes are
 * being dropped.
 */
export interface MissionSnapshotFile {
  contractVersion: number;
  generatedAt: string;
  missions: Array<MissionSnapshotMission>;
  storagePressure?: StoragePressureSnapshot;
}

/** Storage-pressure substate of the publishing runtime (see resilience guard). */
export interface StoragePressureSnapshot {
  /** True while the snapshot is dirty (unpublished changes). */
  dirty: boolean;
  /** True when the last published snapshot is stale (post-incident). */
  stale: boolean;
  /** Wall-clock ms the published snapshot was marked stale. */
  staleAtMs?: number;
  /** True once the dirty snapshot has been republished post-recovery. */
  republished: boolean;
  /** True while the mission is suspended on storage pressure. */
  suspended: boolean;
  /** The active incident, when suspended. */
  incident?: { category: string; code: string; path?: string };
}

export interface MissionObservabilitySnapshot {
  /** Additive: the model the mission is pinned to and each agent's model against it. */
  modelUse?: MissionModelSummary;
  progress: {
    approximatePercent: number;
    verifiedComplete: boolean;
    basis: string;
  };
  acceptanceCoverage: MissionProjection["summary"]["acceptanceCoverage"];
  workflowProgress: MissionProjection["summary"]["workflowProgress"];
  health: string;
  currentObjective?: string;
  currentActivity?: { type: string; summary: string; workerId?: string } | null;
  workers: { active: number; waiting: number; failed: number };
  lastHeartbeatAt?: string;
  lastOutputAt?: string;
  currentActivityStartedAt?: string;
  lastMeaningfulProgressAt: string | null;
  waitingReason?: string;
  waitingSince?: string;
  completionStatus: string;
  progressHistory: Array<{
    at: string;
    approximatePercent: number;
    label?: string;
  }>;
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
    findings: Array<{
      id: string;
      severity: string;
      status: string;
      summary: string;
      repaired: boolean;
    }>;
  };
  workerDetails: MissionProjection["workers"];
  activity: MissionProjection["activity"];
  errors: MissionProjection["errors"];
  recovery: MissionProjection["recovery"];
  changes: MissionProjection["changes"];
  artifacts: MissionProjection["artifacts"];
  action: string;
  reason: string;
  recoveryAttempt: { attempt: number; maxAttempts: number };
  nextAction: string;
  nextActionAt: string | null;
  owner: string | null;
  repository: string | null;
  task: string | null;
  preservedWork: string[];
}

/** Additive autonomous-spec-approval projection (design 2026-09-28). */
export interface MissionSpecApprovalSnapshot {
  phase: string;
  revisionNumber: number;
  semanticSpecHash: string | null;
  planHash: string | null;
  semanticRoundsUsed: number;
  semanticRoundsLimit: number;
  activeStage: string | null;
  activeStageDeadlineAt: string | null;
  overallDeadlineAt: string | null;
  approvalId: string | null;
  invalidatedApprovalId: string | null;
  warning: string | null;
  stopReason: string | null;
  resumeCondition: string | null;
}

export interface MissionSnapshotMission {
  id: string;
  /** Replay-stable authoritative mission event ordinal. */
  revision: number;
  title: string;
  goal: string;
  workflowClass: string;
  status: string;
  /**
   * Additive (contractVersion stays 3): the canonical R-LIFE state and the
   * projection version that produced it. Older readers ignore both.
   */
  canonicalState?: CanonicalLifecycleState;
  lifecycleSchemaVersion?: number;
  riskProfile: string;
  constraints: string[];
  requiredGates: string[];
  acceptanceCriteria: Array<{ id?: string; criterion: string; status: string }>;
  tasks: Array<MissionSnapshotTask>;
  findings: Array<MissionSnapshotFinding>;
  /** Latest durable stop for the current resumption generation, when present. */
  stop?: Pick<MissionStop, "reason" | "attemptedRecoveries" | "preservedWork" | "resumeCondition" | "stoppedAt">;
  /** Additive v2 — absent for legacy publishers / pre-observability missions. */
  observability?: MissionObservabilitySnapshot;
  /** Additive model error rollups per model/endpoint. */
  modelErrors?: ModelErrorRollup[];
  /** Additive verifier stage timings; `reused` is read defensively (#185). */
  verifierStages?: VerifierStageTiming[];
  /** Additive autonomous-spec-approval projection; absent when no spec work exists. */
  specApproval?: MissionSpecApprovalSnapshot;
  /**
   * Additive (#427): which process published this entry and when. Several live
   * `pi` sessions share one `.pi-eng` directory; the stamp is what lets a
   * publisher merge instead of clobber — it knows which entries are its own and
   * which belong to another session.
   */
  ownerPid?: number;
  publishedAtMs?: number;
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
  /** Additive typed accounting; absent when the publisher had no executions. */
  usage?: TaskUsage;
  /** Additive v3 — absent for tasks replayed from pre-reliability events. */
  reliability?: {
    repoId?: string;
    acceptanceIds: string[];
    candidateGeneration: number;
    missionGeneration: number;
    fencingToken: number;
  };
}

export interface MissionSnapshotFinding {
  id: string;
  severity: string;
  status: string;
  summary: string;
  taskId: string | null;
  repaired: boolean;
}

/**
 * Build a versioned snapshot from the mission store's raw entities. The shape
 * is deliberately flat/JSON-safe and mirrors what the plugin renders.
 */
function toObservabilitySnapshot(projection: MissionProjection): MissionObservabilitySnapshot {
  return {
    progress: { ...projection.summary.progress },
    acceptanceCoverage: { ...projection.summary.acceptanceCoverage },
    workflowProgress: { ...projection.summary.workflowProgress },
    health: projection.summary.health,
    currentObjective: projection.summary.currentObjective,
    currentActivity: projection.summary.currentActivity,
    workers: { ...projection.summary.workers },
    lastHeartbeatAt: projection.summary.lastHeartbeatAt,
    lastOutputAt: projection.workers
      .map((worker) => worker.lastOutputAt)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1),
    currentActivityStartedAt: projection.workers.find(
      (worker) => worker.workerId === projection.summary.currentActivity?.workerId,
    )?.currentActivityStartedAt,
    lastMeaningfulProgressAt: projection.summary.lastMeaningfulProgressAt,
    waitingReason: projection.summary.waitingReason,
    waitingSince: projection.summary.waitingSince,
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
    action: projection.summary.action,
    reason: projection.summary.reason,
    recoveryAttempt: { ...projection.summary.recovery },
    nextAction: projection.summary.nextAction,
    nextActionAt: projection.summary.nextActionAt,
    owner: projection.summary.owner,
    repository: projection.summary.repository,
    task: projection.summary.task,
    preservedWork: [...projection.summary.preservedWork],
  };
}

export interface MissionSpecInput {
  phase: string;
  revisionNumber: number;
  semanticSpecHash: string | null;
  planHash: string | null;
  semanticRoundsUsed: number;
  semanticRoundsLimit: number;
  activeStage: string | null;
  activeStageDeadlineAt: string | null;
  overallDeadlineAt: string | null;
  approvalId: string | null;
  invalidatedApprovalId: string | null;
  warning: string | null;
  stopReason: string | null;
  resumeCondition: string | null;
}

export function buildMissionSnapshot(
  mission: Mission,
  tasks: OrchestrationTask[],
  findings: ReviewFinding[],
  observability?: MissionProjection | null,
  stop?: MissionStop | null,
  spec?: MissionSpecInput | null,
  accounting?: {
    executions: Execution[];
    classifications: FailureClassification[];
    verifierStages?: VerifierStageTiming[];
  },
  lifecycle?: CanonicalLifecycle,
): MissionSnapshotMission {
  return {
    id: mission.mission_id,
    revision: mission.revision,
    title: mission.title,
    goal: mission.goal,
    workflowClass: mission.workflow_class,
    status: mission.status,
    canonicalState: lifecycle?.canonicalState ?? toCanonical(mission.status),
    lifecycleSchemaVersion: lifecycle?.lifecycleSchemaVersion ?? LIFECYCLE_SCHEMA_VERSION,
    riskProfile: mission.risk_profile,
    constraints: mission.constraints,
    requiredGates: mission.required_gates,
    acceptanceCriteria: mission.acceptance_criteria.map((c) => ({
      ...(c.acceptance_id ? { id: c.acceptance_id } : {}),
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
      ...(accounting
        ? {
            usage: buildTaskUsage(
              t,
              accounting.executions.filter((e) => e.task_id === t.task_id),
            ),
          }
        : {}),
      ...(t.repo_id !== undefined ||
      t.acceptance_ids !== undefined ||
      t.candidate_generation !== undefined ||
      t.mission_generation !== undefined ||
      t.fencing_token !== undefined
        ? {
            reliability: {
              ...(t.repo_id !== undefined ? { repoId: t.repo_id } : {}),
              acceptanceIds: t.acceptance_ids ?? [],
              candidateGeneration: t.candidate_generation ?? 0,
              missionGeneration: t.mission_generation ?? 0,
              fencingToken: t.fencing_token ?? 0,
            },
          }
        : {}),
    })),
    findings: findings.map((f) => ({
      id: f.finding_id,
      severity: f.severity,
      status: f.status,
      summary: f.summary,
      taskId: f.task_id,
      repaired: f.status === "resolved",
    })),
    ...(accounting
      ? {
          modelErrors: buildModelErrorRollups(accounting.executions, accounting.classifications),
          verifierStages: accounting.verifierStages ?? [],
        }
      : {}),
    ...(observability
      ? {
          observability: {
            ...toObservabilitySnapshot(observability),
            modelUse: summarizeMissionModels(mission, tasks, observability.workers),
          },
        }
      : {}),
    ...(spec
      ? {
          specApproval: {
            phase: spec.phase,
            revisionNumber: spec.revisionNumber,
            semanticSpecHash: spec.semanticSpecHash,
            planHash: spec.planHash,
            semanticRoundsUsed: spec.semanticRoundsUsed,
            semanticRoundsLimit: spec.semanticRoundsLimit,
            activeStage: spec.activeStage,
            activeStageDeadlineAt: spec.activeStageDeadlineAt,
            overallDeadlineAt: spec.overallDeadlineAt,
            approvalId: spec.approvalId,
            invalidatedApprovalId: spec.invalidatedApprovalId,
            warning: spec.warning,
            stopReason: spec.stopReason,
            resumeCondition: spec.resumeCondition,
          },
        }
      : {}),
    ...(stop
      ? {
          stop: {
            reason: stop.reason,
            attemptedRecoveries: [...stop.attemptedRecoveries],
            preservedWork: [...stop.preservedWork],
            resumeCondition: stop.resumeCondition,
            stoppedAt: stop.stoppedAt,
          },
        }
      : {}),
  };
}

export function buildMissionSnapshotFile(
  missions: Array<{
    mission: Mission;
    tasks: OrchestrationTask[];
    findings: ReviewFinding[];
    observability?: MissionProjection | null;
    stop?: MissionStop | null;
    spec?: MissionSpecInput | null;
    executions?: Execution[];
    classifications?: FailureClassification[];
    verifierStages?: VerifierStageTiming[];
    /** The store's recorded lifecycle; absent means derive it from the status. */
    lifecycle?: CanonicalLifecycle;
  }>,
  /** Additive storage-pressure substate (disk-pressure recovery FR-04). */
  storagePressure?: StoragePressureSnapshot | null,
): MissionSnapshotFile {
  return {
    contractVersion: MISSION_SNAPSHOT_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    missions: missions.map((m) =>
      buildMissionSnapshot(
        m.mission,
        m.tasks,
        m.findings,
        m.observability,
        m.stop,
        m.spec,
        m.executions
          ? { executions: m.executions, classifications: m.classifications ?? [], verifierStages: m.verifierStages }
          : undefined,
        m.lifecycle,
      ),
    ),
    ...(storagePressure ? { storagePressure } : {}),
  };
}

/**
 * ── Multi-publisher discipline (#427) ──────────────────────────────────────
 *
 * Several live `pi` sessions share one `.pi-eng` directory per project. Each
 * publishes the snapshot, and each one only knows the missions IT holds live.
 * The write was atomic but last-writer-wins, so the published file was a
 * lottery: a mission that had blocked could read back as absent minutes later,
 * and the PI WEB plugin rendered whichever session happened to write last.
 *
 * Merging on publish makes the file a union. A publisher replaces the entries it
 * owns and leaves every other publisher's alone, so no session can erase
 * another's missions, and the durable `revision` ordinal decides who is right
 * about a mission two sessions both hold.
 */

/** Which process wrote an entry, and when. */
export interface SnapshotPublisherTag {
  ownerPid: number;
  publishedAtMs: number;
}

/** Stamp every entry in a freshly built snapshot with its publisher. */
export function tagSnapshotPublisher(snapshot: MissionSnapshotFile, tag: SnapshotPublisherTag): MissionSnapshotFile {
  return {
    ...snapshot,
    missions: snapshot.missions.map((mission) => ({ ...mission, ...tag })),
  };
}

function newer(existing: MissionSnapshotMission, incoming: MissionSnapshotMission): boolean {
  if (typeof existing.revision === "number" && typeof incoming.revision === "number") {
    if (existing.revision !== incoming.revision) return existing.revision > incoming.revision;
  }
  const existingAt = existing.publishedAtMs ?? 0;
  const incomingAt = incoming.publishedAtMs ?? 0;
  return existingAt > incomingAt;
}

/**
 * Merge this publisher's view into the file already on disk.
 *
 * Rules, in order of authority:
 *   1. Entries this publisher owns and no longer reports are dropped — it is the
 *      authority for its own missions, so a finished one must not linger.
 *   2. For a mission both report, the higher durable `revision` wins. The event
 *      ordinal is replay-stable, so it beats wall-clock recency; a tie goes to
 *      the publisher currently holding the mission.
 *   3. Entries owned by another publisher survive untouched.
 *
 * `storagePressure` always comes from the publisher doing the write: it is that
 * runtime's own write health, and presenting another session's suspended state
 * as this one's would be a lie about the file being read.
 */
export function mergeSnapshotFiles(
  existing: MissionSnapshotFile | null,
  incoming: MissionSnapshotFile,
  tag: SnapshotPublisherTag,
): MissionSnapshotFile {
  const byId = new Map<string, MissionSnapshotMission>();
  for (const mission of existing?.missions ?? []) byId.set(mission.id, mission);

  const merged: MissionSnapshotMission[] = [];
  const incomingIds = new Set<string>();
  for (const mission of incoming.missions) {
    incomingIds.add(mission.id);
    const prior = byId.get(mission.id);
    // Our own previous entry never outranks our current view of it.
    merged.push(prior && prior.ownerPid !== tag.ownerPid && newer(prior, mission) ? prior : mission);
  }
  for (const mission of existing?.missions ?? []) {
    if (incomingIds.has(mission.id)) continue;
    if (mission.ownerPid === tag.ownerPid) continue; // ours, and we no longer hold it
    merged.push(mission);
  }

  // The write health is THIS publisher's own — never the existing file's. Presenting
  // another session's suspended state as this one's would be a lie about the file
  // being read, so `existing`'s copy is discarded and the incoming one is carried
  // through untouched.
  return { ...incoming, missions: merged };
}

export {
  acquireSnapshotPublisherLock,
  SNAPSHOT_LOCK_FILENAME,
  type SnapshotLockHandle,
  type SnapshotLockOptions,
} from "./snapshotLock.ts";

/**
 * Read a published snapshot, tolerating absence and a torn file (#427).
 *
 * A merge must not be blocked by a file it cannot use: a missing or corrupt
 * snapshot degrades to "nothing to merge", which publishes this publisher's view
 * rather than publishing nothing at all.
 */
export async function readMissionSnapshotFile(path: string): Promise<MissionSnapshotFile | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as MissionSnapshotFile;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.missions)) return null;
    return parsed;
  } catch {
    return null;
  }
}
