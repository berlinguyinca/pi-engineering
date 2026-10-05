import { latestTaskCheckpoints } from "./checkpoints.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";
import { FailureClassifier, RecoveryPlanner } from "./recovery.ts";
import { canTransitionMission } from "./state.ts";
import type { FailureCategory, Mission, OrchestrationTask, RecoveryDecision } from "./types.ts";

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELED"]);
const WAIT_ACTIONS = new Set(["WAIT_FOR_REQUIREMENT", "PROBE_AND_BACKOFF", "PAUSE_FOR_PERSISTENCE"]);

export type SupervisorHealth =
  | "HEALTHY"
  | "ORPHANED"
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
    const expectedGenerations = new Map(
      this.store
        .listMissions((mission) => !TERMINAL.has(mission.status))
        .map((mission) => [mission.mission_id, this.currentResumptionGeneration(mission.mission_id)] as const),
    );
    const statuses = await this.tick();
    this.assertExpectedGenerations(expectedGenerations);
    await this.store.flush();
    this.assertExpectedGenerations(expectedGenerations);
    await beforeDispatch?.();
    this.assertExpectedGenerations(expectedGenerations);
    return statuses;
  }

  tick(missionId?: string): Promise<SupervisorStatus[]> {
    if (!this.acceptingTicks) return Promise.reject(new Error("MissionSupervisor is shutting down"));
    const flight = this.runTick(missionId).finally(() => {
      this.activeTicks.delete(flight);
    });
    this.activeTicks.add(flight);
    return flight;
  }

  private async runTick(missionId?: string): Promise<SupervisorStatus[]> {
    const flights = this.store
      .listMissions((mission) => !TERMINAL.has(mission.status))
      .filter((mission) => (missionId ? mission.mission_id === missionId : true))
      .map((mission) => ({
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
      this.assertResumptionGeneration(mission.mission_id, expectedResumptionGeneration);
      return this.status(mission, "HEALTHY", "Mission has current ownership or a named future wait");
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
      decision = this.store.planRecovery(
        this.planner.decide({
          classification: durableClassification,
          history,
          now: this.now(),
          resumptionGeneration: expectedResumptionGeneration,
        }),
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
    if (wait && now >= Date.parse(wait.deadline)) {
      const classification = this.store.getFailureClassification(wait.classificationId);
      return {
        health: "EXPIRED_WAIT",
        category: classification?.category ?? "REQUIREMENT_AMBIGUITY",
        reason: `Named wait ${wait.action} expired at ${wait.deadline}`,
      };
    }
    if (wait) return null;
    const projectedHealth = this.observability?.summary(mission.mission_id)?.health;
    if (projectedHealth === "stalled") {
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
        };
      }
      return null;
    }
    this.stalledProjections.delete(mission.mission_id);
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
    if (!activeExecution) {
      return {
        health: "ORPHANED",
        category: "ORPHANED_EXECUTION",
        reason: `Nonterminal mission ${mission.mission_id} has no active worker, runnable task, dependency wait, or named wait`,
      };
    }
    return null;
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
