# Verification and release gates

## Per microtask gate
1. Correct original authority hash, predecessor approved and base SHA clean.
2. Exact candidate file allowlist: zero unauthorized modifications (including generated/untracked files).
3. <=2 production files, <=2 tests, target <=100 changed lines (Herdr UI <=120). If exceeded: block and approve split first.
4. Declared acceptance tests execute with recorded exit code and logs; `git diff --check` clean.
5. No background tests/processes left in unknown state.
6. No independent model self-approval; human-controlled gate before next task.
7. Never edit main branch directly; isolated worktree/branch and verified commit.

## Phase gates
- After B05: demonstrate failing closed on forbidden paths, missing tests, dirty worktree and mismatched handoff. Do not run workers under B04 before this.
- After E07: error streams survive concurrent sessions and injected crashes, and secrets are absent.
- After D08: diagnose command is read-only and model diagnosis cannot trigger edits.
- After T09: reject out-of-scope candidates and fail-open planner fallback tests.
- After R08: single retry owner, idempotency classifier, no automatic self-repair; feature flag OFF by default.
- After H07: Herdr read-only views show source evidence, not fabricated metrics; no duplicate control plane.
- After V06: final source-and-runtime audit; rollout requires separate operator decision.

## Promotion policy
Start shadow-only. For any intervention, test planted violations, legitimate exploration, unknown/partial state, restart and handoff with hash mismatch. Require zero unauthorized writes in the test matrix and no duplicate acting retry owner. Benchmark false positives before blocking semantic deviations. Use `npm run typecheck`, targeted node --test and later full `npm test` once safe; do not run full heavy suite on every tiny change.
