# Implementation Checklist

## Discovery

- [ ] Locate the current InferWeave/OpenAI-compatible request transport used by the Pi Engineering Harness.
- [ ] Locate current Pi/provider retry logic and document ownership to avoid retry multiplication.
- [ ] Locate task abort/cancellation signal propagation.
- [ ] Locate status renderer and structured event/telemetry facilities.
- [ ] Locate model/provider fallback entry point.

## Core implementation

- [ ] Add typed InferWeave admission error parser.
- [ ] Add retry-delay parser with header/body precedence.
- [ ] Add reason classifier/policy resolver.
- [ ] Add elapsed-time + attempt retry budget.
- [ ] Add bounded jitter.
- [ ] Add abortable wait primitive using existing cancellation signal.
- [ ] Preserve logical request identity across attempts.
- [ ] Ensure only one retry chain exists per logical inference call.
- [ ] Preserve original server request IDs in diagnostics.

## Fallback

- [ ] Route `quota_exhausted` directly to eligible fallback behavior.
- [ ] Support `retry_then_fallback` for selected reasons.
- [ ] Preserve existing role/separation-of-duties constraints when selecting fallback models.

## UI/telemetry

- [ ] Replace repeated transient 429 error spam with a waiting state.
- [ ] Show reason, delay, attempt, elapsed wait, queue and active utilization when available.
- [ ] Add status-bar representation.
- [ ] Add structured retry lifecycle events.
- [ ] Add retry metrics/logging.

## Tests

- [ ] Unit tests for classifier.
- [ ] Unit tests for delay parsing.
- [ ] Fake-timer state-machine tests.
- [ ] Fake InferWeave server integration tests.
- [ ] Cancellation tests.
- [ ] Stream replay safety tests.
- [ ] Non-InferWeave regression tests.

## Documentation

- [ ] Document configuration and defaults.
- [ ] Document InferWeave response-header recommendation.
- [ ] Add troubleshooting section for admission wait behavior.
- [ ] Explain distinction between queue wait, quota exhaustion, provider failure, and auth failure.

## Definition of done

- [ ] A request can receive more than three transient InferWeave admission 429s and still succeed without terminating the agent task.
- [ ] Server-provided 30-second waits are honored.
- [ ] Waits can be cancelled immediately.
- [ ] Permanent failures do not loop.
- [ ] User sees a clear waiting-for-capacity state.
- [ ] Tests pass and implementation is ready for production rollout.
