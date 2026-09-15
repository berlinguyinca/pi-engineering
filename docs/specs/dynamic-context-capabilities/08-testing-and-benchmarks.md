# 08 — Testing and Benchmarks

## Required test matrix

Test context windows at minimum:

- 32K
- 64K
- 128K
- 262,144
- 1,048,576

Test output limits at multiple sizes.

## Unit tests — capability parsing

Inputs:

```text
context_window only
max_model_len only
both identical
both conflicting
InferWeave nested capability
missing values
zero
negative
non-integer
overflow-sized integer
stale cache
operator override smaller/larger
```

Assert deterministic precedence and warnings.

## Unit tests — admission

Cases:

- tiny prompt / tiny output;
- tiny prompt / large requested output;
- large prompt / tiny output;
- near context limit;
- over context limit;
- output request exceeds model output max;
- reservation safety margin;
- weighted-unit rounding;
- cancellation;
- timeout;
- backend failure;
- queue removal.

Assert no leaked permits.

## Integration — vLLM collector

With a test/dummy vLLM-compatible `/v1/models`:

```json
{
  "data": [
    {
      "id": "model-a",
      "max_model_len": 131072
    }
  ]
}
```

Assert InferWeave exposes normalized `context_window=131072`.

## Integration — Pi provider

Mock InferWeave catalog:

- Pi model is registered with correct `contextWindow`;
- Pi model gets correct `maxTokens`;
- catalog refresh changes metadata;
- ETag/304 does not rebuild unnecessarily;
- abort signal cancels discovery call;
- stale fallback works;
- no 260K hard-coded fallback remains.

## Integration — compaction

For each model size:

- grow conversation past Pi native threshold;
- confirm auto-compaction triggers relative to that model's window;
- switch 1M -> 128K with >128K current context;
- assert compact-before-send/fail-safe behavior;
- switch 128K -> 1M and confirm no artificial 260K cap remains.

## Integration — heterogeneous routing

Deployments:

```text
A = 128K
B = 262K
C = 1M
```

Requests:

- 64K can route A/B/C;
- 180K cannot route A;
- 700K routes C only;
- no eligible backend returns `no_context_capable_backend`.

## Concurrency regression

Simulate N Pi sessions with realistic distributions:

```text
70% requests <= 32K
20% requests 32K–128K
8% requests 128K–256K
2% requests >256K
```

Compare old fixed reservation vs weighted admission.

Measure:

- accepted concurrency;
- rejection rate;
- mean/p95 wait;
- hard-reserved tokens;
- backend utilization;
- OOM/context overflow;
- fairness.

## Idle-session regression

Create 100 long-lived Pi sessions.

Only 5 actively request inference.

Expected:

- caller in-flight ≈ 5, not 100;
- hard request leases only for active/queued policy holders;
- idle sessions may have affinity metadata;
- soft KV leases expire/evict according to policy.

## Leak soak test

Run repeated:

- request;
- cancel;
- disconnect;
- upstream error;
- retry;
- complete.

For thousands of iterations.

At end:

```text
hard permits == expected active requests
orphan reservations == 0
```

## Fault injection

- model catalog endpoint timeout;
- malformed model metadata;
- runtime disappears after route selection;
- context capability shrinks after restart;
- gateway restarts with leases;
- Pi uses stale capability;
- network partition to remote site.

All paths must fail boundedly and release resources.

## Performance criteria

Capability discovery must not materially add per-request latency. It should be cached and outside hot-path inference except when a refresh is needed.

Admission token estimation/tokenization must have bounded overhead. Reuse token counts from existing rendering/tokenization stages when possible.

## CI

Add:

- unit suite;
- cross-repo contract fixtures;
- integration test executable from parent workspace;
- load/regression benchmark script;
- machine-readable benchmark output;
- comparison report for fixed vs dynamic admission.
