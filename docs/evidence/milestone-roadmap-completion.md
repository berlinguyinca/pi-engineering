# Evidence — Milestone: Verifiable Roadmap Completion (Roadmap 1.0)

The final required milestone (M12). Structured Roadmap 1.0 with evidence-derived
completion that can never be declared by a model.

## What was built

- **Structured Roadmap 1.0** — `docs/roadmap/roadmap.yaml` (12 required
  milestones + 1 deferred + backlog B-101..B-106), validated by `src/roadmap/schema.ts`
  (unique ids, dependency cycles, required-cannot-be-deferred, unknown evidence
  types, satisfiable evidence types, required-milestone-needs-criteria, waiver ids).
- **Evidence store** — `.pi-eng/roadmap/evidence.jsonl` (gitignored, regenerated)
  + committed manual index `docs/roadmap/evidence.yaml` bound to commit SHAs.
- **Deterministic check registry** — `src/roadmap/checks.ts`: unit/integration/
  typecheck/lint/package_load/roadmap_test → npm commands with coverage paths.
- **Derived evaluation** — `src/roadmap/evaluate.ts`: states NOT_STARTED /
  IN_PROGRESS / IMPLEMENTED / VERIFIED / NEEDS_REVERIFICATION / BLOCKED /
  DEFERRED; topological dependency order; criterion-bound evidence (each
  acceptance criterion needs its own passing+fresh record).
- **Impact-based invalidation** — `GitRepo.changedPathsSince(commit, paths)`,
  fail-safe: empty/unknown commit or git error ⇒ **stale** (never silently fresh).
- **Release gate** — `src/roadmap/releaseGate.ts`: all required VERIFIED +
  5 deterministic gates + `fresh_review` (findings budget) + `dogfood`. Absent
  `fresh_review` ⇒ synthetic `{1,1}` so the gate cannot pass vacuously.
- **CLI + command** — `pi-engineering roadmap check|status`, `/roadmap-status`.
  Exit codes: **0** complete, **1** valid-not-complete, **2** invalid roadmap,
  **3** infra.
- **Autonomous stop** — when the roadmap is complete, `/engineer`, `/plan`,
  `/tournament`, and `executePlan` refuse to invent new work (derived gate, never
  a model declaration).

## Completion evidence (machine-verifiable)

```sh
node scripts/pi-engineering.ts roadmap check   # exit 0, complete: true
node scripts/pi-engineering.ts roadmap status  # exit 0
```

| Gate | Result |
| --- | --- |
| `roadmap check` exit code | **0** |
| `complete` | **true** |
| release gate | **PASS** |
| required milestones VERIFIED | **12/12** |
| M13 (optional) | DEFERRED (explicit reason) |
| Full test suite | **116/116 pass** |
| `tsc --noEmit` | clean |
| biome lint | clean (67 files) |

## Dogfood lifecycle (deterministic)

`scripts/dogfood-roadmap.ts` (also `test/integration/roadmap-dogfood.test.ts`)
proves the full lifecycle in a disposable repo:

`incomplete → exit 1` → `verified → exit 0` → `invalidated (scoped change) →
exit 1 + NEEDS_REVERIFICATION` → `reverified → exit 0` → `status complete=true`
→ `final check → exit 0`.

## Fresh-context review

Six independent fresh-context review rounds (`scripts/fresh-review-roadmap.ts`,
live model, ~90k context each) were run against the implementation. Every
material finding was fixed with a regression test. Notable fixes:

- **Manual evidence whitelist** — only `dogfood`/`fresh_review` may be hand-written;
  a record of any generated type is rejected (can't satisfy criteria without a run).
- **Fail-safe freshness** — empty/unknown evidence commit or git error ⇒ stale.
- **No-review fails** — an absent `fresh_review` never passes the gate.
- **Criterion binding** — evidence is bound per acceptance criterion, not type-only.
- **Orphan-fail invariant** — a fail record from an older target-id scheme no
  longer permanently blocks a milestone (append-only store, no deletion).
- **Failing refresh ≠ demote** — a failing check yields BLOCKED, never IMPLEMENTED.
- **Autonomous stop wired to /plan, /tournament, executePlan** too, not just /engineer.
- **Schema** — required milestone can't depend on a deferrable milestone; evidence
  types must be satisfiable; waivers validated + surfaced in status.

Final review state: **no HIGH findings**; the remaining items are documented LOW
severity / deliberate design decisions (documented in the review output).

## The process step that closes the loop

Deterministic evidence is regenerated at HEAD by `roadmap check`. The two
model-dependent records the release gate requires are recorded by the process
step `scripts/record-roadmap-evidence.ts` into the committed `docs/roadmap/evidence.yaml`
(dogfood + fresh-review bound to the final HEAD, 0/0 unresolved findings). The
system itself refuses to declare completion until this evidence is present — the
repo's own roadmap does not pass its gate until the process step runs.

## Verification

- `npm run typecheck` — clean.
- `npm run lint` (biome) — clean.
- `npm test` — **116/116 passing** (incl. 45 roadmap tests).
- `node scripts/pi-engineering.ts roadmap check` — **exit 0**.
