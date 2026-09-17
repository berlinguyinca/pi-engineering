# 11 — API and Configuration Examples

## Enriched `/v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3.8-27b",
      "object": "model",
      "owned_by": "inferweave",
      "context_window": 262144,
      "max_model_len": 262144,
      "max_tokens": 32768,
      "max_output_tokens": 32768,
      "inferweave": {
        "capability_schema": "inferweave.model-capabilities/v1",
        "capability_generation": "g-17",
        "context": {
          "model_max_tokens": 1048576,
          "guaranteed_routable_tokens": 262144,
          "max_routable_tokens": 1048576,
          "heterogeneous": true
        }
      }
    }
  ]
}
```

## Pi parser

```ts
function positiveSafeInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    ) return value;
  }
}

function resolveContextWindow(model: any, override?: number): number {
  return positiveSafeInt(
    model?.inferweave?.context?.guaranteed_routable_tokens,
    model?.context_window,
    model?.max_model_len,
    override,
    128_000,
  )!;
}
```

Production code should preserve provenance and validate conflicting fields rather than using this minimal example blindly.

## Harness config

```yaml
inferweave:
  baseUrl: https://llm.example.invalid/v1

  modelDiscovery:
    enabled: true
    refreshTtl: 60s
    requestTimeout: 5s
    staleIfError: 15m

  context:
    conservativeFallbackTokens: 128000
    allowUnsafeContextOverride: false

  status:
    showContext: true
    showCapabilityFreshness: true
```

## InferWeave config

```yaml
capabilities:
  discovery:
    refreshInterval: 30s
    staleIfError: 5m

admission:
  caller:
    maxInflightRequests: 8
    maxQueuedRequests: 32

  context:
    mode: weighted
    tokenQuantum: 8192
    safetyRatio: 0.05
    minSafetyTokens: 1024

sessions:
  affinity:
    idleTtl: 30m

  kvCache:
    softIdleTtl: 90s
    pressureEvictable: true

features:
  dynamicModelCapabilities: true
  weightedContextAdmission: false
  softKvLeases: false
```

These are suggested defaults; map them to the repository's existing configuration conventions.

## Request reservation example

Input:

```text
prompt                41,250
requested output       8,192
base                   49,442
5% safety               2,473
reservation            51,915
```

With an 8,192-token quantum:

```text
weighted units = ceil(51,915 / 8,192) = 7
```

This request should not consume a 262,144-token hard reservation.

## Context-aware routing example

```text
Required total: 180K

deployment-a max: 128K  -> reject candidate
deployment-b max: 262K  -> eligible
deployment-c max:   1M  -> eligible

score B and C using locality/load/cache/latency.
```

## Soft lease state

```json
{
  "session_id": "pi-session-...",
  "preferred_deployment": "site-a/model-7",
  "affinity_expires_at": "...",
  "kv": {
    "state": "soft",
    "last_used_at": "...",
    "expires_at": "...",
    "evictable": true
  }
}
```

No caller-concurrency permit is represented here.
