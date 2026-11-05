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
1. Mark `legacy_auto_invoke` deprecated in docs. **Done 2026-10-30** (usage.md, policy.ts JSDoc `@deprecated`); nothing removed.
2. Remove the auto-invoke directive text and `decideMissionDirective`'s legacy branch.
3. Stop registering the `mission` tool only after step 1 criteria hold; `/mission` stays as an explicit command.
4. MissionStore is **not** retired by this plan: it remains the write authority for existing Missions and for explicit `/mission` runs.

## Explicitly not done
- No Mission code, state or events were removed or migrated.
- `authority_generation` (envelope) and `expected_revision` (append guard) are enforced under a cross-process lockfile (`<ledger>.lock`, `src/ledger/fileLock.ts`); a stale writer gets `LedgerRevisionConflictError` / `LedgerAuthorityStaleError` and nothing is written. Revision is per work item. The typed helpers take an optional `LedgerWriteOptions` (guard + authority_generation), and the multi-event ones (`createCandidate`, `promoteCandidate`, `recordEvidence`) append all their events under one lock acquisition or none.
- No `RunQueue` / `RunExecutor` extraction from broker and scheduler: `runWorker` is the single run choke point on the Ledger path, and extracting an interface from ~11k lines of orchestration without a second consumer would add an abstraction, not remove a duplicate.

## Pin migration note (existing active Missions)
- `seedFromStartingModel` (`src/runtime/operatorModelPin.ts`) runs at a Mission's next dispatch in a session that owns it. A pre-existing **active** Mission with no pin and no recorded operator decision gets the session's starting model persisted as an **implicit** pin (`implicit: true`, plus `operator_model_decided_at`). Terminal Missions, Missions that already have a pin or a decision (including a release), and sessions with no starting model are left untouched. That is the only stored-state change.
- Effect: while `execution.hold_mission_model` is true (default) the Mission stays on that model, and a model that becomes unavailable fails the task with its real error instead of failing over. An explicit operator choice (`/model`, `--model auto`) still wins and replaces or clears the implicit pin.
- Opt out: set `execution.hold_mission_model: false` in `engineering.yaml` (global or repository). The router then fails over as before. The implicit pin is still written (the flag controls holding, not seeding); it no longer prevents failover.

## Ledger completion gate and write guards
- `execution.strict_completion` (default true): a Ledger task or work item is only marked completed when `evaluateWorkCompletion` agrees over the work read model. Otherwise it is recorded blocked (`task.blocked` with a `reason`, or the work item as BLOCKED with `blocked_reason`) and `/work` prints the reason. `false` restores unchecked completion.
- Status transitions on the Ledger path (`src/runtime/ledgerTransitions.ts`) write with `expected_revision` (one re-read and re-evaluation on `LedgerRevisionConflictError`, then an error) and with the runtime's `authority_generation`, a per-ledger persisted counter claimed at `EngineeringRuntime.open` (`<ledger>.generation`, same "epoch survives release" idea as MissionStore lease epochs). Mission lease generations are per Mission and Ledger work has none.
