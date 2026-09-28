# Task 11 Report — Local Mission Reliability End-to-End Proof

## Outcome

The public `MSN-qSLaeM` proof runs from a real non-Git meta-root across two
explicitly authorized repositories. Its initial worker is a real
`PiWorkerExecutor` driven by a deterministic OpenAI-compatible transport and
uses the production `checkpoint_progress` tool after committing two of three
deliverables. The
broker independently checks the exact candidate SHA and committed evidence
paths, times the worker out, rejects its late result, and repairs only the
remaining deliverable. Validation and a distinct same-model review session are
bound to the current candidate; reduced independence is recorded as
`same_model_reduced`.

Conflict and red-validation paths compare the complete incumbent HEAD, index,
status, and tracked/untracked content. Restart replay, exhausted fingerprints,
zero-worker orphan recovery, and independent second-mission repository leases
remain covered. A mission succeeds only as `COMPLETE` with current verified
evidence or as an explicitly allowed stopped state with a structurally complete
actionable stop.

## Fix Round 4 Trust Boundaries

- Accepted `checkpoint_progress` artifact bodies are copied to unique,
  checkpoint-owned content-addressed URIs. Persisted URI/hash arrays stay
  one-to-one even for concurrent equal-content claims and survive artifact-store
  replay. Worker-owned source mutation or deletion cannot change the snapshot.
- Immediately before recovery dispatch, every checkpoint artifact is resolved
  and SHA-256 hashed again. Missing, overwritten, or replay-corrupt checkpoint
  content rejects recovery before a replacement worker runs.
- Dogfood `COMPLETE` review findings now require the runtime severity and status
  enums, exact `repaired`/`resolved` consistency, and an exact `blockingOpen`
  count using CompletionGate semantics (`blocking && status !== resolved`). An
  accepted blocking finding therefore rejects completion.

## Fix Round 3 Evidence Boundaries

- Checkpoint artifact references are now resolved through the runtime artifact
  store. Missing, invented, or unreadable references reject the whole progress
  claim. Accepted references persist content-derived SHA-256 hashes in exact
  one-to-one order, including distinct references with identical content.
- Repository-bound lifecycle diagnostics and preserved-reference collection
  both throw typed `RepositoryLifecycleInventoryUnavailableError` with
  `PERSISTENCE_UNAVAILABLE` when the Git provider itself is absent or any
  required inventory API is missing. Recovery fixtures now provide a complete
  inventory double or real temporary `GitRepo`.
- The headline scenario no longer fabricates an activity callback. Its model
  transport invokes `bash`, then `checkpoint_progress`, then stalls; the public
  runtime/broker path records and recovers the authenticated 2/3 checkpoint.
- Snapshot-v3 `COMPLETE` validation now requires every declared criterion to be
  `passed`, exact acceptance totals, `completed = passed + failed + skipped`, a
  passing nonfailure validation result, completed review, and a blocking count
  consistent with review findings. Adversarial fixtures cover each
  contradiction.

## Fix Round 2 Trust Boundaries

- Plain `WorkerActivity` deliverable names no longer grant checkpoint
  authority. The Pi executor registers and translates one explicit production
  tool event, and the broker accepts each claim only when the declared
  deliverable, current candidate SHA, and committed path evidence all match its
  own Git snapshot.
- Missing candidate/integration/promotion/cleanup inventory capabilities now
  throw typed `PERSISTENCE_UNAVAILABLE`. Tests use complete Git doubles. The
  repository root is no longer substituted for missing preserved work; only
  actual candidate, worktree, branch, committed path, and artifact references
  are reported.
- Installed dogfood resolves the unique package with `--no-extensions`, then
  verifies exact HEAD and a clean tracked tree, index, and untracked set before
  any Pi invocation that may load extensions. Source mode uses
  `--no-extensions` on every preliminary Pi invocation.
- Runtime snapshot v3 is validated from `unknown`: required objects and fields,
  string/boolean types, and finite nonnegative integer counters are checked.
  `COMPLETE` requires nonzero declared acceptance, exact coverage, and current
  verified/approved evidence. Allowed stopped states require nonempty reason,
  resume condition, recovery IDs, and preserved-work entries. Missing and
  malformed fake-Pi snapshots exit nonzero.

## Strict TDD Evidence

The new regressions were observed red before production repair:

- checkpoint claims retained their mutable worker-owned artifact URIs;
- COMPLETE dogfood accepted invalid review severity/status values, an accepted
  blocker, and contradictory `repaired`/`status` pairs;
- the real OpenAI-compatible Pi executor completed without emitting any
  authenticated checkpoint activity;
- installed dogfood called model discovery before package resolution and did
  not reject a dirty installation;
- source-mode preliminary model discovery omitted `--no-extensions`;
- the legacy activity field could assert a completed deliverable without SHA or
  path proof;
- lifecycle inventory silently omitted unsupported providers and stopped-work
  reporting substituted a repository root;
- malformed and missing v3 snapshots were not comprehensively rejected.

## Verification

Fresh round-4 final verification:

- `npm run test:mission-reliability` — 30 passed.
- artifact and broker-recovery focused suites — 20 passed.
- `PI_CODING_AGENT_DIR=/tmp/pi-task11-empty-agent npm run test:unit && npm run test:integration`
  — 2,317 unit tests passed; 332 integration tests passed; 1 optional Postgres
  test skipped because `TEST_DATABASE_URL` is unset. The empty unit-only agent
  catalog prevents the advisory vision unit test from contacting a configured
  local model; integration runs with the real catalog for same-model fallback.
- `npm run typecheck` — core and dedicated script configs passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — 21 commands and 7 tools loaded.
- `git diff --check` — passed.

Fresh round-3 final verification:

- `npm run test:mission-reliability` — 22 passed.
- artifact/inventory and snapshot-contract focused tests — 11 passed; the
  public Pi-tool chain is also covered by the 22-test mission suite.
- `npm run test:unit` — 2,316 passed.
- `npm run test:integration` — 324 passed, 1 optional Postgres skip because
  `TEST_DATABASE_URL` is unset.
- `npm test` — 2,640 passed, the same 1 optional Postgres skip.
- `npm run typecheck` — core and dedicated script configs passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — 21 commands and 7 tools loaded.
- `git diff --check` — passed.

## Dogfood Safety and Installed Result

The script refuses any model except exact `local/local` and rejects enabled or
advertised metabolomics. It never creates a repository until install/source
guards, package identity, SHA, cleanliness, model catalog, and canonical temp
parent checks pass. It creates and mutates only a fresh temporary repository.
Default verification relies on installed discovery and never passes
`--extension`; source-only diagnostics are explicitly labeled and use
`--no-extensions` before one explicit source extension. Durable output includes
the public mission ID, revision, status, snapshot contract/path, acceptance
coverage, observability preserved work, and typed stop.

## Explicit Exclusions and Reviewer Focus

- Slice 2 still owns coordinated cross-repository publication,
  repository-head vectors, and remote branch/PR/check/merge reconciliation.
- Slice 3 still owns database-backed distributed leases/controllers and remote
  worker reconciliation.
- Review artifact-store resolution and the one-to-one URI/content-hash merge,
  especially equal-content artifacts and late activity after authority loss.
- Review fail-closed lifecycle inventory for both absent Git and incomplete
  providers, and confirm stopped-work surfaces contain no repository-root
  fallback.
- Review the headline transport sequence to confirm the initial 2/3 progress is
  emitted only by the real Pi tool path.
- Review installed-package call order/cleanliness and exhaustive v3 snapshot
  validation. The default Task 12 path remains installed-package verification.
