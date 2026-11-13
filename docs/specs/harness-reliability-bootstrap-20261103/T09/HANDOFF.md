# T09 — Add scope-integrity result gate

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T09/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T08/T08.handoff.json (sha256:f928904f4c544d19dfaeeb8031446cd9465725c162d981772e87302189b77dca, status PASS, resultSha 11131ece730d723c1e497d860c6185a717b8691f = your base).
Base commit: 11131ece730d723c1e497d860c6185a717b8691f. Mode: isolated-change.

## Objective (plan delta, verbatim)
Before integration verify changed paths against protected task authority; report blocked with exact diff refs. Do not attempt new sandbox or shell pre-hook here.
Evidence: Unauthorized diff never passes to integration; evidence remains recoverable.

## Scope (hard limits)
- Exactly 2 files: `src/plannerWorker/executor.ts` (production ≤ 2 — `src/plannerWorker/review.ts` may be the second only if you put the pure predicate next to `scopeViolations` there; say which you chose) and the NEW `test/unit/planner-worker-scope-gate.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- **Do not create new sandboxing or shell hooks** (the delta forbids it): no new pre-exec interception, no settings/permission file, no `scripts/**` change. This unit is a check on the *result*, before merge.
- Denied: `src/plannerWorker/{types,contract,transitions,stateMachine,handoff,sessionHandoff,missionLock,roles}.ts`, `src/gate/**`, `src/aps/**`, `src/bootstrap/**` (import `matchesGlob`/policy helpers if useful, do not edit), `src/runtime/**`, `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus, if you touched `review.ts`, `node --test --import ./test/support/isolatedState.ts test/unit/planner-handoff-command.test.ts`. Report exit codes.

## Current integration path (verified against base)
`accept()` (`executor.ts:891`) calls `this.integrate(rt)` (`executor.ts:1449`) which merges `rt.worktree.branch` into the mission's integration worktree — and its only guard is `rt.state.changed_files.length === 0`, i.e. the **worker's self-reported** file list. `commitAttempt()` already committed the attempt on the contract branch, and post-commit `scopeViolations(changed, c.scope)` (`executor.ts:742`, defined `review.ts:88`) is computed for review purposes only, never blocking the merge. `blockedEvidence(run)` (`review.ts:163`) is the existing convention for making blocked work recoverable (`blocked_reason = "evidence: …"`, consumed at `executor.ts:589`), and `resetWorktree()` (`executor.ts:1472`) already preserves unintegrated work under `superseded/*` refs.

## Required behaviour
1. Add an **exported pure predicate** so the rule is testable without a live executor:
   `export function scopeIntegrityCheck(input: { changed: readonly string[]; scope: ContractScope; authorityProtected?: readonly string[]; refs: { taskId: string; branch: string; base: string; head: string } }): { ok: true; refs: string } | { ok: false; violations: string[]; protectedHits: string[]; refs: string }`
   - `violations`: entries of `changed` outside `scope` — reuse the existing `scopeViolations`/`matchesScope` from `./review.ts` (do not reimplement glob/segment matching).
   - `protectedHits`: entries of `changed` matching `authorityProtected` globs (use `matchesGlob` from `./contract.ts`). The caller passes the task-authority artifacts; when `authorityProtected` is absent, treat the standard bootstrap layout as protected — `docs/specs/**/manifests/**`, `docs/specs/**/*.handoff.json`, `docs/specs/**/fixtures/**`, `docs/specs/**/templates/**`, `templates/**` and `scripts/bootstrap-*.ts` — as an exported `const PROTECTED_TASK_AUTHORITY_GLOBS` so the rule is visible and overridable. A protected hit is a violation **even when it is inside the contract's scope** (authority is not negotiable by scope).
   - Deterministic: both lists preserve `changed` order, deduplicated, bounded to 20 entries each with a trailing marker `…(+N more)` as a separate note in `refs` rather than an extra element.
   - `refs` (both branches) is one exact, recoverable reference string: `task=<taskId> branch=<branch> base=<base> head=<head> paths=<first bounded list joined by ",">` (plus the `…(+N more)` note when truncated), with `…` never invented for paths that do exist.
   - No git, no fs, no clock, no RNG in this function. Never throw on odd input: non-string entries in `changed` are ignored (and cannot be judged), an empty `changed` yields `{ ok: true }`.
2. Wire it **before** any merge: in `accept()` (or at the top of `integrate()`, your choice — say which), gather the authoritative changed paths from the contract worktree with git (`git diff --name-only <rt.baseCommit> HEAD` after `commitAttempt`, plus `git ls-files --others --exclude-standard` for untracked files the commit missed — say in the report which commands you used), run `scopeIntegrityCheck` with `rt.state.contract.scope` and the refs of the actual attempt (`rt.worktree.branch`, `rt.baseCommit`, current `HEAD` sha), and on `ok: false`: **do not call `integrate`**, set `rt.state.blocked_reason` to the exact `refs` string prefixed `scope gate: `, `setStatus(rt, "blocked", …)`, emit a `phase` event carrying the same refs, and return `"done"` so the mission reports the block instead of merging. Work stays reachable because the attempt commit is already on the contract branch (and `resetWorktree`'s `superseded/*` rule still applies) — do not delete or reset anything in this path.
3. Everything else stays as-is: `scopeViolations` at `executor.ts:742` keeps feeding review; `integrate()` keeps its merge/abort behaviour; no change to review, correction or retry logic. Existing planner-worker tests must keep passing (typecheck proves compilation; name any planner test you ran).
4. No scores, percentages or confidence values anywhere; `blocked_reason` is the literal refs string.

## Tests (new test/unit/planner-worker-scope-gate.test.ts)
Use `test/support/isolatedState.ts` and drive `scopeIntegrityCheck` directly (no executor, no git): a diff of `["src/reader/read.ts","src/ui/theme.ts","docs/roadmap.md"]` against scope `{ allowed: ["src/reader/**"], forbidden: [] }` reports `ok: false` with `violations` naming exactly the two out-of-scope paths in input order, and `refs` contains `task=`, `branch=`, `base=`/`head=` shas and both offending paths; a fully in-scope diff returns `{ ok: true }` with refs still naming the attempt; `package-lock.json`-style protected hits are reported in `protectedHits` **even when the scope allows them** (e.g. scope `docs/specs/**` with a `docs/specs/x/manifests/tasks.json` change); `PROTECTED_TASK_AUTHORITY_GLOBS` covers the five documented families plus `scripts/bootstrap-one.ts` and does not flag ordinary `src/**` paths; duplicates collapse; a 25-path violation set is bounded to 20 with the truncation note appearing only in `refs`; non-string entries and an empty diff are inert; and the same input twice deep-equals.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-scope-gate.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 11131ece730d723c1e497d860c6185a717b8691f HEAD`, which file holds the predicate, the git commands used to collect paths, where you wired the gate (function + line), each command with exit code, and any deviation or BLOCKED clause. Commit only the changed files as `feat(planner-worker): scope-integrity gate before integration (T09)`.
