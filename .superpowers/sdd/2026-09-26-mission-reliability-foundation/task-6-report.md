# Task 6 Report — Exact Candidate Gate Evidence

Base: `0f9527a5c69e6a164dc4d01cf46c499e9864f554`

## RED

- Command: `node --test test/unit/orchestration-gate.test.ts test/integration/orchestrator-e2e.test.ts`
- Result: failed as expected with `ERR_MODULE_NOT_FOUND` for `src/orchestration/evidence.ts`; the existing E2E tests passed before implementation.
- Behaviors introduced by the failing tests: canonical identity hashing; stale manifest/generation/repository/candidate/diff rejection; no-target validation rejection; pending/failed acceptance rejection; unresolved `BLOCKED`/`CANCELED`/`SKIPPED` task rejection; active unfenced execution rejection; invalid supersession rejection; strict review severity/verdict/output/access checks.

## GREEN

- Focused: `node --test test/unit/orchestration-gate.test.ts test/integration/orchestrator-e2e.test.ts` → 65 passed, 0 failed.
- Full suite: `npm test` → 2,389 passed, 0 failed, 1 skipped (`TEST_DATABASE_URL` not set for the optional Postgres test).
- Typecheck: `npm run typecheck` → passed.
- Lint/static format: `npm run lint` → 583 files checked, no errors.
- Diff hygiene: `git diff --check` → passed.

## Files

- `src/orchestration/evidence.ts` — canonical candidate identity construction/hashing and strict review severity normalization.
- `src/orchestration/types.ts` — candidate revision, validation evidence, review evidence, verdict, and independence contracts.
- `src/orchestration/missionStore.ts` — durable candidate/evidence events, replay, defensive copies, and invalidation on manifest/generation/candidate transitions.
- `src/orchestration/completionGate.ts` — exact-current-candidate matching, acceptance coverage, terminal task/execution fencing, supersession, and review/validation fail-closed checks.
- `src/orchestration/broker.ts` — candidate/diff capture and durable typed gate evidence publication behind the live authority fence.
- `src/orchestration/realBackends.ts` — validation command/profile/exit/summary/artifact hashes and structured reviewer session/model/provider/verdict/independence data.
- `src/orchestration/orchestrator.ts` — strict finding normalization, repair invalidation, and acceptance binding only after current validation/review evidence succeeds.
- `test/unit/orchestration-gate.test.ts`, `test/integration/orchestrator-e2e.test.ts` — Task 6 regression coverage.
- Directly affected integration fixtures were updated to emit the newly required typed backend evidence.

## Design Decisions

- Candidate state is persisted independently from gate evidence so validation/review records cannot define the target they claim to verify.
- Identity hashing uses canonical JSON with sorted/deduplicated acceptance and artifact hash sets.
- `CompletionGate.evaluate()` always gathers durable store evidence; callers cannot inject historical counters to bypass exact matching.
- Evidence is invalidated on manifest rebind, mission-generation change, candidate/integration change, and repair. Candidate SHA/diff changes also change the identity hash, so old evidence cannot match.
- Reviewer output must come from the structured `review_result` contract. Missing/unknown severity, missing verdict, inaccessible output, `request_changes`, and unresolved blocking findings fail closed.
- Acceptance criteria carry the exact current identity hash; a passed label with another hash is insufficient.

## Residual Concerns

- The optional Postgres integration test was not run because `TEST_DATABASE_URL` is not configured; the in-memory/JSONL orchestration paths and the complete default suite passed.
- Task 7 still owns isolated-candidate promotion semantics. Task 6 records and checks the exact candidate exposed by the current integration path without implementing Task 7 promotion behavior early.

---

## Review Fix Round 1

Fix base: `bf28347b92e970007eaa745687107f1a360e5212`

### RED

- `node --test test/unit/orchestration-gate.test.ts` → 18 passed, 17 failed after provenance enforcement exposed fixtures that used nonexistent task/execution IDs.
- `node --test test/integration/orchestrator-e2e.test.ts` → normal completion blocked because the harness had no repository-scoped Git target and no explicit per-acceptance results.
- `node --test test/unit/orchestration-missionstore.test.ts` → 10 passed, 2 failed after immutable coverage fingerprints became mandatory.
- `npm test` after the first green pass → 2,387 passed, 8 failed, 1 skipped; all eight failures were directly affected legacy fixtures relying on synthetic repository identity or incomplete reviewer output.

### GREEN

- Focused: `node --test test/unit/orchestration-gate.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-realbackends.test.ts test/integration/orchestrator-e2e.test.ts test/integration/orchestrator-long-outage.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts` → 113 passed, 0 failed.
- Direct runtime/broker regression: `node --test test/integration/orchestration-runtime.test.ts test/unit/orchestration-broker.test.ts` → 55 passed, 3 failed initially; after replacing inaccessible fake artifacts and adding criterion results, the three targeted runtime regressions passed and broker tests remained green.
- Typecheck: `npm run typecheck` → passed.
- Lint/static format: `npm run lint` → 583 files checked, no errors.
- Full suite: `npm test` → 2,395 passed, 0 failed, 1 skipped (`TEST_DATABASE_URL` is not configured for the optional Postgres test).
- Diff hygiene: `git diff --check` → passed; no controller-ledger path changed.

### Fix Decisions

- Replay now reuses canonical identity, hash, manifest/base, acceptance-result, and successful-execution provenance validation. Invalid replay records are quarantined and surfaced to the completion gate.
- Candidate state is keyed by mission and repository. Completion explicitly fails closed for multi-repository missions until repository head-vector evidence exists.
- Gate evidence is published only after its authoritative execution settles successfully. Candidate, validation, and review records bind to mission, task, execution, backend, repository/base, generation, and fence.
- Mutation evidence requires a repository-scoped Git target. The broker raises typed `EvidenceUnavailableError` (`EVIDENCE_UNAVAILABLE`) and never constructs base-plus-empty-diff evidence.
- Acceptance completion requires explicit backend results for each stable acceptance ID. A copied declaration or generic green test/review result cannot attest every criterion.
- Reviewer payloads require verdict, findings, missing tests, spec gaps, explicit acceptance results, accessible artifacts, and real session/model/provider provenance. Blocking missing tests and spec gaps become blocking findings.
- Manifest rebinds, mission generation changes, candidate-changing executions, every integration start, and repair/candidate-affecting transitions durably invalidate prior evidence before new evidence is recorded.
- Supersession requires an immutable SHA-256 coverage fingerprint over repository, objective, and deliverables, successful matching replacements, and current review evidence recorded after replacement completion.

### Residual Concern

- Multi-repository completion is intentionally rejected until a repository head-vector contract is implemented; repository-scoped execution remains supported, but evidence from one repository cannot complete another.

---

## Review Fix Round 2

Fix base: `116881d453e0b0241e8dd4b30f3089724f799611`

### RED

- `node --test test/unit/orchestration-gate.test.ts test/unit/orchestration-realbackends.test.ts` → 59 passed, 5 failed. The exact failures proved that `{severity:'critical'}` could be silently discarded, stale candidate generations and stale execution assignments could publish evidence, a later failed validation was hidden by earlier green evidence, and a historical review execution could be republished with a fresh record timestamp.

### GREEN

- Focused: `node --test test/unit/orchestration-gate.test.ts test/unit/orchestration-realbackends.test.ts` → 64 passed, 0 failed.
- Supersession timestamp regression: `node --test test/unit/orchestration-gate.test.ts` → 43 passed, 0 failed, including delayed first publication of pre-replacement executions.
- Orchestration regression surface: `node --test test/unit/orchestration-*.test.ts test/integration/orchestration*.test.ts` → 222 passed, 0 failed.
- Typecheck: `npm run typecheck` → passed.
- Lint/static format: `npm run lint` → 583 files checked, no errors.
- Full suite first pass: `npm test` → 2,400 passed, 1 unrelated timing failure, 1 optional Postgres skip. The lone failure was `does not remove a recovery claim held by a live process`, which expected `blocked` but observed `timeout` under full-suite load.
- Timing-failure isolation: `node --test --test-name-pattern="does not remove a recovery claim held by a live process" test/unit/platform-eventstore.test.ts` → 1 passed, 0 failed.
- Full suite confirmation: `npm test` → 2,401 passed, 0 failed, 1 optional Postgres skip.
- Diff hygiene: `git diff --check` → passed; no controller-ledger path changed.

### Fix Decisions

- Reviewer validity now covers every raw finding, missing-test entry, and spec-gap entry before normalization. Nothing discarded by normalization can leave `outputValid` true.
- The broker durably assigns each created execution to its task. Candidate, validation, and review publication then require a successfully settled execution with exact mission/task/backend/repository/base, mission generation, candidate generation, fence, and current assignment.
- Validation attempts durably invalidate prior validation and review evidence; review attempts invalidate prior review evidence only. Completion also requires evidence from the latest repo-scoped gate task, so a later red attempt cannot be hidden by an earlier green record.
- Earlier failed gate attempts are ignored only under explicit latest-attempt semantics after the latest assigned attempt succeeds with current evidence. They are not added to recovery/supersession lineage.
- Each execution may publish each evidence class only once, including during replay. Re-recording an old execution under a new evidence ID/timestamp is rejected or quarantined.
- Supersession freshness is measured from the authoritative `ended_at` values of candidate, validation, and review executions. All three must end after every replacement completes; caller-provided `recordedAt` cannot manufacture freshness.

### Residual Concerns

- The optional Postgres event-store integration remains unrun because `TEST_DATABASE_URL` is not configured.
- Multi-repository completion remains intentionally fail-closed until repository head-vector evidence is implemented.

---

## Review Fix Round 3

Fix base: `bb3c6434581eabea30f365b94d6d45b6916491fb`

### RED

- `node --test test/unit/orchestration-gate.test.ts` → 43 passed, 3 failed. Both validation and review allowed an older-created task that executed and failed after a newer green attempt to leave completion open; gate invalidation was also absent until after the failing repository resolver ran.

### GREEN

- Focused: `node --test test/unit/orchestration-gate.test.ts` → 47 passed, 0 failed, including live and JSONL-replay ordering checks and pre-resolution invalidation for validation and review.
- Review-invalidation mutation check: removing the early review invalidation and running `node --test --test-name-pattern="durably invalidates review evidence" test/unit/orchestration-gate.test.ts` → 0 passed, 1 failed; restoring it → 1 passed, 0 failed.
- Orchestration regression surface: `node --test test/unit/orchestration-*.test.ts test/integration/orchestration*.test.ts` → 226 passed, 0 failed.
- Typecheck: `npm run typecheck` → passed.
- Lint/static format: `npm run lint` → 583 files checked, no errors.
- Full suite: `npm test` → 2,405 passed, 0 failed, 1 optional Postgres skip.

### Fix Decisions

- A gate attempt begins when its exact assigned execution durably enters `RUNNING`. The store reconstructs a monotonic authoritative-start order from `execution.started` event sequence, accepting a start only when mission, candidate generation, fence, and current assignment all match.
- Completion selects the latest validation and review by authoritative execution-start order, never task creation or map insertion order.
- A failed gate task becomes obsolete only when current passing evidence belongs to a strictly later authoritative successful execution. Failed attempts without a proven earlier start remain blocking.
- Repository-scoped validation/review invalidation now occurs immediately after the execution enters `RUNNING`, before repository resolution, worktree setup, checkpoint setup, or backend dispatch can fail.

### Residual Concerns

- The optional Postgres event-store integration remains unrun because `TEST_DATABASE_URL` is not configured.
- Multi-repository completion remains intentionally fail-closed until repository head-vector evidence is implemented.
