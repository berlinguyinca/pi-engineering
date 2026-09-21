# 03 — Dynamic Admission and Context Leases

## Objective

Replace fixed full-window reservations (for example, always holding ~260K units) with request-scoped, weighted admission.

This document is the main fix for unnecessary `caller_concurrency` pressure.

## Separate admission dimensions

InferWeave should distinguish:

1. **Caller fairness/concurrency**
   - How many requests from a caller may be actively generating/queued.
   - Counts active requests, not idle sessions.

2. **Request context budget**
   - Prompt + possible output + safety.
   - Weighted by the request's expected resource demand.

3. **Backend runtime capacity**
   - Runtime queue/KV/cache/GPU/load signals.
   - Used for routing/admission.

4. **Affinity/cache lease**
   - Soft state preserved after a request.
   - Does not consume a hard caller-concurrency permit.

## Request reservation

Once InferWeave has authoritative tokenization (or the best runtime-equivalent estimate), compute:

```text
prompt_tokens = tokenized request actually sent to model

requested_output =
    request.max_output_tokens / max_tokens if supplied
    else model.default_output_tokens
    bounded to model.max_output_tokens

base_reservation = prompt_tokens + requested_output

safety_margin =
    max(config.minSafetyTokens,
        ceil(base_reservation * config.safetyRatio))

hard_request_reservation =
    min(model.context_window,
        base_reservation + safety_margin)
```

Recommended initial defaults:

```yaml
admission:
  context:
    safetyRatio: 0.05
    minSafetyTokens: 1024
```

Tune with observed data.

Do not use the theoretical maximum context as the reservation.

## Two-stage accounting

Because exact token count may not be known at the earliest gateway stage:

### Stage A — pre-admission estimate
Use a fast conservative tokenizer/estimate before expensive work.

### Stage B — authoritative correction
After the request is rendered/tokenized by the correct model tokenizer, adjust the reservation.

If the corrected reservation cannot be satisfied:

- queue according to policy, or
- reject with a precise capacity reason.

Never let the reservation silently exceed the model's supported context.

## Weighted permits

If the existing limiter is "slots" or "seats", replace/extend it with weighted units.

Example:

```text
tokenQuantum = 8192

weightedUnits =
    ceil(hard_request_reservation / tokenQuantum)
```

A 20K request consumes far fewer units than a 250K request.

If the backend already exposes a more direct KV/block capacity model, prefer backend-native units over a generic token quantum.

## Caller concurrency

`caller_concurrency` must count only:

- admitted and queued requests that intentionally hold a permit under policy;
- active inference requests.

It must not count:

- a Pi process that is idle;
- a chat/session merely because it exists;
- a soft KV cache lease;
- a session-affinity mapping;
- a finished request.

Provide separate limits:

```yaml
admission:
  caller:
    maxInflightRequests: 8
    maxQueuedRequests: 32
```

Do not encode token capacity into the caller-count dimension.

## Hard reservation lifecycle

A hard request lease is acquired before dispatch and released on every terminal path:

- normal completion;
- model error;
- gateway error;
- cancellation;
- client disconnect;
- deadline exceeded;
- upstream timeout;
- route failure;
- process cleanup/reaper after orphan detection.

Use RAII/defer/finally semantics in implementation.

## Lease watchdog

Every hard reservation has:

- request ID;
- caller ID;
- model ID;
- deployment ID once routed;
- reserved units/tokens;
- acquisition timestamp;
- deadline/heartbeat state.

A watchdog/reaper must release orphaned permits.

Do not rely only on client cleanup.

## Idle session behavior

After a response completes:

- release the hard request reservation immediately;
- keep only lightweight session metadata/affinity;
- optionally retain KV state as a **soft lease** (see next spec).

The next Pi turn reacquires capacity based on its then-current context.

This is crucial: a long-lived Pi session may have a 200K conversation but consumes no active inference reservation while the user/agent is idle.

## Growth-aware optimization

For a continuing session, the next request's prompt can be much larger than the previous one. The gateway therefore reacquires based on the new request, not the previous reservation.

Optional prewarm/predictive reservation may be introduced later, but must be soft and reclaimable.

## Admission errors

Return structured details where compatible:

```json
{
  "error": {
    "type": "inference_admission_error",
    "code": "context_capacity",
    "message": "Request needs approximately 118784 context tokens; current backend capacity is temporarily unavailable.",
    "retryable": true,
    "retry_after_ms": 1250,
    "details": {
      "prompt_tokens": 93210,
      "output_budget_tokens": 16384,
      "reserved_tokens": 115073,
      "model_context_window": 262144
    }
  }
}
```

Differentiate at least:

- `caller_concurrency`
- `caller_queue_full`
- `context_capacity`
- `model_context_exceeded`
- `no_context_capable_backend`
- `backend_saturated`

Pi/harness retry logic can then make better decisions.

## Queue policy

Large requests must not starve small ones indefinitely, and small requests must not permanently starve large ones.

Recommended scheduler:

- weighted fair queue;
- age boost;
- per-caller fairness;
- model/backend-specific capacity.

Track wait time and reserved token-units.

## Cancellation correctness

Tests must prove cancellation releases:

- caller permit;
- token/KV reservation;
- queued state;
- route lease if request-specific.

This is a high-priority regression suite because leaks recreate the original issue over time.
