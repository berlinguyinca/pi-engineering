# Extension reliability implementation plan

**Goal:** Fix the lifecycle, model-configuration, memory latency, and split-view problems identified in the investigation.

**Architecture:** Preserve existing extension APIs and behavior, repairing ownership and lifetime boundaries. Use optimistic conflict detection for configuration writes, existing bounded memory caching where available, and lazy/bounded UI bookkeeping. No new dependencies; no live credential or installation changes.

**Tech stack:** TypeScript, node:test, existing Pi extension APIs.

**Scope:** User-authorized fixes to the reported investigation findings, including the original refresh reload error. Newer main already moves panel initialization off the startup critical path; retain that improvement. Authentication failures must be surfaced and backed off; never fabricate or replace credentials.

## Tasks

- [x] Model refresh: write regression tests for edits during network waits and dry-run admission changes; run red; implement conflict rejection without overwriting unrelated fields, and prevent dry-run scheduler mutation; run model suites.
- [x] Memory: inspect newer cache implementation; cover missing auth-failure backoff/cache behavior and startup/turn budgets; run red before any needed fixes. Verify configured endpoint without exposing credentials.
- [x] Split view: regress restored tool text, disabled-panel bookkeeping, response history bounds, and synchronous shell path scans; run red; implement lazy bounded response state and filesystem-free shell bookkeeping; preserve toggles and live outputs.
- [x] Reload: regress stale context invalidation in both refresh and sync commands; run red; notify/clear widgets before reload and never access old context afterwards; preserve accurate write/error reporting.
- [x] Integrate: targeted tests, typecheck, formatting/lint, full project tests, command/loading smoke checks; independent review and fix material findings.

## Validation and limits

Use temporary directories and local HTTP servers for network/write races. Lifecycle tests must invalidate contexts after reload. Do not change the user's live models, token files, or running sessions. Report remaining baseline failures and authentication errors explicitly.

## Evidence

- Focused reliability suites: 93/93 pass under Node 22.23.2; model lane additionally passed 98 model tests.
- Core and scripts typecheck pass; command/package smoke checks pass; changed-file Biome checks pass.
- Independent core review approved; split-view architectural review is CLEAR after documentation corrections.
- Full repository lint has the same 16 existing failures on pristine base and this branch; no unrelated formatting changes made.
- The saved memory token is rejected with HTTP 401. Profile structure and whitespace handling are valid; no verified replacement credential exists locally. Code handles rejection without repeated per-prompt requests; the credential itself remains unchanged.
- Model writes use optimistic conflict detection around the asynchronous planning window; they are not cross-process filesystem transactions.
- Added profile isolation to the test preload after discovering existing tests could update the live memory revision marker. Both Pi profile conventions now default to temporary storage; missing/empty settings and explicit overrides have subprocess coverage. The marker was restored to the installed release; host/token settings were preserved.
- Full Node 22 suite: 6,105 pass, 25 fail, 1 skip, 10 todo (6,141 tests). Twenty failures were a missing Playwright browser; after installing the browser, all 24 browser tests pass.
- Remaining full-suite failures outside this change: DAG parallel execution (worktree hard-link lock refusal), long task-id planner execution (same refusal/missing output), inspector lifecycle (started vs restarted), real Host reload resource-count equality, and housekeeping resource-count equality. The first four reproduce on pristine main; housekeeping passes in isolation on both main and this branch. No unrelated assertions were weakened.
- Node 26's changed Undici dispatcher internals break two existing timeout tests; these pass under Node 22.23.2, used for the final full-suite run.

## Merge review follow-up

- Independent review found that an automatic memory lookup could repopulate stale cache or failure backoff after a successful explicit save/check/search. A dedicated automatic lookup epoch now retires those pending producers without invalidating command contexts.
- Six overlap regressions failed before the fix and pass afterward. Current-head focused verification passes 99/99 tests, full core/scripts typecheck and loading smoke checks. The memory lane additionally passes 115/115 tests. Both independent re-reviews approve, with architectural status CLEAR.
- The 6,141-test full-suite results above apply to the initial PR head; the small merge-review follow-up was verified with the targeted suites rather than repeating that baseline run.
