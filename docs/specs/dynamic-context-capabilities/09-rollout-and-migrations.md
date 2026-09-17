# 09 — Rollout and Migration

## Phase 0 — instrument current behavior

Before changing admission:

- expose current caller permits;
- expose current fixed reservation amount;
- record 429 reasons;
- record average actual prompt size;
- record model/runtime context windows.

This creates a baseline.

## Phase 1 — capability discovery

Implement InferWeave capability normalization and Pi dynamic discovery.

Admission remains unchanged.

Verify:

- Pi context windows match server;
- no model regressions;
- status/diagnostics are correct.

## Phase 2 — shadow weighted admission

Compute new request reservations but do not enforce them.

For every request record:

```text
old decision
new shadow decision
old reserved amount
new predicted reserved amount
```

Investigate divergences.

## Phase 3 — enable weighted admission for canary callers

Use feature flag / allowlist.

Watch:

- 429s;
- OOMs;
- context errors;
- queue time;
- GPU utilization;
- reservation leak metrics.

## Phase 4 — general weighted admission

Turn on globally once canary is stable.

Keep old policy available for emergency rollback.

## Phase 5 — soft KV/affinity tuning

After hard admission is stable, tune:

- KV TTL;
- pressure eviction;
- route affinity;
- WAN locality.

Do not block the core fix on perfect KV policies.

## Config migration

Search for and remove/replace:

- `260000`
- `260k`
- `262144` when used as a generic reservation rather than an intentional model capability;
- `context_slots`/`seats` assumptions tied to full model context;
- caller/session permits acquired at session creation and released only at session end.

Do not mechanically delete legitimate 262,144 model limits. Every occurrence must be classified.

## Database/state migration

If current admission reservations are persisted:

- add lease type and expiry;
- distinguish hard request vs soft cache/affinity;
- backfill active records conservatively;
- garbage-collect old session-wide hard reservations.

Prefer ephemeral distributed lease state for active request permits if consistent with InferWeave architecture.

## Compatibility window

During mixed-version deployment:

- old Pi clients continue to work with `/v1/models`;
- new Pi clients can use extension metadata;
- new gateway does not require client-supplied context fields;
- old nodes lacking capability metadata use explicit deployment config or conservative treatment.

## Rollback criteria

Rollback weighted admission if:

- backend OOM/context failures materially increase;
- leaked permits appear;
- fairness degrades severely;
- capability normalization is inconsistent.

Capability discovery can remain enabled independently.
