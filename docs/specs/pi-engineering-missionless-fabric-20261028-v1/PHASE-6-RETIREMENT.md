# Phase 6 — shadow comparison, canary and Mission retirement

Status: **plan plus the safe parts shipped; nothing legacy was deleted.**

## What shipped (merged to main)
- Phase 1: implicit Missions off by default. `execution.legacy_auto_invoke: true` in `engineering.yaml` restores the old behaviour per operator, per repository, or globally. This is the canary/rollback switch; no env flag.
- Phase 2: read-only `LedgerWorkProjection` and `projectLegacyMissions`. Existing Missions stay readable and resumable; `mergeWorkGraphs` reports an id present in two stores as a conflict.
- Phase 3: every worker run is now an `agent.started` / `agent.completed|failed` pair on the Ledger with `run_id`, `session_id`, `task_id`.
- Phase 4: `execution.preference: team` adds a delegation advisory (no Mission). `direct` / `adaptive` leave interactive behaviour unchanged.
- Phase 5: `/work` shows tasks, runs and verification from both stores.

## Shadow comparison (available now)
`PHASE-1-O1-CORPUS.json` compares what the legacy classifier would inject against the new default for a fixed prompt corpus (legacy 3/8, new 0/8). Re-run it after changing the classifier. A live-model comparison (time to first tool call, subagent launches, tokens) is **not measured**: it needs a model session fixture.

## Retirement criteria (all required before any removal)
1. No session in the canary window enabled `legacy_auto_invoke` for a reason other than habit (operator review of the config, not telemetry guesses).
2. `/work` shows zero `conflicts` and no legacy Mission stuck non-terminal that nobody owns.
3. A live-model comparison exists showing no regression in verification outcome rate on the same prompts.
4. Explicit operator approval in writing for each removal step.

## Removal order (each its own reviewed PR, never batched)
1. Mark `legacy_auto_invoke` deprecated in docs.
2. Remove the auto-invoke directive text and `decideMissionDirective`'s legacy branch.
3. Stop registering the `mission` tool only after step 1 criteria hold; `/mission` stays as an explicit command.
4. MissionStore is **not** retired by this plan: it remains the write authority for existing Missions and for explicit `/mission` runs.

## Explicitly not done
- No Mission code, state or events were removed or migrated.
- `authority_generation` (envelope) and `expected_revision` (append guard) are enforced under a cross-process lockfile (`<ledger>.lock`, `src/ledger/fileLock.ts`); a stale writer gets `LedgerRevisionConflictError` / `LedgerAuthorityStaleError` and nothing is written. Revision is per work item. The typed helpers take an optional `LedgerWriteOptions` (guard + authority_generation), and the multi-event ones (`createCandidate`, `promoteCandidate`, `recordEvidence`) append all their events under one lock acquisition or none.
- No `RunQueue` / `RunExecutor` extraction from broker and scheduler: `runWorker` is the single run choke point on the Ledger path, and extracting an interface from ~11k lines of orchestration without a second consumer would add an abstraction, not remove a duplicate.
