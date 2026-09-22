/**
 * Mission Observability service (spec 00–07).
 *
 * A projector/read-model service that lives BESIDE the Mission Controller
 * (spec 06): it records structured mission events, tracks heartbeat vs
 * meaningful progress, derives health, detects stalls/loops, exposes weighted
 * DAG progress, and builds the projection consumed by Pi-Web (via the snapshot
 * publisher) and, later, Herdr.
 *
 * Persistence reuses the SAME EventStoreBackend as the MissionStore: observability
 * events are appended to the shared store and replayed on open, so reconnect/
 * restart reconstructs progress, activity, workers, tests, review, and errors
 * without resetting progress to zero (spec 01/05/17).
 *
 * The Communication Gate is always open: `onUpdate` emits user-facing progress
 * updates; it never suppresses ordinary Pi output. A mission being active is
 * never grounds to close communication.
 */

import { id } from "../../core/ids.ts";
import type { EventStoreBackend } from "../../platform/eventstore/backend.ts";
import type { MissionStore } from "../missionStore.ts";
import {
  fromStoredEvent,
  newObservabilityEvent,
  storedTypeForEventType,
  toStoredEvent,
  waitingReasonLabel,
} from "./events.ts";
import type { MissionObservabilityEvent, MissionObservabilityEventType } from "./events.ts";
import { deriveHealth } from "./health.ts";
import { computeProgress } from "./progress.ts";
import { WorkerLoopTracker } from "./stall.ts";
import type {
  ActivityType,
  CurrentActivity,
  ErrorGroup,
  LoopSignal,
  MissionActivityRecord,
  MissionHealth,
  MissionObservabilityConfig,
  MissionObservabilitySummary,
  MissionProjection,
  ProgressHistoryPoint,
  RecoveryAttempt,
  ReviewObservabilityState,
  TestObservabilityState,
  WaitingReason,
  WorkerObservability,
} from "./types.ts";
import { DEFAULT_OBSERVABILITY_CONFIG } from "./types.ts";

type CompletionStatusValue =
  | "not_ready"
  | "validating"
  | "review_blocked"
  | "repairing"
  | "final_validation"
  | "verified_complete";

interface MissionObsState {
  missionId: string;
  title: string;
  runtimeStartedAt: string;
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  currentObjective?: string;
  currentActivity?: CurrentActivity;
  waitingReason?: WaitingReason;
  waitingSince?: string;
  completionStatus: CompletionStatusValue;
  verifiedComplete: boolean;
  progressHistory: ProgressHistoryPoint[];
  activity: MissionActivityRecord[];
  workers: Map<string, WorkerObservability>;
  loopTrackers: Map<string, WorkerLoopTracker>;
  tests: TestObservabilityState;
  review: ReviewObservabilityState;
  errors: ErrorGroup[];
  recovery: RecoveryAttempt[];
  taskUnits: Record<string, { completed: number; total: number }>;
  taskWeights: Record<string, number>;
  artifacts: string[];
  changes: { branch?: string; worktree?: string; changedFiles: string[]; commits: string[]; integrationState: string };
  lastUpdateEmittedAt?: string;
  lastHeartbeatPersistedAt?: number;
  quietSince?: string;
}

function emptyTestState(): TestObservabilityState {
  return {
    running: false,
    completed: 0,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    retries: 0,
  };
}

function emptyReviewState(): ReviewObservabilityState {
  return {
    started: false,
    completed: false,
    status: "not_started",
    findings: [],
    blockingOpen: 0,
    reReviewPending: false,
  };
}

export interface MissionObservabilityOptions {
  backend: EventStoreBackend;
  store: MissionStore;
  config?: Partial<MissionObservabilityConfig>;
  /** User-facing update emitter (Communication Gate — always open). */
  onUpdate?: (missionId: string, message: string) => void;
  /** Deterministic clock for tests. */
  now?: () => string;
}

export class MissionObservability {
  readonly config: MissionObservabilityConfig;
  private readonly store: MissionStore;
  private readonly backend: EventStoreBackend;
  private readonly onUpdate?: (missionId: string, message: string) => void;
  private readonly nowFn: () => string;
  private readonly states = new Map<string, MissionObsState>();
  private emitChain: Promise<void> = Promise.resolve();

  constructor(opts: MissionObservabilityOptions) {
    this.backend = opts.backend;
    this.store = opts.store;
    this.config = { ...DEFAULT_OBSERVABILITY_CONFIG, ...opts.config };
    this.onUpdate = opts.onUpdate;
    this.nowFn = opts.now ?? (() => new Date().toISOString());
  }

  /** Open and replay persisted observability events (reconnect/restart). */
  static open(opts: MissionObservabilityOptions): MissionObservability {
    const obs = new MissionObservability(opts);
    for (const e of opts.backend.all()) {
      const ev = fromStoredEvent(e);
      if (ev) obs.apply(ev);
    }
    return obs;
  }

  private now(): string {
    return this.nowFn();
  }

  private state(missionId: string, title?: string): MissionObsState {
    let s = this.states.get(missionId);
    if (!s) {
      s = {
        missionId,
        title: title ?? missionId,
        runtimeStartedAt: this.now(),
        workers: new Map(),
        loopTrackers: new Map(),
        tests: emptyTestState(),
        review: emptyReviewState(),
        errors: [],
        recovery: [],
        taskUnits: {},
        taskWeights: {},
        artifacts: [],
        changes: { changedFiles: [], commits: [], integrationState: "unknown" },
        progressHistory: [],
        activity: [],
        completionStatus: "not_ready",
        verifiedComplete: false,
      };
      this.states.set(missionId, s);
    }
    return s;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  /** Persist an observability event (append + apply). Returns the event id. */
  private persist(ev: MissionObservabilityEvent): void {
    const stored = toStoredEvent(ev, storedTypeForEventType(ev.type));
    this.emitChain = this.emitChain.then(() => this.backend.append(stored)).then(() => undefined);
    this.apply(ev);
  }

  /** Await all pending event writes (tests assert durability). */
  async flush(): Promise<void> {
    await this.emitChain;
  }

  private record(input: {
    missionId: string;
    type: MissionObservabilityEventType;
    summary: string;
    sourceType?: "orchestrator" | "worker" | "process" | "repo" | "test" | "review" | "inferweave";
    sourceId?: string;
    taskId?: string;
    workerId?: string;
    metadata?: Record<string, unknown>;
    meaningfulProgress?: boolean;
  }): void {
    const ev = newObservabilityEvent({
      missionId: input.missionId,
      type: input.type,
      summary: input.summary,
      source: { type: input.sourceType ?? "orchestrator", id: input.sourceId },
      taskId: input.taskId,
      workerId: input.workerId,
      metadata: input.metadata,
      meaningfulProgress: input.meaningfulProgress,
    });
    // Stamp with the observability clock so replay and deterministic tests see
    // the same ordering the live service observed.
    ev.timestamp = this.now();
    this.persist(ev);
  }

  private apply(ev: MissionObservabilityEvent): void {
    const s = this.state(ev.missionId);
    const meta = ev.metadata ?? {};
    switch (ev.type) {
      case "MISSION_CREATED":
        s.title = (meta.title as string) ?? ev.summary;
        s.progressHistory = [{ at: ev.timestamp, approximatePercent: 0, meaningfulProgress: false, label: "created" }];
        break;
      case "MISSION_PHASE_CHANGED": {
        const label = (meta.phase as string) ?? undefined;
        if (ev.meaningfulProgress) this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, label);
        break;
      }
      case "MISSION_HEALTH_CHANGED":
        break;
      case "TASK_ASSIGNED": {
        const wid = meta.workerId as string | undefined;
        const w = wid ? s.workers.get(wid) : undefined;
        if (w) w.taskId = ev.taskId;
        break;
      }
      case "TASK_STARTED":
      case "TASK_COMPLETED":
      case "TASK_FAILED":
      case "TASK_BLOCKED":
      case "TASK_WAITING":
        if (ev.meaningfulProgress) this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? undefined);
        break;
      case "TASK_PROGRESS": {
        const completed = (meta.completed as number) ?? 0;
        const total = (meta.total as number) ?? 0;
        if (ev.taskId) s.taskUnits[ev.taskId] = { completed, total };
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? undefined);
        break;
      }
      case "WORKER_STARTED": {
        if (!ev.workerId) break;
        const w: WorkerObservability = {
          workerId: ev.workerId,
          taskId: ev.taskId,
          state: "running",
          model: meta.model as string | undefined,
          runtime: meta.runtime as string | undefined,
          host: meta.host as string | undefined,
          startedAt: ev.timestamp,
          lastHeartbeatAt: ev.timestamp,
          lastMeaningfulProgressAt: ev.meaningfulProgress ? ev.timestamp : undefined,
          repeatedFileReads: 0,
          repeatedToolCalls: 0,
          repeatedErrors: 0,
          repeatedCycles: 0,
        };
        s.workers.set(ev.workerId, w);
        if (!s.loopTrackers.has(ev.workerId)) s.loopTrackers.set(ev.workerId, new WorkerLoopTracker(this.config));
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? undefined);
        break;
      }
      case "WORKER_HEARTBEAT": {
        if (ev.workerId) {
          const w = s.workers.get(ev.workerId);
          if (w) {
            w.lastHeartbeatAt = ev.timestamp;
            w.state = "running";
            if (meta.tokensPerSec !== undefined) w.tokensPerSec = meta.tokensPerSec as number;
            s.workers.set(ev.workerId, w);
          }
        }
        s.lastHeartbeatAt = ev.timestamp;
        break;
      }
      case "WORKER_ACTIVITY": {
        const workerId = ev.workerId ?? (meta.workerId as string | undefined);
        const type = (meta.activityType as ActivityType) ?? "tool_invocation";
        const rec: MissionActivityRecord = {
          at: ev.timestamp,
          workerId,
          type,
          summary: ev.summary,
          file: meta.file as string | undefined,
          command: meta.command as string | undefined,
          meaningfulProgress: ev.meaningfulProgress,
        };
        this.pushActivity(s, rec);
        s.currentActivity = { type, summary: ev.summary, workerId, file: rec.file, command: rec.command };
        if (workerId) {
          const w = s.workers.get(workerId);
          if (w) {
            w.lastHeartbeatAt = ev.timestamp;
            w.currentActivity = ev.summary;
            if (ev.meaningfulProgress) {
              w.lastMeaningfulProgressAt = ev.timestamp;
              w.repeatedFileReads = 0;
              w.repeatedToolCalls = 0;
              w.repeatedCycles = 0;
            }
            s.workers.set(workerId, w);
          }
        }
        if (ev.meaningfulProgress) this.noteMeaningful(s, ev.timestamp);
        break;
      }
      case "WORKER_WAITING": {
        if (ev.workerId) {
          const w = s.workers.get(ev.workerId);
          if (w) {
            w.state = "waiting";
            s.workers.set(ev.workerId, w);
          }
        }
        break;
      }
      case "WORKER_FAILED": {
        if (ev.workerId) {
          const w = s.workers.get(ev.workerId);
          if (w) {
            w.state = "failed";
            w.endedAt = ev.timestamp;
            s.workers.set(ev.workerId, w);
          }
        }
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? "worker failed");
        break;
      }
      case "WORKER_COMPLETED": {
        if (ev.workerId) {
          const w = s.workers.get(ev.workerId);
          if (w) {
            w.state = "completed";
            w.endedAt = ev.timestamp;
            w.lastMeaningfulProgressAt = ev.timestamp;
            s.workers.set(ev.workerId, w);
          }
        }
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? "worker completed");
        break;
      }
      case "TEST_STARTED":
        s.tests.running = true;
        s.tests.suite = meta.suite as string | undefined;
        s.tests.total = (meta.total as number) ?? 0;
        break;
      case "TEST_PROGRESS": {
        s.tests.running = true;
        s.tests.completed = (meta.completed as number) ?? s.tests.completed;
        s.tests.total = (meta.total as number) ?? s.tests.total;
        s.tests.passed = (meta.passed as number) ?? s.tests.passed;
        s.tests.failed = (meta.failed as number) ?? s.tests.failed;
        s.tests.skipped = (meta.skipped as number) ?? s.tests.skipped;
        s.tests.lastUpdatedAt = ev.timestamp;
        if (ev.meaningfulProgress) this.noteMeaningful(s, ev.timestamp);
        break;
      }
      case "TEST_COMPLETED": {
        s.tests.running = false;
        s.tests.completed = (meta.completed as number) ?? s.tests.completed;
        s.tests.total = (meta.total as number) ?? s.tests.total;
        s.tests.passed = (meta.passed as number) ?? s.tests.passed;
        s.tests.failed = (meta.failed as number) ?? s.tests.failed;
        s.tests.lastUpdatedAt = ev.timestamp;
        if (meta.failed && (meta.failed as number) > 0 && (meta.failureSummary as string | undefined)) {
          s.tests.failures = [meta.failureSummary as string, ...s.tests.failures].slice(0, 20);
        }
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? "tests completed");
        break;
      }
      case "BUILD_STARTED":
      case "BUILD_PROGRESS":
      case "BUILD_COMPLETED":
      case "BUILD_FAILED":
        if (ev.meaningfulProgress) this.noteMeaningful(s, ev.timestamp);
        break;
      case "MODEL_REQUEST_WAITING":
        s.waitingReason = (meta.reason as WaitingReason) ?? "model_request";
        s.waitingSince = s.waitingSince ?? ev.timestamp;
        break;
      case "MODEL_REQUEST_COMPLETED":
      case "MODEL_REQUEST_FAILED":
        if (meta.clearWaiting === true) {
          // Explicit resume (clearWaiting) always clears any waiting reason.
          s.waitingReason = undefined;
          s.waitingSince = undefined;
        } else if (s.waitingReason === "model_request" || s.waitingReason === "inferweave_admission") {
          s.waitingReason = undefined;
          s.waitingSince = undefined;
        }
        break;
      case "REVIEW_STARTED":
        s.review.started = true;
        s.review.status = "running";
        s.review.reviewerId = ev.workerId ?? (meta.reviewerId as string | undefined);
        s.review.model = meta.model as string | undefined;
        this.appendHistory(s, ev.timestamp, "review started");
        break;
      case "REVIEW_FINDING": {
        const severity = (meta.severity as "blocking" | "major" | "minor") ?? "major";
        s.review.findings.push({
          findingId: ev.taskId ?? id("F"),
          severity,
          summary: ev.summary,
          file: meta.file as string | null | undefined,
          status: "open",
          repaired: false,
        });
        if (severity === "blocking") {
          s.review.blockingOpen += 1;
          s.completionStatus = "review_blocked";
        }
        break;
      }
      case "REVIEW_COMPLETED":
        s.review.status = "completed";
        s.review.completed = true;
        this.appendHistory(s, ev.timestamp, (meta.label as string) ?? "review completed");
        break;
      case "REPAIR_STARTED":
        s.completionStatus = "repairing";
        this.appendHistory(s, ev.timestamp, "repair started");
        break;
      case "REPAIR_COMPLETED": {
        const findingId = (meta.findingId as string | undefined) ?? ev.taskId;
        const f = s.review.findings.find((x) => x.findingId === findingId);
        if (f) {
          f.repaired = true;
          f.status = "resolved";
          if (f.severity === "blocking") s.review.blockingOpen = Math.max(0, s.review.blockingOpen - 1);
        }
        s.review.reReviewPending = true;
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, "repair completed");
        break;
      }
      case "RECOVERY_STARTED": {
        const attempt = (meta.attempt as number) ?? s.recovery.length + 1;
        s.recovery.push({
          attempt,
          action: (meta.action as string) ?? "recover",
          startedAt: ev.timestamp,
          status: "running",
          summary: ev.summary,
        });
        this.appendHistory(s, ev.timestamp, "recovery started");
        break;
      }
      case "RECOVERY_COMPLETED": {
        const a = s.recovery.at(-1);
        if (a) {
          a.status = "succeeded";
          a.completedAt = ev.timestamp;
        }
        break;
      }
      case "RECOVERY_FAILED": {
        const a = s.recovery.at(-1);
        if (a) {
          a.status = "failed";
          a.completedAt = ev.timestamp;
        }
        break;
      }
      case "ARTIFACT_CREATED":
        if (!s.artifacts.includes(ev.summary)) s.artifacts = [...s.artifacts, ev.summary].slice(-50);
        this.noteMeaningful(s, ev.timestamp);
        break;
      case "GIT_DIFF_UPDATED": {
        const files = (meta.files as string[] | undefined) ?? [];
        s.changes.changedFiles = Array.from(new Set([...s.changes.changedFiles, ...files])).slice(-200);
        this.noteMeaningful(s, ev.timestamp);
        break;
      }
      case "COMMIT_CREATED":
        if (meta.commit && !s.changes.commits.includes(meta.commit as string)) {
          s.changes.commits = [...s.changes.commits, meta.commit as string].slice(-100);
        }
        this.noteMeaningful(s, ev.timestamp);
        break;
      case "INTEGRATION_COMPLETED":
        s.changes.integrationState = "integrated";
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, "integration completed");
        break;
      case "COMPLETION_GATE_STARTED":
        s.completionStatus = "final_validation";
        break;
      case "COMPLETION_GATE_FAILED":
        s.completionStatus = s.completionStatus === "review_blocked" ? "review_blocked" : "not_ready";
        break;
      case "COMPLETION_GATE_PASSED":
        s.verifiedComplete = true;
        s.completionStatus = "verified_complete";
        this.noteMeaningful(s, ev.timestamp);
        this.appendHistory(s, ev.timestamp, "verified complete");
        break;
      case "FILE_READ":
      case "FILE_CHANGED":
      case "COMMAND_STARTED":
      case "COMMAND_PROGRESS":
      case "COMMAND_COMPLETED":
      case "COMMAND_FAILED":
        break;
    }
  }

  private noteMeaningful(s: MissionObsState, at: string): void {
    s.lastMeaningfulProgressAt = at;
    s.lastHeartbeatAt = at;
    s.quietSince = undefined;
  }

  private pushActivity(s: MissionObsState, rec: MissionActivityRecord): void {
    s.activity = [...s.activity, rec].slice(-this.config.activityRetention);
  }

  private appendHistory(s: MissionObsState, at: string, label?: string): void {
    const mission = this.store.getMission(s.missionId);
    const pct = this.computePercent(s, mission?.status);
    s.progressHistory = [...s.progressHistory, { at, approximatePercent: pct, label, meaningfulProgress: true }].slice(
      -this.config.historyRetention,
    );
  }

  private computePercent(s: MissionObsState, missionStatus?: string): number {
    const res = computeProgress({
      missionId: s.missionId,
      tasks: this.store.listTasks(s.missionId),
      missionStatus: (missionStatus ?? "NEW") as never,
      verifiedComplete: s.verifiedComplete,
      completionStatus: s.completionStatus,
      units: s.taskUnits,
      weights: s.taskWeights,
      creditRunningWithoutUnits: true,
    });
    return res.approximatePercent;
  }

  // ── public recording API ────────────────────────────────────────────────

  missionCreated(missionId: string, title: string): void {
    this.record({
      missionId,
      type: "MISSION_CREATED",
      summary: "Mission created",
      metadata: { title },
    });
  }

  phaseChanged(missionId: string, phase: string): void {
    const s = this.state(missionId);
    this.record({
      missionId,
      type: "MISSION_PHASE_CHANGED",
      summary: `Phase ${phase}`,
      metadata: { phase, label: phase.toLowerCase() },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, `Phase: ${phase}`);
  }

  taskStarted(missionId: string, taskId: string, label: string): void {
    this.record({
      missionId,
      type: "TASK_STARTED",
      summary: `Task started: ${label}`,
      taskId,
      metadata: { label },
      meaningfulProgress: true,
    });
  }

  taskCompleted(missionId: string, taskId: string, label: string): void {
    this.record({
      missionId,
      type: "TASK_COMPLETED",
      summary: `Task completed: ${label}`,
      taskId,
      metadata: { label },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, `Task finished: ${label}`);
  }

  taskProgress(missionId: string, taskId: string, completed: number, total: number): void {
    this.record({
      missionId,
      type: "TASK_PROGRESS",
      summary: `Task progress ${completed}/${total}`,
      taskId,
      metadata: { completed, total, activityType: "running_test" },
      meaningfulProgress: true,
    });
  }

  setWaiting(missionId: string, reason: WaitingReason, detail?: string): void {
    const s = this.state(missionId);
    if (!s.waitingSince) s.waitingSince = this.now();
    s.waitingReason = reason;
    this.record({
      missionId,
      type: "MODEL_REQUEST_WAITING",
      summary: detail ?? `Waiting — ${waitingReasonLabel(reason)}`,
      metadata: { reason, detail },
    });
  }

  clearWaiting(missionId: string): void {
    const s = this.state(missionId);
    s.waitingReason = undefined;
    s.waitingSince = undefined;
    this.record({
      missionId,
      type: "MODEL_REQUEST_COMPLETED",
      summary: "Resumed",
      metadata: { clearWaiting: true },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "Resumed progress.");
  }

  setCurrentObjective(missionId: string, objective: string): void {
    this.state(missionId).currentObjective = objective;
  }

  activity(
    missionId: string,
    input: {
      type: ActivityType;
      summary: string;
      workerId?: string;
      file?: string;
      command?: string;
      meaningfulProgress?: boolean;
    },
  ): void {
    this.record({
      missionId,
      type: "WORKER_ACTIVITY",
      summary: input.summary,
      workerId: input.workerId,
      metadata: {
        activityType: input.type,
        file: input.file,
        command: input.command,
      },
      meaningfulProgress: input.meaningfulProgress ?? false,
    });
  }

  heartbeat(missionId: string, workerId?: string, metadata: Record<string, unknown> = {}): void {
    const s = this.state(missionId);
    const now = this.now();
    const nowMs = Date.parse(now);
    if (s.lastHeartbeatPersistedAt && nowMs - s.lastHeartbeatPersistedAt < this.config.heartbeatSampleMs) {
      // Sampled out: update in-memory only (spec 05 cardinality).
      s.lastHeartbeatAt = now;
      if (workerId) {
        const w = s.workers.get(workerId);
        if (w) {
          w.lastHeartbeatAt = now;
          s.workers.set(workerId, w);
        }
      }
      return;
    }
    s.lastHeartbeatPersistedAt = nowMs;
    this.record({
      missionId,
      type: "WORKER_HEARTBEAT",
      summary: "Heartbeat",
      workerId,
      metadata: { ...metadata, activityType: "tool_invocation" },
    });
  }

  meaningfulProgress(missionId: string, summary: string, workerId?: string): void {
    this.record({
      missionId,
      type: "WORKER_ACTIVITY",
      summary,
      workerId,
      metadata: { activityType: "git_diff", meaningful: true },
      meaningfulProgress: true,
    });
  }

  workerStarted(
    missionId: string,
    workerId: string,
    opts: { taskId?: string; model?: string; runtime?: string; host?: string } = {},
  ): void {
    this.record({
      missionId,
      type: "WORKER_STARTED",
      summary: `Worker started: ${workerId}`,
      workerId,
      taskId: opts.taskId,
      metadata: { model: opts.model, runtime: opts.runtime, host: opts.host, label: "worker started" },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, `Worker started: ${workerId}`);
  }

  workerCompleted(missionId: string, workerId: string): void {
    this.record({
      missionId,
      type: "WORKER_COMPLETED",
      summary: `Worker completed: ${workerId}`,
      workerId,
      metadata: { label: "worker completed" },
      meaningfulProgress: true,
    });
  }

  workerFailed(missionId: string, workerId: string): void {
    this.record({
      missionId,
      type: "WORKER_FAILED",
      summary: `Worker failed: ${workerId}`,
      workerId,
      metadata: { label: "worker failed" },
    });
    this.emitUpdate(missionId, `Worker failed: ${workerId}`);
  }

  testProgress(
    missionId: string,
    completed: number,
    total: number,
    passed?: number,
    failed?: number,
    skipped?: number,
  ): void {
    const s = this.state(missionId);
    s.tests.running = true;
    s.tests.completed = completed;
    s.tests.total = total;
    if (passed !== undefined) s.tests.passed = passed;
    if (failed !== undefined) s.tests.failed = failed;
    if (skipped !== undefined) s.tests.skipped = skipped;
    this.record({
      missionId,
      type: "TEST_PROGRESS",
      summary: `Tests ${completed}/${total}`,
      metadata: { completed, total, passed, failed, skipped, activityType: "running_test" },
      meaningfulProgress: true,
    });
  }

  testCompleted(missionId: string, passed: number, failed: number, skipped: number, failureSummary?: string): void {
    const s = this.state(missionId);
    s.tests.running = false;
    s.tests.passed = passed;
    s.tests.failed = failed;
    s.tests.skipped = skipped;
    s.tests.completed = passed + failed + skipped;
    this.record({
      missionId,
      type: "TEST_COMPLETED",
      summary: `Tests completed: ${passed} passed, ${failed} failed`,
      metadata: {
        completed: passed + failed + skipped,
        total: passed + failed + skipped,
        passed,
        failed,
        skipped,
        failureSummary,
        label: "tests completed",
        activityType: "running_test",
      },
      meaningfulProgress: true,
    });
    if (failed > 0) this.emitUpdate(missionId, `Tests: ${passed} passed, ${failed} failing.`);
  }

  reviewStarted(missionId: string, reviewerId?: string, model?: string): void {
    this.record({
      missionId,
      type: "REVIEW_STARTED",
      summary: "Independent review started",
      workerId: reviewerId,
      metadata: { reviewerId, model },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "Independent review started.");
  }

  reviewFinding(
    missionId: string,
    severity: "blocking" | "major" | "minor",
    summary: string,
    file?: string | null,
  ): void {
    this.record({
      missionId,
      type: "REVIEW_FINDING",
      summary,
      metadata: { severity, file, activityType: "review_finding" },
      meaningfulProgress: true,
    });
    if (severity === "blocking") this.emitUpdate(missionId, `Blocking review finding: ${summary}`);
  }

  reviewCompleted(missionId: string): void {
    this.record({
      missionId,
      type: "REVIEW_COMPLETED",
      summary: "Independent review completed",
      metadata: { label: "review completed" },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "Independent review completed.");
  }

  repairStarted(missionId: string, taskId: string): void {
    this.record({
      missionId,
      type: "REPAIR_STARTED",
      summary: "Repair started",
      taskId,
      metadata: { activityType: "repair_started" },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "Repair started.");
  }

  repairCompleted(missionId: string, taskId: string, findingId: string): void {
    this.record({
      missionId,
      type: "REPAIR_COMPLETED",
      summary: "Repair completed",
      taskId,
      metadata: { findingId, activityType: "repair_completed" },
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "Repair completed.");
  }

  recoveryStarted(missionId: string, workerId: string, action: string, attempt: number, detail: string): void {
    this.record({
      missionId,
      type: "RECOVERY_STARTED",
      summary: `Recovery attempt ${attempt}: ${action}`,
      workerId,
      metadata: { attempt, action, activityType: "recovery" },
      meaningfulProgress: false,
    });
    this.emitUpdate(missionId, `Recovery attempt ${attempt}/${action}: ${detail}`);
  }

  recoveryCompleted(missionId: string): void {
    this.record({
      missionId,
      type: "RECOVERY_COMPLETED",
      summary: "Recovery completed",
      metadata: { activityType: "recovery" },
    });
    this.emitUpdate(missionId, "Recovery completed; work resumed.");
  }

  recoveryFailed(missionId: string): void {
    this.record({
      missionId,
      type: "RECOVERY_FAILED",
      summary: "Recovery failed",
      metadata: { activityType: "recovery" },
    });
  }

  recordError(missionId: string, key: string, summary: string): void {
    const s = this.state(missionId);
    const now = this.now();
    const existing = s.errors.find((e) => e.key === key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
    } else {
      s.errors = [...s.errors, { key, count: 1, lastAt: now, firstAt: now, example: summary }].slice(-50);
    }
    this.record({
      missionId,
      type: "COMMAND_FAILED",
      summary: `Error: ${summary}`,
      metadata: { errorKey: key, activityType: "error" },
    });
  }

  gateStarted(missionId: string): void {
    this.record({
      missionId,
      type: "COMPLETION_GATE_STARTED",
      summary: "CompletionGate evaluation started",
      meaningfulProgress: true,
    });
  }

  gateFailed(missionId: string, reasons: string[]): void {
    this.record({
      missionId,
      type: "COMPLETION_GATE_FAILED",
      summary: `CompletionGate not passed: ${reasons.slice(0, 3).join("; ")}`,
      metadata: { reasons },
    });
    this.emitUpdate(missionId, `Completion not yet verified (${reasons.length} condition(s) pending).`);
  }

  gatePassed(missionId: string): void {
    this.record({
      missionId,
      type: "COMPLETION_GATE_PASSED",
      summary: "100% · VERIFIED COMPLETE ✓",
      meaningfulProgress: true,
    });
    this.emitUpdate(missionId, "100% · VERIFIED COMPLETE ✓");
  }

  markVerifiedComplete(missionId: string): void {
    this.gatePassed(missionId);
  }

  setTaskUnits(missionId: string, taskId: string, completed: number, total: number): void {
    this.state(missionId).taskUnits[taskId] = { completed, total };
  }

  setTaskWeight(missionId: string, taskId: string, weight: number): void {
    this.state(missionId).taskWeights[taskId] = weight;
  }

  // ── loop/stall signals (fed by worker instrumentation) ───────────────────

  private tracker(missionId: string, workerId: string): WorkerLoopTracker | undefined {
    const s = this.state(missionId);
    let t = s.loopTrackers.get(workerId);
    if (!t) {
      t = new WorkerLoopTracker(this.config);
      s.loopTrackers.set(workerId, t);
    }
    return t;
  }

  noteWorkerRead(missionId: string, workerId: string, path: string): void {
    this.tracker(missionId, workerId)?.readFile(path);
  }

  noteWorkerTool(missionId: string, workerId: string, signature: string): void {
    this.tracker(missionId, workerId)?.toolCall(signature);
  }

  noteWorkerError(missionId: string, workerId: string, signature: string): void {
    this.tracker(missionId, workerId)?.error(signature);
  }

  noteWorkerCycle(missionId: string, workerId: string, signature: string): void {
    this.tracker(missionId, workerId)?.cycle(signature);
  }

  workerFileChanged(missionId: string, workerId: string): void {
    this.tracker(missionId, workerId)?.fileChanged();
  }

  /** Loop signals currently flagged for a worker (spec 03). */
  loopSignals(missionId: string, workerId: string): LoopSignal[] {
    return this.tracker(missionId, workerId)?.signals() ?? [];
  }

  hasLoop(missionId: string, workerId: string): boolean {
    return this.tracker(missionId, workerId)?.hasLoop() ?? false;
  }

  // ── read model / projection ──────────────────────────────────────────────

  summary(missionId: string): MissionObservabilitySummary | null {
    const s = this.states.get(missionId);
    const mission = this.store.getMission(missionId);
    if (!s && !mission) return null;
    if (!s) return null;
    const status = mission?.status ?? "NEW";
    const health = this.currentHealth(s, status);
    const workerCounts = this.workerCounts(s);
    const progress = computeProgress({
      missionId,
      tasks: this.store.listTasks(missionId),
      missionStatus: status,
      verifiedComplete: s.verifiedComplete,
      completionStatus: s.completionStatus,
      units: s.taskUnits,
      weights: s.taskWeights,
      creditRunningWithoutUnits: true,
      historyLabel: s.currentActivity?.type ?? status.toLowerCase(),
    });
    return {
      missionId,
      title: s.title,
      state: status,
      phase: status,
      progress: {
        approximatePercent: progress.approximatePercent,
        verifiedComplete: s.verifiedComplete,
        basis: progress.basis,
      },
      health: health.health,
      currentObjective: s.currentObjective,
      currentActivity: s.currentActivity,
      workers: workerCounts,
      lastHeartbeatAt: s.lastHeartbeatAt,
      lastMeaningfulProgressAt: s.lastMeaningfulProgressAt,
      waitingReason: health.waitingReason ?? s.waitingReason,
      waitingSince: s.waitingSince,
      completionStatus: s.completionStatus,
      runtimeStartedAt: s.runtimeStartedAt,
    };
  }

  private currentHealth(s: MissionObsState, status: string): { health: MissionHealth; waitingReason?: WaitingReason } {
    const now = this.now();
    const alive = this.anyWorkerRunning(s);
    return deriveHealth({
      missionStatus: status as never,
      waitingReason: s.waitingReason,
      blocked: status === "BLOCKED",
      failed: status === "FAILED",
      complete: status === "COMPLETE",
      verifiedComplete: s.verifiedComplete,
      lastHeartbeatAt: s.lastHeartbeatAt,
      lastMeaningfulProgressAt: s.lastMeaningfulProgressAt,
      slowAfterMs: this.config.slowAfterMs,
      stallAfterMs: this.config.stallAfterMs,
      now,
      alive,
    });
  }

  private anyWorkerRunning(s: MissionObsState): boolean {
    return [...s.workers.values()].some((w) => w.state === "running" || w.state === "waiting");
  }

  private workerCounts(s: MissionObsState): { active: number; waiting: number; failed: number } {
    let active = 0;
    let waiting = 0;
    let failed = 0;
    for (const w of s.workers.values()) {
      if (w.state === "running") active += 1;
      else if (w.state === "waiting") waiting += 1;
      else if (w.state === "failed") failed += 1;
    }
    return { active, waiting, failed };
  }

  projection(missionId: string): MissionProjection | null {
    const summary = this.summary(missionId);
    const s = this.states.get(missionId);
    const mission = this.store.getMission(missionId);
    if (!s || !summary) return null;
    const progress = computeProgress({
      missionId,
      tasks: this.store.listTasks(missionId),
      missionStatus: mission?.status ?? "NEW",
      verifiedComplete: s.verifiedComplete,
      completionStatus: s.completionStatus,
      units: s.taskUnits,
      weights: s.taskWeights,
      creditRunningWithoutUnits: true,
    });
    const workers: WorkerObservability[] = [];
    for (const w of s.workers.values()) {
      const tracker = s.loopTrackers.get(w.workerId);
      const signals = tracker?.signals() ?? [];
      workers.push({
        ...w,
        repeatedFileReads: signals.find((x) => x.kind === "repeated_file_read")?.count ?? w.repeatedFileReads,
        repeatedToolCalls: signals.find((x) => x.kind === "repeated_tool_call")?.count ?? w.repeatedToolCalls,
        repeatedErrors: signals.find((x) => x.kind === "repeated_error")?.count ?? w.repeatedErrors,
        repeatedCycles: signals.find((x) => x.kind === "repeated_cycle")?.count ?? w.repeatedCycles,
      });
    }
    return {
      summary,
      tasks: progress.tasks,
      workers,
      activity: s.activity.slice(-this.config.activityRetention),
      progressHistory: s.progressHistory,
      tests: s.tests,
      review: s.review,
      changes: s.changes,
      errors: s.errors,
      recovery: s.recovery,
      artifacts: s.artifacts,
    };
  }

  listMissionIds(): string[] {
    return [...this.states.keys()];
  }

  /** Emit a concise user-facing update (Communication Gate — always open). */
  private emitUpdate(missionId: string, message: string): void {
    // A transition-level update resets the quiet-period timer so a periodic
    // summary (maybeEmitQuietUpdate) is suppressed while real transitions are
    // still streaming. Only live API calls reach emitUpdate — replay applies
    // events directly and never emits — so this cannot cause reconnect spam.
    const s = this.states.get(missionId);
    if (s) s.lastUpdateEmittedAt = this.now();
    try {
      this.onUpdate?.(missionId, message);
    } catch {
      // An update emitter is an observer, never a participant.
    }
  }

  /**
   * Quiet-period visibility: if no transition-level update has been emitted
   * for `quietUpdateIntervalMs`, emit a health summary (spec 02).
   */
  maybeEmitQuietUpdate(missionId: string): void {
    const s = this.states.get(missionId);
    if (!s) return;
    const now = Date.parse(this.now());
    const last = s.lastUpdateEmittedAt ? Date.parse(s.lastUpdateEmittedAt) : Date.parse(s.runtimeStartedAt);
    if (now - last >= this.config.quietUpdateIntervalMs) {
      s.lastUpdateEmittedAt = this.now();
      const sum = this.summary(missionId);
      if (!sum) return;
      const tests = s.tests.total > 0 ? ` · tests ${s.tests.completed}/${s.tests.total}` : "";
      const lastProg = this.ageLabel(s.lastMeaningfulProgressAt);
      this.emitUpdate(
        missionId,
        `Mission · ${s.title} · ~${sum.progress.approximatePercent}%\n\nStill running${tests}.\nLast meaningful progress ${lastProg}; health ${sum.health.toUpperCase()}.`,
      );
    }
  }

  private ageLabel(iso?: string): string {
    if (!iso) return "n/a";
    const ms = Math.max(0, Date.now() - Date.parse(iso));
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }
}
