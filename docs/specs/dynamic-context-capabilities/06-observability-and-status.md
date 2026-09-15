# 06 — Observability and Status

## Objective

Make it obvious why a request was admitted/rejected, what context limit Pi believes, what InferWeave advertised, and whether capacity is being held unnecessarily.

## InferWeave metrics

Names may adapt to existing metric conventions.

Required conceptual metrics:

```text
inferweave_model_context_window_tokens{model}
inferweave_deployment_context_window_tokens{model,deployment,runtime}
inferweave_model_max_output_tokens{model}

inferweave_admission_inflight_requests{caller,model}
inferweave_admission_queued_requests{caller,model}
inferweave_admission_reserved_tokens{model,deployment}
inferweave_admission_reserved_units{model,deployment}
inferweave_admission_rejections_total{reason,model}
inferweave_admission_wait_seconds{model}

inferweave_request_lease_active{model,deployment}
inferweave_affinity_leases{model,deployment}
inferweave_soft_kv_leases{model,deployment}
inferweave_kv_evictions_total{reason,model,deployment}

inferweave_capability_refresh_total{runtime,result}
inferweave_capability_age_seconds{model,deployment}
inferweave_route_exclusions_total{reason}
```

Avoid unbounded labels such as raw session/request IDs in Prometheus.

## Structured request log

For admission decisions log fields similar to:

```json
{
  "event": "admission_decision",
  "request_id": "...",
  "caller_hash": "...",
  "model": "qwen3.8-27b",
  "prompt_tokens": 18342,
  "output_budget_tokens": 8192,
  "reserved_tokens": 27861,
  "model_context_window": 262144,
  "decision": "admit",
  "queue_ms": 4,
  "deployment": "site-a/...",
  "capability_generation": "c924..."
}
```

For rejection:

```json
{
  "decision": "reject",
  "reason": "caller_concurrency",
  "caller_inflight": 8,
  "caller_limit": 8
}
```

Do not log prompt contents by default.

## Pi status/footer

Integrate with the existing pi-engineering-harness status bar.

Target information:

```text
model · ctx used/window percent · tok/s · directory · repo:branch · worktree
```

Example:

```text
qwen3.8-27b · ctx 143k/262k 55% · 31 tok/s · inferweave:main · wt:admission
```

If fallback/stale:

```text
ctx 88k/128k 69% ⚠stale
```

## Diagnostics

Provide a human-readable command/page that shows the whole chain:

```text
Pi
  selected model             qwen3.8-27b
  registered context         262144
  current context            143102 (54.6%)
  max output                 32768

InferWeave catalog
  guaranteed routable        262144
  max routable               1048576
  generation                 c924...
  age                        12s

Current/last request
  prompt                     143102
  requested output           8192
  admission reservation      159930
  backend                    hpc/qwen...
  hard request lease         released
  affinity lease             active
  soft KV lease              active
```

## Dashboard

If the existing InferWeave dashboard/Grafana stack exists, add panels:

- advertised context by model;
- runtime context by deployment;
- current reserved context tokens;
- active requests vs idle affinity/KV leases;
- admission rejection rate by reason;
- p50/p95 wait time;
- request reservation size histogram;
- utilization improvement versus old fixed reservation;
- stale capability probes.

## Success metric

Track an explicit before/after metric:

```text
capacity amplification =
  old_fixed_reservation_equivalent / new_actual_reserved_tokens
```

Also compare:

- 429 caller_concurrency rate;
- throughput;
- TTFT;
- average wait;
- GPU utilization;
- cache hit rate;
- tail latency.

The rollout is successful only if false admission pressure drops without causing context overflows or backend OOMs.
