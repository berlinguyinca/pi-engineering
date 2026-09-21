# InferWeave + Pi Dynamic Context Capability & Admission

**Status:** Implementation specification  
**Date:** 2026-09-14  
**Scope:** InferWeave gateway/runtime discovery, pi-engineering-harness provider integration, context-aware admission, leases, routing, compaction integration, observability, tests, and rollout.

## Goal

Remove the assumption that every Pi/InferWeave session permanently consumes a fixed ~260K context reservation.

The system must instead:

1. Discover the **actual context capability** exposed by the serving runtime/gateway.
2. Publish a stable, normalized InferWeave capability contract.
3. Have Pi consume that capability dynamically as `contextWindow`/`maxTokens`.
4. Use Pi's native context accounting and compaction against the discovered limit.
5. Reserve gateway/backend capacity based on the **current request and expected generation**, not the theoretical maximum context window.
6. Release hard reservations when a request completes.
7. Keep session affinity and reusable KV state as **soft, expiring, evictable** state rather than hard caller-concurrency permits.
8. Make every decision observable.

## Non-goals

- Forking Pi's core compaction engine when its extension/provider APIs are sufficient.
- Treating transient backend load as a model capability.
- Advertising a large context window unless InferWeave guarantees it can route requests of that size.
- Holding a hard capacity permit for the lifetime of an interactive Pi session.
- Hiding context overflow with silent truncation.

## Documents

- `00-overview-and-architecture.md` — overall design and invariants
- `01-inferweave-capability-api.md` — normalized model/runtime capability contract
- `02-pi-provider-integration.md` — dynamic Pi model discovery and refresh
- `03-admission-and-context-leases.md` — replacement for fixed 260K reservations
- `04-routing-affinity-and-kv-cache.md` — heterogeneous backends, sticky sessions, soft KV leases
- `05-compaction-and-context-policy.md` — Pi compaction behavior and optional adaptive policy
- `06-observability-and-status.md` — metrics, logs, traces, status bar
- `07-compatibility-fallbacks-and-security.md` — fallback hierarchy, stale data, auth and safety
- `08-testing-and-benchmarks.md` — unit/integration/load/failure testing
- `09-rollout-and-migrations.md` — phased deployment and rollback
- `10-cross-repo-work-breakdown.md` — decomposed implementation workstreams
- `11-api-and-config-examples.md` — concrete payloads/config examples
- `12-acceptance-criteria.md` — Definition of Done
- `SOURCES.md` — research sources and conclusions
- `IMPLEMENTATION_PROMPT.md` — paste-ready orchestration prompt

## Core invariant

> `context_window` describes what a request/session is allowed to grow to. It is **not** a reservation of that many tokens for the lifetime of a caller session.

Hard capacity is held only for active work. Affinity/cache state may outlive a request, but must be separately accounted, TTL-bound, and evictable under pressure.
