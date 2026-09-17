# 10 — Model Routing and InferWeave Integration

## Principle

Pi Engineering should request capabilities, not hard-coded hardware placement.

Example logical request:

```yaml
role: scout
latency: high
reasoning: medium
coding: medium
context: 64000
vision: false
```

or:

```yaml
role: architecture_review
reasoning: high
coding: high
context: 128000
fresh_context: true
```

## Resolution

Pi Engineering selects/request a model through policy.
InferWeave remains responsible for:

- hardware placement
- GPU worker allocation
- batching
- residency
- scaling
- queueing
- model availability

Do not statically bind Pi roles to specific GPUs.

## Adaptive escalation

Start with the cheapest suitable capability profile.

Escalate when:

- low confidence,
- repeated failures,
- architecture ambiguity,
- difficult merge/integration,
- severe review disagreement,
- security-sensitive complexity.

## Telemetry-driven routing

Record:

- role
- model
- model version
- thinking level
- input/output tokens
- duration
- retries
- validation outcome
- review findings caused by implementation
- final success

This enables future empirical model selection.
