# UI, Status, and Telemetry

## 1. User-facing behavior

Retryable admission control MUST NOT spam the console with repeated red `Error: 429` messages.

Instead display a stable/updating wait state, for example:

```text
InferWeave capacity busy

  Model:       Qwen 3.8 27B
  Reason:      queue_timeout
  Active:      4 / 4
  Queue:       26 / 100
  Retry in:    30s
  Attempt:     3
  Waited:      1m 02s

Waiting for inference capacity...  [Esc to cancel]
```

The actual UI SHOULD integrate with the harness's current renderer rather than printing a new block for every countdown update.

## 2. Status bar integration

Expose compact state suitable for the Pi Engineering Harness status bar, e.g.:

```text
IW:waiting 30s | q:26/100 | active:4/4
```

Do not displace higher-priority status information unnecessarily. This state can replace normal token-throughput state while no inference is actively streaming.

## 3. Events

Publish structured lifecycle events:

```text
inference.retry.scheduled
inference.retry.waiting
inference.retry.started
inference.retry.succeeded
inference.retry.exhausted
inference.retry.cancelled
inference.fallback.triggered
```

Suggested fields:

```json
{
  "provider": "inferweave",
  "model": "...",
  "logical_request_id": "...",
  "server_request_id": "...",
  "reason": "queue_timeout",
  "http_status": 429,
  "attempt": 3,
  "delay_ms": 30000,
  "elapsed_ms": 62000,
  "active": 4,
  "active_limit": 4,
  "queued": 26,
  "queue_limit": 100
}
```

## 4. Metrics

At minimum collect:

- retry count by provider/model/reason,
- cumulative admission wait time,
- admission retry success rate,
- exhausted retry count,
- fallback-after-admission count,
- cancellation while waiting,
- histogram of server-requested retry delays,
- queue/active saturation values when supplied.

Suggested metrics:

```text
pi_harness_inference_admission_retries_total
pi_harness_inference_admission_wait_seconds
pi_harness_inference_admission_exhausted_total
pi_harness_inference_admission_fallback_total
pi_harness_inference_admission_cancelled_total
```

## 5. Logging

Normal retry waits SHOULD log at info/debug level, not error level.

The final exhausted condition may be logged as warning/error depending on whether fallback succeeds.

Logs MUST preserve InferWeave's `request_id` to correlate client and gateway traces.
