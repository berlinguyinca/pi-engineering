# 01 — InferWeave Capability API

## Objective

Make InferWeave the authoritative normalization layer for model context/output capabilities regardless of backend type.

## Sources

Capability collectors should use the strongest runtime-local source available.

Examples:

- vLLM: `/v1/models` currently exposes `max_model_len`.
- InferWeave-managed runtime metadata/config.
- backend-specific introspection.
- explicit deployment config override.
- model metadata only as a last resort.

Do not infer a runtime's usable context solely from the model name.

## `/v1/models`

Keep OpenAI-compatible fields and add optional extension fields. Unknown extension fields must not break normal OpenAI-compatible clients.

Recommended model item:

```json
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
    "capability_generation": "sha256-or-monotonic-generation",
    "updated_at": "2026-09-14T23:00:00Z",
    "context": {
      "model_max_tokens": 1048576,
      "guaranteed_routable_tokens": 262144,
      "max_routable_tokens": 1048576,
      "heterogeneous": true,
      "source": "runtime"
    }
  }
}
```

### Compatibility aliases

Emit both when practical:

- `context_window`: easy for Pi/provider adapters and other gateways.
- `max_model_len`: compatible with vLLM terminology.
- `max_tokens`: common custom-provider convention for max output.
- `max_output_tokens`: unambiguous output naming.

The normalized values must refer to total context where appropriate (input + output).

## Dedicated capabilities endpoint

Add:

```http
GET /v1/models/{model_id}/capabilities
```

Example:

```json
{
  "schema": "inferweave.model-capabilities/v1",
  "model": "qwen3.8-27b",
  "generation": "c924...",
  "updated_at": "2026-09-14T23:00:00Z",
  "context": {
    "theoretical_model_max_tokens": 1048576,
    "guaranteed_routable_tokens": 262144,
    "max_routable_tokens": 1048576
  },
  "output": {
    "max_tokens": 32768,
    "default_tokens": 8192
  },
  "routing": {
    "context_aware": true,
    "heterogeneous_deployments": true
  },
  "sources": [
    {
      "deployment_id": "site-a/qwen3.8-27b-r9700",
      "runtime": "vllm",
      "effective_context_tokens": 262144,
      "source": "runtime:/v1/models.max_model_len"
    },
    {
      "deployment_id": "hpc/qwen3.8-27b-blackwell",
      "runtime": "vllm",
      "effective_context_tokens": 1048576,
      "source": "runtime:/v1/models.max_model_len"
    }
  ]
}
```

The detailed endpoint is primarily for debugging, dashboards, policy and advanced clients. Pi should normally need only `/v1/models`.

## Guaranteed routable context rule

For each public model ID/alias:

```text
if router can guarantee context-aware placement:
    advertised context_window = max context guaranteed routable by policy
else:
    advertised context_window = minimum effective context among eligible deployments
```

A larger value may be advertised only if route enforcement makes it true.

## Route validation

Every request must compute/obtain:

```text
required_total_context =
    actual_prompt_tokens
    + bounded_requested_output_tokens
```

Candidate deployments must satisfy:

```text
deployment.effective_context_tokens >= required_total_context
```

If no candidate can satisfy the request, return an explicit context/capacity error. Do not send it to a smaller backend and hope the runtime truncates.

## Capability lifecycle

Capabilities change on:

- model reload;
- runtime restart with a new max context;
- deployment config change;
- adding/removing deployments in a way that changes guaranteed routable context;
- provider model metadata refresh.

Capabilities should **not** change on:

- transient queue depth;
- temporary GPU utilization;
- temporary caller concurrency;
- momentary network latency.

## Generation, caching, and conditional refresh

Support:

- `ETag` on `/v1/models` and dedicated capability responses;
- `If-None-Match`;
- `Cache-Control` suitable for short-lived discovery caching;
- `capability_generation` so clients can report which snapshot they use.

Suggested default client refresh TTL: 60 seconds, configurable.

## Active-session stability

Do not lower an already-advertised public capability just because a large-context backend is temporarily busy. That is a load/admission issue.

When a configuration change genuinely removes the capability:

- increment capability generation;
- stop admitting new oversized requests;
- preserve existing in-flight work;
- maintain session route compatibility where feasible;
- surface clear errors if an existing session can no longer be served safely.

## Internal normalized schema

Create a typed internal representation similar to:

```ts
interface ModelCapability {
  modelId: string;
  theoreticalModelMaxTokens?: number;
  guaranteedRoutableTokens: number;
  maxRoutableTokens: number;
  maxOutputTokens: number;
  defaultOutputTokens?: number;
  generation: string;
  updatedAt: string;
  heterogeneous: boolean;
  sources: CapabilitySource[];
}
```

Validation:

- positive safe integers;
- `maxOutputTokens <= guaranteedRoutableTokens`;
- `guaranteedRoutableTokens <= maxRoutableTokens`;
- reject impossible or negative values;
- record provenance.

## Backend collector abstraction

Implement backend adapters rather than putting vLLM-specific parsing into the public API layer:

```ts
interface RuntimeCapabilityCollector {
  probe(deployment, signal): Promise<RuntimeCapability>;
}
```

At minimum implement/verify the collector used by current InferWeave runtimes. vLLM parsing must accept `max_model_len`.

## Failure behavior

If a backend capability probe fails:

- retain a last-known-good capability for a bounded stale period;
- mark it stale in telemetry;
- do not silently expand context;
- when stale data expires, use explicit operator-configured limits or remove that deployment from context-guaranteed routing;
- never fall back to 260K merely because discovery failed.
