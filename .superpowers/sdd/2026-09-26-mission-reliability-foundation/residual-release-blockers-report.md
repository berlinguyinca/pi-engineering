# Residual release blockers implementation report

## Outcome

Both authorized residual release blockers were corrected in one bounded TDD cycle:

1. Artifact lock-domain bootstrap now publishes a no-clobber authority marker, stages and descriptor-pins the exact directory inode before publishing that authority, recovers every instrumented crash boundary, rejects path substitution, and converges concurrent first openers on one durable domain.
2. Mission-recovery dogfood now parses JSONL records strictly and proves one ordered, mission-bound recovery lineage from checkpoint through stale-result rejection, replacement candidate, fresh `local/local` / `same_model_reduced` review, and successful recovery. Summary booleans are returned from that structured proof.

No dependency, public package contract, install state, PR, push, merge, or unrelated area was changed.

## Files changed

- `src/artifacts/ArtifactStore.ts`
  - Stages `.artifact-locks` under a token-derived private name and pins its descriptor before publishing bootstrap authority.
  - Publishes the bound bootstrap record with a hard link, so an existing authority cannot be overwritten.
  - Moves only the identity-checked staged inode into the final name and validates the named inode again before accepting the domain.
  - Recovers bound staged/final states after injected crashes and retains conservative compatibility handling for legacy prepared markers.
- `scripts/dogfood-mission-recovery.ts`
  - Strictly parses JSONL line-by-line and reports malformed line numbers.
  - Selects only records whose `run_id` matches the asserted snapshot mission.
  - Binds checkpoint, original execution, mission generation, recovery decision, supersession, replacement task, candidate identity, review evidence, and successful recovery in append order.
  - Requires review model `local/local`, independence mode `same_model_reduced`, valid/accessible approving output, and a fresh reviewer session.
  - Derives all emitted recovery-proof booleans from the parsed proof result.
- `test/unit/artifacts.test.ts`
  - Adds deterministic same-name substitution, concurrent first-open, and pre-open crash recovery coverage.
- `test/integration/mission-reliability-foundation.test.ts`
  - Upgrades the fake durable log to the real stored-event schema.
  - Adds wrong-mission, nested-counterfeit, out-of-order, failed-recovery, wrong-recovery, malformed-JSONL, and valid-sequence cases.

## Strict TDD evidence

### Artifact bootstrap RED

Command:

```text
node --test --test-name-pattern='bootstrap binds' test/unit/artifacts.test.ts
```

Expected RED:

```text
fail 1
AssertionError: Missing expected rejection.
```

This proved the pre-open directory-substitution hook was not exercised and a replacement name was accepted.

Command:

```text
node --test --test-name-pattern='concurrent first openers' test/unit/artifacts.test.ts
```

Expected RED:

```text
fail 1
Error: ARTIFACT INTEGRITY: artifact lock root bootstrap token changed
```

This proved concurrent first openers overwrote bootstrap authority instead of converging.

Command:

```text
node --test --test-name-pattern='bootstrap recovers' test/unit/artifacts.test.ts
```

Expected RED:

```text
fail 1
AssertionError: Missing expected rejection.
```

This proved the newly required directory-created-before-open crash boundary did not exist.

### Artifact bootstrap GREEN

Command:

```text
node --test --test-name-pattern='bootstrap binds|concurrent first openers|prepared bootstrap|bootstrap recovers|bootstrap fails closed' test/unit/artifacts.test.ts
```

Meaningful output:

```text
tests 5
pass 5
fail 0
```

### Mission-bound dogfood RED

Command:

```text
node --test --test-name-pattern='dogfoods the uniquely|rejects (wrong-mission|nested-counterfeit|out-of-order|failed-recovery|wrong-recovery|malformed) dogfood' test/integration/mission-reliability-foundation.test.ts
```

Expected RED:

```text
tests 7
pass 2
fail 5
```

The raw substring implementation incorrectly accepted wrong-mission, out-of-order, failed-recovery, wrong-recovery, and malformed-JSONL evidence. The nested-string case already failed closed because JSON escaping prevented its counterfeit text from matching; it remains as an explicit regression.

### Mission-bound dogfood GREEN

The same command after the minimal parser/proof implementation produced:

```text
tests 7
pass 7
fail 0
```

## Verification

- `node --test test/unit/artifacts.test.ts` — 27 passed, 0 failed.
- `node --test test/integration/mission-reliability-foundation.test.ts` — 43 passed, 0 failed.
- `npm run typecheck` — core and scripts TypeScript checks passed.
- `npm run lint` — 592 files checked, no fixes required.
- `npm run test:e2e` — command/tool registration and package load passed (`21 commands`, `7 tools`).
- `npm test` — 2,696 passed, 0 failed, 1 optional Postgres test skipped because `TEST_DATABASE_URL` was not configured.
- `git diff --check` — passed.

## Self-review

- Replaced the initial direct-directory repair with staging-before-publication after review identified a remaining crash interval between `mkdir` and durable inode binding.
- Confirmed bootstrap candidates and durable domain records both use hard-link publication for no-clobber semantics.
- Confirmed a winning process keeps the staged directory descriptor pinned across rename; recovery reopens only the token-derived staged name and requires exact device/inode/token equality.
- Confirmed the final named inode is checked after domain publication and bootstrap cleanup.
- Confirmed dogfood proof uses the repository's actual `StoredEvent` envelope and orchestration payload field names rather than invented text markers.
- Confirmed unrelated missions and nested strings cannot enter the selected mission event stream.
- Confirmed review identity equality covers workspace manifest hash, mission generation, repository/base/candidate/diff identity, acceptance IDs, and artifact hashes.
- Confirmed no metabolomics or model-selection behavior changed; the live gate remains exactly `local/local`.

## Concerns / known gaps

- The repository-wide suite intentionally skipped the optional Postgres OpenViking round-trip because `TEST_DATABASE_URL` was absent; this is unrelated to both blockers.
- Legacy `prepared` bootstrap markers remain conservatively supported for upgrade recovery. New bootstraps never publish an unbound named directory: they publish only after staging, token creation, descriptor pinning, and inode binding.

## Independent-review fix round — claimant/helper publication race

### Finding

Independent review found one remaining legitimate concurrency failure: after the winning claimant published the bound bootstrap marker, a helper opener could rename the claimant's exact staged inode into `.artifact-locks` and complete publication first. When the claimant resumed, it treated the now-present final path as hostile substitution even though the final device/inode was its own still-pinned staged directory.

### TDD RED

Added a deterministic two-process interleaving regression. The claimant blocks in `afterLockBootstrapBound`; the helper opens the same root, publishes the exact staged inode, writes through the resulting store, and then releases the claimant.

Command:

```text
node --test --test-name-pattern='original bootstrap claimant accepts' test/unit/artifacts.test.ts
```

Expected RED:

```text
tests 1
pass 0
fail 1
Error: ARTIFACT INTEGRITY: artifact lock root path was substituted during bootstrap
```

This reproduces the independent review finding exactly and proves the prior probabilistic concurrent-open test did not lock the critical ordering.

### Minimal fix

At the final-name arbitration point, the claimant now compares the named path's device/inode with its still-pinned staged descriptor:

- exact device/inode equality means another legitimate opener published the already-authoritative staged inode, so the claimant converges on it;
- any different device/inode remains a same-name substitution and fails closed;
- a missing final name still follows the original rename-and-fsync publication path;
- token and bound bootstrap identity validation still occur before this decision, and final named identity validation still occurs afterward.

### GREEN and verification

Focused command:

```text
node --test --test-name-pattern='original bootstrap claimant accepts|bootstrap binds|concurrent first openers|prepared bootstrap|bootstrap recovers|bootstrap fails closed' test/unit/artifacts.test.ts
```

Output:

```text
tests 6
pass 6
fail 0
```

Broader evidence after the fix:

- `node --test test/unit/artifacts.test.ts` — 28 passed, 0 failed.
- `npm run typecheck` — core and scripts passed.
- `npm run lint` — 592 files checked, no fixes required.
- `npm test` — 2,697 passed, 0 failed, 1 optional Postgres test skipped because `TEST_DATABASE_URL` was absent.
- `npm run test:e2e` — command registration and package loading passed (`21 commands`, `7 tools`).
- `git diff --check` — passed.

### Fix-round self-review

- The new acceptance branch cannot authorize a replacement inode: it requires equality with the already-bound and descriptor-pinned staged inode.
- A symlink, independently created directory, or renamed replacement has a different inode and still triggers the substitution error.
- The claimant continues using its pinned descriptor after a helper rename, so there is no second name-based reopen.
- Either opener may publish the durable domain record first; existing hard-link no-clobber publication makes both converge on the same token/device/inode record.
- Crash hooks and legacy prepared-marker recovery remain unchanged and passed their complete artifact regression suite.
