# Acceptance and regression criteria

1. Replaying a previously observed 32K reasoning loop triggers a guarded interruption before reaching the original limit, if trace exhibits sustained repetition; event identifies channel/reason and retains bounded sanitized evidence.
2. Genuine extended reasoning with demonstrable progress does **not** trigger spurious cancellation. Legitimate code blocks, repetitive tests/output, and long final answers pass control fixtures.
3. Mixed `thinking_delta`, `text_delta`, snapshots, tool deltas and stream restarts account tokens once only; no quadratic budget charge. If provider withholds reasoning tokens, report monitoring limits and use server-side token budget/cap.
4. Server-side cancellation is verified through logs/metrics or explicitly labeled unconfirmed. No duplicate tool side effects after abort; no spurious GPU/model unload.
5. Recovery restarts from last verified checkpoint, excludes degenerate prefix, injects appropriate change in strategy, and uses bounded attempts. Same-fingerprint failure escalates.
6. Existing 429, 503, admission and stream-silence retry paths retain behavior; regression tests pass.
7. Versioned prompt experiment compares completion and token consumption across held-out traces; no auto-promotion without correctness/no-regression checks.
8. UI uses existing Herdr inspector, APS telemetry, event store. Aggregates don't double-count attempts or imply actual token savings from max output subtraction.
9. Config compatible with existing defaults; controlled canary and rollback demonstrated; production switches not changed without verification/approval.
10. `docs/specs/<unique-id>/` receives artifact and audit/results evidence; repo changes are committed in coherent phase increments where permitted.
