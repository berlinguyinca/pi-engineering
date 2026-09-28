# Task 11 Report — Local Mission Reliability End-to-End Proof

## Outcome

The public `MSN-qSLaeM` proof runs from a real non-Git meta-root across two
explicitly authorized repositories. Its Pi worker uses the production
`checkpoint_progress` tool after committing two of three deliverables. The
broker independently checks the exact candidate SHA and committed evidence
paths, rejects a spoofed claim visibly, times the worker out, rejects its late
result, and repairs only the remaining deliverable. Validation and a distinct
same-model review session are bound to the current candidate; reduced
independence is recorded as `same_model_reduced`.

Conflict and red-validation paths compare the complete incumbent HEAD, index,
status, and tracked/untracked content. Restart replay, exhausted fingerprints,
zero-worker orphan recovery, and independent second-mission repository leases
remain covered. A mission succeeds only as `COMPLETE` with current verified
evidence or as an explicitly allowed stopped state with a structurally complete
actionable stop.

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

Fresh final verification:

- `npm run test:mission-reliability` — 16 passed.
- broker plus real Pi-tool focused tests — 21 passed.
- `npm run test:unit` — 2,315 passed.
- `npm run test:integration` — 318 passed, 1 optional Postgres skip because
  `TEST_DATABASE_URL` is unset.
- `npm test` — 2,633 passed, the same 1 optional Postgres skip.
- `npm run typecheck` — core and dedicated script configs passed.
- `npm run lint` — 592 files checked, no errors.
- `npm run test:e2e` — 21 commands and 7 tools loaded.
- `git diff --check` — passed.

One unrelated unit test (`cav-explore.test.ts`, page-exception fail-closed) was
flaky during the first broad unit run; the Task 11 regression itself was also
made deterministically wait for its queued checkpoint diagnostic rather than
depending on wall time. Fresh final results supersede that intermediate run.

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
- Review the tool-event translation and broker SHA/path validation, especially
  late activity after authority loss and final checkpoint merging.
- Review fail-closed lifecycle inventory and confirm stopped-work surfaces
  contain no repository-root fallback.
- Review installed-package call order/cleanliness and exhaustive v3 snapshot
  validation. The default Task 12 path remains installed-package verification.
