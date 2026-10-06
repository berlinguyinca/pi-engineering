# Mission time limits

Owner requirement: a mission is not bound by a fixed wall-clock window. "If it
takes 8h, then it takes 8h." Evidence from session review: 185 task executions
were killed at exactly 30 minutes (~92 worker-hours lost), and a time-budget
timeout sent missions to BLOCKED with "task execution budget exhausted".

## Policy

- **No default duration cap** on a mission, task, worker, review, validation,
  integration or supervisor recovery. Work is split by deliverables, never by a
  clock.
- **Hung-worker detection is activity-based.** A worker is treated as hung only
  after a full window with no activity at all: no tool start/finish, no model
  output, no checkpoint, and no inference-wait signal. The default window is one
  hour. A hung worker is resumed from its checkpoint (up to 3 times per task
  run), not failed.
- **Waiting for inference capacity is never a stall.** Gateway holds (429
  `queue_timeout`, admission cooldowns, slot queues, `WAITING_FOR_*`) keep the
  watchdog alive. Mission workers wait as long as the gateway asks.
- **Leases stay, and live controllers renew them.** Crash recovery still works:
  a dead process stops renewing and its lease expires.
- **Subprocess hang guards are inactivity-based.** A verification command is
  killed only after it has been silent for the whole window (15 minutes by
  default). A suite that keeps printing runs to completion.
- **Caps are opt-in.** An operator can still set a task or mission ceiling
  explicitly. Nothing applies one implicitly.
- **Only the user ends a healthy mission early.** Cancelling (Esc on the running
  `/mission` or `mission` tool, which aborts its signal) is the only way.
  `mission {action:"status"}` and the BLOCKED report show the elapsed time, the
  last activity and the current stage.

## Configuration

`engineering.yaml` (global `~/.pi/agent/engineering.yaml` or repo `.pi/engineering.yaml`):

```yaml
limits:
  # Hung-worker window: resume a worker after this long with no activity at all.
  worker_inactivity_ms: 3600000      # default 1h; min 60000
  # OPT-IN caps. Leave unset (the default) for no limit.
  # max_task_wall_clock_ms: 28800000   # one task execution
  # max_mission_wall_clock_ms: 86400000 # the whole mission; reaching it cancels the mission and keeps the work
```

| Environment variable | Meaning | Default |
|---|---|---|
| `PI_ENGINEERING_WORKER_INACTIVITY_MS` | Hung-worker window. Overrides `limits.worker_inactivity_ms`. | 1h |
| `PI_ENGINEERING_WORKER_TIMEOUT_MS` | OPT-IN wall-clock limit per execution. | unset (none) |
| `PI_GATEWAY_MAX_OUTAGE` | OPT-IN total outage ceiling, after which the task FAILS. | unset (none) |
| `PI_GATEWAY_AUTO_RESUME_HORIZON` | How long a paused mission keeps probing to resume itself. | unbounded |
| `PI_GATEWAY_RETRY_WINDOW` | Retry window before a mission *pauses*. A paused mission is not failed. | 12h |

## Inventory

Classes:

- **(a)** A total-duration cap on work. Removed, or made opt-in.
- **(b)** Hung-process or liveness detection. Kept, made activity-based and generous.
- **(c)** A lease or heartbeat TTL for crash recovery. Kept; live owners renew it.
- **(d)** A per-subprocess or per-request hang guard. Kept, inactivity-based where it bounds work.
- **(—)** Not a mission limit (cache TTL, poll cadence, backoff spacing, interactive-only). Kept.

Line numbers refer to this branch.

### Mission, task and worker execution

| Limit | Where | Before | Class | Decision |
|---|---|---|---|---|
| Default execution wall-clock budget `workerTimeoutMs()` | `src/orchestration/broker.ts:421` | 30 min | a | **Removed.** Returns `undefined` unless `PI_ENGINEERING_WORKER_TIMEOUT_MS` is set (opt-in). |
| Broker execution deadline timer (TimeoutError abort) | `src/orchestration/broker.ts:2219` | always armed | a | **Opt-in only.** Armed only when a task budget or the opt-in default exists. |
| Broker inactivity watchdog (new) | `src/orchestration/broker.ts:2236`, `DEFAULT_WORKER_INACTIVITY_MS` at `:388` | — | b | **Added.** Applies to agent, research and review runs. Aborts after `inactivityTimeoutMs` with no activity. An inference wait (`processWaitingForInference`) resets it. The task stays RUNNING. |
| Before-deadline checkpoint timer | `src/orchestration/broker.ts:2545` | armed at deadline − 30s | a | Only when a budget exists. Activity-milestone checkpoints still run. |
| Activity heartbeat (15s) and cancellation ack grace (5s) | `src/orchestration/broker.ts:582`, `:585` | — | — | Kept. A display heartbeat; a grace after cancel. |
| Workset `maxTaskBudgetMs` | `src/orchestration/workset.ts:39` | 30 min, validated on every task | a | **Optional.** Unset by default (`limits.max_task_wall_clock_ms`). Tasks without a budget validate. |
| Planner default budget (orchestrator normalize) | `src/orchestration/orchestrator.ts` (normalize, `boundedTaskFields` at `:2406`) | 30 min | a | Uses the configured limit or none. |
| Runtime default planner `execution_budget_ms: 30 * 60_000` | `src/runtime/EngineeringRuntime.ts:878` | 30 min | a | **Removed.** |
| Spec-approval planned task default budget | `src/orchestration/specApproval.ts:361` | 30 min | a | **Removed.** Only an explicit budget is carried. |
| Recovery replacement tasks inherit `execution_budget_ms` | `src/orchestration/orchestrator.ts:738` | copied | a | Inherited only while a task limit is configured, so legacy 30-min budgets do not propagate. |
| "task execution budget exhausted after a durable partial checkpoint", which BLOCKED the mission | `src/orchestration/orchestrator.ts:1744` | fired on every 30-min timeout | a | Reachable only from an opt-in limit. Reworded to "configured task wall-clock limit … reached". |
| Hung worker resumed instead of failed (new) | `src/orchestration/scheduler.ts:564` | timeout → FAILED | b | An `inactivity` outcome is retried, up to 3 times per run. The retry starts from the hung execution's cancellation checkpoint (its preserved candidate, dirty edits included), not from the mission base. |
| Standalone `PiWorkerExecutor` timer (`req.timeoutMs ?? 300_000`) | `src/workers/PiWorkerExecutor.ts:891` | total duration | b/d | **Inactivity-based.** Every session event re-arms it. It is re-armed while the admission controller is waiting. Mission workers use the broker's watchdog instead (owner signal). |
| Legacy `engineer()` worker runs (`timeoutMs` 240s, 300s, 600s) | `src/runtime/EngineeringRuntime.ts:1276`, `:1420`, `:1517`, … | total duration | d | These are now silence windows via the executor change above. |
| Opt-in mission wall-clock limit (new) | `src/orchestration/orchestrator.ts:1206` | — | a (opt-in) | `limits.max_mission_wall_clock_ms`. Reaching it cancels the mission with all work preserved. |

### Gateway and inference waiting

| Limit | Where | Before | Class | Decision |
|---|---|---|---|---|
| Worker gateway hold budget `maxRetries` (8 holds) | `src/gateway/config.ts:50`, used at `src/workers/PiWorkerExecutor.ts:388` | 8 holds, then fail | a | **Unbounded for mission workers** (`unboundedInferenceWait`). Each hold emits a "Waiting for inference capacity" activity. Retry-alternate advice keeps the finite count, so the decision goes back to the mission. Standalone runs keep 8. |
| Interactive pump horizon `DEFAULT_GATEWAY_MAX_ELAPSED_MS` (12h) | `src/gateway/streamRetry.ts:194`, `src/gateway/config.ts:51` | 12h | — | Kept, interactive only. It wraps the operator session's provider registry. Mission workers run on their own `ModelRuntime`, so it never bounds them. |
| Short transient budget (5 min), retry-alternate advice (15 min) | `src/gateway/streamRetry.ts:227`, `:234` | — | — | Kept, interactive advice. In missions, retry-alternate advice ends one attempt. The mission retries it and is not failed. |
| After-output retry horizon | `src/gateway/afterOutputRetry.ts:80` | 12h | — | Kept, interactive only. |
| Resilience retry window (12h) | `src/resilience/config.ts:76`, `src/orchestration/scheduler.ts:899` | 12h → PAUSE | — | Kept. Exhaustion **pauses** the mission (not failed) and auto-resume follows. |
| Auto-resume horizon | `src/resilience/config.ts:78` | 24h, then left paused | a | **Unbounded by default.** A paused mission keeps probing and resumes when capacity returns. `PI_GATEWAY_AUTO_RESUME_HORIZON` sets a horizon. |
| Total outage ceiling `max_outage_ms` | `src/resilience/config.ts`, `src/orchestration/scheduler.ts:1082` | 36h → task FAILED | a | **Opt-in** (`PI_GATEWAY_MAX_OUTAGE`). Unset by default. |
| Relaunch cap `max_relaunches` (100) | `src/resilience/config.ts:79`, `src/orchestration/scheduler.ts:1086` | — | — | Kept. A count of relaunches while the probe says the gateway is *healthy* — a failing task, not a wait. |
| Probe request timeout (5s), `request_timeout_ms` (120s) | `src/resilience/probe.ts:78`, `src/resilience/config.ts:81` | — | d | Kept. A per-probe hang guard. |
| InferWeave admission retry `max_elapsed_ms` (15 min), unknown reason (60s), capacity fallback (180s) | `src/inference/admissionConfig.ts:98`, `:111`, `src/inference/admissionContract.ts:80` | — | — | Kept (optional adapter, configurable). An exhausted chain ends one attempt with a transient marker. The mission retries it and is never failed by it. |
| Model unavailable TTL (30 min) | `src/runtime/modelRouting.ts:19` | — | — | Kept. A routing-avoidance TTL, not a limit on work. |

### Supervisor, recovery and leases

| Limit | Where | Before | Class | Decision |
|---|---|---|---|---|
| Recovery decision deadline `decisionTtlMs` | `src/orchestration/recovery.ts:287` | 30 min (36h in the scheduler), then STOP | a | **Opt-in.** `deadline` is `null` by default. Recovery is bounded by attempt counts (mission ceiling, per-fingerprint strategy budget). A scheduler-configured `max_outage_ms` still sets one. |
| Named-wait expiry (EXPIRED_WAIT) | `src/orchestration/supervisor.ts:328` | expired 30 min after the decision | a | A wait without a deadline never expires on a clock. |
| Supervisor STALLED diagnosis | `src/orchestration/supervisor.ts:338`, `src/orchestration/observability/types.ts:294` | 5 min stale *heartbeat* plus no progress, debounced 2 ticks | b | Kept. It needs the broker's 15s heartbeat to be stale for 5 min, so the process is dead or its event loop is wedged. A live, busy worker heartbeats. |
| Mission lease (30s TTL) and CONTROLLER_DISCONNECTED | `src/orchestration/ownership.ts:44`, `src/orchestration/supervisor.ts:309` | renewed only while a worker held authority | c | Kept. **A live controller now renews it for the whole mission** (`src/orchestration/orchestrator.ts:1300`). Gateway waits between dispatches had let it expire and fenced the mission's own next dispatch. |
| Dispatch authority renewal (heartbeat = lease/3) | `src/orchestration/ownership.ts` (`RenewableDispatchAuthority`) | — | c | Kept. |
| Supervisor tick (30s), repair backoff (30s → 30 min) | `src/orchestration/supervisor.ts:102`, `src/orchestration/supervisorBackoff.ts:32` | — | — | Kept. Cadence and spacing, not limits. |
| Autonomous spec stage deadline (5 min) | `src/orchestration/specApproval.ts:720`, `src/orchestration/supervisor.ts:297` | — | c | Kept. A crash-recovery marker for a spec stage. Not wired into production missions (no `orchestrationSpecApproval` host). See residual risks. |
| Spec approval overall deadline (40 min → `SPEC_DEADLINE_EXHAUSTED`) | `src/orchestration/specApproval.ts:723` | 40 min | a | **Opt-in** (`overallDeadlineMs`). Bounded by semantic rounds. |
| Resilience `MissionSupervisor` and watchdog stall thresholds (5 and 10 min) | `src/resilience/watchdog.ts:24`, `src/resilience/MissionSupervisor.ts:351` | — | b | Kept. A library, not wired into the runtime. Already heartbeat-based and never stalls a WAITING mission. |

### Validation, integration and subprocesses

| Limit | Where | Before | Class | Decision |
|---|---|---|---|---|
| Verification stage timeout (300s for package scripts, 600s for cargo, go and pytest) | `src/verify/Verifier.ts:11` (`DEFAULT_STAGE_INACTIVITY_MS`) | total duration, killed mid-suite | d | **Inactivity-based** (`runWithInactivityGuard`). Killed only after 15 min with no output. |
| Git command timeout (120s) | `src/git/GitRepo.ts:221` | — | d | Kept. A short git hang guard (git prints little, so silence is about the same as duration). |
| Roadmap checks (600s), CAV runner (300s), herdr CLI and wait (120s, 300s) | `src/roadmap/checks.ts:75`, `src/cav/runner.ts:53`, `src/runtime/herdr/*` | — | d | Kept. Not on the mission path. |
| Interactive lifecycle pass budget (15 min), specialist (240s), verification (600s), role runner (240s) | `src/lifecycle/policy.ts:227`, `:272`, `:280`, `src/lifecycle/roleRunner.ts:152` | — | — | Kept. The interactive `/engineering` lifecycle, not missions. Role runs go through the executor's now inactivity-based guard. |
| Platform remote workers (10 min task, 30s heartbeat staleness, 30s command), Plannotator decision (5 min) | `src/platform/WorkGraph.ts:22`, `src/platform/ControlPlane.ts:113`, `src/platform/RemoteWorker.ts:61`, `src/platform/Plannotator.ts:233` | — | c/d | Kept. Platform control plane, not the mission orchestrator. |
| Planner/worker gateway chat completion (600s) | `src/plannerWorker/gateway.ts` (`chatCompletion`) | total duration, aborted mid-generation or mid-admission | a | **Removed.** Opt-in via `GatewayConnection.timeoutMs`; otherwise only the caller's signal ends it. |
| Planner/worker catalogue, route-table and route-event probes (5s, 15s), mode-decision catalogue fetch (5s) | `src/plannerWorker/gateway.ts`, `src/plannerWorker/extension.ts` | — | d | Kept. Metadata probes with a static fallback; they bound no work. Contract verification and worker runs have no default limit (`verificationTimeoutMs`, `workerTimeoutMs` are opt-in). |
| Runtime handover bounds: safe-point drain after quiesce (300s), lifecycle calls and handover dispatch wait (120s); update validation subprocesses (`npm ci` 10 min, typecheck/tests 10-30 min, git 2-5 min) | `src/runtime/host/host.ts`, `src/update/validate.ts`, `src/update/gitSource.ts` | — | d | Kept. They bound a reload/update attempt, which then aborts and leaves the running generation (and its missions) untouched. The wait for a safe point itself has no default limit (`PI_ENGINEERING_SAFE_POINT_TIMEOUT_MS` is opt-in). |
| Artifact lock wait, session-control heartbeat, learned body-cap TTL, auto-invoke resubmit window | `src/artifacts/ArtifactStore.ts:41`, `src/sessionControl/SessionControl.ts:13`, `src/request/bodyBudget.ts:141`, `src/orchestration/autoInvoke.ts:33` | — | — | Kept. Locks, cadence and caches. |

## Residual risks

- Tasks persisted **before** this change carry `execution_budget_ms: 1800000`.
  Resuming such a task still applies that budget once. Recovery replacements
  no longer inherit it. New missions have no budget.
- The inference-wait signal is process-wide (`AdmissionController.status()`). A
  genuinely hung worker can live longer than the window while *another* caller
  in the same process waits on the gateway. It is caught once the waiting stops.
- A single tool call that is silent for longer than the inactivity window (one
  hour by default) is treated as hung. Raise `limits.worker_inactivity_ms` for
  such workloads.
- The autonomous spec-stage deadline (5 min) is not renewed by a live stage. It
  is not wired into production missions today. Wiring it needs stage heartbeats.
