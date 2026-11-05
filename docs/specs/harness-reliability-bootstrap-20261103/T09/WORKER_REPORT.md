# T09 worker report — scope-integrity gate before integration

Commit: `3bb21ab2` `feat(planner-worker): scope-integrity gate before integration (T09)` (amended per conductor budget verdict; base `11131ece730d723c1e497d860c6185a717b8691f`).

## Diff vs base (hard cap: 100 total changed lines)

```
$ git diff --numstat 11131ece730d723c1e497d860c6185a717b8691f HEAD
54	1	src/plannerWorker/executor.ts
41	0	test/unit/planner-worker-scope-gate.test.ts
```

Total = 54 + 1 + 41 = **96** ≤ 100. Production 55 changed lines, test 41 (new file). Only these two files are in the commit.

## What was implemented (HANDOFF.md + binding PATCH.md amendment)

- `src/plannerWorker/executor.ts` (holds the predicate):
  - `export const PROTECTED_TASK_AUTHORITY_GLOBS` — the six documented authority families (`docs/specs/**/manifests/**`, `docs/specs/**/*.handoff.json`, `docs/specs/**/fixtures/**`, `docs/specs/**/templates/**`, `templates/**`, `scripts/bootstrap-*.ts`).
  - `export const scopeIntegrityCheck` — pure, deterministic (input order, deduped, bounded to 20, `…(+N more)` note only inside `refs`, never invented), reuses `scopeViolations`/`matchesScope` (review.ts) and `matchesGlob` (contract.ts); protected hits unauthorized even inside scope; never throws (non-string entries ignored, empty diff → `{ ok: true }`); no git/fs/clock/RNG.
  - `export const scopeGateBlockedReason` → exactly `"evidence: scope gate: " + refs` (the `evidence: ` prefix is what the blocked-evidence path consumes).
- `test/unit/planner-worker-scope-gate.test.ts` — dense rewrite, 4 its covering every previously covered behaviour: out-of-scope paths named in input order with exact recoverable refs; in-scope diff ok with refs still naming the attempt; protected hit inside scope unauthorized + `authorityProtected` override; all six families matched (incl. `scripts/bootstrap-one.ts`) with ordinary `src/**` clean; dedup order, bound to 20 with note only in refs, empty diff and non-string entries inert, same input deep-equals; `scopeGateBlockedReason` exact prefix (PATCH item 5). No behaviour lost vs the rejected commit.

## Wiring (per PATCH.md: after commit, recoverable)

- Gate location: `attempt()` in `src/plannerWorker/executor.ts`, immediately **after** `commitAttempt(rt)` and **before** verification/review/integration — covers both immediate-review and batch-review paths to `accept()`/`integrate()`.
- Path collection (git, in the contract worktree): `git diff --name-only <rt.baseCommit> <HEAD>` plus `git ls-files --others --exclude-standard`.
- On `ok: false`: (1) `keepSuperseded()` creates `refs/heads/superseded/<branch>-<stamp>` on the attempt commit, collision-suffixed (`.1`, …) exactly like `resetWorktree()`, so a later reset cannot orphan the diff — nothing deleted or reset in this path; (2) `rt.state.blocked_reason = scopeGateBlockedReason(refs)`; (3) `phase` event with the same refs naming the preserved ref; (4) `setStatus(rt, "blocked", …)`; (5) return `"done"` — `integrate()` never called.
- `accept()`/`integrate()` unchanged; pre-existing `scopeViolations` review signal untouched (PATCH item 4). No new sandbox or shell hook; no denied file touched; no new state field in `types.ts`.

## Verify (the only two commands run)

| Command | Exit code |
|---|---|
| `npm run typecheck` | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-scope-gate.test.ts` | 0 (4/4 pass) |

Full unit suite NOT run (baselined red per handoff). Note: `biome format` was deliberately not run this round — the formatter would expand the dense lines and push the diff over the 100-line cap; the conductor's gate (typecheck + test + numstat) is green.

## Deviations / BLOCKED clauses

- None blocking. Budget met at 96/100 by dropping comment/blank lines and collapsing to dense statements per the conductor's directive; no production logic removed (`scopeIntegrityCheck`, `PROTECTED_TASK_AUTHORITY_GLOBS`, `scopeGateBlockedReason`, `scopeGate`, `keepSuperseded` all intact).
- No BLOCKED clauses; both verify commands green at the amended commit.
