# Task 7 Report — Isolated candidate integration and promotion

## Result

Repository-bound real integration now creates a mission candidate from the bound base, merges worker handoffs only in that candidate, and runs deterministic validation and independent review from the candidate cwd. The incumbent is promoted once, after current gates pass, only when its HEAD still equals the bound base and the repository fencing identity is authoritative.

Conflict, red validation/checks, failed review, cancellation/stale authority, and incumbent divergence preserve candidate/worker refs for diagnosis and leave incumbent HEAD/index/tree unchanged.

## RED evidence

- `node --test test/unit/git.test.ts`
  - 10 passed, 2 failed as expected.
  - Failures: `repo.mergeRefInWorktree is not a function`; `repo.promoteCandidate is not a function`.
- Initial focused integration run after routing merges to candidates exposed expected old-contract failures: runtime reviewers/verifiers still expected incumbent cwd, and broker tests expected integration to mutate the incumbent. Those assertions were updated to the candidate contract before the implementation was completed.

## GREEN evidence

- `node --test test/unit/git.test.ts test/unit/orchestration-broker.test.ts test/integration/orchestration-runtime.test.ts`
  - 71 passed, 0 failed.
- `npm run typecheck`
  - passed.
- `npm run lint`
  - passed (`Checked 583 files`).
- `npm test`
  - 2,413 tests; 2,412 passed, 0 failed, 1 skipped.
- `git diff --check`
  - passed.

## Reviewer focus

- Confirm every candidate Git mutation is immediately preceded by the supplied fencing assertion.
- Confirm review, validation, candidate identity/diff capture, and context-tool resolution all bind to the same candidate checkout.
- Confirm promotion is unreachable on red validation, request-changes review, cancellation/authority loss, or incumbent divergence.
- Confirm preserved candidate refs remain discoverable after failure and successful promotion occurs only once.

## Residual concerns

- `IntegrationRunner.candidateScoped` intentionally preserves legacy injected test/custom runners that still integrate directly. The production `realBackends` runner declares candidate scope; repository-bound runtime missions therefore use the isolated path.
- Legacy in-memory orchestrators without a `MissionOwnership` provider retain a compatibility promotion path. Production `EngineeringRuntime` supplies durable ownership and uses repository fencing for candidate creation, integration, and promotion.

## Fix round 1

Review findings were addressed with the following hardening:

- Promotion cleanliness inspects tracked and untracked incumbent paths (`--untracked-files=all`) and rejects collisions without overwriting them. Only untracked `.pi-eng/**` runtime metadata is ignored, and promotion separately rejects candidates that touch that namespace, so the exception cannot hide a reset collision.
- Promotion writes durable intent, performs a base-bound `git update-ref` compare-and-swap inside a repository promotion critical section, reconciles the checkout, and records completion. An observed candidate HEAD is idempotently reconciled as already promoted after restart.
- Candidate lifecycle records live in the repository Git common directory and include mission, repository, lease generation, execution attempt, branch, path, base SHA, candidate SHA, state, and timestamp. Every attempt gets a unique ref; preserved candidates are never deleted by retry creation.
- Promotion intent/completion records are keyed by mission, repository, generation, and exact candidate SHA. Restart observes `HEAD == candidate` as a committed promotion and completes reconciliation idempotently rather than attempting a second promotion.
- Candidate-scoped integration/validation/review restore the exact persisted candidate after broker recreation, remount a missing checkout only when its branch still resolves to the recorded SHA, and fail with `CANDIDATE_UNAVAILABLE` instead of falling back to the incumbent.
- Promotion/mission cleanup stays under repository authority. Stale destructive cleanup retains the worktree/ref for later reconciliation.
- Recovered-commit ancestry is checked against the exact candidate worktree HEAD.
- Candidate worktrees resolve their own Git/context/verifier dependencies; unresolved candidate-looking paths fail closed.

### Fix-round RED/GREEN evidence

- RED: `node --test test/unit/git.test.ts` failed on untracked collision overwrite and non-idempotent restart promotion.
- RED: the preserved same-attempt retry regression failed because candidate creation deleted and recreated the diagnostic ref.
- GREEN: `node --test test/unit/git.test.ts` passed 15/15 after durable lifecycle reconciliation and preserved-attempt refusal.
- GREEN: focused Task 7 suite passed 76/76 after crash/remount and missing-candidate regressions.
- GREEN: `npm run typecheck` passed.
- GREEN: `npm run lint` passed (`Checked 583 files`).
- GREEN: bounded `timeout 180 npm test` passed: 2,418 tests; 2,417 passed, 0 failed, 1 skipped.
- GREEN: `git diff --check` passed.

### Fix-round residual concerns

- None known in the Task 7 correctness scope. Production backends are candidate-scoped; legacy injected runners remain opt-in compatibility surfaces and do not silently acquire candidate scope.

## Fix round 2

The second review round hardened restart and concurrency boundaries:

- Promotion intent and completion are loaded by exact mission, repository, mission generation, candidate generation, integration execution, base SHA, and candidate SHA. `HEAD == candidateSha` is recoverable only with that exact durable intent; restart reasserts authority immediately before checkout reconciliation.
- Crash injection covers promotion immediately after compare-and-swap, reset, candidate-state persistence, completion persistence, candidate cleanup, and before mission completion. Every committed boundary reconciles idempotently as already promoted.
- The custom PID-directory promotion lock was replaced by the repository's tokenized `ExclusiveFileLock`, including atomic owner publication, token-matched release, stale-owner recovery, and a real child-process contention regression.
- Candidate merges now journal intent before each handoff, then persist merge result and the resulting candidate SHA immediately after the Git mutation. An advanced ref with an incomplete journal is reconciled by ancestry proof without a second merge.
- Integration verification journals intent/result. An interrupted intent is rerun and durably completed on restart.
- Candidate restoration no longer selects the newest record. It requires the exact durable integration execution and matching repository, base, mission generation, candidate generation, branch SHA, and current authority.
- Both mission-cancellation finalizers acquire repository cleanup authority. Stale cancellation preserves work and writes explicit candidate-preservation/worktree-cleanup findings rather than swallowing failures.

### Fix-round-2 RED/GREEN evidence

- RED: promotion crash-boundary hooks were absent, `HEAD == candidateSha` promoted without durable intent, and merge replay had no durable journal; the three adversarial Git regressions failed before implementation.
- RED: the first focused run exposed read-only missions attempting recovery promotion without integration lineage; durable integration lineage now gates that path.
- RED: full-suite concurrency exposed cancellation settling before worktree cleanup and a pre-abort listener race in the stale-cancellation regression; cancellation now awaits authorized cleanup and the regression handles pre-aborted signals.
- GREEN: focused Task 7 suite passed 83/83.
- GREEN: `npm run typecheck` passed.
- GREEN: `npm run lint` passed (`Checked 583 files`).
- GREEN: bounded `timeout 180 npm test` passed: 2,425 tests; 2,424 passed, 0 failed, 1 skipped.
- GREEN: `git diff --check` passed.

### Fix-round-2 reviewer focus

- Verify promotion recovery accepts only exact durable intent/completion identity and never interprets an arbitrary matching HEAD as proof.
- Verify every handoff mutation has a persisted pre-intent and post-SHA, and incomplete intents reconcile only with ancestry proof.
- Verify cancellation cleanup uses newly acquired repository authority and stale paths retain diagnostics with an explicit finding.
- Verify `ExclusiveFileLock` remains the sole promotion critical-section implementation; no ad hoc PID lock remains.

### Fix-round-2 residual concerns

- `ExclusiveFileLock` is intentionally a local-filesystem protocol. Shared/network filesystems or hosts with different PID namespaces still require a distributed lock and remain outside the local-promotion contract.

## Fix round 3

Candidate identity is now stable across integration retries. A `CandidateRecord` owns the durable branch/path/base/current SHA, creation execution, and optional parent/seed lineage; each integration execution owns a separate `IntegrationRunRecord` keyed by candidate ID and execution ID. Every run freezes the complete handoff plan to exact commit SHAs before its first merge, journals each sequence independently, and updates both the run SHA and candidate SHA after mutation. Preserved repair work creates a child candidate seeded from the preserved parent rather than reusing or deleting it.

Merge restart handling now inspects `MERGE_HEAD`, unmerged index entries, and full worktree status. Conflict recovery persists `abort_intent` before `git merge --abort`, checks the command result, and proves the original clean HEAD/no-merge state before recording a completed conflict. Advanced candidate refs reconcile from the exact pending run journal and ancestry proof before exact-SHA restoration rejects them.

Committed-promotion reconciliation is a dedicated pre-gate operation. Historical intent identity remains unchanged, while a newly acquired repository authority guards recovery. Only `HEAD == candidateSha` with an exact durable intent is reconciled; `HEAD == baseSha` remains an uncommitted intent and performs no compare-and-swap, while any other HEAD is reported as divergence.

Cleanup now inventories by repository, acquires and closes authority independently for each repository, continues after another repository fails, checks `git worktree remove` exit status, returns structured failures, and records durable pending-cleanup findings containing repository/path/branch/preservation details. Failed removals remain retryable; candidate preservation and promoted-candidate cleanup failures are explicit.

### Fix-round-3 RED/GREEN evidence

- RED: the new two-repository cleanup regression failed because a failed removal was placed in the permanently retained set, preventing the required retry.
- RED: adversarial tests captured the pre-fix collision model: sequence zero lived on the candidate rather than a run, handoff refs were resolved during each merge, and conflict abort had no durable intermediate state.
- GREEN: focused Task 7 suite passed 89/89, including two run-local sequence-zero journals, frozen future handoffs, advanced-ref replay, dirty conflict replay, abort failure, fresh-authority promotion recovery, exact-intent/no-CAS behavior, child candidate lineage, locked removal retry, and independent two-repository cleanup.
- GREEN: `npm run typecheck` passed.
- GREEN: `npm run lint` passed (`Checked 583 files`).
- GREEN: `git diff --check` passed.
- GREEN: bounded `timeout 180 npm test` passed: 2,431 tests; 2,430 passed, 0 failed, 1 skipped.

### Fix-round-3 reviewer focus

- Verify candidate creation identity never changes when later `IntegrationRunRecord`s use sequence zero, and run restoration remains exact to repository/mission/candidate generation and candidate ID.
- Verify the frozen run plan merges pinned `refSha` values even if source refs advance after planning.
- Verify conflict completion is impossible until abort succeeds and clean HEAD/no `MERGE_HEAD`/no unmerged index is proven.
- Verify pre-gate promotion reconciliation requires exact historical intent but uses fresh current authority immediately before recovery reset; an old base-only intent never performs CAS.
- Verify cleanup authority and failure reporting are repository-scoped, independent, durable, and retryable.

### Fix-round-3 residual concerns

- `ExclusiveFileLock` remains intentionally local-filesystem scoped, as noted above. No new distributed-lock behavior was introduced.
