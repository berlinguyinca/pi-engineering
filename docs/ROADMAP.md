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
| Relevance-ranked context + scout-guided required files | **Works** | `context.test.ts`, integration: scout-required test |
| Fresh-context review loop (fix rounds carry diff+findings feedback) | **Works** | integration: fix-round test |
| `/commands` + semantic tools in pi | **Works** | `scripts/smoke-commands.ts`, `scripts/smoke-installed.ts` |
| Real-model end-to-end dogfood | **Works** | `scripts/dogfood.ts`; see below |

**Verification evidence (last full run):**
- `npx tsc --noEmit` — passes.
- `npm test` — 49/49 passing (unit + integration).
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
manual `scripts/smoke-*.ts`; `requiredFiles` context hook still unused) are
documented limitations, not correctness defects.

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

These are in the spec but intentionally deferred to keep the vertical slice
reversible and small. They are the next candidates, in rough priority order.

### 1. Task DAGs / multi-step work items

Today a work item is a single goal implemented in one shot (with fix rounds).
The spec allows decomposing a larger goal into dependent tasks with ordering.

- **Why deferred:** single-slice is enough to prove the loop; dependency
  scheduling adds orchestration complexity without new isolation/evidence value.
- **What it needs:** a task planner that emits an ordered list of sub-goals, each
  run through the existing pipeline, with dependency edges recorded in the ledger.

### 2. Verify profile caching

`Verifier.detect()` re-reads `package.json` and re-derives the profile on every
call. Caching the profile per-repo (keyed on package.json content) would cut a
small amount of work in multi-round runs.

- **Why deferred:** negligible cost today; the vertical slice favors clarity.
- **What it needs:** an in-memory (or `.pi-eng/`-persisted) cache keyed on the
  detected inputs, invalidated on change.

### 3. `/verify` full-suite mode

`/verify` currently runs the detected profile (typecheck/test/build). A
`/verify full` variant could additionally run lint + a broader test set and
record all of it as evidence.

- **Why deferred:** the evidence-recording path is in place; adding more stages
  is profile configuration, not architecture.

## Known limitations (honest)

- **Single model assumption.** Workers run on whatever model the session uses.
  The spec's "multiple models" provisions are out of scope by project constraint.
  This means a reviewer and an implementer can share a failure mode (anchoring).
  The clean-room challenger mitigates this for high/critical risk only.
- **Promotion is a merge, not a squash.** The incumbent history accumulates one
  "implementation candidate" + one "promote" commit per accepted round. This is
  intentional (auditable lineage) but is noisier than a squash.
- **No linting/formatting configured.** The project has no formatter/linter
  wired into CI (out of the vertical slice's minimal scope). `tsc` + tests are
  the gate. Adding `biome`/`prettier` is a small, safe improvement.
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

## Next slice

**Task DAGs (priority #3).** The next highest-value slice: decompose a larger
goal into an ordered list of dependent sub-goals, each run through the existing
pipeline, with dependency edges recorded in the ledger. This increases the
breadth of work items the runtime can accept and exercises the ledger's
lineage model (`parent_id`). A close second is **verify-profile caching** (item
2 below), a small token saver in multi-round runs.

**Candidate tournaments:** already implemented as a vertical slice.
`EngineeringRuntime.tournament(goal, { n })` spawns N independent candidates
from the same base commit, verifies each, reviews each survivor, deterministically
selects a winner (fewest material findings, then fewest changed files, then stable
id), records the losers as rejected, and promotes the winner via the controlled
merge. Covered by a deterministic integration test (`test/integration/vertical-slice.test.ts`:
"candidate tournament ..."). Remaining tournament refinements:

- Parallel candidate execution (today candidates are produced sequentially).
- Configurable winner-selection strategy beyond the current deterministic sort.
- A clean-room challenger pass across the finalists.

A close second is **task DAGs (item 2)**, which increases the breadth of work
items the runtime can accept.

## How to run the evidence yourself

```sh
npx tsc --noEmit
npm test
node scripts/smoke-installed.ts          # standalone package load
node scripts/dogfood.ts <repo> <goal>    # real-model end-to-end (dev tool)
```
