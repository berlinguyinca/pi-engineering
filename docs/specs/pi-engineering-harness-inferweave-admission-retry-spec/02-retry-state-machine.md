# Retry State Machine

## 1. Required states

Recommended internal states:

```text
READY
  |
  v
REQUESTING
  | success
  +------------------------------> READY/STREAMING
  |
  | retryable admission
  v
ADMISSION_WAIT
  | delay complete
  v
RETRYING
  |
  +------------------------------> REQUESTING

Any state --abort--> CANCELLED
Any state --permanent failure/budget exhausted--> FAILED
```

The implementation may use existing Pi/harness state machinery, but equivalent semantics MUST be observable.

## 2. Logical request identity

Retries MUST preserve a logical request identity separate from individual HTTP attempt IDs.

Track at least:

```ts
interface RetryContext {
  logicalRequestId: string;
  attempt: number;
  firstAttemptAt: number;
  elapsedMs: number;
  cumulativeWaitMs: number;
  lastReason?: string;
  lastServerRequestId?: string;
  lastDelayMs?: number;
}
```

This allows one agent turn to be traced across multiple InferWeave request IDs.

## 3. Retry budget

Use both:

- `maxAttempts`
- `maxElapsedMs`

Whichever limit is reached first terminates local retries.

Recommended defaults for engineering-agent workloads:

```yaml
maxAttempts: 50
maxElapsedMs: 900000   # 15 minutes
```

These SHOULD be configurable globally and overrideable per provider/model/reason.

## 4. Delay calculation

Pseudo-code:

```ts
const serverDelay = parseServerRetryDelay(response);
const backoffDelay = exponentialBackoff(attempt, baseDelayMs, maxBackoffMs);

let delay = serverDelay ?? backoffDelay;
delay = clamp(delay, minDelayMs, maxDelayMs);
delay = addBoundedJitter(delay, jitterRatio);
```

When InferWeave explicitly supplies a delay, jitter MUST remain small so the client respects scheduler intent while avoiding a thundering herd.

Recommended jitter: 0–10% positive jitter for server-directed admission retries.

## 5. Abortable wait

Waiting MUST use the same cancellation/abort signal that controls the active Pi task.

Requirements:

- `Esc`/cancel aborts sleep immediately.
- cancellation does not wait for the retry timer to finish.
- no orphan timers remain.
- cancellation does not trigger provider fallback.
- final state reports user/agent cancellation, not InferWeave failure.

## 6. Retryable stream failures

Differentiate failures that occur:

1. before any streamed tokens are emitted,
2. after partial assistant output is emitted.

Initial implementation SHOULD automatically replay admission failures only when no model output has been committed to the turn.

For post-stream interruption, use existing stream-resume/recovery semantics if available. Do not naively replay a full generation and duplicate content.

## 7. Fallback policy

Admission retry and model fallback are distinct mechanisms.

Recommended sequence:

```text
preferred model
    |
    +--> retryable admission
            |
            +--> wait/retry within admission policy
            |
            +--> success -> continue
            |
            +--> fallback threshold/budget reached
                    |
                    +--> if reason permits fallback
                            choose eligible alternate model/provider
```

`queue_timeout` and `caller_concurrency` SHOULD generally remain on the selected model while inside their wait budget.

`capacity_unavailable` MAY trigger an earlier fallback according to routing policy.

`quota_exhausted` SHOULD skip long local retry waits and enter existing provider/model fallback logic immediately.

Any fallback MUST continue to honor the engineering harness separation-of-duties/model-role constraints already in place.

## 8. No retry storms

The harness MUST NOT create parallel retries for the same logical request.

Exactly one retry timer/request chain may exist per logical inference invocation unless the orchestration layer explicitly implements hedged requests as a separate feature.
