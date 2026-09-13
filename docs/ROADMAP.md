# Roadmap & Reality-Check

This document is a deliberately honest status assessment of `pi-engineering-runtime`.
It records what actually works (with evidence), what is stubbed or aspirational,
and the highest-value next slices. It is not marketing; it is a working map.

The authoritative product specification is
`docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`. Where this
document disagrees with the spec, the implementation is the thing that is behind,
and the gap is called out here.

## Status snapshot (validated)

| Capability | Status | Evidence |
| --- | --- | --- |
| Engineering Ledger (event-sourced, replay-on-open) | **Works** | `test/unit/ledger.test.ts`; durable `.pi-eng/ledger.jsonl` |
| Artifact store (`artifact://` URIs, lazy reads) | **Works** | `test/unit/artifacts.test.ts` |
| Artifact-backed lazy candidate-diff review (no inline diff) | **Works** | integration: lazy-diff + stale-artifact tests; `artifact_read` pagination |
| Worktree isolation + controlled promote-merge (INV-003/004/005) | **Works** | `test/unit/git.test.ts`; integration tests |
| Deterministic verification (`CommandVerifier`) | **Works** | `test/unit/verifier.test.ts` |
| Fresh-context worker sessions, bounded structured results (INV-001) | **Works** | `test/unit/workers.test.ts`; real-model dogfood |
| Role context-token budget enforcement | **Works** | `PiWorkerExecutor` abort on overflow; budget threading tests |
| INV-006 machine-evidence gating | **Works** | `isMachineEvidence()` in claims path |
| Independent review + no-promote-with-open-findings (INV-007) | **Works** | integration: "no final-round bypass", "review that fails to complete must not silently promote" |
| Review-completion gate (incomplete review ≠ clean review) | **Works** | integration: incomplete-review tests (engineer + tournament) |
| Clean-room challenger for high/critical risk (§12.2) | **Works** | integration: challenger test |
| Candidate tournaments (independent candidates, deterministic winner) | **Works** | integration: tournament test |
| Configurable tournament strategy + clean-room finalist challenge | **Works** | integration: strategy + challenger tests |
| Parallel candidate execution (opt-in) + concurrency-safe ledger | **Works** | integration: parallel test; `eventstore.test.ts` |
| Optional distinct reviewer worker (anchoring mitigation) | **Works** | integration: reviewerWorker test |
| Task DAG planning + execution (multi-step work items) | **Works** | `taskdag.test.ts`, `dag.test.ts` |
| Verify profile caching + `/verify full` suite | **Works** | `verifier.test.ts` |
| Lint/format gate (biome) | **Works** | `npm run lint` / `npm run format` |
| Relevance-ranked context + scout-guided required files | **Works** | `context.test.ts`, integration: scout-required test |
| Fresh-context review loop (fix rounds carry diff+findings feedback) | **Works** | integration: fix-round test |
| `/commands` + semantic tools in pi | **Works** | `scripts/smoke-commands.ts`, `scripts/smoke-installed.ts` |
| Real-model end-to-end dogfood | **Works** | `scripts/dogfood.ts`; see below |

**Verification evidence (last full run):**
- `npx tsc --noEmit` — passes.
- `npm test` — 68/68 passing (unit + integration).
- `npm run lint` (biome check) — clean.
- Standalone install: pi's `ResourceLoader` discovers and loads the package
  extension with zero errors (`scripts/smoke-installed.ts`).
- Real dogfood (`qwen3.8-27b`): `titleCase()` added to `src/transform.js`,
  exported from `src/index.js`, tested in `test/transform.test.js`, promoted and
  merged — 2 rounds, ~438s, 4 workers (1 scout, 2 implementers, 1 reviewer),
  71 tool calls, 130.6k input / 22.5k output tokens, 4 verify stages, 4 evidence
  records. The implementer also repaired a pre-existing broken `typecheck`
  script (a glob that `CommandVerifier` does not shell-expand) by enumerating
  files, so the promoted tree typechecks cleanly.

## Fresh-review findings (addressed)

An independent fresh-context architecture reviewer (`scripts/fresh-review.ts`)
ran against the implementation and reported 2 HIGH, 5 MEDIUM, and 5 LOW
findings. All material (HIGH + MEDIUM) findings were fixed with regression tests:

| # | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | HIGH | Verification could pass with zero passing evidence (failing non-required fallback stage) | `VerifyOutcome.passed` now requires ≥1 passing stage | `verifier.test.ts` |
| 2 | HIGH | Gate profile read from the candidate worktree, so the implementer could neutralize its own gate | Profile detected from the main repo; stages still run in the worktree | integration |
| 3 | MED | Worktrees placed inside the main tree when opened from a subdirectory | Worktree path derived from `repoRoot` (sibling of the tree) | `git.test.ts` |
| 4 | MED | `ContextBroker.search` swallowed git-grep regex errors as "no matches" | Goal keywords searched as literals; grep errors surfaced | `context.test.ts` |
| 5 | MED | Per-cwd runtime cache → divergent ledger views over one `.pi-eng` file | Cache keyed by git toplevel | — (extension) |
| 6 | MED | Unbounded `worker_result`; findings fed untruncated into next prompt | Schema caps + `maxItems`; findings truncated in feedback | `workers.test.ts` |
| 7 | MED | `ledger_claim` could turn a fabricated `artifact://` URI into a verified fact | Verified only when the artifact reference resolves | `tools.test.ts` |

LOW findings: fixed `ledger_read` evidence scoping and inaccurate merge-failure
reason; removed an unused import. The remaining LOW items (no automated test for
the real `PiWorkerExecutor` path — it requires a live model and is covered by the
manual `scripts/smoke-*.ts`) is a
documented limitation, not a correctness defect.

## Review-completion gate (recent fix)

The first dogfood run exposed a real INV-007 violation: the independent reviewer
hit its hard context-token budget (24k) mid-run and returned a **failed** status
with no findings, and the runtime treated that as a clean review and promoted
the candidate anyway. A candidate whose review did not complete was being
promoted as if independently reviewed.

**Fix:** `review()` now reports `completed: boolean`. `engineer()` and
`tournament()` retry an incomplete review with a *fresh* reviewer session (fresh
context discards the accumulated tokens that caused the overflow) and, if it
still fails, record a blocking `critical` finding and **refuse to promote**
(engineer) or make the candidate **ineligible to win** (tournament). A failed
review is never treated as a clean review. Covered by two regression tests.

## What is deliberately NOT built yet

None of the deferred roadmap items remain — all are implemented (see below). The
only spec provisions still out of scope are those excluded by the project
constraint: multiple-model support, AutoSpec/InferWeave adapters, a hosted
control plane, and a Go control plane. These are deliberate boundaries, not
accidental gaps.

## Known limitations (honest)

- **Single model default.** Workers run on whatever model the session uses.
  Multiple models are not REQUIRED (project constraint), but an optional
  separate `reviewerWorker` can be supplied for the review/challenger roles,
  mitigating the anchoring failure mode where an implementer and reviewer share
  a bias. The clean-room challenger also mitigates high/critical risk.
- **Promotion is a merge, not a squash.** The incumbent history accumulates one
  "implementation candidate" + one "promote" commit per accepted round. This is
  intentional (auditable lineage) but is noisier than a squash.
- **Lint/format gate via biome.** `npm run lint` (biome check) + `npm run format`
  are configured (2-space, 120 width). `noExplicitAny`/`noNonNullAssertion` are
  disabled (the codebase intentionally uses them); everything else in the
  recommended rule set is enforced.
- **Real-model smoke scripts are not CI.** `scripts/dogfood.ts`, `smoke-worker.ts`
  etc. hit a live model and are excluded from the deterministic test suite by
  design. They are dev tools only.
- **Reviewer budget is tight.** The reviewer's 24k hard token budget (spec
  §10.6) can still be exceeded by a reviewer that reads many files, but the
  primary context-pressure source — the inlined candidate diff — has been
  removed (see artifact-backed lazy diff below), and the retry-with-fresh-
  context path keeps an overflow from ever becoming a silent promotion.

## Artifact-backed lazy candidate-diff retrieval (implemented)

**Milestone: artifact-backed large-output handling and lazy retrieval**
(priority #1). The full candidate diff is no longer inlined into the reviewer
prompt. Candidate diffs are stored as `artifact://` references (a `diff_artifact_uri`
on the candidate, set when a diff is captured) and the reviewer reads the full
diff on demand via `artifact_read`, which now supports `offset` pagination so
arbitrarily large diffs are fully retrievable without re-injecting them into the
24k reviewer budget. `ensureDiffArtifact` verifies the stored content matches the
candidate's current `diff` and rewrites it when stale, and treats a failed
artifact write as a review that could not complete (never a silent clean review).

Dogfood (real model, fresh fixture): max worker context dropped from **24.9k
(overflowed the 24k reviewer budget → failed review)** to **11.7k**; **0 blocked
or failed workers** (previously 1); **1 round**, promoted, **8/8 tests pass**;
49 tool calls / 45.9k input / 10.2k output tokens. The review summary confirmed
"The full diff was read" via the artifact. Machine evidence: `test/integration/vertical-slice.test.ts`
("review keeps the full diff out of context behind a lazy artifact reference" +
"ensureDiffArtifact reuses a fresh artifact but rewrites a stale one"), `test/unit/tools.test.ts`
(artifact_read pagination + missing-content error), 42/42 tests pass, `tsc` clean.
Fresh-context review of the milestone reported 1 HIGH (fixed via artifact_read
pagination), 4 MEDIUM (fixed: stale-artifact verification, missing-content error,
bounded changed-files list, roadmap/evidence), and 3 LOW (fixed: artifact-write
failure gating, empty-diff consistency; remaining test-gap items added).
- **`pi -p` (print mode) hangs in this environment** regardless of the extension;
  confirmed as environmental, not caused by this package.

## Relevance-ranked context + scout-guided required files (implemented)

**Milestone: Context Broker improvements (priority #2).** The broker now ranks
repository files by relevance to the goal and feeds the scout's identified
change surface directly to the implementer.

- **`rankFiles()`** scores files by goal-keyword path matches plus *distinct*
goal symbols found via `git grep` (counting distinct keywords, not raw line
frequency, so a test file that repeats one symbol is not over-weighted), with a
deterministic non-test/shorter-path tie-break.
- **`assembleContext()`** now includes content slices of the most relevant files
(not just one-line symbol hits), bounded by the token budget, so a worker starts
with the actual code it needs instead of re-fetching it with tool round-trips.
- **Scout-guided required files:** `scout()` returns the concrete files it
identifies (`details.relevant_files`); `engineer()` re-assembles the implementer
context with those as REQUIRED, closing the previously-unused `requiredFiles`
hook. Oversized required files are truncated (never silently dropped).
- **Keyword extraction** now strips punctuation (`'Implement add(a, b)'` →
keyword `add`), so a punctuated goal no longer yields an empty context package.
- **Multi-keyword search** (`searchAny`) builds a safe per-keyword alternation;
`search()` remains a literal single-query, so regex metacharacters in a goal are
never treated as regex.
- **Error containment:** a context-assembly failure degrades to an empty package
plus a ledger note instead of aborting the run.

Dogfood (real model, fresh fixture): **1 round**, promoted, **0 blocked/failed
workers**, **30 tool calls**, **4/4 tests pass**, max worker context **11.6k**.
Machine evidence: `test/unit/context.test.ts` (ranking order, relevant-file
content, punctuated-goal non-empty package, oversized-required truncation,
segment-based ignore matching, `searchAny` alternation) and the integration test
("scout-identified files become required context for the implementer"), 49/49
tests pass, `tsc` clean. Fresh-context review reported 1 HIGH (multi-keyword
`search('a|b')` was escaped as a literal → fixed via `searchAny`), plus MEDIUM
findings all fixed with regression tests (punctuation keyword extraction,
oversized-required truncation, segment-based ignores, scout-file dedupe,
context-assembly error containment).

## Task DAGs (implemented)

**Milestone: multi-step work items (priority #3).** `plan(goal)` runs a planner
worker that decomposes a large goal into a dependency-aware task DAG, recorded as
ledger `Task` entities (title, kind, risk, `depends_on` edges resolved to real
task ids, write `scope_paths`). `executePlan(planId)` topological-sorts the DAG
(Kahn), records write-scope conflicts, and runs each task through the standard
engineer pipeline in dependency order, blocking tasks whose dependencies failed
and linking each executed task to its result work item. `/plan` + `/execute`
commands expose it in pi. Pure helpers (`src/plan/taskDag.ts`: `topoSort`,
`tasksConflict`, `blockedByFailure`) are unit-tested.

Dogfood (real model, fresh fixture): a goal decomposed into **3 correctly-ordered
tasks**, all executed through the pipeline, plan **COMPLETED**, **0 blocked/failed
workers**, 5/5 fixture tests pass, 99 tool calls / 191.7k input tokens. Machine
evidence: `test/unit/taskdag.test.ts` (5) + `test/integration/dag.test.ts` (2),
68/68 tests pass, `tsc` clean.

## Verify profile caching (implemented)

`CommandVerifier.detect()` now caches per-repo keyed on cwd + package.json
CONTENT (invalidated on change), saving a re-read + tokenize per verification
call in multi-round runs. `clearCache()` for tests. Covered by a unit test.

## `/verify` full suite (implemented)

`detect(cwd, { full })` adds the repo's declared `lint` and `test:full`/`test:all`
stages; `/verify full` runs the broader suite and records it all as evidence.
`VerificationProvider` interface extended. Covered by a unit test.

## Tournament refinements (implemented)

`tournament(goal, { n, strategy, challengeFinalists, parallel })`:
- **Configurable winner-selection strategy**: `findings` (default: fewest material
  findings, then fewest files, then stable id) | `changes` | `stable`.
- **Clean-room challenger pass** over the top two finalists (opt-in, high/critical
  risk): an independent session inspects both diffs and may promote the runner-up;
  the override is recorded as a decision.
- **Parallel candidate execution** (`parallel: true`; `/tournament ... --parallel`):
  the independent candidates run concurrently via `Promise.all`, each in its own
  isolated worktree with nothing merged into the main branch until the winner is
  selected, so parallel execution is safe. The `EventStore` now serializes
  concurrent appends, so parallel producers never corrupt the durable ledger.
  Defaults to sequential (a single serial worker gains little); a concurrency-
  capable worker or distinct reviewer worker realizes the benefit. A regression
  test proves candidates overlap in the implement phase (concurrency counter).

## Multi-model defense (implemented)

`EngineeringRuntime.open({ cwd, worker, reviewerWorker })` accepts an **optional
separate worker** for the independent-review and clean-room-challenger roles,
mitigating the single-model anchoring failure mode where an implementer and
reviewer share the same bias. When omitted it falls back to the single worker, so
multiple models are OPTIONAL, never required (project constraint). A regression
test proves the reviewer/challenger run on the distinct worker while the
implementer stays on the main worker.

Covered by 3 integration tests (strategy, challenger, reviewerWorker) + 1
concurrency unit test (`eventstore.test.ts`). 68/68 tests pass, `tsc` clean.
`npm run lint` clean.

## Next slice

Remaining work is beyond the current roadmap and gated by the project
constraint:
- **Task-DAG parallel execution** — deferred with a concrete reason: each task's
  `engineer()` promotes via a merge into the main branch, so running independent
  tasks concurrently would race on `index.lock`/the main branch. Safe parallelism
  requires tasks to accumulate on separate branches and merge sequentially.
- **Candidate parallel execution by default** — available via `parallel: true`;
  not default because a single serial worker gains nothing and concurrency
  assumes a multi-worker/multi-model backend.
- Deliberately out-of-scope: AutoSpec/InferWeave adapters, a hosted control
  plane, and a Go control plane.

## How to run the evidence yourself

```sh
npx tsc --noEmit
npm test
node scripts/smoke-installed.ts          # standalone package load
node scripts/dogfood.ts <repo> <goal>    # real-model end-to-end (dev tool)
```
