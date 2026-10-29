# Phase 1 results (final diff)

| Check | origin/main baseline | Phase 1 |
|-------|----------------------|---------|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run lint` | exit 0 | exit 0 |
| `npm test` | 6554 tests, 6552 pass, 1 fail, 1 skipped | 6565 tests, 6563 pass, 1 fail, 1 skipped |

Failures are load-dependent flakes, not regressions:
- Baseline: `parallel tournament candidates run concurrently in isolated worktrees` (vertical-slice). It passed in the Phase 1 run. I did not rerun it alone on the baseline.
- Phase 1 run: `outbox perf: stage + deliver scales linearly` (`test/unit/envelope-v2-hardening.test.ts`). Rerun alone: 1 fail, then 1 pass with no code change. The diff does not touch the outbox.
- An earlier Phase 1 run (before the test fixes) showed 12 failures: 5 were the legacy-hook tests in `extension-auto-invoke.test.ts` (fixed by opting them into legacy) and the rest passed when each file was rerun alone.

New tests: 11 (corpus, wrapper, policy defaults/yaml/invalid/gates, real-extension default, string-typed flag).
O1 corpus: legacy 3/8 prompts injected the Mission directive, new default 0/8 (`PHASE-1-O1-CORPUS.json`).
Not measured: time to first tool call, subagent launches (needs a live model).
