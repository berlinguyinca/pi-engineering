# R08 — WORKER_REPORT

Task authority: `docs/specs/harness-reliability-bootstrap-20261103/R08/HANDOFF.md`.
Parent handoff: `R07/R07.handoff.json` (sha256:bb491e863114f06dd320a932d2391c611f63f7f8351f77ab1643829c738baabf, PASS), base `e151794ff1fc21ee9ab77567f330817f802ce0e3`.
Commit produced: `12d47c2f5658f4e154474f4d235c397b43af65b3` on `feat/r08-resolution-evidence` —
`feat(incidents): resolution evidence separating temporary recovery from root-cause resolution (R08)`.

## Diff (git diff --numstat e151794ff1fc21ee9ab77567f330817f802ce0e3 HEAD)

```
42	0	src/incidents/resolutionEvidence.ts
56	0	test/unit/incident-resolution-evidence.test.ts
```

98 added lines, 0 deleted, 2 files (budget ≤ 100 lines / 2 files). Nothing else changed:
`src/incidents/recoveryOutcome.ts`, `src/incidents/evidenceBundle.ts`, `src/inference/retryTrace.ts`,
`src/bootstrap/**`, `templates/**`, `test/support/**`, `scripts/**` and every other denied path are untouched.
(Worktree note: `node_modules` was absent in this fresh worktree and is symlinked to the primary checkout's, per
AGENTS.md; that symlink is gitignored and is not part of the commit.)

## Verification (at commit 12d47c2f)

| Command | Exit code | Result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | 0 | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/incident-resolution-evidence.test.ts` | 0 | 6 tests, 6 pass, 0 fail |

### Per-suite counts (same runner, `--import ./test/support/isolatedState.ts`)

| Suite | exit | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/unit/recovery-outcome.test.ts` (D04, the existing durable verdict) | 0 | 6 | 6 | 0 — stays green; the file is unmodified |
| `test/unit/error-evidence-bundle.test.ts` (D07 evidence bundle) | 0 | 4 | 4 | 0 |
| `test/unit/recovery-optin.test.ts` (R07 opt-in recovery) | 0 | 6 | 6 | 0 |

Note: the handoff names the D07 suite `test/unit/evidence-bundle.test.ts`; no such file exists at this base. The
evidence-bundle suite is `test/unit/error-evidence-bundle.test.ts` (its header is the D07 one), and that is what was run.
`npm run lint` (biome) still fails repo-wide at this base and was not chased, as instructed.

## Rule order as implemented (`classifyResolution`)

1. **Failing reproduction required.** `reproduction` absent, `command` blank, or `exitCode === 0` → `unresolved` +
   `"failing-reproduction"`; a run that already passed proves nothing was fixed. This short-circuits, so a passing
   reproduction is named even when identities, check, scope and `postFixStatus` are all valid.
2. **Identity is shape.** `patchIdentity` / `settingIdentity` must match `RESOLUTION_SHA = /^sha256:[0-9a-f]{64}$/`;
   present-but-unshaped text (or absence) contributes `"patch-identity"` / `"setting-identity"` and is never echoed
   into the verdict — collected, not short-circuited, so both entries are reported together.
3. **Passing check names the check that ran.** `passingCheck` absent, `exitCode !== 0`, or blank `command` / `artifact`
   → `"passing-check"` (command + exitCode + artifact, the handoff-gate idea).
4. **Scope.** `scopeAllowed === false`, a blank changed path, or a `changedFiles` entry not covered by `allowedPaths`
   → `"scope"`. Coverage is exact-path or path-segment prefix (`src/` covers `src/b/c.ts`); `allowedPaths: []` covers
   nothing, and `src/a.ts` never covers `src/a.ts.bak`.
   Any of rules 2–4 unmet → `unresolved` with the collected `missing`.
5. **Observed post-fix status.** `postFixStatus` absent / `null` / `"unknown"` → `unknown`, `resolved: false`,
   `missing: ["post-fix-status"]`.
6. `"unresolved"` or `"suppressed"` → `unresolved` + `"post-fix-status"`.
7. `"recovered"` → `recovered_temporarily`, `resolved: false`, `temporaryBecause =
   "postFixStatus.recovered:completion-record-not-removed-cause"`, `missing: ["same-check-sequence"]`. `retryCount`
   appears only inside `reason` (`postFixStatus.recovered:retryCount=N`) and never raises the status.
8. `recovered_temporarily` → `root_cause_resolved` **only** when `sameCheckSequencePassed === true`. `resolved` is
   computed as `status === "root_cause_resolved"`, so the invariant is structural, and `missing` is empty exactly for
   that one status. Purity: the only import is `import type { RecoveryOutcome } from "./recoveryOutcome.ts";` — no fs,
   clock, RNG, timer, `process.env` or telemetry, and `recoveryOutcome.ts` is neither modified nor called.

Tests: 6 `it()` blocks, one per property, plus a 20-case table (5 `postFixStatus` values — absent plus the four
`RecoveryOutcome` values × `sameCheckSequencePassed` true/false × reproduction present/absent) asserting
`resolved === (status === "root_cause_resolved")`, `missing.length === 0 ⟺ resolved`, exactly 1 `root_cause_resolved`
and 1 `recovered_temporarily` in that table, and a source read of the module asserting no `writeFile`, `appendFile`,
`console.`, `Date.now`, `Math.random`, `process.env`, `setTimeout`, `fetch` and exactly one import line, the type-only one.

## Why a durable `recovered` cannot by itself mean root cause resolved

`recoveryOutcome.ts` states its ordered rules as "suppressed (complete record) > recovered (allowlisted completion
strictly after failureAt) > unresolved (recorded failure, no completion/suppression) > unknown (inconsistent /
unsubstantiated claim)", and `recovered` is reached from exactly one proof: a completion record whose `kind` is in
`COMPLETION_KINDS` (`verification.passed`, `unit.passed`, `typecheck.passed`, `task.completed`) whose `at` is strictly
after `failureAt`. That record says a run of some kind finished successfully after the failure — it is a statement
about the ordering of durable events, not about the cause. The same file is deliberately explicit that weaker signals
prove nothing ("HTTP status is never recovery proof, and `retryTraced` alone proves only that attempts were acted on"),
which is exactly the residual gap: nothing in D04 asks *why* the run finished. A retry that happened to land on a
healthy upstream, a suppressed alert path, a cache warm-up or a flaky fixture all produce an allowlisted completion
strictly after the failure and therefore a durable `recovered`, while the defect is untouched. So R08 treats
`recovered` as evidence of *a* passing run, never of a removed cause: it can only support `recovered_temporarily`, and
promotion to `root_cause_resolved` requires the things D04 never looks at — a reproduction that actually failed
(`exitCode !== 0`; a run that passed proves nothing), sha-256-shaped identity of the patch or setting that changed, a
named passing check with its artifact, a scope the change stayed inside, and `sameCheckSequencePassed`, i.e. the same
named check that failed now passing. `retryCount` is reported in `reason` only, so 500 retries read exactly like 0.
