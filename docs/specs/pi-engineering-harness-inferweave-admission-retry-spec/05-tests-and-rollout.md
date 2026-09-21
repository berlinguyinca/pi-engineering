# Testing and Rollout

## 1. Unit tests

Add table-driven tests for classification:

- `queue_timeout` -> retry
- `caller_concurrency` -> retry
- `worker_saturated` -> retry
- `model_loading` -> retry
- `capacity_unavailable` -> retry/fallback policy
- `quota_exhausted` -> fallback/no wait loop
- 401 -> fail
- 403 -> fail
- malformed 400 -> fail
- unknown reason + server delay -> configurable behavior
- unknown reason without server delay -> conservative failure/default behavior

## 2. Delay parsing tests

Verify precedence and parsing for:

- `retry-after-ms: 30000`
- `Retry-After: 30`
- `Retry-After: <HTTP date>`
- body `retry_after_ms: 30000`
- invalid/negative/NaN values
- values over configured maximum
- no server delay -> exponential backoff

## 3. State-machine tests

Use fake timers where practical.

Required cases:

1. one 429 then success,
2. four 30-second 429s then success,
3. retries exceeding legacy 3-attempt behavior but remaining under elapsed budget,
4. max attempts reached,
5. max elapsed time reached,
6. cancellation during wait,
7. cancellation immediately before retry starts,
8. success resets retry state,
9. no duplicate concurrent retry chains.

## 4. Integration test with fake InferWeave server

Implement a deterministic test server sequence such as:

```text
request 1 -> 429 queue_timeout retry_after_ms=50
request 2 -> 429 queue_timeout retry_after_ms=50
request 3 -> 200 streaming response
```

Assert:

- the same logical invocation survives,
- exactly 3 HTTP attempts occur,
- delay is honored within tolerance,
- wait telemetry is published,
- the final content is returned once,
- no terminal error is presented for attempts 1 and 2.

## 5. Real-gateway validation

Against a development InferWeave gateway, deliberately constrain admission concurrency and generate enough requests to trigger:

- `caller_concurrency`
- `queue_timeout`

Confirm the Pi Engineering Harness waits, resumes, and remains cancellable.

## 6. Stream safety tests

Verify no automatic full replay after user-visible tokens have already been committed unless the existing provider layer explicitly guarantees safe stream resume.

## 7. Feature flag rollout

Recommended staged rollout:

1. implement classifier + telemetry in observe-only mode,
2. enable retries for `queue_timeout`,
3. enable `caller_concurrency`,
4. enable remaining transient admission reasons,
5. activate reason-specific fallback,
6. make admission policy default-on for InferWeave.

## 8. Regression requirements

Run existing Pi Engineering Harness tests plus provider/inference tests.

Verify:

- non-InferWeave OpenAI-compatible endpoints are not accidentally classified as InferWeave admission responses,
- Ctrl-C/Esc behavior remains responsive,
- agent orchestration does not mark waiting agents failed,
- subagents remain visible to parent orchestration while waiting,
- retry waits do not consume active inference/token accounting as if tokens were streaming.
