# D04 report — classify recovery outcome accurately (ordinal 17)

**Status: PASS, merged.** `feat/d04-recovery-outcome` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`23e2d905` → `68e70ed58b93ce31dc28dd4a07871ffa4347c02e` (single commit, `HEAD^` = approved base).

| item | value |
| --- | --- |
| diff | `src/incidents/recoveryOutcome.ts` 53/0, `test/unit/recovery-outcome.test.ts` 42/0 → 95 changed lines (budget ≤100) |
| handoffHash | `sha256:5ad9e5f80f0e56effb291d9e1cab9b5fd4621e28cf9eb9069cbec7e5d342f1c3` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:e5d3fd8a2d8eef185e9f0f419389b3ec962405c9f0fbba1c81e080f050ddc53a` |
| parent | **strictly verified**: `parent=D03 accepted sha256:9e4972d15be…` (`nextTaskId: D04`) |
| base / result / next | `23e2d90501da…` / `68e70ed58b93…` / `D05 @ 68e70ed58b93…` |

`classifyRecoveryOutcome(evidence)` is pure over caller-supplied durable evidence (no file, clock or env access):
`suppressed` only with a complete suppression record; `recovered` only with an allowlisted
`COMPLETION_KINDS = [verification.passed, unit.passed, typecheck.passed, task.completed]` record **strictly after**
`failureAt`; `unresolved` for a recorded failure with nothing else; `unknown` when evidence is malformed or a
completion cannot be substantiated. Every verdict carries a stable `reason` code and a `missing` list naming the
exact absent proof, which is how D03's placeholder `resolution` gets fed honestly.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/recovery-outcome.test.ts` (6/6, one test per criterion) (spec `verify` 2) | 0 | `logs/02-unit-recovery-outcome.txt` |
| neighbours: `error-aggregate`, `error-fingerprint`, `error-reader` (15/15) | 0 | `logs/03-unit-neighbours.txt` |
| conductor's 13-case adversarial probe | 0 | `logs/04-conductor-outcome-probe.txt` |

Evidence criterion reproduced independently: claiming `recovered` with `httpStatus: 200` and no completion →
`unresolved` + `missing: ["completion:allowlisted-kind-after-failureAt"]`; `204` + `retryTraced` → same; a
completion of kind `user_says_fine`, a completion **equal** to `failureAt`, and a completion **earlier** than the
failure → `unknown` (`completion.not.substantiated`) rather than `recovered`; a valid allowlisted completion
strictly after → `recovered` (`completion.strictly.after.failure`, `missing: []`); half-filled suppression →
`unknown` + `suppression:eventId`; `null`/`{}`/bad dates never throw; across 200/201/202/204/299 no outcome is
ever `recovered` and no `reason` ever cites the status.

## Deviations

None. Conductor-side history actions: none. One documented ordering nuance worth knowing for D05/D06: a false
`recovered` claim with **no** completion record at all resolves to `unresolved` (rule 3) rather than `unknown`
(rule 4) — either way the claim is rejected and `missing` names the absent evidence, which is what the plan's
evidence criterion requires.
