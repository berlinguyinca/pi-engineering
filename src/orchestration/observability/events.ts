/**
 * Mission observability events (spec 05).
 *
 * Structured, append-only events drive the observability projection. They are
 * persisted through the SAME EventStoreBackend as the MissionStore (single
 * event model, no parallel infra stack). Event types use the lowercase dotted
 * `mission.obs.*` namespace so MissionStore replay ignores them (it only handles
 * its own orchestration types) while the observability replay reconstructs
 * state on restart/reconnect.
 */

import { id } from "../../core/ids.ts";
import type { StoredEvent } from "../../platform/eventstore/backend.ts";
import type { ActivityType, WaitingReason } from "./types.ts";

/** Canonical observability event kinds (spec 05). */
export type MissionObservabilityEventType =
  | "MISSION_CREATED"
  | "MISSION_PHASE_CHANGED"
  | "MISSION_HEALTH_CHANGED"
  | "TASK_ASSIGNED"
  | "TASK_STARTED"
  | "TASK_PROGRESS"
  | "TASK_WAITING"
  | "TASK_BLOCKED"
  | "TASK_FAILED"
  | "TASK_COMPLETED"
  | "WORKER_STARTED"
  | "WORKER_HEARTBEAT"
  | "WORKER_ACTIVITY"
  | "WORKER_WAITING"
  | "WORKER_FAILED"
  | "WORKER_COMPLETED"
  | "FILE_READ"
  | "FILE_CHANGED"
  | "COMMAND_STARTED"
  | "COMMAND_PROGRESS"
  | "COMMAND_COMPLETED"
  | "COMMAND_FAILED"
  | "TEST_STARTED"
  | "TEST_PROGRESS"
  | "TEST_COMPLETED"
  | "BUILD_STARTED"
  | "BUILD_PROGRESS"
  | "BUILD_COMPLETED"
  | "BUILD_FAILED"
  | "MODEL_REQUEST_STARTED"
  | "MODEL_REQUEST_WAITING"
  | "MODEL_REQUEST_PROGRESS"
  | "MODEL_REQUEST_COMPLETED"
  | "MODEL_REQUEST_FAILED"
  | "REVIEW_STARTED"
  | "REVIEW_FINDING"
  | "REVIEW_COMPLETED"
  | "REPAIR_STARTED"
  | "REPAIR_COMPLETED"
  | "RECOVERY_STARTED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_FAILED"
  | "ARTIFACT_CREATED"
  | "GIT_DIFF_UPDATED"
  | "COMMIT_CREATED"
  | "INTEGRATION_COMPLETED"
  | "COMPLETION_GATE_STARTED"
  | "COMPLETION_GATE_FAILED"
  | "COMPLETION_GATE_PASSED";

/** The persisted event shape (maps 1:1 to a StoredEvent). */
export interface MissionObservabilityEvent {
  event_id: string;
  missionId: string;
  timestamp: string;
  source: { type: "orchestrator" | "worker" | "process" | "repo" | "test" | "review" | "inferweave"; id?: string };
  type: MissionObservabilityEventType;
  taskId?: string;
  workerId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  meaningfulProgress: boolean;
}

/** Persistent event type (lowercase dotted, additive). */
export type MissionObsStoredType =
  | "mission.obs.created"
  | "mission.obs.phase"
  | "mission.obs.health"
  | "mission.obs.task"
  | "mission.obs.worker"
  | "mission.obs.activity"
  | "mission.obs.heartbeat"
  | "mission.obs.test"
  | "mission.obs.review"
  | "mission.obs.recovery"
  | "mission.obs.gate"
  | "mission.obs.error";

export const OBSERVABILITY_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "mission.obs.created",
  "mission.obs.phase",
  "mission.obs.health",
  "mission.obs.task",
  "mission.obs.worker",
  "mission.obs.activity",
  "mission.obs.heartbeat",
  "mission.obs.test",
  "mission.obs.review",
  "mission.obs.recovery",
  "mission.obs.gate",
  "mission.obs.error",
]);

/** Build a persisted StoredEvent carrying a mission observability event. */
export function toStoredEvent(ev: MissionObservabilityEvent, storedType: MissionObsStoredType): StoredEvent {
  return {
    event_id: ev.event_id,
    timestamp: ev.timestamp,
    type: storedType,
    project_id: null,
    run_id: ev.missionId,
    worker_id: ev.workerId ?? null,
    payload: {
      missionId: ev.missionId,
      sourceType: ev.source.type,
      sourceId: ev.source.id ?? null,
      obsType: ev.type,
      taskId: ev.taskId ?? null,
      workerId: ev.workerId ?? null,
      summary: ev.summary,
      metadata: ev.metadata ?? {},
      meaningfulProgress: ev.meaningfulProgress,
    },
  };
}

/** Rebuild a MissionObservabilityEvent from a stored event. */
export function fromStoredEvent(e: StoredEvent): MissionObservabilityEvent | null {
  if (!OBSERVABILITY_EVENT_TYPES.has(e.type)) return null;
  const p = e.payload as Record<string, unknown>;
  return {
    event_id: e.event_id,
    missionId: (p.missionId as string) ?? e.run_id ?? "",
    timestamp: e.timestamp,
    source: {
      type: (p.sourceType as MissionObservabilityEvent["source"]["type"]) ?? "orchestrator",
      id: (p.sourceId as string | null) ?? undefined,
    },
    type: (p.obsType as MissionObservabilityEventType) ?? "MISSION_CREATED",
    taskId: (p.taskId as string | null) ?? undefined,
    workerId: (p.workerId as string | null) ?? undefined,
    summary: (p.summary as string) ?? "",
    metadata: (p.metadata as Record<string, unknown>) ?? {},
    meaningfulProgress: Boolean(p.meaningfulProgress),
  };
}

/** Convenience: build a fresh observability event (no persistence yet). */
export function newObservabilityEvent(input: {
  missionId: string;
  type: MissionObservabilityEventType;
  summary: string;
  source?: MissionObservabilityEvent["source"];
  taskId?: string;
  workerId?: string;
  metadata?: Record<string, unknown>;
  meaningfulProgress?: boolean;
}): MissionObservabilityEvent {
  return {
    event_id: id("obsevt"),
    missionId: input.missionId,
    timestamp: new Date().toISOString(),
    source: input.source ?? { type: "orchestrator" },
    type: input.type,
    taskId: input.taskId,
    workerId: input.workerId,
    summary: input.summary,
    metadata: input.metadata,
    meaningfulProgress: input.meaningfulProgress ?? false,
  };
}

/** Map an observable ActivityType to a persisted stored type (additive). */
export function storedTypeForActivity(type?: ActivityType): MissionObsStoredType {
  switch (type) {
    case "running_test":
    case "validation":
      return "mission.obs.test";
    case "review_started":
    case "review_finding":
    case "review_completed":
      return "mission.obs.review";
    case "recovery":
      return "mission.obs.recovery";
    case "error":
      return "mission.obs.error";
    default:
      return "mission.obs.activity";
  }
}

/** Map a canonical observability event type to a persisted stored type. */
export function storedTypeForEventType(type: MissionObservabilityEventType): MissionObsStoredType {
  switch (type) {
    case "MISSION_CREATED":
      return "mission.obs.created";
    case "MISSION_PHASE_CHANGED":
    case "MISSION_HEALTH_CHANGED":
      return "mission.obs.phase";
    case "TASK_STARTED":
    case "TASK_PROGRESS":
    case "TASK_COMPLETED":
    case "TASK_WAITING":
    case "TASK_BLOCKED":
    case "TASK_FAILED":
    case "TASK_ASSIGNED":
      return "mission.obs.task";
    case "WORKER_STARTED":
    case "WORKER_HEARTBEAT":
    case "WORKER_ACTIVITY":
    case "WORKER_WAITING":
    case "WORKER_FAILED":
    case "WORKER_COMPLETED":
      return "mission.obs.worker";
    case "TEST_STARTED":
    case "TEST_PROGRESS":
    case "TEST_COMPLETED":
    case "BUILD_STARTED":
    case "BUILD_PROGRESS":
    case "BUILD_COMPLETED":
    case "BUILD_FAILED":
      return "mission.obs.test";
    case "REVIEW_STARTED":
    case "REVIEW_FINDING":
    case "REVIEW_COMPLETED":
    case "REPAIR_STARTED":
    case "REPAIR_COMPLETED":
      return "mission.obs.review";
    case "RECOVERY_STARTED":
    case "RECOVERY_COMPLETED":
    case "RECOVERY_FAILED":
      return "mission.obs.recovery";
    case "COMPLETION_GATE_STARTED":
    case "COMPLETION_GATE_FAILED":
    case "COMPLETION_GATE_PASSED":
      return "mission.obs.gate";
    case "COMMAND_FAILED":
      return "mission.obs.error";
    case "COMMAND_STARTED":
    case "COMMAND_PROGRESS":
    case "COMMAND_COMPLETED":
    case "MODEL_REQUEST_STARTED":
    case "MODEL_REQUEST_WAITING":
    case "MODEL_REQUEST_PROGRESS":
    case "MODEL_REQUEST_COMPLETED":
    case "MODEL_REQUEST_FAILED":
    case "FILE_READ":
    case "FILE_CHANGED":
    case "ARTIFACT_CREATED":
    case "GIT_DIFF_UPDATED":
    case "COMMIT_CREATED":
    case "INTEGRATION_COMPLETED":
      return "mission.obs.activity";
  }
}

/** Human-readable waiting label for a WaitingReason. */
export function waitingReasonLabel(reason: WaitingReason): string {
  switch (reason) {
    case "inferweave_admission":
      return "InferWeave admission queue";
    case "worker_dependency":
      return "worker dependency";
    case "integration_tests":
      return "integration tests";
    case "slurm_scheduler":
      return "Slurm scheduler";
    case "external_resource":
      return "external resource";
    case "human_approval":
      return "human approval";
    case "credential":
      return "credential";
    case "rate_limit":
      return "rate limit";
    case "model_request":
      return "model request";
    default:
      return "other";
  }
}
