# 04 — Routing, Affinity, and KV Cache

## Objective

Preserve the performance benefit of sticky sessions and reusable KV cache without turning affinity into a full hard context reservation.

## Three lease types

### A. Request lease — hard
- Exists only while queued/active according to admission policy.
- Consumes hard admission capacity.
- Released at request terminal state.

### B. Affinity lease — metadata
- Maps `session_id -> preferred deployment`.
- Very cheap.
- May live for minutes/hours.
- Does not reserve inference capacity by itself.

### C. KV/cache lease — soft
- Represents reusable backend cache state.
- May improve TTFT.
- Evictable under pressure.
- Has TTL/idle expiry.
- Must never be counted as caller concurrency.

## Suggested default lifetimes

Make configurable; initial values are examples, not immutable requirements.

```yaml
sessions:
  affinity:
    idleTtl: 30m
  kvCache:
    softIdleTtl: 90s
    pressureEvictable: true
  requestLease:
    watchdogGrace: 30s
```

Use runtime evidence to tune.

## Pressure behavior

When capacity is available:

- prefer existing session/backend affinity;
- reuse cached prefixes/KV where runtime supports it.

As pressure rises:

1. evict oldest/lowest-value soft KV leases;
2. preserve affinity metadata if cheap;
3. route the next request normally if preferred backend cannot satisfy it;
4. never reject a feasible request solely to preserve an idle cache.

## Heterogeneous context routing

For a model alias with different deployments:

```text
deployment A = 128K
deployment B = 262K
deployment C = 1M
```

A 90K request can use A/B/C.

A 200K request can use B/C.

A 600K request can use C only.

The router must include `required_total_context` as a hard candidate filter before scoring latency/load/locality.

## Session affinity and capability changes

If a session grows beyond the preferred backend's context capability:

- migrate/re-route to a capable deployment;
- record an affinity transition;
- accept loss of reusable KV if necessary;
- never force the request onto an incapable backend.

The public model capability must reflect what routing can guarantee.

## Geographic InferWeave topology

Keep the existing location-aware routing goals:

1. satisfy hard model/context capability;
2. satisfy authorization/policy;
3. prefer session affinity/cache hit when feasible;
4. prefer local/low-latency site;
5. consider queue/capacity;
6. avoid unnecessary WAN transfer.

Context capability is a hard filter; locality is a score.

## Session identity

Use a stable session identifier emitted by the Pi harness when the gateway/runtime supports it.

Do not use caller identity alone as session identity: one caller may run many Pi subagents/worktrees.

Recommended identity dimensions:

```text
caller_id
pi_session_id
agent/subagent_id
repository/worktree identity (optional metadata, not security identity)
```

## Cache security

Cached prompts/KV/session metadata are sensitive.

- namespace by authenticated tenant/caller;
- never allow cross-tenant cache reuse based solely on matching prefix;
- do not expose prompt text in metrics;
- hash identifiers where appropriate;
- enforce the same authorization when resolving an affinity/session ID.

## Telemetry

Track separately:

- hard in-flight reservations;
- affinity leases;
- soft KV leases;
- cache hit/miss;
- cache eviction reason;
- affinity hit/miss/migration;
- context-required route exclusions;
- cross-site route transitions.

This separation makes it possible to see whether idle caches help performance or merely consume resources.
