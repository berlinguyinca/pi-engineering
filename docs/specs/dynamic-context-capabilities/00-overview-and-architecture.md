# 00 — Overview and Architecture

## Problem

The current behavior effectively treats a Pi caller/session as though it needs a fixed ~260K token slot. This is wasteful when:

- the selected model only supports 32K/64K/128K;
- the request currently contains 8K–40K tokens;
- the configured runtime exposes a different maximum than the model's theoretical maximum;
- the session is idle;
- the gateway is preserving affinity but no request is in flight;
- multiple Pi subagents exist but only some are generating at a given moment.

It can also contribute to `429 inference admission: caller_concurrency` by conflating caller/session existence with active resource consumption.

## Desired architecture

```text
                        ┌─────────────────────────────┐
                        │ Serving runtimes            │
                        │ vLLM / SGLang / llama.cpp   │
                        │ vendor APIs / remote nodes  │
                        └──────────────┬──────────────┘
                                       │ runtime limits
                                       ▼
┌────────────────────────────────────────────────────────────────┐
│ InferWeave                                                     │
│                                                                │
│ Capability collectors -> normalized model/deployment catalog   │
│                         │                                      │
│                         ├── /v1/models                         │
│                         └── /v1/models/{id}/capabilities       │
│                                                                │
│ Request tokenizer/estimator -> Admission -> Router -> Backend  │
│                                  │          │                   │
│                                  │          └─ affinity lease  │
│                                  └─ hard request reservation    │
│                                                                │
│ KV/session cache = soft lease, pressure-evictable              │
└───────────────────────────────┬────────────────────────────────┘
                                │ dynamic model metadata
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ pi-engineering-harness                                         │
│                                                                │
│ InferWeave provider extension                                  │
│   refreshModels()                                              │
│   contextWindow <- advertised effective/guaranteed window      │
│   maxTokens     <- advertised output limit                     │
│                                                                │
│ Pi native context usage + native compaction                    │
│ status: used / window / % / capability source & age            │
└────────────────────────────────────────────────────────────────┘
```

## Four values that MUST remain distinct

### 1. Theoretical model maximum
What the model architecture/configuration can theoretically support.

Example: 1,048,576 tokens.

### 2. Deployment/runtime maximum
What a particular loaded runtime is configured and able to accept.

Example: vLLM started with `--max-model-len 262144`.

### 3. Gateway guaranteed routable maximum
What InferWeave promises for the public model ID/alias.

If a model alias can route to 128K and 1M deployments, it may advertise 1M **only if the router guarantees that >128K requests are sent exclusively to capable deployments**. Otherwise advertise the safe lower bound.

### 4. Active request reservation
The amount of backend/gateway capacity currently budgeted for a request:

```text
prompt/input tokens
+ requested/derived output budget
+ configurable safety margin
```

This is not the same thing as any maximum context window.

## Required invariants

1. No hard-coded 260K fallback or reservation.
2. Capability and load are separate:
   - context window changes only when deployment/model capability changes;
   - transient load changes admission/routing scores, not the advertised model limit.
3. Hard caller-concurrency permits correspond to **in-flight requests**, not idle interactive sessions.
4. A disconnected/cancelled/timed-out request cannot leak a hard reservation.
5. Cached KV/affinity may survive the request only as a soft lease.
6. A model switch in Pi uses the new model's context window on subsequent accounting/compaction.
7. Unknown capability is explicit and observable; fallback is conservative.
8. InferWeave never routes a request to a deployment whose effective context window is smaller than the required total request context.
9. The server re-validates all limits. Client metadata is advisory, never trusted for safety/capacity accounting.
10. Existing OpenAI-compatible clients keep working.

## Recommended implementation boundary

Do not patch upstream Pi unless inspection proves an extension/provider cannot accomplish a requirement. Current Pi supports dynamic provider registration, dynamic `refreshModels`, per-model `contextWindow`, `maxTokens`, context usage inspection, and native compaction.

The expected implementation is therefore:

- **InferWeave:** capability normalization + dynamic admission/leases + routing enforcement.
- **pi-engineering-harness:** dynamic provider adapter + refresh/cache + status/telemetry + optional policy layer.
- **Shared/integration tests:** prove contract interoperability and capacity behavior.
