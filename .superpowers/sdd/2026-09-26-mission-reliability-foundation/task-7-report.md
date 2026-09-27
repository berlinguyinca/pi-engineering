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
