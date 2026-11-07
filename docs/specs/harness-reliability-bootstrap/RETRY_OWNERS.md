# RETRY_OWNERS — retry ownership by failure class

Catalogs **current** ownership as of base commit `3bb21ab2e4b4434f01f01d93770ff4a131f176e9`: for
each failure class, who decides to send the failed request again and under what bound. It proposes
exactly one owner per class going forward and changes no code. Every row cites a `path:line` that
was opened at base; `inferred` marks the few claims that come from reading a code path rather than
a constant, and `unknown` marks what was not found.

## Ownership table

| Failure class | Current owner (module + `path:line`) | Current limit | Who decides the retry | Proposed single owner | Notes |
| --- | --- | --- | --- | --- | --- |
| **429** | `gateway/signals.ts` `parseGatewayWait` `src/gateway/signals.ts:361` + `decideGatewayRetry` `:728`, consumed at `src/workers/PiWorkerExecutor.ts:1211` | config key `maxRetries: 8` `src/gateway/config.ts:69` (`PI_GATEWAY_MAX_RETRIES` `:142`); mission workers replace the ceiling with `Number.POSITIVE_INFINITY` `PiWorkerExecutor.ts:809` | the worker-executor loop, from the gateway signal | `inference/admissionConfig.ts` + `admissionTransport.ts`, which already hold a per-reason policy (`admissionConfig.ts:94`, loop `admissionTransport.ts:730`) | Three more sites decide 429 today (conflict 1) |
| **404** | `inference/failureClassifier.ts:482` (`model_not_found`) → `inference/recovery.ts:264` `refresh_and_fail` | one resync retry: `maxRetries: 1` `src/guard/transient.ts:127`; GitHub lineage requires 3 confirmations `src/github/reconcile.ts:52` | inference layer for model calls; each non-LLM client decides for itself | `inference/recovery.ts` for provider 404; non-LLM 404s stay with their own reader | One status, three meanings: model absence `failureClassifier.ts:482`, hidden/absent node `runtime/herdr/graphClient.ts:140`, terminal rejection `runtime/herdr/ControlPlaneIngest.ts:286` |
| **400** | No retry owner. `resilience/classify.ts:153` returns `retryable: false`; `guard/transient.ts:136` maps `invalid_request` → `permanent` | `none` | nobody — it fails fast (`inference/failureClassifier.ts:384` → `inference/recovery.ts:289`) | `inference/recovery.ts` `fail` branch, with the single 400 exception folded into it | One 400 **is** retried: unknown-model wording gets `maxRetries: 1` (`guard/transient.ts:283`, `failureClassifier.ts:488`). `inferred`: a bare 400 with no such wording falls through `classifyError` to `transient.ts:391` (`permanent`) — no 400 branch exists between `:172` and `:391` |
| **5xx** | `guard/transient.ts:325` (`server_unavailable`) / `:330` (`server_error`) inside `withTransientRetry` (`:551`); the in-call ladder `inference/recovery.ts:240` `wait_gateway_retry` | `maxAttempts: 4` `guard/transient.ts:467`; `streamRetryMaxAttempts: 4` `inference/resilienceConfig.ts:74` (`retryPolicy.ts:100`); ingest dead-letters after 5 `runtime/herdr/ControlPlaneIngest.ts:197`, `:279` | the worker loop for thrown failures; the inference ladder for in-call failures | `inference/recovery.ts` — the model-vs-account scope rule it needs already exists at `gateway/signals.ts:689` | `gateway/streamRetry.ts:7-9` states Pi's own `retryAssistantCall` retries an errored assistant message 3× for interactive turns — read from that comment; the external package was not opened |
| **network timeout** | `guard/transient.ts:358` (network) / `:362` (timeout), loop `withTransientRetry` `:551`; in-call `inference/failureClassifier.ts:536` → `retry_same_model` `:335` | `maxAttempts: 4` `guard/transient.ts:467`; `DEFAULT_STREAM_RESUME_MAX = 3` `inference/streamResume.ts:52`; unpinned gate roles capped to 2 `PiWorkerExecutor.ts:2336` | the worker loop owns 5xx/network/timeout replays, stated at `PiWorkerExecutor.ts:999` | `guard/transient.ts` — it already owns both the classification and the loop | Deadlines are set elsewhere: `request_timeout_ms: 120_000` / `connect_timeout_ms: 10_000` `resilience/config.ts:92-93`. `verify/Verifier.ts:40` (`15 * 60_000`) is a hang guard, not a retry |
| **missing `worker_result`** | `workers/PiWorkerExecutor.ts` names it `:1427` and decides retryability by re-classifying the last error `:1428-1442` or throwing `TransientError` `:2189`, `:2201` | zero-tool cap 20 `resilience/config.ts:90`, applied `orchestration/scheduler.ts:952`; task `max_attempts` default 3 `orchestration/missionStore.ts:1686`, applied `orchestration/scheduler.ts:1109` | the worker decides retryable/not; the scheduler decides whether to re-dispatch | `orchestration/scheduler.ts` owns the re-run budget; the worker only tags the class | A silent stream death is deliberately made retryable rather than permanent (`PiWorkerExecutor.ts:2165-2191`) |
| **tool error** | No pi-eng retry owner; only bounds: `MAX_UNKNOWN_TOOL_CALLS = 3` `PiWorkerExecutor.ts:180` (abort `:1914`), `tool_loop_limit: 3` `lifecycle/policy.ts:294` read at `PiWorkerExecutor.ts:1666` | 3 consecutive unknown-tool calls; 3 identical repeated calls; verify-stage cap `DEFAULT_MAX_ATTEMPTS = 2` `verify/targetedRetry.ts:44` | the model is simply re-prompted by the pi agent loop; pi-eng only stops the loop | `workers/PiWorkerExecutor.ts` as the single bound owner — automatic retry of a failed tool result stays off | `PiWorkerExecutor.ts:1813` only *labels* an `isError` tool result for the transcript. Whether Pi's own loop retries anything here: `unknown` (external package, not opened) |

## Unresolved conflicts

1. **429 has four decision points, not one.** `gateway/signals.ts:81` (`WAIT_STATUSES`) and `:728`
   decide the worker hold; `guard/transient.ts:240` classifies 429 as retryable `rate_limit` under
   `maxAttempts: 4`; `inference/admissionConfig.ts:97` (`max_attempts: 50`) drives its own loop at
   `admissionTransport.ts:730`; `runtime/herdr/ControlPlaneIngest.ts:271` backs off the ingest
   outbox; `resilience/classify.ts:176` maps it to `RATE_LIMITED` → `WAITING_FOR_CAPACITY` (`:30`).
   These are three *scopes* (provider call, ingest queue, mission state) but four *owners*. To
   consolidate: the admission layer decides provider 429 once, `transient.ts` stops classifying it
   (it already defers a body-advertised refusal at `transient.ts:210`), and the scheduler keeps only
   the state mapping. `resilience/classify.ts:52` also lists 429 in `TRANSIENT_STATUSES`, which
   `:176` shadows.
2. **5xx is retried at two layers of one worker attempt.** `withTransientRetry`
   (`guard/transient.ts:551`) and the in-call ladder (`inference/recovery.ts:240`) both wait and
   resend. The boundary is declared, not owned: `PiWorkerExecutor.ts:999-1001` passes
   `transientRetryOwner: "worker-transient-retry"` (`inference/resilientStream.ts:193`) so the
   ladder settles instead of replaying. Consolidation = one module holds the 5xx budget.
3. **`gateway/signals.ts:81` and `guard/transient.ts:325` disagree on 503.** `isAccountWideRefusal`
   (`signals.ts:689`) says a 5xx is about one model and must not park the process; `transient.ts`
   owns the retry for the same status. Both are right about different scopes and nothing records
   which one wins for a given call.
4. **404 count is decided twice.** `guard/transient.ts:127` grants `maxRetries: 1`;
   `inference/recovery.ts:263-268` says refresh the catalog once, then fail. Whichever runs first
   ends it; no single owner states "one 404 retry".
5. **`worker_result` retries do not consume the attempt budget.** The zero-tool path decrements the
   local attempt counter (`orchestration/scheduler.ts:973`, comment `:972`), so
   `max_attempts` (`missionStore.ts:1686`) never applies to it; the real bound is
   `max_zero_tool_retries` (`orchestration/scheduler.ts:952`). Two budgets, one failure class.
6. **Classes with no owner today:** `400` (fails fast everywhere except the unknown-model wording)
   and tool errors (nothing retries; only `MAX_UNKNOWN_TOOL_CALLS` and `tool_loop_limit` stop a
   loop). Stated explicitly rather than assigned an owner that does not exist.

## Adjacent budgets on the same classes (located, not counted as owners above)

- Model routing re-picks a model up to 3×: `MAX_ROUTING_ATTEMPTS = 3` `lifecycle/roleRunner.ts:71`
  (applied `:88`) — a routing-level second opinion on the same 5xx/404 the layers above saw.
- Model fallback arms after 3 gateway holds: `FALLBACK_AFTER_HOLDS = 3` `gateway/fallbackLifecycle.ts:31`.
- Liveness probes back off instead of retrying: `DEFAULT_HEALTH_ERROR_BACKOFF_MS = 60_000`
  `models/health.ts:48`, applied `models/health.ts:115`.
- Contract-level attempt ladder: `max_local_attempts: 2` `plannerWorker/types.ts:199`, decided
  `plannerWorker/convergence.ts:182`; one escalation per run `aps/escalation.ts:34`.
- Source hot-reload retry pacing `30_000` → `5 * 60_000` `runtime/host/sourceWatch.ts:27-28`
  (applied `:104`); snapshot publish `SNAPSHOT_PUBLISH_MAX_RETRIES = 4`
  `runtime/EngineeringRuntime.ts:200`. Neither is provider-facing.

## Method

- Read the cited regions of: `resilience/classify.ts`, `resilience/config.ts`,
  `guard/transient.ts`, `gateway/signals.ts`, `gateway/config.ts`, `gateway/streamRetry.ts`,
  `gateway/fallbackLifecycle.ts`, `gateway/afterOutputRetry.ts`, `inference/failureClassifier.ts`,
  `inference/recovery.ts`, `inference/retryDelay.ts`, `inference/retryPolicy.ts`,
  `inference/resilienceConfig.ts`, `inference/admissionConfig.ts`, `inference/admissionTransport.ts`,
  `inference/resilientStream.ts`, `inference/streamResume.ts`, `workers/PiWorkerExecutor.ts`,
  `orchestration/scheduler.ts`, `plannerWorker/executor.ts`, `plannerWorker/convergence.ts`,
  `aps/escalation.ts`, `verify/Verifier.ts`, `verify/targetedRetry.ts`, `lifecycle/roleRunner.ts`,
  `lifecycle/policy.ts`, `models/health.ts`, `models/refresh.ts`, `runtime/EngineeringRuntime.ts`,
  `runtime/host/sourceWatch.ts`, `runtime/herdr/ControlPlaneIngest.ts`, `runtime/herdr/graphClient.ts`,
  `github/reconcile.ts`, `orchestration/missionStore.ts`.
- Greps used: status literals (`429`, `404`, `400`, `status >= 500`) and `retry|backoff|maxRetries|
  max_attempts|Retry-After` across `src/`; symbol listings per file; consumer searches for
  `decideGatewayRetry`, `classifyInfraError`, `resolveTransientRetryConfig`, `max_attempts`.
- Constants were cited from the declaration line, never from prose; values that come from config are
  cited as the config key plus its default line (e.g. `gateway/config.ts:69`, `admissionConfig.ts:97`).
- **No source file was modified.** This document is the only file written; `git diff --check` is the
  only verify command run.
