# Investigation: worker observability event flow → /mission-status rendering

## 1. Where `workerStarted` is emitted (orchestrator)

- `OrchestrationOrchestrator.observeWorkerActivity` — `src/orchestration/orchestrator.ts:1342-1416`
  - Fed by the `WorkerRunController` constructor option `onActivity: (event) => this.observeWorkerActivity(event)` — `src/orchestration/orchestrator.ts:402`.
  - First-seen guard: `observedExecutions` set — `src/orchestration/orchestrator.ts:1350-1352` (one `workerStarted` per executionId; also records `taskExecutions` mapping mission:task → execution).
  - Routing provenance read (P4 comment, lines 1354-1358): `task.execution_requirements` (model/route/node/fallbacks/inferenceWaitMs) plus the broker-resolved model from the execution record `store.getExecution(event.executionId)?.model` — `orchestrator.ts:1366`. The recorded model wins over the requested one.
  - Emit: `obs?.workerStarted(event.missionId, event.executionId, { taskId, runtime: "pi", model, route, node, fallbacks, inferenceWaitMs })` — `src/orchestration/orchestrator.ts:1367-1375`.
  - In the same block: `obs?.taskStarted(...)` + `obs?.setCurrentObjective(...)` (`orchestrator.ts:1376-1379`); heartbeats → `obs?.heartbeat(...)` (1381-1385); other activity → `obs?.activity(...)` + `obs?.noteWorkerTool(...)` (1386-1396); completion/failure → `obs?.workerCompleted/workerFailed` (1397-1412).
- Note: the mode decision is NOT an observability event — it is persisted on the mission (see §3).

## 2. How MissionObservability stores and projects it

- `workerStarted` handler — `src/orchestration/observability/MissionObservability.ts:450-468`
  - Upserts `s.workers.get(executionId)` entry with `taskId, runtime, model, route, node, fallbacks, inferenceWaitMs, status: "running", startedAt`; resets `lastActivityMs` if a new execution replaces a worker slot.
  - `this.persist(missionId, { type: "worker_started", missionId, executionId, taskId, runtime, model, route, node, fallbacks, inferenceWaitMs, inferenceWaitSec, at: iso() })`.
- Store shape: `MissionObsState.workers: Map<string, WorkerObsEntry>` (`src/orchestration/observability/MissionObservability.ts:65-67`); `WorkerObsEntry` fields at lines 43-54.
- Projection: `summary()` — `MissionObservability.ts:1131-1249`
  - `workersDetail` = `[...s.workers.values()].map(...)` with `lastActivityMs` (falls back to `startedAt`), sorted by recency — lines 1169-1170.
  - Also derived: `phase`, `currentObjective`, `workerCount`, `buildActivity` (from `s.toolCounts`), `lastActivity`, `workflowProgress` (lines 1189-1206).
- Persistence: `persist()` (line 919) appends to `pendingWrites`, chains durable writes per mission via `emitChain` (line 954, failure-tolerant), and applies the event to in-memory state immediately via `apply()` — so `summary()` is live even before the write drains.

## 3. How the extension renders workersDetail and the mode decision

- `/mission-status` command — `extensions/index.ts:2022`
  - Reads `rt.missionObservability?.summary(m.mission_id)` — `extensions/index.ts:2028`.
  - Renders per-worker model/route: `Workers: ${summary?.workersDetail.length ?? 0} active` and per-worker line `${w.model ?? "model?"}${w.route ? ` (route ${w.route})` : ""}` — `extensions/index.ts:2068-2070`.
  - Mode decision line: `execution mode: ${m.execution_mode.mode} — ${m.execution_mode.reason}` from the mission record — `extensions/index.ts:2064` (also in the mission completion banner at line 2012).
- Where `m.execution_mode` comes from:
  - The `/mission run` handler passes `executionMode: plannerWorker.lastDecision()` (the planner's `chooseExecutionMode` decision, `src/plannerWorker/extension.ts:224,290`) into `orchestrator.orchestrate(...)` — `extensions/index.ts:1987`.
  - Orchestrator persists it on mission creation: `this.store.updateMission(mission.mission_id, { execution_mode: opts.executionMode })` — `src/orchestration/orchestrator.ts:1672`.
  - Orchestrator reports it as a progress line (never swallowed): re-read from the store and `this.report(... "execution mode: ...")` — `src/orchestration/orchestrator.ts:1724-1732`.
  - Store update plumbing: `src/orchestration/missionStore.ts:3174-3175`.

## Event-flow summary

1. Worker activity callback → `observeWorkerActivity` (orchestrator.ts:1342), first event per execution → `workerStarted` emit (orchestrator.ts:1367) with broker-resolved model + execution_requirements route metadata.
2. `MissionObservability.workerStarted` (MissionObservability.ts:450) upserts `workers` map + persists `worker_started` event; state applied in memory immediately.
3. `summary()` (MissionObservability.ts:1131) projects `workersDetail` (lines 1169-1170).
4. `/mission-status` (extensions/index.ts:2022) renders `workersDetail` as per-worker model/route lines (2068-2070); the mode decision is a mission-record field (`m.execution_mode`) persisted at orchestrateMission time (orchestrator.ts:1672) and rendered at extensions/index.ts:2012/2064.

## Tests covering this flow

- `test/integration/orchestrator-e2e.test.ts:851-880` — asserts `workersDetail` carries per-task routing provenance (model/route) in the summary.
- `test/integration/extension-mission-commands.test.ts` — `/mission-status` rendering incl. `execution_mode` (lines 540, 616).
- `test/integration/mission-observability-e2e.test.ts` — end-to-end observability summary assertions.
