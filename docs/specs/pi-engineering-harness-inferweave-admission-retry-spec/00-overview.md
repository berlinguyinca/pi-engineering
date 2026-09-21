# Pi Engineering Harness — InferWeave Admission Retry Specification

Status: Proposed
Target: `pi-engineering-harness`
Primary integration: InferWeave OpenAI-compatible gateway/provider transport

## 1. Problem

InferWeave can reject an otherwise valid inference request with HTTP 429 when capacity is temporarily unavailable. Example:

```json
{
  "active": 4,
  "active_limit": 4,
  "message": "inference admission: queue_timeout",
  "queue_limit": 100,
  "queued": 26,
  "reason": "queue_timeout",
  "request_id": "78a63cfa-5383-4d5e-b7a3-33bc508dfaf5",
  "retry_after_ms": 30000,
  "scope": "agent",
  "type": "inference_admission"
}
```

Today these responses may surface to Pi as repeated errors and eventually terminate a turn after a small fixed retry count. For long-running engineering agents this is undesirable: the cluster is healthy, the request is valid, and the gateway is explicitly asking the client to wait.

## 2. Goal

Teach the Pi Engineering Harness to interpret InferWeave admission responses as scheduler feedback rather than generic failures.

When InferWeave returns a retryable admission response, the harness MUST:

1. Parse the structured error payload.
2. Honor a server-provided retry delay.
3. Wait without blocking cancellation.
4. Keep the current task/turn alive.
5. Retry the same logical inference request.
6. Expose the wait state in the UI/status/telemetry.
7. Retry within bounded time/attempt budgets.
8. Fall back only for reasons/policies that warrant fallback.
9. Fail immediately for permanent/non-retryable errors.

## 3. Design principle

Retry policy MUST be primarily **reason-aware and elapsed-time-aware**, not merely `N attempts`.

A request that waits 30 seconds three times has not necessarily failed; it may simply be waiting for a heavily utilized GPU worker group to become available.

## 4. Placement

The preferred implementation location is the InferWeave-facing provider/transport boundary used by `pi-engineering-harness`, before errors are flattened into generic Pi errors.

Do not implement this by regex-matching terminal text such as `Error: 429 ...` after Pi has already classified the response.

Logical flow:

```text
Pi Engineering Harness
        |
        v
InferWeave provider/transport adapter
        |
        +--> request
        |
        v
InferWeave Gateway
        |
        +--> 2xx/stream --------------------> continue normally
        |
        +--> retryable admission response
               |
               +--> classify reason
               +--> determine delay
               +--> publish wait state
               +--> abortable sleep
               +--> retry same logical request
```

## 5. Scope

Included:

- InferWeave 429 admission responses.
- Retry delay extraction from headers and JSON payloads.
- Retry reason classification.
- Time/attempt budgets.
- Jitter and safety bounds.
- Abort/cancel behavior.
- Structured retry telemetry.
- Console/status-bar visibility.
- Model/provider fallback policy integration.
- Tests and rollout safeguards.

Not included:

- Changing InferWeave's scheduler itself.
- Assigning GPUs statically to models.
- Treating all HTTP 429 responses as retryable.
- Hiding permanent authentication, authorization, quota, malformed request, or policy failures.

## 6. Core acceptance criteria

The feature is complete when all of the following are true:

- A `queue_timeout` with `retry_after_ms=30000` waits approximately 30 seconds and retries without terminating the task.
- The wait is cancellable immediately by the user/agent abort signal.
- A sequence of retryable admission failures can survive beyond three attempts when still inside the configured elapsed-time budget.
- Retry delay is taken from server headers when available and falls back to structured JSON or local backoff.
- The UI shows that the harness is waiting for InferWeave capacity rather than reporting repeated opaque errors.
- Permanent failures are not retried indefinitely.
- Retry events are observable in logs/metrics/traces.
- Existing non-InferWeave providers continue to work unchanged unless explicitly configured to use the same retry policy abstraction.
