import { latestTaskCheckpoints } from "./checkpoints.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";
import { FailureClassifier, RecoveryPlanner, taskFailureReason } from "./recovery.ts";
import { canTransitionMission } from "./state.ts";
import {
  type FailureCategory,
  type Mission,
  type OrchestrationTask,
  PLANNER_CLARIFICATION_CATEGORY,
  type RecoveryDecision,
} from "./types.ts";

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELED"]);
/** Task statuses that occupy no worker and can never become runnable again. */
const TERMINAL_TASK_STATUSES = new Set(["SUCCEEDED", "FAILED", "SKIPPED", "CANCELED"]);
const WAIT_ACTIONS = new Set(["WAIT_FOR_REQUIREMENT", "PROBE_AND_BACKOFF", "PAUSE_FOR_PERSISTENCE"]);
const FINISHING_PHASES: ReadonlySet<string> = new Set(["VALIDATING", "REVIEWING", "INTEGRATING", "FINAL_VALIDATION"]);

/**
 * `PLANNING_EMPTY`: the planner produced no executable work, so only the
 * operator can say why. `REPAIR_REQUIRED`: every task reached a terminal state
 * and at least one of them failed, so the work must be requeued, not fenced.
 */
export type SupervisorHealth =
  | "HEALTHY"
  | "ORPHANED"
  | "PLANNING_EMPTY"
  | "REPAIR_REQUIRED"
  | "DEADLOCKED"
  | "CONTROLLER_DISCONNECTED"
  | "STALLED"
  | "EXPIRED_WAIT"
  | "ACTIONABLE_STOP";

export interface SupervisorStatus {
  missionId: string;
  missionStatus: Mission["status"];
  missionRevision: number;
  missionBlockedEpisodeId: string | null;
  missionUpdatedAt: string;
  resumptionGeneration: number;
  health: SupervisorHealth;
  action: string;
  lastMeaningfulProgressAt: string | null;
  reason: string;
  recovery: { attempt: number; maxAttempts: number };
  nextAction: string;
  nextActionAt: string | null;
  owner: string | null;
  repository: string | null;
  task: string | null;
  preservedWork: string[];
  decision?: RecoveryDecision;
}

export interface MissionSupervisorOptions {
  store: MissionStore;
  observability?: MissionObservability;
  recoveryPlanner?: RecoveryPlanner;
  now?: () => number;
  intervalMs?: number;
  onError?: (diagnostic: SupervisorDiagnostic) => void | Promise<void>;
  /** Consume settled durable decisions. Called for startup and every periodic/explicit tick. */
  onStatuses?: (statuses: SupervisorStatus[]) => void | Promise<void>;
  /**
   * Runs before each tick lists missions (e.g. to catch up on events other
   * sessions appended to a shared namespace).
   */
  beforeTick?: () => void | Promise<void>;
  /**
   * Whether THIS supervisor may act on a mission. Several live sessions can see
   * one mission; only its custodian reconciles it. Defaults to every mission.
   */
  admit?: (mission: Mission) => boolean | Promise<boolean>;
  /** Whether the planner is running for a mission right now (no tasks yet is then expected). */
  planningInFlight?: (missionId: string) => boolean;
  /** Whether a controller in this process is driving the mission right now (it is then not orphaned). */
  runInFlight?: (missionId: string) => boolean;
}

export interface SupervisorDiagnostic {
  occurredAt: string;
  name: string;
  message: string;
  callbackFailure?: SupervisorDiagnosticDetail;
}

export interface SupervisorDiagnosticDetail {
  occurredAt: string;
  name: string;
  message: string;
}

interface Diagnosis {
  health: Exclude<SupervisorHealth, "HEALTHY" | "ACTIONABLE_STOP">;
  category: FailureCategory;
  reason: string;
  task?: OrchestrationTask;
  /** The planner's own question, when it explicitly asked the operator to clarify the goal. */
  operatorQuestion?: string;
}

class StaleSupervisorResumptionError extends Error {
  constructor(missionId: string, expectedGeneration: number, currentGeneration: number) {
    super(`stale supervisor resumption for ${missionId}: expected ${expectedGeneration}, current ${currentGeneration}`);
    this.name = "StaleSupervisorResumptionError";
  }
}

/** Clock-driven mission watchdog. It never depends on a worker event to run. */
export class MissionSupervisor {
  private readonly store: MissionStore;
  private readonly observability?: MissionObservability;
  private readonly planner: RecoveryPlanner;
  private readonly classifier = new FailureClassifier();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly onError?: (diagnostic: SupervisorDiagnostic) => void | Promise<void>;
  private readonly onStatuses?: (statuses: SupervisorStatus[]) => void | Promise<void>;
  private readonly beforeTick?: () => void | Promise<void>;
  private readonly admit?: (mission: Mission) => boolean | Promise<boolean>;
  private readonly planningInFlight?: (missionId: string) => boolean;
  private readonly runInFlight?: (missionId: string) => boolean;
  private readonly supervisorDiagnostics: SupervisorDiagnostic[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly missionTicks = new Map<string, Promise<SupervisorStatus>>();
  private readonly activeTicks = new Set<Promise<SupervisorStatus[]>>();
  private acceptingTicks = true;
  /** Consecutive STALLED projections per mission, used to debounce recovery. */
  private readonly stalledProjections = new Map<string, number>();

  constructor(options: MissionSupervisorOptions) {
    this.store = options.store;
    this.observability = options.observability;
    this.planner = options.recoveryPlanner ?? new RecoveryPlanner();
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.onError = options.onError;
    this.onStatuses = options.onStatuses;
    this.beforeTick = options.beforeTick;
    this.admit = options.admit;
    this.planningInFlight = options.planningInFlight;
    this.runInFlight = options.runInFlight;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("MissionSupervisor intervalMs must be positive");
    }
  }

  start(): void {
    if (this.timer) return;
    this.acceptingTicks = true;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.handleIntervalFailure(error));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stop scheduling, reject new ticks, and drain every reconciliation/consumer flight. */
  async shutdown(): Promise<void> {
    this.acceptingTicks = false;
    this.stop();
    const settled = await Promise.allSettled([...this.activeTicks]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "MissionSupervisor shutdown failed while draining");
  }

  diagnostics(): SupervisorDiagnostic[] {
    return this.supervisorDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.callbackFailure ? { callbackFailure: { ...diagnostic.callbackFailure } } : {}),
    }));
  }

  async reconcileOnStartup(beforeDispatch?: () => void | Promise<void>): Promise<SupervisorStatus[]> {
    // Catch up BEFORE pinning generations, and not again inside this tick: a
    // generation another session advances mid-startup must not fail the open.
    await this.beforeTick?.();
    const expectedGenerations = new Map(
      (await this.admitted(this.store.listMissions((mission) => !TERMINAL.has(mission.status)))).map(
        (mission) => [mission.mission_id, this.currentResumptionGeneration(mission.mission_id)] as const,
      ),
    );
    const statuses = await this.tick(undefined, { catchUp: false });
    this.assertExpectedGenerations(expectedGenerations);
    await this.store.flush();
    this.assertExpectedGenerations(expectedGenerations);
    await beforeDispatch?.();
    this.assertExpectedGenerations(expectedGenerations);
    return statuses;
  }

  tick(missionId?: string, options: { catchUp?: boolean } = {}): Promise<SupervisorStatus[]> {
    if (!this.acceptingTicks) return Promise.reject(new Error("MissionSupervisor is shutting down"));
    const flight = this.runTick(missionId, options.catchUp ?? true).finally(() => {
      this.activeTicks.delete(flight);
    });
    this.activeTicks.add(flight);
    return flight;
  }

  private async runTick(missionId: string | undefined, catchUp: boolean): Promise<SupervisorStatus[]> {
    if (catchUp) await this.beforeTick?.();
    const candidates = this.store
      .listMissions((mission) => !TERMINAL.has(mission.status))
      .filter((mission) => (missionId ? mission.mission_id === missionId : true));
    const flights = (await this.admitted(candidates)).map((mission) => ({
      mission,
      expectedResumptionGeneration: this.currentResumptionGeneration(mission.mission_id),
    }));
    const statuses = await Promise.all(
      flights.map(({ mission, expectedResumptionGeneration }) =>
        this.reconcileFlight(mission, expectedResumptionGeneration),
      ),
    );
    for (const { mission, expectedResumptionGeneration } of flights) {
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    }
    await this.store.flush();
    for (const { mission, expectedResumptionGeneration } of flights) {
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    }
    await this.onStatuses?.(statuses);
    await this.store.flush();
    return statuses;
  }

  /** The missions this supervisor may act on (its custody), in input order. */
  private async admitted(missions: Mission[]): Promise<Mission[]> {
    const admit = this.admit;
    if (!admit) return missions;
    const verdicts = await Promise.all(missions.map((mission) => admit(mission)));
    return missions.filter((_, index) => verdicts[index]);
  }

  private reconcileFlight(mission: Mission, expectedResumptionGeneration: number): Promise<SupervisorStatus> {
    const flightKey = `${mission.mission_id}\u0000${expectedResumptionGeneration}`;
    const existing = this.missionTicks.get(flightKey);
    if (existing) return existing;
    const flight = this.reconcile(mission, expectedResumptionGeneration).finally(() => {
      if (this.missionTicks.get(flightKey) === flight) this.missionTicks.delete(flightKey);
    });
    this.missionTicks.set(flightKey, flight);
    return flight;
  }

  private async reconcile(mission: Mission, expectedResumptionGeneration: number): Promise<SupervisorStatus> {
    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    // The operator paused it (Esc): only the operator resumes it. Checked
    // first, because between the interrupt and the durable stop its tasks are
    // RETRYING with no worker, which would otherwise read as an orphan.
    if (this.store.getMission(mission.mission_id)?.operator_paused_at) {
      return this.status(mission, "HEALTHY", "Paused by the operator; waiting for /mission resume");
    }
    const currentStop = this.store
      .listMissionStops(mission.mission_id)
      .filter((stop) => stop.resumptionGeneration === expectedResumptionGeneration)
      .at(-1);
    if (currentStop) {
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
      return this.statusForStop(mission, currentStop.reason, currentStop.resumeCondition, expectedResumptionGeneration);
    }

    const diagnosis = this.diagnose(mission);
    if (!diagnosis) {
      const scheduledWait = this.currentWait(mission.mission_id);
      if (
        scheduledWait &&
        scheduledWait.action !== "WAIT_FOR_REQUIREMENT" &&
        this.now() >= Date.parse(scheduledWait.nextActionAt)
      ) {
        return this.status(mission, "HEALTHY", scheduledWait.expectedMaterialChange, undefined, scheduledWait);
      }
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
      const wait = this.currentWait(mission.mission_id);
      const healthy = this.status(mission, "HEALTHY", "Mission has current ownership or a named future wait");
      // The open wait is shown to the operator, never handed to the runtime as a decision to act on.
      return wait ? { ...healthy, nextAction: wait.expectedMaterialChange, nextActionAt: wait.nextActionAt } : healthy;
    }

    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    if (diagnosis.health === "DEADLOCKED" && mission.status !== "BLOCKED") {
      if (canTransitionMission(mission.status, "BLOCKED")) this.store.transitionMission(mission.mission_id, "BLOCKED");
    }
    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    const classification = this.classifier.classify({
      missionId: mission.mission_id,
      taskId: diagnosis.task?.task_id ?? null,
      executionId: null,
      summary: diagnosis.reason,
      category: diagnosis.category,
      observedAt: new Date(this.now()).toISOString(),
    });
    const durableClassification =
      this.store
        .listFailureClassifications(mission.mission_id)
        .find((existing) => existing.fingerprint === classification.fingerprint) ??
      this.store.classifyFailure(classification);
    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    const history = this.store.listRecoveryDecisions(mission.mission_id);
    let decision = history.find(
      (candidate) =>
        candidate.classificationId === durableClassification.classificationId &&
        (candidate.resumptionGeneration ?? 0) === expectedResumptionGeneration &&
        (candidate.status === "planned" || candidate.status === "started"),
    );
    if (!decision) {
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
      const decided = this.planner.decide({
        classification: durableClassification,
        history,
        now: this.now(),
        resumptionGeneration: expectedResumptionGeneration,
        exhaustionIsTerminal: true,
      });
      decision = this.store.planRecovery(
        diagnosis.operatorQuestion && decided.action === "WAIT_FOR_REQUIREMENT"
          ? { ...decided, operatorGuidance: `operator question: ${diagnosis.operatorQuestion}` }
          : decided,
      );
      if (decision.action === "STOP") {
        this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
        const exhausted = this.store.transitionRecovery(decision.recoveryId, "exhausted");
        const preservedWork = this.preservedWork(mission.mission_id);
        this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
        this.store.stopMission(mission.mission_id, {
          reason: diagnosis.reason,
          preservedWork,
          attemptedRecoveries: [...history.map((candidate) => candidate.recoveryId), decision.recoveryId],
          resumeCondition: `Resume after the condition changes: ${decision.expectedMaterialChange}`,
        });
        decision = exhausted;
      }
    }
    await this.store.flush();
    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    const result = this.status(mission, diagnosis.health, diagnosis.reason, diagnosis.task, decision);
    const stop = this.store
      .listMissionStops(mission.mission_id)
      .filter((candidate) => candidate.resumptionGeneration === expectedResumptionGeneration)
      .at(-1);
    this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
    return stop
      ? {
          ...result,
          action: "STOP",
          nextAction: stop.resumeCondition,
          preservedWork: this.preservedWork(mission.mission_id),
        }
      : result;
  }

  /** The open named wait (probe/backoff, requirement, persistence) of the current resumption, if any. */
  private currentWait(missionId: string): RecoveryDecision | undefined {
    const generation = this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    return this.store
      .listRecoveryDecisions(missionId)
      .filter(
        (decision) =>
          (decision.resumptionGeneration ?? 0) === generation &&
          WAIT_ACTIONS.has(decision.action) &&
          (decision.status === "planned" || decision.status === "started"),
      )
      .at(-1);
  }

  private diagnose(mission: Mission): Diagnosis | null {
    const now = this.now();
    // A mission paused in PLANNING with a current, deadline-bounded autonomous
    // spec-approval stage is healthy: the controller is doing bounded spec work,
    // so it must NOT be diagnosed as an orphaned taskless PLANNING mission.
    if (mission.status === "PLANNING") {
      const specStages = this.store.listSpecStages(mission.mission_id);
      const latestStage = specStages.at(-1);
      if (latestStage && latestStage.outcome === "running") {
        const deadline = Date.parse(latestStage.deadlineAt);
        if (Number.isFinite(deadline)) {
          if (now < deadline) return null;
          return {
            health: "ORPHANED",
            category: "ORPHANED_EXECUTION",
            reason: `Autonomous spec stage ${latestStage.stage} deadline expired at ${latestStage.deadlineAt}`,
          };
        }
      }
    }
    // Preflight failures have no worker to orphan. Preserve their unresolved
    // cause until recovery succeeds instead of replacing it with lease noise.
    if (
      (mission.status === "BLOCKED" || mission.status === "REPAIRING") &&
      this.store.listTasks(mission.mission_id).length === 0 &&
      !this.planningInFlight?.(mission.mission_id)
    ) {
      const blocker = this.store.listFailureClassifications(mission.mission_id).at(-1);
      if (
        blocker &&
        blocker.category !== "ORPHANED_EXECUTION" &&
        !this.store
          .listRecoveryDecisions(mission.mission_id)
          .some((decision) => decision.classificationId === blocker.classificationId && decision.status === "succeeded")
      ) {
        const operatorQuestion =
          blocker.category === "REQUIREMENT_AMBIGUITY"
            ? this.store
                .listFindings(mission.mission_id)
                .filter((finding) => finding.category === PLANNER_CLARIFICATION_CATEGORY && finding.status === "open")
                .at(-1)?.evidence
            : undefined;
        return {
          health: "REPAIR_REQUIRED",
          category: blocker.category,
          reason: blocker.summary,
          ...(operatorQuestion ? { operatorQuestion } : {}),
        };
      }
    }
    const lease = this.store.getMissionLease(mission.mission_id);
    if (lease && now >= Date.parse(lease.renewBy)) {
      return {
        health: "CONTROLLER_DISCONNECTED",
        category: "ORPHANED_EXECUTION",
        reason: `Controller ${lease.ownerId} lease expired at ${lease.renewBy}`,
      };
    }
    const currentResumption = this.store.listMissionResumptions(mission.mission_id).at(-1)?.generation ?? 0;
    const wait = this.store
      .listRecoveryDecisions(mission.mission_id)
      .filter(
        (decision) =>
          (decision.resumptionGeneration ?? 0) === currentResumption &&
          WAIT_ACTIONS.has(decision.action) &&
          (decision.status === "planned" || decision.status === "started"),
      )
      .at(-1);
    // A wait without a deadline (the default) never expires on a clock; it
    // ends when its condition changes or the user cancels.
    if (wait?.deadline && now >= Date.parse(wait.deadline)) {
      const classification = this.store.getFailureClassification(wait.classificationId);
      return {
        health: "EXPIRED_WAIT",
        category: classification?.category ?? "REQUIREMENT_AMBIGUITY",
        reason: `Named wait ${wait.action} expired at ${wait.deadline}`,
      };
    }
    const projection = this.observability?.projection(mission.mission_id);
    const stalledWorker = projection?.workers.find(
      (worker) => worker.state === "running" && worker.health === "stalled",
    );
    if (stalledWorker || projection?.summary.health === "stalled") {
      // Debounce: only classify after the STALLED projection persists across
      // consecutive supervisor evaluations. A single stale tick (e.g. a worker
      // between tool calls) must not fence a live worker. A genuinely dead
      // worker is recovered one tick later.
      const consecutive = (this.stalledProjections.get(mission.mission_id) ?? 0) + 1;
      this.stalledProjections.set(mission.mission_id, consecutive);
      if (consecutive >= 2) {
        return {
          health: "STALLED",
          category: "ORPHANED_EXECUTION",
          reason: "Worker heartbeat is live but meaningful progress exceeded the stall threshold",
          task: stalledWorker?.taskId ? this.store.getTask(stalledWorker.taskId) : undefined,
        };
      }
      return null;
    }
    this.stalledProjections.delete(mission.mission_id);
    // A wait protects its own condition, not independently running workers.
    if (wait) return null;
    const tasks = this.store.listTasks(mission.mission_id);
    const activeExecution = this.store
      .listExecutions(mission.mission_id)
      .some((execution) => execution.status === "RUNNING");
    const dependencySatisfied = (taskId: string) =>
      this.store.getTask(taskId)?.status === "SUCCEEDED" || this.store.isTaskSatisfiedBySupersession(taskId);
    const runnable = tasks.find(
      (task) =>
        (task.status === "READY" || task.status === "PENDING" || task.status === "RETRYING") &&
        task.depends_on.every(dependencySatisfied),
    );
    if (!activeExecution && runnable) {
      return {
        health: "ORPHANED",
        category: "ORPHANED_EXECUTION",
        reason: `Runnable task ${runnable.task_id} has no active worker`,
        task: runnable,
      };
    }
    const unresolved = tasks.find(
      (task) =>
        ["PENDING", "READY", "WAITING", "BLOCKED", "RETRYING"].includes(task.status) &&
        task.depends_on.some((dependency) => !dependencySatisfied(dependency)),
    );
    // A dependency that is RUNNING is in flight, not stuck: its execution row settles before its task row does (result
    // capture and the change observer run git in between), so a tick landing there sees no live execution. Judging
    // that a deadlock BLOCKED healthy missions; a dead controller is still caught by its lease.
    const waitsOnRunning =
      unresolved?.depends_on.some((dependency) => this.store.getTask(dependency)?.status === "RUNNING") ?? false;
    if (!activeExecution && unresolved && !runnable && waitsOnRunning) return null;
    if (!activeExecution && unresolved && !runnable) {
      return {
        health: "DEADLOCKED",
        category: "DEADLOCKED_DAG",
        reason: `Task ${unresolved.task_id} has unresolved dependencies: ${unresolved.depends_on
          .filter((dependency) => !dependencySatisfied(dependency))
          .join(", ")}`,
        task: unresolved,
      };
    }
    if (activeExecution) return null;
    // Nothing is running and nothing is runnable. The CAUSE decides the
    // recovery; one blanket orphaned-execution STOP used to erase three
    // different situations, two of which are not orphaned executions (#112).
    if (tasks.length === 0) {
      // The planner is still running: no tasks yet is expected, not an answer.
      if (this.planningInFlight?.(mission.mission_id)) return null;
      const question = this.store
        .listFindings(mission.mission_id)
        .filter((finding) => finding.category === PLANNER_CLARIFICATION_CATEGORY && finding.status === "open")
        .at(-1)?.evidence;
      return {
        health: "PLANNING_EMPTY",
        category: "REQUIREMENT_AMBIGUITY",
        reason: `Planning produced no tasks for mission ${mission.mission_id}: the operator must confirm or restate what this mission should do${question ? `. The planner asks: ${question}` : ""}`,
        ...(question ? { operatorQuestion: question } : {}),
      };
    }
    const failed = tasks.find(
      (task) => task.status === "FAILED" && !this.store.isTaskSatisfiedBySupersession(task.task_id),
    );
    const terminalOnly = tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status));
    if (failed && terminalOnly) {
      // Requeue through the existing supersession/repair machinery: naming the
      // failed task makes the repair plan create one bounded replacement for it
      // instead of declaring an ownerless mission and stopping.
      const reason = `Task ${failed.task_id} (${failed.kind}:${failed.role}) failed and no task is runnable: ${taskFailureReason(
        failed,
        this.store.listExecutions(mission.mission_id, failed.task_id),
        this.store.listFailureClassifications(mission.mission_id),
      )}`;
      // A failed worker task is an implementation defect only when its failure
      // matches NO known provider/infrastructure signature. A blanket
      // IMPLEMENTATION_DEFECT used to swallow a gateway capacity 400 (the
      // `inferweave_backpressure` envelope) and turn it into a CREATE_REPAIR_TASKS
      // loop that burned the repair budget re-issuing the same doomed request;
      // capacity, network and credential failures route to their own recoveries
      // (wait, stop) instead. Only an unrecognised failure stays a defect.
      const inferred = this.classifier.inferRecognizedCategory({
        missionId: mission.mission_id,
        taskId: failed.task_id,
        executionId: null,
        summary: reason,
      });
      return {
        health: "REPAIR_REQUIRED",
        category: inferred ?? "IMPLEMENTATION_DEFECT",
        reason,
        task: failed,
      };
    }
    // Every task is finished and the live controller is between the worker and the next gate (integration, validation,
    // review): git and verification run there with no execution row, and the slower they are the longer a tick can land
    // in that window. A controller that is running this mission is not an orphan.
    if (FINISHING_PHASES.has(mission.status) && this.runInFlight?.(mission.mission_id)) return null;
    return {
      health: "ORPHANED",
      category: "ORPHANED_EXECUTION",
      reason: `Nonterminal mission ${mission.mission_id} has no active worker, runnable task, dependency wait, or named wait`,
    };
  }

  private status(
    mission: Mission,
    health: SupervisorHealth,
    reason: string,
    diagnosedTask?: OrchestrationTask,
    decision?: RecoveryDecision,
  ): SupervisorStatus {
    const currentMission = this.store.getMission(mission.mission_id) ?? mission;
    const summary = this.observability?.summary(mission.mission_id);
    const task =
      diagnosedTask ?? this.store.listTasks(mission.mission_id).find((candidate) => candidate.status === "RUNNING");
    const manifest = this.store.getWorkspaceManifest(mission.mission_id);
    const lease = this.store.getMissionLease(mission.mission_id);
    const preservedWork = this.preservedWork(mission.mission_id);
    return {
      missionId: mission.mission_id,
      missionStatus: currentMission.status,
      missionRevision: currentMission.revision,
      missionBlockedEpisodeId: currentMission.blocked_episode_id ?? null,
      missionUpdatedAt: currentMission.updated_at,
      resumptionGeneration: this.currentResumptionGeneration(mission.mission_id),
      health,
      action: decision?.action ?? (health === "HEALTHY" ? "MONITOR" : "STOP"),
      lastMeaningfulProgressAt: summary?.lastMeaningfulProgressAt ?? null,
      reason,
      recovery: {
        attempt: decision?.attempt ?? 0,
        maxAttempts: decision?.maxAttempts ?? 0,
      },
      nextAction: decision?.expectedMaterialChange ?? "Continue monitoring",
      nextActionAt: decision?.nextActionAt ?? null,
      owner: lease?.ownerId ?? null,
      repository: task?.repo_id ?? manifest?.repositories[0]?.repoId ?? null,
      task: task?.task_id ?? null,
      preservedWork,
      ...(decision ? { decision } : {}),
    };
  }

  private statusForStop(
    mission: Mission,
    reason: string,
    resumeCondition: string,
    expectedResumptionGeneration: number,
  ): SupervisorStatus {
    const decision = this.store
      .listRecoveryDecisions(mission.mission_id)
      .filter((candidate) => (candidate.resumptionGeneration ?? 0) === expectedResumptionGeneration)
      .at(-1);
    const status = this.status(mission, "ACTIONABLE_STOP", reason, undefined, decision);
    return { ...status, action: "STOP", nextAction: resumeCondition };
  }

  private preservedWork(missionId: string): string[] {
    const currentCheckpoints = latestTaskCheckpoints(this.store.listTaskCheckpoints(missionId));
    return [
      ...new Set(
        [
          ...currentCheckpoints.flatMap((checkpoint) => [
            checkpoint.worktree,
            checkpoint.branch,
            checkpoint.candidateSha,
            ...checkpoint.committedChanges,
            ...checkpoint.preservedUncommittedChanges,
            ...checkpoint.artifactRefs,
          ]),
          ...this.store.listMissionStops(missionId).flatMap((stop) => stop.preservedWork),
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
      ),
    ];
  }

  private currentResumptionGeneration(missionId: string): number {
    return this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
  }

  private assertExpectedGenerations(expected: ReadonlyMap<string, number>): void {
    for (const [missionId, generation] of expected) this.assertResumptionGeneration(missionId, generation);
  }

  private assertResumptionGeneration(missionId: string, expected: number): void {
    const current = this.currentResumptionGeneration(missionId);
    if (current !== expected) {
      throw new StaleSupervisorResumptionError(missionId, expected, current);
    }
  }

  private async handleIntervalFailure(error: unknown): Promise<void> {
    if (error instanceof StaleSupervisorResumptionError) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    const diagnostic: SupervisorDiagnostic = {
      occurredAt: new Date(this.now()).toISOString(),
      name: normalized.name,
      message: normalized.message,
    };
    this.appendDiagnostic(diagnostic);
    try {
      await this.onError?.({ ...diagnostic });
    } catch (callbackError) {
      const callbackFailure = callbackError instanceof Error ? callbackError : new Error(String(callbackError));
      diagnostic.callbackFailure = {
        occurredAt: new Date(this.now()).toISOString(),
        name: callbackFailure.name,
        message: callbackFailure.message,
      };
    }
  }

  private appendDiagnostic(diagnostic: SupervisorDiagnostic): void {
    this.supervisorDiagnostics.push(diagnostic);
    if (this.supervisorDiagnostics.length > 100) this.supervisorDiagnostics.shift();
  }
}
