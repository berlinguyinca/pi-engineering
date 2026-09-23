# Admission Error Contract

## 1. Structured response

The harness SHOULD recognize InferWeave admission responses matching:

```ts
interface InferWeaveAdmissionError {
  type: "inference_admission" | "inferweave_backpressure";
  code?: string;
  reason: string;
  message?: string;
  scope?: "request" | "model" | "caller" | "global" | string;
  retryable?: boolean;
  replay_safe?: boolean;
  request_state?: "not_started" | "queued" | "dispatched" | "streaming" | "unknown";
  action?: string;
  action_code?: string;
  request_id?: string;
  retry_after_ms?: number;

  active?: number;
  active_limit?: number;
  queued?: number;
  queue_limit?: number;

  [key: string]: unknown;
}
```

Recognition requires either supported type tag and accepts top-level, `error`,
`detail`, and `detail.error` envelopes. New-contract automatic replay requires
explicit `retryable=true`, `replay_safe=true`, request state `not_started` or
`queued`, and action code `IW-ACT-BACKOFF`, `IW-ACT-REDUCE-CONCURRENCY`, or
`IW-ACT-RETRY-ALTERNATE`. Explicit false always wins. Legacy envelopes without
the new fields retain the conservative compatibility heuristics.

## 2. HTTP status

Primary status is expected to be HTTP 429.

The policy abstraction SHOULD permit future InferWeave scheduler states to use another transient status (for example 503) without redesigning the harness.

## 3. Retry delay resolution

Parse `retry-after-ms`, standard `Retry-After`, and body `retry_after_ms`. The
largest valid server value is the minimum wait. Use local exponential backoff
only when no valid server hint exists.

`Retry-After` MUST support both forms defined by HTTP semantics:

- integer seconds
- HTTP date

Server-provided values are validated but never clamped downward. If the minimum
cannot fit the remaining elapsed budget, stop and surface the final server
failure rather than retry early.

## 4. InferWeave gateway recommendation

InferWeave SHOULD return both machine-readable headers and the JSON field:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 30
retry-after-ms: 30000
```

and:

```json
{
  "type": "inference_admission",
  "reason": "queue_timeout",
  "retry_after_ms": 30000,
  "scope": "agent"
}
```

The harness MUST remain compatible with the current body-only form so the client-side feature can roll out independently of the gateway header change.

## 5. Initial reason taxonomy

The harness MUST support at least:

| Reason | Default action | Notes |
|---|---|---|
| `queue_timeout` | wait + retry | Temporary queue wait expired |
| `caller_concurrency` | wait + retry | Caller already consumes allowed active concurrency |
| `worker_saturated` | wait + retry | No worker capacity at the moment |
| `model_loading` | wait + retry | Model activation/residency in progress |
| `capacity_unavailable` | retry, then policy fallback | May justify alternate eligible model/provider after budget/threshold |
| `quota_exhausted` | no local wait loop; fallback/fail | Capacity is not expected to recover promptly for this caller |
| `auth_failed` / 401 | fail immediately | Permanent until credentials change |
| `forbidden` / 403 | fail immediately | Permanent authorization/policy failure |
| malformed request / 400 | fail immediately | Client bug/request issue |

Unknown admission reasons MUST follow a configurable conservative default. Recommended default: retry only when the HTTP status is transient and a valid server retry delay is supplied; otherwise fail rather than loop indefinitely.

## 6. Error preservation

Every final failure MUST retain:

- original HTTP status,
- InferWeave `reason`,
- server `message`, `code`, and `action_code`,
- original `request_id`,
- number of attempts,
- elapsed retry time,
- last requested delay,
- whether fallback was attempted,
- final failure classification.
