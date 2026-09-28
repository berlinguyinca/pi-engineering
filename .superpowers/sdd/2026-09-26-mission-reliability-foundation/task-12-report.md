# Task 12 Prerequisite Report — Final Artifact Integrity

## Outcome

The Task 12 prerequisite rulings are closed before independent review:

- Recovery checkpoint artifacts are read from their current canonical files and
  SHA-256 checked by a synchronous verify-and-dispatch primitive. The selected
  backend is called from that primitive's callback in the same JavaScript call
  stack, with no await or promise-resolution boundary after the last read/hash.
- Artifact categories and IDs are canonical single path segments. Every disk
  path is resolved under the exact real category directory, URI aliases and
  symlinks are rejected, and public metadata is returned as a fresh frozen
  clone. Immutable authority is also rechecked from durable metadata while a
  cross-process canonical-key lock is held.

Task 12 PR, merge, reinstall, and installed `local/local` dogfood were not
performed in this prerequisite commit.

## Implementation Evidence

### Post-verification dispatch boundary

`ExecutionBroker.dispatchWithVerifiedRecovery` rebuilds durable recovery
identity and delegates the final gate to `ArtifactStore.verifyAndDispatch`.
That primitive synchronously opens every current canonical content file with
`O_NOFOLLOW`, reads and hashes its bytes, and invokes the backend callback
before returning. Every runner entry point uses this boundary, including
agent/research, process, review, integration, and validation. Initial
`execute()` validation remains in place for fail-fast behavior, while this
runner-local synchronous read is authoritative for dispatch.

The mission regression instruments both preliminary and final reads, mutates
the checkpoint immediately before the true final synchronous read, and asserts
two preliminary reads, two final reads, a blocked mission, and zero replacement
`runAgent` calls. Overwrite, deletion, post-`execute()` tamper, and reopen checks
remain covered.

### Canonical immutable artifacts

`ArtifactStore` now:

- validates category, ID, owner ID, composite keys, and URIs as canonical path
  segments, rejecting dot-segment, slash, backslash, percent-encoded, and
  extra-segment aliases;
- resolves the root, category, metadata, and content paths and verifies that
  content/metadata remain direct children of the exact real category;
- rejects symlinked roots, categories, metadata files, and content files, and
  uses no-follow opens for content verification and writes;
- serializes mutation with a cross-process lock derived from the canonical key,
  then rereads durable metadata under that lock before put/delete decisions;
- reconstructs private immutable canonical keys during replay and validates
  replay metadata against its category directory, metadata filename, canonical
  URI, content file, and required immutable marker;
- fails closed on mismatched/corrupt replay metadata, orphan content, and
  missing immutable markers so a stale or fresh instance cannot overwrite a
  reserved key;
- stores frozen metadata internally and returns fresh frozen metadata from
  `put`, `putImmutable`, `get`, `getByUri`, and `list`.

Tests exercise live and reopened stores, stale instances, concurrent child
processes, corrupt replay, exact collisions and aliases, metadata mutation,
immutable put/delete, symlinked categories/files, and outside-file survival.

## Strict TDD Evidence

Before the first repair, the focused ArtifactStore suite reported the expected
canonical alias and mutable-metadata failures. Fix round 1 then added tests that
failed for the three remaining high-severity gaps:

- a stale store instance overwrote an immutable key created by another process;
- corrupt immutable replay did not reject and reserve the canonical key;
- symlinked categories and final content files were accepted or followed;
- the broker lacked a synchronous primitive that reads current bytes and
  dispatches without an intervening asynchronous boundary.

After the repair, all eleven artifact tests and the current-byte broker timing
regression pass. The regression mutates on the actual final read and proves
that replacement dispatch remains at zero.

## Verification

Fresh verification on the final working tree:

- `npm run test:mission-reliability` — 37 passed.
- `node --test test/unit/artifacts.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts` — 75 passed.
- focused artifact/tools/vertical-slice/broker/recovery/mission suites — 135
  passed before the final concurrent-process case; the final artifact suite
  passed 11/11 twice.
- `npm test` — 2,662 passed; 1 optional Postgres test skipped because
  `TEST_DATABASE_URL` is unset.
- `npm run build` — core and scripts TypeScript checks passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — package load passed with 21 commands and 7 tools.
- `git diff --check` — passed.

Fix-round base: `2a7c038997df92c8cafc2e0bb12fa0c567381ee9`.
Original Task 12 base: `8c8bede63a82250f67d1cdead56938d3fbe67f62`
from `task-12-base.txt`.
The final Lore commit SHA is recorded in the Task 12 prerequisite handoff.

## Reviewer Focus

- Confirm `verifyAndDispatch` remains synchronous and is the final operation
  around all five runner methods; no future await or cached byte snapshot may be
  inserted between its current-file hash loop and callback invocation.
- Confirm candidate reconciliation and integration preparation may await only
  before the runner-local final verification.
- Confirm put/delete always acquire the canonical-key file lock before reading
  durable immutable authority, including stale and concurrent processes.
- Attack replay with missing immutable markers, metadata
  filename/category/URI disagreement, orphan content, and symlinked category or
  final files; all must fail closed without touching outside files.
- Confirm lock recovery and temporary-file replacement preserve the fail-closed
  behavior under interrupted writers.

## Remaining Scope Boundaries

Slice 2 still owns coordinated cross-repository publication and remote
branch/PR/check/merge reconciliation. Slice 3 still owns database-backed
distributed leases/controllers and remote worker reconciliation. Those
exclusions are unchanged by these prerequisites.
