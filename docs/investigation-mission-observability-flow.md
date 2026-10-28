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

## P4 model provenance: two gaps that left `usage.model` / `workersDetail.model` null

Symptom: for an unrouted in-session worker (e.g. an investigator with no
`execution_requirements.model` and no pinned route), `/mission-status` rendered
`usage.model` and the per-worker model as null, even though a model clearly
served the run. Both surfaces read the **execution record's `model` field**
(`ex.model`): task `usage.model` via `missionWhy.ts` and `workersDetail.model`
via `orchestrator.ts:1366` (`store.getExecution(...).model`). The design intent
(orchestrator.ts:1354-1358) is that "the recorded model wins over the requested
one" — but `ex.model` was never actually set to the model that served.

Two independent gaps had to be closed for the serving model to reach `ex.model`:

### Gap 1 — executor success path never attached `details.model`

- `PiWorkerExecutor`'s **failure** and **superseded** paths attached
  `result.details.model` (the resolved serving model), but the **success** path
  did not. So for a completed run, `ranOn(run)`
  (`src/orchestration/realBackends.ts:272-277`, reads `run.result.details?.model`)
  was always `undefined`, and the backend's model resolution
  `model = route ?? ranOn(run) ?? reviewFallbackModel`
  (`src/orchestration/realBackends.ts:634`) fell through to null for unpinned
  roles.
- Fix: on the success path, attach the resolved serving model to the completed
  result's `details.model` (route when routed, else the executor default),
  matching the failure-path pattern — `src/workers/PiWorkerExecutor.ts`.
- Test: `test/integration/worker-model-provenance.test.ts` (in-session default
  model + routed model; red→green).

### Gap 2 — broker settlement never copied the serving model onto the execution record

- The execution record is created **before** the backend runs, seeded with the
  *requested* model: `model: modelRequirements?.model ?? null`
  (`src/orchestration/broker.ts:2871`). Settlement
  (`src/orchestration/broker.ts:3564`, the general non-gate path) recorded
  `exit_status`, `artifact_refs`, `usage`, error/summary — but **not** `model`.
  So `ex.model` stayed the requested value (null for unrouted roles) and the
  serving model the backend recorded on the outcome (`outcome.usage.model`, set
  by `withModel`, `src/orchestration/realBackends.ts:280-289`) was discarded.
- Fix: at settlement, copy the serving model onto the record when the outcome
  carries one: `...(typeof outcome.usage?.model === "string" && outcome.usage.model
  ? { model: outcome.usage.model } : {})` — so the model that actually served
  wins over the requested one, and the requested value is preserved when the
  outcome records no model.
- Test: `test/unit/orchestration-broker-model-provenance.test.ts` (unrouted
  serving model recorded; serving model preferred over a differing requested
  model on failover; requested model preserved when the outcome is unnamed;
  red→green).

### The complete provenance chain (both fixes in place)

```
PiWorkerExecutor success path  ->  result.details.model          (Gap 1 fix)
        |  ranOn(run) reads details.model            realBackends.ts:272
        v
model = route ?? ranOn(run) ?? reviewFallbackModel   realBackends.ts:634
        |  withModel(outcome, model)
        v
outcome.usage.model = modelKey(model)               realBackends.ts:280-289,850
        |  broker settlement copies outcome.usage.model -> execution.model  (Gap 2 fix)
        v
execution.model (store)                               broker.ts:3564-3577
        |  read by both surfaces
        v
missionWhy usage.model  +  orchestrator workersDetail.model
```

### Live confirmation (no redeploy, no fleet disruption)

Both fixes are verified at the test level with the real `PiWorkerExecutor` and
real `ExecutionBroker` at each link. A live confirmation was then run **without**
touching the deployed fleet: a scratch git repo plus a per-process agent dir
(`PI_CODING_AGENT_DIR`) whose `settings.json` pointed only at a deployed
pi-engineering release carrying the fix. The shared fleet release and config were
left untouched, so no running session was affected.

Result — `tasks[].usage.model` is populated with the serving model for every task
that ran LLM inference:

- Runtime `9f0d857`, mission `MSN-3lsyJt` (COMPLETE): both implementer tasks show
  `usage.model = "qwen3.8-27b-modality-vision-quant-q8_k_xl"` (`inferenceMs`
  31344 / 107696; completion tokens 884 / 2492). Unrouted roles (integrator ×2,
  validator; 0 tokens) correctly show `model = null`.
- Runtime `7565cf10`, mission `MSN-6erqDr`: the implementer task shows
  `usage.model = "qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m"` — recorded
  **even though the task settled FAILED**, confirming model provenance is captured
  independent of task outcome. (That mission's failure was LLM gateway capacity
  exhaustion — the pinned implementer model `text-ctx-c128k` on the `development`
  provider returned repeated 429 `queue_deadline_exceeded` backpressure — not a
  runtime regression; the runtime correctly retried and entered recovery while
  waiting for capacity.)

Reviewer / gate provenance gap (observed live, since fixed): the reviewer /
fresh-review task consumes real LLM tokens (`MSN-3lsyJt` `TSK-7qcSIT`: 26651 prompt
/ 2908 completion) yet its `usage.model` was `null` (`wall.inferenceMs` 0). Root
cause: gate backends (review/integration/validation) settle a successful run through
`buildGateEvidencePublication → publishGateEvidenceIfAuthoritative`, a different
path than the agent backend's `setExecutionStatus`, so the P4 Gap-2 model copy never
applied to them. Fixed by carrying the serving model (`outcome.usage.model`) through
the `GateEvidencePublication` and settling the execution record's `model` field to
it (see `test/unit/orchestration-broker-model-provenance.test.ts`, gate-path test).

## Tests covering this flow

- `test/integration/worker-model-provenance.test.ts` — executor attaches the serving model to `details.model` (Gap 1).
- `test/unit/orchestration-broker-model-provenance.test.ts` — broker settlement records the serving model on the execution record (Gap 2, non-gate path + the gate/review publication path).
- `test/integration/orchestrator-e2e.test.ts:851-880` — asserts `workersDetail` carries per-task routing provenance (model/route) in the summary.
- `test/integration/extension-mission-commands.test.ts` — `/mission-status` rendering incl. `execution_mode` (lines 540, 616).
- `test/integration/mission-observability-e2e.test.ts` — end-to-end observability summary assertions.
