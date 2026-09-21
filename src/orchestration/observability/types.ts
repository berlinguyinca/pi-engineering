/**
 * Mission Observability — canonical contracts (spec 00–07).
 *
 * These types are the stable public surface for mission observability: the
 * weighted-progress summary, health derivation inputs, structured mission
 * events, the derived projection/read model, and the persisted per-mission
 * state reconstructed on restart/reconnect.
 *
 * They live BESIDE the Mission Controller (spec 06): the controller remains the
 * authority for lifecycle/DAG/completion; observability reads it and records
 * events without coupling UI rendering into orchestration logic.
 */

/** Mission health (spec 03). */
export type MissionHealth = "active" | "waiting" | "slow" | "stalled" | "blocked" | "failed" | "complete";

/** Completion verification status (spec 07). */
export type CompletionStatus =
  | "not_ready"
  | "validating"
  | "review_blocked"
  | "repairing"
  | "final_validation"
  | "verified_complete";

/** A named, explainable waiting reason (spec 03). */
export type WaitingReason =
  | "inferweave_admission"
  | "worker_dependency"
  | "integration_tests"
  | "slurm_scheduler"
  | "external_resource"
  | "human_approval"
  | "credential"
  | "rate_limit"
  | "model_request"
  | "other";

/** Observable activity kinds (spec 02). */
export type ActivityType =
  | "planning"
  | "reading_file"
  | "editing_file"
  | "creating_file"
  | "deleting_file"
  | "running_command"
  | "running_test"
  | "building"
  | "linting"
  | "typechecking"
  | "waiting_for_model"
  | "waiting_for_queue"
  | "waiting_for_worker"
  | "waiting_for_dependency"
  | "model_request"
  | "worker_started"
  | "worker_completed"
  | "tool_invocation"
  | "artifact_created"
  | "git_diff"
  | "git_commit"
  | "integration"
  | "review_started"
  | "review_finding"
  | "review_completed"
  | "repair_started"
  | "repair_completed"
  | "validation"
  | "retry"
  | "error"
  | "recovery";

/** A single observable activity record (no chain-of-thought, spec 02). */
export interface MissionActivityRecord {
  at: string;
  workerId?: string;
  type: ActivityType;
  summary: string;
  file?: string;
  command?: string;
  meaningfulProgress: boolean;
}

/** Current observable activity on the mission summary. */
export interface CurrentActivity {
  type: ActivityType;
  summary: string;
  workerId?: string;
  file?: string;
  command?: string;
}

/** Worker observability state (spec 04 Workers / spec 06 contract). */
export type WorkerObsState = "running" | "waiting" | "completed" | "failed" | "idle";

export interface WorkerObservability {
  workerId: string;
  taskId?: string;
  state: WorkerObsState;
  model?: string;
  runtime?: string;
  host?: string;
  startedAt?: string;
  endedAt?: string;
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  currentActivity?: string;
  tokensPerSec?: number;
  /** Loop/no-progress signals (spec 03). */
  repeatedFileReads: number;
  repeatedToolCalls: number;
  repeatedErrors: number;
  repeatedCycles: number;
  noProgressSince?: string;
}

/** Weighted task progress (spec 01). */
export type MissionTaskProgressState = "pending" | "ready" | "running" | "waiting" | "blocked" | "failed" | "completed";

export interface MissionTaskProgress {
  taskId: string;
  title: string;
  state: MissionTaskProgressState;
  weight: number;
  units?: { completed: number; total: number };
  startedAt?: string;
  completedAt?: string;
  lastMeaningfulProgressAt?: string;
  assignedWorkerId?: string;
  dependsOn: string[];
  waitingReason?: WaitingReason;
}

/** A point on the progress history trend (spec 04). */
export interface ProgressHistoryPoint {
  at: string;
  approximatePercent: number;
  label?: string;
  meaningfulProgress: boolean;
}

/** Live test state (spec 04 Tests). */
export interface TestObservabilityState {
  running: boolean;
  completed: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  suite?: string;
  lastUpdatedAt?: string;
  failures: string[];
  retries: number;
}

/** Live review state (spec 04 Review / spec 06 review). */
export interface ReviewObservabilityState {
  started: boolean;
  completed: boolean;
  reviewerId?: string;
  model?: string;
  status: "not_started" | "running" | "completed";
  findings: Array<{
    findingId: string;
    severity: "blocking" | "major" | "minor";
    summary: string;
    file?: string | null;
    status: "open" | "accepted" | "resolved";
    repaired: boolean;
  }>;
  blockingOpen: number;
  reReviewPending: boolean;
}

/** Grouped recurring errors (spec 04 Errors). */
export interface ErrorGroup {
  key: string;
  count: number;
  lastAt: string;
  firstAt: string;
  example: string;
}

/** A loop signal detected for a worker (spec 03). */
export interface LoopSignal {
  kind:
    | "repeated_file_read"
    | "repeated_tool_call"
    | "repeated_error"
    | "repeated_cycle"
    | "no_dag_transition"
    | "unchanged_git_diff"
    | "unchanged_test_position";
  detail: string;
  count: number;
}

/** Recovery attempt record (spec 03/09). */
export interface RecoveryAttempt {
  attempt: number;
  action: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed";
  summary: string;
}

/** The canonical per-mission observability summary (spec 00 contract). */
export interface MissionObservabilitySummary {
  missionId: string;
  title: string;
  state: string;
  phase: string;
  progress: {
    approximatePercent: number;
    verifiedComplete: boolean;
    basis: "weighted_dag" | "inferred";
  };
  health: MissionHealth;
  currentObjective?: string;
  currentActivity?: CurrentActivity;
  workers: { active: number; waiting: number; failed: number };
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  waitingReason?: WaitingReason;
  waitingSince?: string;
  completionStatus: CompletionStatus;
  runtimeStartedAt?: string;
}

/** The derived projection/read model (spec 05). */
export interface MissionProjection {
  summary: MissionObservabilitySummary;
  tasks: MissionTaskProgress[];
  workers: WorkerObservability[];
  activity: MissionActivityRecord[];
  progressHistory: ProgressHistoryPoint[];
  tests: TestObservabilityState;
  review: ReviewObservabilityState;
  changes: {
    branch?: string;
    worktree?: string;
    changedFiles: string[];
    commits: string[];
    integrationState: string;
  };
  errors: ErrorGroup[];
  recovery: RecoveryAttempt[];
  artifacts: string[];
}

/** Config for health/stall thresholds, per activity type (spec 03). */
export interface MissionObservabilityConfig {
  /** Age of lastMeaningfulProgressAt beyond which health becomes SLOW (ms). */
  slowAfterMs: number;
  /** Age beyond which a running worker with no progress becomes STALLED (ms). */
  stallAfterMs: number;
  /** How often a "quiet-period" user update may be emitted (ms). */
  quietUpdateIntervalMs: number;
  /** Max recent activity records kept per mission. */
  activityRetention: number;
  /** Max progress-history points kept per mission. */
  historyRetention: number;
  /** Heartbeat-only compaction: persist a heartbeat event at most once per N ms. */
  heartbeatSampleMs: number;
  /**
   * Per-activity-type stall thresholds: how many repeated identical signals
   * trigger the loop/stall heuristic for that activity type.
   */
  loopThresholds: Record<string, number>;
}

export const DEFAULT_OBSERVABILITY_CONFIG: MissionObservabilityConfig = {
  slowAfterMs: 120_000, // 2m
  stallAfterMs: 300_000, // 5m
  quietUpdateIntervalMs: 300_000, // 5m
  activityRetention: 200,
  historyRetention: 500,
  heartbeatSampleMs: 15_000,
  loopThresholds: {
    reading_file: 6,
    tool_invocation: 6,
    running_command: 6,
    running_test: 8,
    error: 4,
    default: 8,
  },
};
