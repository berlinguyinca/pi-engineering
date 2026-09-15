# 12 — Acceptance Criteria / Definition of Done

## Capability discovery

- [ ] InferWeave exposes normalized context and max-output metadata.
- [ ] vLLM `max_model_len` is consumed when vLLM is used.
- [ ] Capability provenance/generation is tracked.
- [ ] `/v1/models` remains compatible with ordinary clients.
- [ ] Detailed capability endpoint exists or equivalent documented interface is provided.
- [ ] Heterogeneous model aliases advertise only a context size routing can guarantee.

## Pi integration

- [ ] pi-engineering-harness dynamically discovers models.
- [ ] `contextWindow` is set from server metadata.
- [ ] `maxTokens` is set from server metadata.
- [ ] Model catalog can refresh without hard-coded model tables.
- [ ] Discovery is cached and cancellable.
- [ ] Fallback is conservative and not 260K.
- [ ] Status shows current usage/window/%.
- [ ] Diagnostics show capability source, age, generation, and overrides.
- [ ] Model switch large->small is safe.
- [ ] Pi native compaction remains functional.

## Admission

- [ ] Full context window is no longer held as a hard reservation for every Pi session.
- [ ] Request reservation is based on prompt + bounded output + safety margin.
- [ ] Caller concurrency counts active work, not idle sessions.
- [ ] Hard permits are released on all terminal paths.
- [ ] Watchdog cleans orphan reservations.
- [ ] Structured rejection reasons distinguish concurrency, context, and backend saturation.
- [ ] Weighted capacity/fairness is tested.

## Routing/cache

- [ ] Required context is a hard route filter.
- [ ] Affinity is separated from hard admission.
- [ ] KV/cache retention is soft, TTL-bound, and pressure-evictable.
- [ ] Session can migrate to a larger-context backend as it grows.
- [ ] Idle session state does not create false caller-concurrency pressure.

## Observability

- [ ] Metrics exist for advertised/runtime context.
- [ ] Metrics exist for hard request reservations.
- [ ] Metrics separately count affinity and soft KV leases.
- [ ] Rejections are counted by reason.
- [ ] Dashboard/status makes old false-reservation behavior visible.
- [ ] No prompt contents are emitted in normal metrics.

## Regression/performance

- [ ] 32K/64K/128K/262K/1M test matrix passes.
- [ ] 100 idle Pi sessions with 5 active requests do not count as 100 hard in-flight requests.
- [ ] Cancellation/leak soak ends with zero orphan hard reservations.
- [ ] Heterogeneous routing tests pass.
- [ ] Dynamic policy lowers false `caller_concurrency` 429s in representative load.
- [ ] No material increase in context overflow/backend OOM.
- [ ] Existing clients remain functional.

## Documentation

- [ ] Architecture docs updated.
- [ ] Config reference updated.
- [ ] API docs updated.
- [ ] Migration/rollout documented.
- [ ] Old fixed reservation assumptions removed or explicitly justified.
