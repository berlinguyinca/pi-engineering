# ERROR_SOURCES — every error path the pi harness has today

E01 inventory, read-only. Every row cites the emitting site as `file:line` at result SHA
`36cab891c696ff709d09fb2c4066186e5201c5d9`, names the single owner of that event, and classifies
what is already emitted versus missing. Nothing here is implementation — E02+ consumes the `S`/`X`
rows. Sites were located by grepping `kind:`/`type:` emissions, `catch`, `throw`, `append`,
`stderr` and exit/abort handling across the five named subsystems and the host entry point.

**Status legend** — `D` durable (appended to `events/<session>.jsonl`) · `E` thrown to the caller ·
`T` transient (callback or telemetry bus only) · `S` swallowed by a handler · `X` no handler exists.

## 1. Durable event store — owner `src/runtime/isolation/SessionEventStore.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Torn tail found while reading a stream | `SessionEventStore.ts:183` (`kind: "torn_tail"`) | SessionEventStore (reader) | **D** |
| Malformed lines skipped while reading | `SessionEventStore.ts:212` (`malformed_lines_skipped`) | SessionEventStore (reader) | **D** |
| `append` called after `close()` | `SessionEventStore.ts:283` | caller of `append` | **E** |
| Writer superseded by a newer session writer | `SessionEventStore.ts:288` | SessionEventStore (ownership) | **E** |
| Own-stream append fails (ENOSPC, EACCES, EIO) | `SessionEventStore.ts:295-300` (`appendChain = op.catch(() => undefined)`), same at `:336` for `appendAll` | SessionEventStore (chain) | **S** |

## 2. Supervisor (APS) — owner `src/aps/supervisor.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Loop candidate observed | `aps/supervisor.ts:288` (`agent.loop_candidate`), appended at `:262` | APS supervisor | **D** |
| Loop prevented | `aps/supervisor.ts:278` (`agent.loop_prevented`), appended at `:199` | APS supervisor | **D** |
| Supervisor's own event append fails | `aps/supervisor.ts:200` and `:263` (empty `catch`) | APS supervisor | **S** |
| Probe of a watched process fails | `aps/supervisor.ts:189` and `:194` (empty `catch`) | APS supervisor | **S** |
| Watched process exit code | `aps/supervisor.ts:215` — `exit_code: null` is hardcoded | APS supervisor | **X** |
| Other internal failures | `aps/supervisor.ts:225`, `:252`, `:257` (empty `catch`) | APS supervisor | **S** |

## 3. Incidents — owner `src/incidents/IncidentController.ts`, sink `AutoSpecIncidentSink.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Incident committed (deduped append) | `IncidentController.ts:77` (`appendConditionally`) | IncidentController | **D** |
| Duplicate incident | `IncidentController.ts:8` (`IncidentState` = `duplicate`) | IncidentController | **T** |
| Deduplication lost the race | `IncidentController.ts:83` (throw) | caller of `record` | **E** |
| Incident published | `IncidentController.ts:98` (`append`) | IncidentController | **D** |
| Sink publish failed | `IncidentController.ts:115` `catch` → `:116` append (`publish_failed`) | IncidentController | **D** |
| Sink child returned invalid JSON or a bad ack | `AutoSpecIncidentSink.ts:47-49`, `:59` (throw) | AutoSpecIncidentSink | **E** |
| Sink temp event directory cleanup | `AutoSpecIncidentSink.ts:60-61` (`.catch(() => undefined)`) | AutoSpecIncidentSink | **S** |

## 4. Retry trace — owner = the acting layer; carrier `src/inference/retryTrace.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Trace entry for one failed request | `inference/retryTrace.ts:112` (`emit("inference.retry.trace", …)`) | the layer recorded as `owner` (`:40`) | **T** |
| Trace transport contract | `inference/retryTrace.ts:10-11` (`details.retry_trace` + telemetry bus) | RetryTrace (data only) | **T** |
| Retry lifecycle states | `lifecycle/telemetry.ts:27-34` (`scheduled|waiting|started|succeeded|exhausted|cancelled`) | lifecycle telemetry | **T** |
| In-call replay ladder / fallback model | `inference/resilientStream.ts:378` (`kind: "fallback"`) | resilient-stream | **T** |
| Compact-and-retry recovery attempt | `inference/recovery.ts:160` (`compact_and_retry`) | recovery layer | **T** |
| Gateway capacity hold reason | `workers/PiWorkerExecutor.ts:910`, `:1493` (`${status}:${reason|code|type|"refused"}`) | worker-gateway-hold | **T** |
| Model takeover / scheduler relaunch window | `inference/retryTrace.ts:21-22` (layers `model-takeover`, `scheduler-window`) | realBackends / broker scheduler | **T** |

## 5. Worker result & activity — owner `src/workers/PiWorkerExecutor.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Activity: waiting for inference / stream stalled | `PiWorkerExecutor.ts:921`, `:1808` (`emitWorkerActivity … kind: "state"`) | PiWorkerExecutor → `req.onActivity` | **T** |
| Activity observer itself throws | `workers/activity.ts:476-479` (empty `catch`, documented as intentional) | worker activity feed | **S** |
| Transcript of session / message / tool_call / tool | `PiWorkerExecutor.ts:1826`, `:1845`, `:1856`, `:1863` (`transcript.write`) | `workers/transcriptStore.ts:105` `TranscriptWriter` | **D** |
| Transcript writer could not be created | `PiWorkerExecutor.ts:1770-1771` (`catch` → `transcript = undefined`): capture silently off | PiWorkerExecutor | **S** |
| Worktree/branch identity mismatch | `PiWorkerExecutor.ts:531`, `:536` (throw) caught at `:539` | PiWorkerExecutor (identity guard) | **E** |
| Provider connection refused / rethrow | `PiWorkerExecutor.ts:1067` (`ConnectRefusedError`) → `:1069` | worker-transient-retry | **E** |
| Transient failure on a non-throwing path | `PiWorkerExecutor.ts:1403-1404` (marker mirrors the thrown path) | worker-transient-retry | **T** |
| Fire-and-forget setup failures | `PiWorkerExecutor.ts:455` (`wireResilience`), `:492` (`registerLocalProviders`), `:1764` (`steer`) — all `.catch(() => {})` | PiWorkerExecutor | **S** |

## 6. Execution evidence & process exits — owner `src/orchestration/broker.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Verify command exit code captured | `orchestration/broker.ts:197` (`exitCode` in the evidence type) | broker (execution evidence) | **D** |
| Command outcome mapping | `broker.ts:1088` (`passed|failed|skipped` from `exitCode === 0`) | broker | **D** |
| Validation gate on exit code | `broker.ts:2943` | broker (gate) | **D** |
| Timeout / inactivity / cancel reason | `broker.ts:468-469` (`clockAbort`), `:3543` (`timedOut`), `:3676` (`canceled`) | broker (execution clock) | **D** |
| Process quarantine request fails | `broker.ts:1436` (`.catch(() => undefined)`) | broker (quarantine) | **S** |

## 7. Host & process level — owner `src/runtime/host/entry.ts`

| Event | Exact site | Owner | Status |
| --- | --- | --- | --- |
| Runtime load / fallback diagnostics | `runtime/host/entry.ts:132`, `:140`, `:148`, `:156` (`process.stderr.write`) | host entry | **T** |
| Subprocess `{code, stdout, stderr}` | `runtime/host/sourceWatch.ts:265` | the sourceWatch caller | **T** |
| Uncaught exception | **no `process.on("uncaughtException")` anywhere in `src`** (repo-wide grep) | nobody | **X** |
| Unhandled rejection | **no `process.on("unhandledRejection")` anywhere in `src`** | nobody | **X** |
| Exit-time handling | `verify/Verifier.ts:59`, `runtime/herdr/portableLock.ts:84` (`process.on("exit")` cleanup only, no error flush) | those two modules | **X** |

## What is emitted today, and what E02 must add

- **Durable (`D`, 11 rows):** only the session store's own read diagnostics, APS loop events, the incident
  lifecycle, the worker transcript, and broker execution evidence. Every other failure reaches a callback or
  the telemetry bus and dies with the turn.
- **Swallowed (`S`, 10 groups):** the dangerous class — `SessionEventStore.ts:300`/`:336` and `aps/supervisor.ts:200`/`:263`
  mean the failure log itself can fail silently, and `PiWorkerExecutor.ts:1771` disables transcript capture without a word.
- **Absent (`X`, 3 rows):** process-level crash handlers, the watched exit code (`exit_code: null`), exit-time flush.
- Consequence: an error can be real, kill a worker, and leave no durable record. E02 must add crash/exit capture plus a
  self-diagnostic path for store failures; E03+ must move the `T` rows onto a durable envelope, keeping the single owner
  named in each row above.
