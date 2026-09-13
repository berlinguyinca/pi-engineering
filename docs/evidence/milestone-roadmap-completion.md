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

## Backlog implementation (M13-M22)

The full backlog discovered during M12 is implemented as verifiable milestones
and folded into Roadmap 1.0 (now 22 required milestones, all VERIFIED):

- **M13 Parallel Task DAG execution** — `executePlan(plan, { parallel })` runs
  independent, write-scope-disjoint tasks concurrently in dependency waves
  (bounded by the scheduler); a runtime `withGitLock` serializes promotion merges
  into the shared main branch, eliminating the `index.lock` race that previously
  forced sequential execution. `computeParallelWaves` groups topo order; write
  scope conflicts (`tasksConflict`/`scopesOverlap`) detect directory-vs-descendant
  overlap so a wave can never race.
- **M14 Model routing & diversity** — `ModelRouter` capability+quota routing with
  separation-of-duties diversity (independent roles prefer a provider other than
  the implementer's) and graceful single-model degradation.
- **M15 Scheduling & backpressure** — `Scheduler` weighted-deficit round-robin,
  backpressure, and concurrency-bounded speculative execution.
- **M16 Budget management** — `BudgetManager` token-budget escalation + marginal
  value stopping.
- **M17 Security hardening** — `SecurityPolicy` secret redaction, tool policy,
  untrusted-repo prompt-injection guardrails (fail-closed).
- **M18 Integration & merge queue** — `MergeQueue` serialized candidate→
  integration→main promotion with rebase + deterministic gate.
- **M19 Repository intelligence** — `RepoIntel` dependency-free symbol index +
  optional LSP seam (core never depends on an LSP).
- **M20 Verification farm** — test-impact analysis, machine-gated adversarial test
  generation, property scaffolding (with vacuous detection), mutation kill-rate,
  differential, performance-vs-baseline.
- **M21 Engineering benchmark** — autonomy/context/throughput metrics vs baseline.
- **M22 Optional adapter seams & telemetry** — AutoSpec/InferWeave seams empty by
  default (core standalone) + deterministic telemetry export.

### Fresh-context review of the backlog modules

`scripts/fresh-review-backlog.ts` reviewed M13-M22 in a fresh context and found 5
material findings: dead `RouteResult.fallback` field; unbounded/untested
speculative execution; non-weighted fairness; exact-string write-scope conflict
detection (directory vs descendant race); vacuous property-test scaffold. All 5
were fixed with regression tests (`scripts/fresh-review-backlog-fixes.ts`
confirmed each RESOLVED; 0 critical, 0 high).

## Verification

- `npm run typecheck` — clean.
- `npm run lint` (biome) — clean.
- `npm test` — **194/194 passing**.
- `npm run test:e2e` — clean (10 commands, package load).
- `node scripts/pi-engineering.ts roadmap check` — **exit 0**, `complete: true`,
  22/22 VERIFIED, release gate **PASS**.
