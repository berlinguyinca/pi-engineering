# Task 12 Prerequisite Report — Final Artifact Integrity

## Outcome

The two load-bearing Task 11 rulings are closed before independent Task 12
review:

- Recovery checkpoint artifacts are resolved and SHA-256 checked in the same
  promise continuation that invokes the selected backend. There is no await or
  promise-resolution boundary after the last hash and before `runAgent`,
  `runProcess`, `runReview`, `runIntegration`, or `runValidation`.
- Artifact categories and IDs are canonical single path segments. Every disk
  path is resolved under the exact category directory, URI aliases are rejected,
  immutable policy is held in a private canonical-key set, and public metadata
  is returned as a fresh frozen clone.

Task 12 PR, merge, reinstall, and installed `local/local` dogfood were not
performed in this prerequisite commit.

## Implementation Evidence

### Post-verification dispatch boundary

`ExecutionBroker.dispatchWithVerifiedRecovery` rebuilds durable recovery
identity, resolves all checkpoint artifacts, hashes the resolved byte snapshots,
and calls the backend directly from the `Promise.all(...).then(...)` callback.
Every runner entry point uses this boundary, including agent/research, process,
review, integration, and validation. Initial `execute()` validation remains in
place for fail-fast behavior, while the runner-local check is authoritative for
dispatch.

The mission regression schedules a filesystem mutation through a promise
reaction plus a queued microtask and asserts both a blocked mission and zero
replacement `runAgent` calls. Overwrite, deletion, post-`execute()` tamper, and
reopen checks remain covered.

### Canonical immutable artifacts

`ArtifactStore` now:

- validates category, ID, owner ID, composite keys, and URIs as canonical path
  segments, rejecting dot-segment, slash, backslash, percent-encoded, and
  extra-segment aliases;
- resolves the root, category, metadata, and content paths and verifies that
  content/metadata remain direct children of the exact category;
- reconstructs immutable canonical keys during replay from valid metadata and
  uses that private set for overwrite/delete policy;
- validates replay metadata against its category directory, metadata filename,
  and canonical URI;
- stores frozen metadata internally and returns fresh frozen metadata from
  `put`, `putImmutable`, `get`, `getByUri`, and `list`.

Tests exercise live and reopened stores, concurrent exact collisions and alias
attempts across both instances, metadata mutation, immutable put/delete, and
content survival.

## Strict TDD Evidence

Before the ArtifactStore repair, the new focused suite reported two expected
failures:

- path-alias writes/reads were accepted instead of rejected;
- returned immutable metadata was mutable and not frozen.

After the repair, all seven artifact tests passed. The broker timing regression
extends the Task 11 red evidence where a mutation after handle creation could
reach replacement dispatch; final verification now remains adjacent to every
backend invocation.

## Verification

Fresh verification on the final working tree:

- `npm run test:mission-reliability` — 37 passed.
- `node --test test/unit/artifacts.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts` — 71 passed.
- focused artifact/tools/vertical-slice/broker/recovery/mission suites — 132 passed.
- `npm test` — 2,658 passed; 1 optional Postgres test skipped because
  `TEST_DATABASE_URL` is unset.
- `npm run build` — core and scripts TypeScript checks passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — package load passed with 21 commands and 7 tools.
- `git diff --check` — passed.

Base: `8c8bede63a82250f67d1cdead56938d3fbe67f62` from `task-12-base.txt`.
The final Lore commit SHA is recorded in the Task 12 prerequisite handoff.

## Reviewer Focus

- Confirm `dispatchWithVerifiedRecovery` remains the final operation around all
  five runner methods; no future await may be inserted between its hash loop and
  callback invocation.
- Confirm candidate reconciliation and integration preparation may await only
  before the runner-local final verification.
- Attack ArtifactStore with mixed encoded separators, extra URI segments,
  metadata filename/category/URI disagreement, returned-object mutation, and
  concurrent live/reopened exact-key collisions.
- Confirm direct filesystem corruption remains fail-closed at dispatch, while
  public immutable put/delete paths make in-process post-hash mutation
  impossible.

## Remaining Scope Boundaries

Slice 2 still owns coordinated cross-repository publication and remote
branch/PR/check/merge reconciliation. Slice 3 still owns database-backed
distributed leases/controllers and remote worker reconciliation. Those
exclusions are unchanged by these prerequisites.
