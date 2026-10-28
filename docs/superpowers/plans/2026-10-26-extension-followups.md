# Remaining extension reliability fixes

**Goal:** Repair all six findings from the post-merge audit of PR #439.

**Architecture:** Preserve existing public behavior and security checks while repairing ownership boundaries: Git errors must stop integration, unfinished work must remain recoverable, lock metadata must not collide with Git's safety scan, scheduler observations must identify the provider/model, memory commands must survive ordinary turn changes, and inspector attachment must own its shutdown cleanup.

**Constraints:** No new dependencies. No live credentials, installation updates, or production configuration changes. Work only on the isolated feature branch. Keep full Git safety checks and session/connection fences. Tests use temporary repositories/profiles and local HTTP or deterministic deferred operations.

## Tasks

- [x] Git safety and output preservation: regress the legitimate lock-publication race and failed add/status/head/diff paths; stop on failed Git queries, verify integration before completion, and preserve unharvested work on failure. Repair the lock namespace/protocol without broad hard-link exemptions or changing the shared file-lock contract. Verify DAG and planner-worker regressions.
- [x] Provider isolation: regress independent providers and colliding model IDs; scope catalog capacity observations to provider/base URL and chosen task model; preserve explicit scheduler limits. Ensure unrelated health refreshes cannot change an existing mission's scheduling capacity. Retain dry-run fences and handle advertised zero capacity honestly.
- [x] Memory command lifetime: regress saves/checks/searches spanning the next turn, stale automatic success/error, and real session/credential replacement. Reserve session generation for session/connection changes, and use the automatic lookup epoch for turn changes.
- [x] Inspector lifecycle: regress attachment during awaited shutdown and explicit disposal; register lifecycle cancellation before config fetch, suppress/dispose late attachments, and make the handle own runtime reporter cleanup. Use unique session IDs in lifecycle tests without changing intentional seen-session behavior.
- [x] Integrate: targeted suites, typecheck, changed-file lint/static checks, package/loading smoke, complete Node 22 project test run, independent implementation and architecture review; resolve material findings, commit with Lore trailers, push and open a PR.

## Validation

Each defect must have a regression observed failing before its implementation. The full-suite baseline from PR #439 included real parallel-lock/output failures, an inspector fixture identity failure, flaky resource-count equality assertions, and 16 unrelated lint errors. Browser runtime is now installed. Distinguish newly fixed failures, remaining baseline defects, and environmental gaps precisely. Do not weaken assertions to obtain a green result.

## Evidence and review decisions

- Final focused verification passes 254/254 tests on Node 22.23.2. Core/scripts typecheck, package/command loading smoke, changed-file Biome (20 TypeScript files), and whitespace checks pass.
- Git lane additionally passes 71/71 tests, including real lock-publication, refused-query, output-preservation and fresh-resume regressions. Four verification/review mutation cases demonstrated a new review finding before sealing the integration commit.
- Independent implementation review approves the whole branch; final architectural status is CLEAR. Review required durable resume preservation and binding verification/application to the same clean commit; both were implemented and retested.
- Unknown or ambiguous task routes intentionally use configured scheduler limits; a requested pin is not authoritative pre-dispatch routing. Local process/validation/integration work ignores model capacity. Explicit scoped routes retain advertised capacity, including zero.
- Git safety scan and shared file-lock publication stay unchanged. All lock sites use validated private metadata; legacy entries fail closed. All older mutating processes must be drained/restarted before deploying the new namespace. Failed workspaces require deliberate recovery, not destructive automatic resume.
- Existing same-provider endpoint/credential rotation in the health cache is unchanged; this work isolates scheduling observations and does not redesign health-cache refresh policy.
- Repository-wide lint still reports 13 pre-existing errors (down from 16 because the touched inspector tests were formatted). No unrelated assertions were weakened.
- The full suite started before the final small commit-sealing follow-up. The affected Git/planner suites and all 254 focused tests were rerun on final source afterward; do not represent the broad baseline run as an exact final-head rerun.
- Broad Node 22 run finished: 6,157 pass, 2 fail, 1 skip, 10 TODO (6,170 tests). The remaining failures are housekeeping's active-resource-count equality and quiet mission activity's 1.1-second timer assertion. The first was already observed before these changes; the second also fails on pristine `f8ae867`. The reported DAG/planner output and inspector lifecycle fixture failures are resolved. Browser tests ran with the installed runtime.
