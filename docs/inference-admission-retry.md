# InferWeave Admission Retry

The Pi Engineering Harness converts InferWeave admission-control rejections
(`4xx`/`5xx` with a structured `type: "inference_admission"` or
`"inferweave_backpressure"` body) from terminal
inference failures into scheduler-directed wait/retry states. The agent stays
alive while the gateway is busy, waits are abortable, and the UI shows a
waiting-for-capacity state instead of repeated `Error: 429` lines.

The authoritative spec lives at
`docs/specs/pi-engineering-harness-inferweave-admission-retry-spec/`.

## Why this exists

A busy InferWeave node replies `429 queue_timeout` with a
`retry_after_ms: 30000` body. Without this subsystem the harness surfaced the
rejection as an inference error, the agent-level retry policy re-fired the whole
turn, and the wait was never actually honored. This subsystem:

- parses admission responses **structurally** (never by regex on rendered error
  text);
- waits the server-directed duration (or an exponential backoff) instead of
  failing;
- honors both an **attempt limit** and a **cumulative-wait budget**;
- keeps **one logical inference operation** alive across attempts, correlating
  with InferWeave request ids;
- is **abortable immediately** via Pi cancellation (Esc / Ctrl-C / cancel);
- never multiplies retries with the provider transport or the agent layer.

## How it fits together

```
ctx.modelRegistry / ModelRuntime (registered providers)
        │  streamSimple wrapped (installAdmissionRetry)
        ▼
createAdmissionStreamSimple ── per-attempt capture fetch
        │  reads raw status/headers/body before Pi flattens the error
        ▼
executeWithAdmissionRetry ── state machine (READY → REQUESTING → ADMISSION_WAIT
        │  → RETRYING → STREAMING → SUCCEEDED/FAILED/CANCELLED)
        │  publishes inference.retry.* / inference.fallback.* events
        ▼
AdmissionEventBus ──► AdmissionMetrics ──► Prometheus / telemetry JSONL
                  └─► AdmissionStatusController ──► ctx.ui status bar + widget
                  └─► bridgeAdmissionToTelemetry ──► lifecycle telemetry
```

### Provider seam

The harness wraps `ProviderConfigInput.streamSimple` for InferWeave-facing
OpenAI-compatible providers. Both `stream()` and `streamSimple()` route through
it when `model.api === extension.api`, so the harness sees every inference for
that provider. A per-attempt **capture fetch** is injected into the delegate
options so the raw HTTP status, headers, and body are read before pi-ai flattens
them into an `APIError`.

### Retry ownership

- **Admission retries** happen only here. When `own_transport_retries` is on
  (default), the transport forces `maxRetries: 0` and re-issues the admission
  response with `x-should-retry: false`, so pi-ai's transport retry loop backs
  off too.
- **Agent-level retry** is stopped by phrasing the terminal message as
  *"out of admission budget"* — pi-ai's assistant-error classifier treats that
  phrase as a permanent provider limit, so the agent does not re-spend a budget
  that is already gone.
- **Fallback** is left to the existing RoleRouter (separation of duties): the
  harness emits `inference.fallback.triggered` and the model router decides the
  alternate model.

## Admission classification

A response is normalized from a supported type tag at the top level or under
`error`, `detail`, or `detail.error`. New-contract replay requires explicit true
retryable and replay-safe flags, `not_started`/`queued`, a permitted frozen
action code, no committed output, and remaining finite attempt and elapsed
budgets. Explicit false and unknown actions are terminal. Legacy envelopes
without these fields keep conservative compatibility heuristics, except
permanent quota, authentication, authorization, and malformed-request reasons,
which are never replayed.

### Reason taxonomy

| Reason | Action |
| --- | --- |
| `queue_timeout`, `caller_concurrency`, `worker_saturated`, `model_loading` | `retry` |
| `capacity_unavailable` | `retry_then_fallback` (180s) |
| `quota_exhausted` | `fallback` (no wait) |
| `auth_failed`, `forbidden`, `malformed_request` | `fail` (permanent) |
| *unknown* | `retry_if_server_delay_present` (60s budget) |

The **HTTP status outranks the reason token**: `400/401/403/404/409/413/422` always
`fail`, whatever the gateway labelled it.

### Retry timing

All valid `retry-after-ms`, `Retry-After`, and body `retry_after_ms` hints are
considered; the largest is the server minimum. Local exponential backoff is
used only when no valid server hint exists.

Server minima are never clamped downward. Jitter is **positive-only** and must
fit the remaining elapsed budget; otherwise the retry chain stops and preserves
the final server message/code.

The interactive wrapper defaults to 8 attempts and 300000 ms elapsed. Duration
budgets and cooldowns use a monotonic clock; wall time is used only to interpret
HTTP-date retry headers and render countdown deadlines. The duration clock is
injectable for deterministic tests. Model-scoped cooldowns are keyed
by provider/model and do not pause unrelated models; absent scope retains the
legacy process-wide hold.

### Response-header recommendation

InferWeave is encouraged to return the delay in headers as well as the body so
any client can honor it without parsing the JSON:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
retry-after-ms: 30000
Content-Type: application/json

{"type":"inference_admission","reason":"queue_timeout","retry_after_ms":30000}
```

The harness supports both header forms and the body-only form, so it stays
compatible while the header change rolls out independently.

## Configuration

Top-level YAML in the engineering policy under `inference.retry.admission`
(snake_case). Defaults live in
`src/inference/admissionConfig.ts` (`DEFAULT_ADMISSION_RETRY_CONFIG`).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `observe_only` | `false` | Parse + emit events, never wait or change control flow. |
| `max_attempts` | `50` | Attempt cap for one logical inference. |
| `max_elapsed_ms` | `900000` | Monotonic wall-clock budget for one logical inference. |
| `min_delay_ms` / `max_delay_ms` | `500` / `120000` | Delay bounds (ms). |
| `base_backoff_ms` / `max_backoff_ms` | `2000` / `120000` | Backoff (ms). |
| `jitter_ratio` | `0.1` | Positive jitter fraction. |
| `honor_retry_after` | `true` | Honor server-directed delays. |
| `shared_budget_ms` | `0` | Additional per `provider/model` wait cap across logical requests (0 disables). |
| `correlation_headers` | `true` | Send `x-pi-logical-request-id` / `x-pi-attempt`. |
| `own_transport_retries` | `true` | Zero the provider transport retries on attempts. |
| `report_saturation` | `true` | Feed queue/active saturation into the capability registry for routing. |
| `unknown_reason.mode` | `retry_if_server_delay_present` | Behavior for unknown reasons. |
| `reasons.<reason>` | — | Per-reason overrides (`action`, `max_elapsed_ms`, `fallback_after_ms`). |
| `providers.<id>` / `models.<provider/model>` | — | Scope overrides. |
| `wrap_providers` | `[]` | Only wrap these provider ids (empty = all). |

Environment overrides use `PI_HARNESS_ADMISSION_*` (e.g.
`PI_HARNESS_ADMISSION_MAX_ATTEMPTS`, `PI_HARNESS_ADMISSION_OBSERVE_ONLY`,
`PI_HARNESS_ADMISSION_UNKNOWN_REASON_MODE`, `PI_HARNESS_ADMISSION_WRAP_PROVIDERS`).

## Events and metrics

Events (published on `AdmissionEventBus`) carry `logicalRequestId`, `attempt`,
`maxAttempts`, `reason`, `httpStatus`, `retryAfterMs`, `delayUsedMs`,
`delaySource`, `elapsedWaitMs`, queue/active depth+limit, `serverRequestId`,
`sessionId`, `agentId`, `role`, `workerId`, and `runId`.

| Event | Meaning |
| --- | --- |
| `inference.retry.started` | An attempt began (including the first). |
| `inference.retry.scheduled` | A wait was scheduled. |
| `inference.retry.waiting` | The wait is in progress. |
| `inference.retry.succeeded` | A logical inference succeeded. |
| `inference.retry.exhausted` | The budget/attempt limit was reached. |
| `inference.retry.cancelled` | The operator/scheduler cancelled the wait. |
| `inference.fallback.triggered` | Handed to model routing (quota/`retry_then_fallback`/`budget_ledger`). |

Metrics aggregate under `pi_harness_inference_admission_*`
(`..._retries_total`, `..._wait_seconds_total`, `..._success_after_retry_total`,
`..._exhausted_total`, `..._fallback_total`, `..._cancelled_total`, and the
`queue_depth` / `active_workers` gauges).

`/engineering admission` prints a live summary.

## UI

While waiting, the status bar shows
`IW:waiting 30s | q:26/100 | active:4/4 | attempt 3 | waited 30s` and a widget
panel lists the model, reason, active/queue utilization, countdown, attempt and
cumulative wait, ending with *"Waiting for inference capacity... [Esc to cancel]"*.

## Tests

`test/unit/inference-admission-transport.test.ts` provides the deterministic
fake-clock state-machine coverage:

- single 429 then success (honors a 30s wait);
- acceptance: four 30s `queue_timeout` waits then a successful stream (agent
  alive through all waits);
- retry-after precedence and delay resolution;
- attempt and elapsed budgets (`budget_attempts` / `budget_elapsed`), stopping
  rather than shortening a server minimum;
- immediate cancellation (mid-wait and pre-aborted), never reported as an
  InferWeave failure;
- quota→fallback (no wait); 401/403 never waited; unknown reasons;
- stream replay safety; `observe_only`; shared-budget ledger; metrics fields.

The checked-in parser, delay, policy/config, gateway controller, interactive
stream retry, installer, and status suites cover both retry paths. Integration
coverage includes the real provider registry, extension event wiring, and the
`node:http` fake-InferWeave endpoint.

## Troubleshooting

- **I see a wait but no progress.** The wait is abortable; press Esc / send a
  cancellation. It is never silently skipped.
- **`quota_exhausted` still fails.** That is by design: quota is a permanent
  condition, so it goes to fallback/terminal, never a wait.
- **Permanent failures loop.** They don't: `400/401/403/404/409/413/422` always `fail`
  immediately.
- **A wait ran long.** `max_elapsed_ms` and `max_attempts` bound a single
  logical operation; `shared_budget_ms` bounds it across re-entrant operations
  per provider/model.

### Distinguishing the four outcomes

- **Queue wait** (`queue_timeout`, `caller_concurrency`, `worker_saturated`,
  `model_loading`) — transient; retried with the server delay.
- **Quota exhaustion** (`quota_exhausted`) — permanent for this budget; routed
  to fallback, not waited.
- **Provider failure** — a non-admission error body; passed through untouched,
  never reclassified.
- **Auth/authorization failure** (`auth_failed`, `forbidden`, 401/403) —
  permanent; fails immediately, no wait.
