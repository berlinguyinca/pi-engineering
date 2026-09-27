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
}

interface Diagnosis {
  health: Exclude<SupervisorHealth, "HEALTHY" | "ACTIONABLE_STOP">;
  category: FailureCategory;
  reason: string;
  task?: OrchestrationTask;
}

/** Clock-driven mission watchdog. It never depends on a worker event to run. */
export class MissionSupervisor {
  private readonly store: MissionStore;
  private readonly observability?: MissionObservability;
  private readonly planner: RecoveryPlanner;
  private readonly classifier = new FailureClassifier();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<SupervisorStatus[]>;

  constructor(options: MissionSupervisorOptions) {
    this.store = options.store;
    this.observability = options.observability;
    this.planner = options.recoveryPlanner ?? new RecoveryPlanner();
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("MissionSupervisor intervalMs must be positive");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileOnStartup(beforeDispatch?: () => void | Promise<void>): Promise<SupervisorStatus[]> {
    const statuses = await this.tick();
    await this.store.flush();
    await beforeDispatch?.();
    return statuses;
  }

  tick(missionId?: string): Promise<SupervisorStatus[]> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick(missionId).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(missionId?: string): Promise<SupervisorStatus[]> {
    const missions = this.store
      .listMissions((mission) => !TERMINAL.has(mission.status))
      .filter((mission) => (missionId ? mission.mission_id === missionId : true));
    const statuses: SupervisorStatus[] = [];
    for (const mission of missions) statuses.push(await this.reconcile(mission));
    await this.store.flush();
    return statuses;
  }

  private async reconcile(mission: Mission): Promise<SupervisorStatus> {
    const currentResumption = this.store.listMissionResumptions(mission.mission_id).at(-1)?.generation ?? 0;
    const currentStop = this.store
      .listMissionStops(mission.mission_id)
      .filter((stop) => stop.resumptionGeneration === currentResumption)
      .at(-1);
    if (currentStop) return this.statusForStop(mission, currentStop.reason, currentStop.resumeCondition);

    const diagnosis = this.diagnose(mission);
    if (!diagnosis) return this.status(mission, "HEALTHY", "Mission has current ownership or a named future wait");

    if (diagnosis.health === "DEADLOCKED" && mission.status !== "BLOCKED") {
      if (canTransitionMission(mission.status, "BLOCKED")) this.store.transitionMission(mission.mission_id, "BLOCKED");
    }
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
    const history = this.store.listRecoveryDecisions(mission.mission_id);
    let decision = history.find(
      (candidate) =>
        candidate.classificationId === durableClassification.classificationId &&
        (candidate.resumptionGeneration ?? 0) === currentResumption &&
        (candidate.status === "planned" || candidate.status === "started"),
    );
    if (!decision) {
      decision = this.store.planRecovery(
        this.planner.decide({
          classification: durableClassification,
          history,
          now: this.now(),
          resumptionGeneration: currentResumption,
        }),
      );
      if (decision.action === "STOP") {
        const exhausted = this.store.transitionRecovery(decision.recoveryId, "exhausted");
        const preservedWork = this.preservedWork(mission.mission_id);
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
    const result = this.status(mission, diagnosis.health, diagnosis.reason, diagnosis.task, decision);
    const stop = this.store
      .listMissionStops(mission.mission_id)
      .filter((candidate) => candidate.resumptionGeneration === currentResumption)
      .at(-1);
    return stop
      ? {
          ...result,
          action: "STOP",
          nextAction: stop.resumeCondition,
          preservedWork: [...stop.preservedWork],
        }
      : result;
  }

  private diagnose(mission: Mission): Diagnosis | null {
    const now = this.now();
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
    const projectedHealth = this.observability?.summary(mission.mission_id)?.health;
    if (projectedHealth === "stalled") {
      return {
        health: "STALLED",
        category: "ORPHANED_EXECUTION",
        reason: "Worker heartbeat is live but meaningful progress exceeded the stall threshold",
      };
    }
    const tasks = this.store.listTasks(mission.mission_id);
    const activeExecution = this.store
      .listExecutions(mission.mission_id)
      .some((execution) => execution.status === "RUNNING");
    const succeeded = new Set(tasks.filter((task) => task.status === "SUCCEEDED").map((task) => task.task_id));
    const runnable = tasks.find(
      (task) =>
        (task.status === "READY" || task.status === "PENDING" || task.status === "RETRYING") &&
        task.depends_on.every((dependency) => succeeded.has(dependency)),
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
        task.depends_on.some((dependency) => !succeeded.has(dependency)),
    );
    if (!activeExecution && unresolved && !runnable) {
      return {
        health: "DEADLOCKED",
        category: "DEADLOCKED_DAG",
        reason: `Task ${unresolved.task_id} has unresolved dependencies: ${unresolved.depends_on
          .filter((dependency) => !succeeded.has(dependency))
          .join(", ")}`,
        task: unresolved,
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
    const summary = this.observability?.summary(mission.mission_id);
    const task =
      diagnosedTask ?? this.store.listTasks(mission.mission_id).find((candidate) => candidate.status === "RUNNING");
    const manifest = this.store.getWorkspaceManifest(mission.mission_id);
    const lease = this.store.getMissionLease(mission.mission_id);
    const preservedWork = this.preservedWork(mission.mission_id);
    return {
      missionId: mission.mission_id,
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

  private statusForStop(mission: Mission, reason: string, resumeCondition: string): SupervisorStatus {
    const decision = this.store.listRecoveryDecisions(mission.mission_id).at(-1);
    const status = this.status(mission, "ACTIONABLE_STOP", reason, undefined, decision);
    return { ...status, action: "STOP", nextAction: resumeCondition };
  }

  private preservedWork(missionId: string): string[] {
    return [
      ...new Set(
        this.store
          .listTaskCheckpoints(missionId)
          .flatMap((checkpoint) => [checkpoint.worktree, checkpoint.branch])
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
      ),
    ];
  }
}
