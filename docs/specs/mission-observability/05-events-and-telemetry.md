# 05 — Mission Events and Telemetry

## Event-sourced observability

Mission observability should be driven by structured events produced by the orchestrator, workers, test runners, review workflow, repository integrations, and InferWeave adapters.

## Base event

```ts
interface MissionEvent {
  id: string;
  missionId: string;
  timestamp: string;

  source: {
    type: "orchestrator" | "worker" | "process" | "repo" | "test" | "review" | "inferweave";
    id?: string;
  };

  type: MissionEventType;
  taskId?: string;
  workerId?: string;

  summary: string;

  metadata?: Record<string, unknown>;

  meaningfulProgress: boolean;
}
```

## Event types

At minimum:

```text
MISSION_CREATED
MISSION_PHASE_CHANGED
MISSION_HEALTH_CHANGED

TASK_CREATED
TASK_ASSIGNED
TASK_STARTED
TASK_PROGRESS
TASK_WAITING
TASK_BLOCKED
TASK_FAILED
TASK_COMPLETED

WORKER_STARTED
WORKER_HEARTBEAT
WORKER_ACTIVITY
WORKER_WAITING
WORKER_FAILED
WORKER_COMPLETED

FILE_READ
FILE_CHANGED
COMMAND_STARTED
COMMAND_PROGRESS
COMMAND_COMPLETED
COMMAND_FAILED

TEST_STARTED
TEST_PROGRESS
TEST_COMPLETED

BUILD_STARTED
BUILD_PROGRESS
BUILD_COMPLETED
BUILD_FAILED

MODEL_REQUEST_STARTED
MODEL_REQUEST_WAITING
MODEL_REQUEST_PROGRESS
MODEL_REQUEST_COMPLETED
MODEL_REQUEST_FAILED

REVIEW_STARTED
REVIEW_FINDING
REVIEW_COMPLETED
REPAIR_STARTED
REPAIR_COMPLETED

RECOVERY_STARTED
RECOVERY_COMPLETED
RECOVERY_FAILED

ARTIFACT_CREATED
GIT_DIFF_UPDATED
COMMIT_CREATED
INTEGRATION_COMPLETED

COMPLETION_GATE_STARTED
COMPLETION_GATE_FAILED
COMPLETION_GATE_PASSED
```

## Derived read model

Do not make Pi-Web reconstruct everything client-side.

Create a mission observability projection/read model that returns:

- summary,
- tasks,
- workers,
- recent activity,
- progress history,
- tests,
- review state,
- errors,
- artifacts.

## Streaming

Pi-Web should receive updates by the project's existing real-time transport if available. Prefer existing WebSocket/SSE/event infrastructure rather than inventing a parallel stack.

Reconnect must:
- fetch current projection,
- resume event stream,
- avoid duplicate events.

## Persistence

Events and projections must survive process restart.

Use project-standard persistence patterns. Do not introduce a new database solely for this feature unless existing architecture makes it necessary.

## Cardinality / retention

Raw high-frequency heartbeat events can be compacted or sampled.

Persist important state transitions and meaningful progress events longer than repetitive low-value heartbeat data.

## Future Herdr integration

Design event/projection schemas so Herdr can aggregate:

- mission title/state,
- host,
- repo,
- branch/worktree,
- worker count,
- progress,
- health,
- current activity,
- last meaningful progress.

Herdr integration is not required to block initial Pi-Web completion, but schemas should not prevent it.
