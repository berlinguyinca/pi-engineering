# Task 12 Prerequisite Report — Final Artifact Integrity

## Final Whole-Branch Fix Wave (base `eb37f17`)

The final blocking review findings are closed in one cohesive package:

- Artifact lock-domain initialization now publishes a private, root-level,
  fsynced `.artifact-lock-bootstrap.json` before `.artifact-locks` can be
  created. Its `prepared` token and `bound` device/inode/token phases are
  recovered explicitly; an absent final domain record without this proof fails
  closed. Crash tests cover every durable bootstrap boundary, legitimate first
  initialization/concurrent recovery, an unproven preexisting directory, a
  directory substituted after the prepared marker but before binding, and
  deletion of the final record followed by directory replacement while the old
  domain is still held.
- Recovery-claim publication transfers its pinned descriptor only after the
  candidate name is cleaned successfully, and all collision/error paths close
  their owned descriptor. `ExclusiveFileLock.release()` now throws structured
  `FILE_LOCK_RELEASE_FAILED`, keeps its descriptor and ownership state until
  quarantine cleanup succeeds, and restores the fixed name on a cleanup fault.
  `JsonlEventStore.close()` retains the writer lock/open-file registration and
  surfaces that error. Fault injection, replacement, reacquisition, and
  repeated descriptor-count tests cover the lifecycle.
- Safety-critical Git queries now throw `GitQueryError` with
  `GIT_QUERY_FAILED`; `captureDiff`, `changedFiles`, `statusPathsIn`,
  `statusIn`, branch-ahead/current-branch/ancestry, and non-missing commit
  resolution no longer synthesize empty or clean state. Broker harvest,
  evidence/materiality, cleanup, and promotion paths propagate or preserve on
  query failure. Injected failures prove no unverified handoff or promotion,
  no gate evidence on an invalidated capture, and retention of cleanup targets
  when ancestry cannot be established.
- Installed/default mission-recovery dogfood now requests the production
  checkpoint tool and a bounded interruption rather than accepting a
  straight-line completion. The result must contain durable checkpoint and
  recovery history with attempt greater than zero, a stale late-result
  rejection, preserved work, a fresh `local/local`
  `same_model_reduced` review record, and an actionable next step/stop whenever
  zero workers remain. The fake installed fixture exercises the same contract;
  local-only, metabolomics-disabled, temp-only, exact installed SHA, and clean
  installed-tree guards remain mandatory.

### Final verification evidence

- Focused artifact/lock/Git/broker/recovery/mission suites passed.
- `npm run test:unit`: 2,349 passed.
- `npm run test:integration`: 339 passed; 1 optional test skipped.
- `npm run test:mission-reliability`: 37 passed.
- `npm run build`: core and scripts TypeScript checks passed.
- `npm run lint`: 592 files checked, no errors.
- `npm run test:e2e`: package load passed with 21 commands and 7 tools.
- `git diff --check`: passed.

No push, PR, merge, or installation was performed in this final fix wave.

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
- Each store pins the device/inode identity of `.artifact-locks`; a replacement
  real directory is rejected before a second store can enter the same key's
  critical section. Lock and recovery-claim owner records use a strict process
  incarnation schema, and recovery claim reaping/release is device/inode bound.
- Lock-domain authority is now durably rooted in `.artifact-lock-domain.json`,
  outside the replaceable lock directory. Its fsynced device/inode/token binding
  is checked during store creation and every lock-root open, so a store opened
  only after replacement cannot adopt the replacement as a new domain.

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
Mutable records are rejected explicitly: dispatch additionally requires
`immutable: true`, an `IMMUTABLE_ID`, and equality between the digest embedded
in that ID and the persisted SHA-256.
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
- durably deletes content and metadata, fsyncs the category while the recovery
  journal still exists, then removes the journal and fsyncs the category again;
- serializes mutation with the tokenized `ExclusiveFileLock`, then rereads
  durable metadata under that lock before put/delete decisions;
- pins and validates the `.artifact-locks` directory from the already pinned
  root, addresses locks through that descriptor, and retains it through
  owner-conditional release so a directory swap cannot redirect or split the
  lock domain; the store also preserves the directory's initial device/inode
  identity and rejects a later real-directory replacement before lock entry;
- publishes a private token inside the pinned lock directory and atomically
  hard-links a fsynced device/inode/token record into the artifact root. A
  missing lock directory is never recreated once that durable authority exists;
- binds stale takeover and release to the acquired token, device, and inode.
  Replacement is quarantined atomically, revalidated, and either removed,
  restored without replacement, or preserved as a diagnostic instead of
  deleting an unproven inode;
- records the Linux boot ID and `/proc/<pid>/stat` start time in each lock owner.
  PID reuse and boot changes are stale; unavailable or incomplete incarnation
  evidence fails closed. Owner records require a positive safe-integer PID,
  nonempty hostname/token, UUID-shaped boot ID, and positive digit-only process
  start time; malformed or unsupported values are never classified stale;
- keeps every observed lock and claim inode pinned by an explicitly owned file
  descriptor until publication, quarantine, reaping, or release has completed.
  Quarantine names are revalidated against that pin immediately before removal,
  and all retry, mismatch, malformed-record, exception, and success paths close
  their descriptors deterministically;
- binds recovery claims to their published device/inode identity. Dead-claim
  reaping and release both quarantine and revalidate that exact identity, so a
  same-token replacement is restored or preserved and recovery aborts instead
  of deleting an unproven inode;
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
test proved no journal recovery existed.

Fix round 3 added five red groups: mutable records could reach dispatch; delete
did not expose or prove both durability barriers; `.artifact-locks` was not
pinned from the root through release; same-token replacement inodes could be
removed during stale takeover or release; and PID existence alone treated a
reused PID as its prior owner. The repaired suites cover both SIGKILL delete
phases, deterministic lock-directory replacement, same-token/new-inode
replacement at takeover and release, reused-PID and changed-boot recovery, and
fail-closed missing incarnation evidence.

Fix round 4 added four red groups: two existing stores could enter split lock
domains after a real `.artifact-locks` replacement; zero/fractional PID and
malformed boot/start fields could be recovered as stale; recovery-claim release
could delete a same-token replacement; and the dead-claim reaper could unlink a
same-token replacement after tombstone publication. The repaired suites also
retain the simultaneous stale-reaper proof that critical-section concurrency
never exceeds one.

Fix round 5 added a red reopened-store proof: while an older holder retained the
original directory, replacing `.artifact-locks` let a newly opened store adopt
the replacement. The inode-race fixtures now attempt immediate reuse at the
fixed name without reservation files for claim release, dead-claim reaping, and
stale takeover. The first full-suite run also exposed a descriptor-lifecycle
fault: Node could garbage-collect a `FileHandle` wrapper across a deliberately
nonsettling recovery hook, closing the intended pin and crashing the claimant.
Pins now use explicitly owned numeric descriptors; the live-claim process race
then passed 20 consecutive runs before the focused and full suites.

## Verification

Fresh verification on the final working tree:

- `npm run test:mission-reliability` — 37 passed.
- focused ArtifactStore and platform lock suites — 44 passed.
- expanded broker/recovery/artifact/platform lock suites — 209 passed.
- focused tools/verifier suites — 15 passed.
- `npm test` — 2,678 passed; 1 optional Postgres test skipped because
  `TEST_DATABASE_URL` is unset.
- `node --test test/unit/cav-explore.test.ts` — 3 passed twice after the page
  exception fixture was made deterministic for either focus or click selection.
- `npm run build` — core and scripts TypeScript checks passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — package load passed with 21 commands and 7 tools.
- `git diff --check` — passed.

Fix-round-5 base: `bf4dd89`.
Fix-round-4 base: `4839e67`.
Fix-round-3 base: `c821026b7780b12086f544f633b9c35afd9ee87c`.
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
  durable authority and retain both the root and `.artifact-locks` descriptors
  until conditional release.
- Attack replay with missing immutable markers, metadata
  filename/category/URI disagreement, orphan content, and symlinked category or
  final files; all must fail closed without touching outside files.
- Confirm the journal is durable before either final file changes, replay
  completes only a digest-valid transaction, and no dispatch occurs while a
  journal remains incomplete. For delete, confirm the first category fsync
  precedes journal removal and a second category fsync follows it.
- Confirm directory ownership/mode checks plus pinned `/proc/self/fd` traversal
  close category-parent swaps without relying on lexical containment.
- Confirm stale takeover and release never unlink a lock by token alone: the
  named token/device/inode identity must survive quarantine revalidation, and
  process liveness must include boot ID plus process start time.

## Remaining Scope Boundaries

Slice 2 still owns coordinated cross-repository publication and remote
branch/PR/check/merge reconciliation. Slice 3 still owns database-backed
distributed leases/controllers and remote worker reconciliation. Those
exclusions are unchanged by these prerequisites.
