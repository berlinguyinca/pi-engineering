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
That primitive synchronously opens both metadata and current content through a
pinned category descriptor with `O_NOFOLLOW`. It validates metadata
filename/category/URI identity, the immutable marker and embedded digest, the
stored size/digest binding, and the caller's expected hash before invoking the
backend callback. Missing or corrupt metadata therefore produces zero dispatch.
Every runner entry point uses this boundary, including agent/research, process,
review, integration, and validation.

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
  pins root/category directory descriptors so a post-validation rename or
  symlink swap cannot redirect read, write, delete, or verification;
- creates private directories with mode `0700` and rejects roots/categories not
  owned by the current user or writable by group/other;
- persists SHA-256 on every record and checks actual size/digest during replay,
  reads, mutation authority, and synchronous dispatch;
- publishes a fsynced transaction journal before replacing content/metadata and
  completes an interrupted put/delete on replay, preventing mixed generations;
- serializes mutation with the tokenized `ExclusiveFileLock`, then rereads
  durable metadata under that lock before put/delete decisions;
- binds lock release to the acquired token, device, and inode, while the
  existing recovery-claim protocol serializes stale-owner takeover;
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

Fix round 2 added four red groups: metadata corruption still dispatched; stored
records lacked digests; deterministic category swaps escaped the validation
window; and the PID-only lock could remove a replacement. A fifth red crash
test proved no journal recovery existed. After repair, all seventeen artifact
tests pass, including SIGKILL recovery, simultaneous stale-lock reapers with
observed maximum concurrency one, and same-token/new-inode replacement safety.

## Verification

Fresh verification on the final working tree:

- `npm run test:mission-reliability` — 37 passed.
- `node --test test/unit/artifacts.test.ts` — 17 passed twice.
- focused broker/recovery/platform lock suites — 81 passed.
- focused tools/verifier suites — 15 passed.
- `npm test` — 2,668 passed; 1 optional Postgres test skipped because
  `TEST_DATABASE_URL` is unset.
- `npm run build` — core and scripts TypeScript checks passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — package load passed with 21 commands and 7 tools.
- `git diff --check` — passed.

Fix-round-2 base: `dc0d1adfbf1796434d40b2413553d25426ccf6ad`.
Fix-round-1 base: `2a7c038997df92c8cafc2e0bb12fa0c567381ee9`.
Original Task 12 base: `8c8bede63a82250f67d1cdead56938d3fbe67f62`
from `task-12-base.txt`.
The final Lore commit SHA is recorded in the Task 12 prerequisite handoff.

## Reviewer Focus

- Confirm `verifyAndDispatch` remains synchronous and is the final operation
  around all five runner methods; metadata and content must remain descriptor-
  relative, no-follow, digest-bound reads in the same callback stack.
- Confirm candidate reconciliation and integration preparation may await only
  before the runner-local final verification.
- Confirm put/delete always acquire the canonical-key token lock before reading
  durable authority and retain the root descriptor until conditional release.
- Attack replay with missing immutable markers, metadata
  filename/category/URI disagreement, orphan content, and symlinked category or
  final files; all must fail closed without touching outside files.
- Confirm the journal is durable before either final file changes, replay
  completes only a digest-valid transaction, and no dispatch occurs while a
  journal remains incomplete.
- Confirm directory ownership/mode checks plus pinned `/proc/self/fd` traversal
  close category-parent swaps without relying on lexical containment.

## Remaining Scope Boundaries

Slice 2 still owns coordinated cross-repository publication and remote
branch/PR/check/merge reconciliation. Slice 3 still owns database-backed
distributed leases/controllers and remote worker reconciliation. Those
exclusions are unchanged by these prerequisites.
