# Pi Engineering Runtime — Autonomous Next Milestone

Pi Engineering Runtime has completed its initial bootstrap and dogfood validation.

This is no longer a bootstrap exercise.

Your job is to continue development autonomously using the repository's actual implementation state and evidence.

Read, in order:

1. `AGENTS.md`
2. the authoritative specification under `docs/specs/`
3. `docs/ROADMAP.md`
4. current source and tests
5. recent git history
6. dogfood/validation evidence produced by previous runs
7. current Engineering Ledger state, if available

Do not assume the roadmap is correct. Reconcile it with the implementation and test evidence.

## Objective

Select the highest-value unblocked next milestone and implement it completely.

Prioritize capabilities that improve:

1. correctness;
2. token/context efficiency;
3. autonomous operation;
4. fresh-context isolation;
5. deterministic verification;
6. dogfood usability;
7. only then broader orchestration scale.

Do not ask the operator to select the milestone unless the specification genuinely permits materially incompatible product directions.

Recommendation equals action.

## Expected Priority Order

Use actual evidence to override this ordering when appropriate, but the expected sequence is:

1. artifact-backed large-output handling and lazy retrieval;
2. Context Broker improvements;
3. context/token/autonomy telemetry;
4. real clean-room `/challenge`;
5. worker/process isolation improvements;
6. Git worktree candidate isolation;
7. risk-adaptive orchestration;
8. multiple competing candidates;
9. deterministic candidate tournament;
10. parallel task DAG execution;
11. advanced testing/fuzz/property/mutation verification;
12. AutoSpec adapter;
13. InferWeave adapter;
14. CI/dashboard integration.

Do not skip directly to AutoSpec, InferWeave, large DAG orchestration, or dashboards while core standalone Pi behavior remains incomplete.

## Milestone Requirements

For the milestone you select:

### 1. Establish Baseline

Before modifying code:

* identify the current behavior;
* identify the concrete limitation demonstrated by dogfooding;
* identify relevant specification requirements;
* identify measurable success criteria;
* record a compact baseline where useful.

### 2. Design

Choose the smallest architecture that solves the problem while preserving future extensibility.

Do not create speculative abstractions with no current consumer.

Keep Pi Engineering Runtime model-agnostic.

DeepSeek-V4-Flash is the current reference model for dogfooding, but no core API should depend on DeepSeek-specific behavior.

### 3. Implement

Implement the selected milestone completely.

Prefer vertical functionality over disconnected framework pieces.

Maintain backwards compatibility with the already-working standalone Pi workflow unless the specification explicitly requires otherwise.

### 4. Dogfood

Use the newly implemented capability during this repository's own development whenever practical.

Do not fake dogfooding through mocks when a real Pi invocation can safely exercise the feature.

### 5. Verify

Use machine evidence.

Run all relevant:

* formatters;
* linters;
* type checking;
* unit tests;
* integration tests;
* fixture/end-to-end tests;
* package loading tests;
* realistic Pi workflow tests.

For context-related features, measure context/token effects when the runtime exposes enough information to do so.

### 6. Fresh Independent Review

Launch a genuinely fresh-context reviewer.

The reviewer must not inherit implementation reasoning.

Give it only the required specification constraints, relevant implementation, and verification evidence.

Ask it specifically to find:

* correctness defects;
* context leaks;
* unbounded output;
* accidental transcript inheritance;
* weak provider abstractions;
* race/concurrency hazards;
* error-handling gaps;
* unverifiable success claims;
* unnecessary complexity.

Finding no material problem is an acceptable review result.

Fix material findings and rerun affected verification.

### 7. Record Evidence

Update the Engineering Ledger and/or project evidence with verified facts rather than narrative history.

Where applicable track:

* peak parent context;
* worker context size;
* retrieved code tokens;
* tool-output bytes;
* bytes/tokens withheld behind artifact handles;
* worker count;
* verification actions;
* user questions;
* autonomous decisions;
* failures caught by deterministic verification;
* failures caught by fresh review.

### 8. Update Roadmap

Update `docs/ROADMAP.md` based on actual state.

Mark requirements truthfully as:

* VERIFIED
* IMPLEMENTED
* PARTIAL
* BLOCKED
* DEFERRED
* NOT STARTED

Do not mark capabilities complete merely because interfaces exist.

### 9. Commit

Create coherent conventional commits for completed work.

Do not push or publish unless explicitly configured to do so.

## Autonomous Behavior

Do not stop for ordinary engineering decisions.

Do not ask about:

* naming;
* file placement;
* dependency selection when clearly justified;
* implementation details;
* testing details;
* refactoring;
* reversible architecture decisions;
* documentation;
* whether to fix problems discovered during this milestone.

Investigate and act.

If one component is blocked, continue independent work.

Only escalate a genuinely consequential unresolved product decision that cannot be resolved from the specification, repository, tests, documentation, or experiments.

## Completion Gate

Do not finish until:

* one meaningful next milestone is complete;
* it has been exercised realistically;
* deterministic verification passes;
* fresh-context review has completed;
* material findings are repaired;
* verification has been rerun;
* roadmap and ledger reflect reality;
* completed work has been committed.

At completion, report only:

* milestone selected and why;
* functionality added;
* dogfood result;
* measurable context/autonomy impact;
* verification evidence;
* fresh-review findings;
* commits;
* remaining limitation;
* recommended next milestone.

Begin immediately.

---

## Milestone Report — Verifiable Roadmap Completion (Roadmap 1.0) — COMPLETE

**Milestone selected and why:** M12 Verifiable Roadmap Completion — the final
required milestone. It makes "done" a machine-derivable property (never a model
declaration) and closes the loop on all prior work.

**Functionality added:** structured Roadmap 1.0 (`docs/roadmap/roadmap.yaml`),
evidence-derived milestone states, impact-based invalidation, release gate,
`roadmap check|status` CLI + `/roadmap-status`, autonomous stop.

**Dogfood result:** full lifecycle proven deterministically in a disposable repo
(incomplete→1, verified→0, invalidated→1+NEEDS_REVERIFICATION, reverified→0,
status complete, final check 0). The repo's own roadmap passes its gate.

**Verification evidence:** `roadmap check` exit **0**, complete:true, release gate
PASS, 12/12 VERIFIED (M13 DEFERRED); **116/116** tests; typecheck + biome clean.

**Fresh-review findings:** six independent fresh-context review rounds; all material
findings fixed with regression tests (manual whitelist, fail-safe freshness,
no-review-fails, criterion binding, orphan-fail invariant, failing-refresh≠demote,
autonomous-stop on all entry points, schema hardening). Final state: no HIGH.

**Commits:** 10 (roadmap system `9a54771` + 9 fix/docs commits), pushed to `origin`.

**Remaining limitation:** Task-DAG parallel execution (M13) deferred with an
explicit reason (per-task `engineer()` promotes via merge into main → `index.lock`
race; safe parallelism needs branch-based candidate accumulation + sequential
integration). Also: the autonomous-stop gate is conservative on a fresh checkout
(deterministic evidence is gitignored and regenerated locally), so it never blocks
without local evidence — a deliberate fail-safe tradeoff.

**Recommended next milestone:** M13 Parallel Task DAG execution, or a CI config
(`roadmap:check` in CI, spec §20 SHOULD) and the deferred benchmark/autonomy/
docs/e2e sub-gates (backlog B-102).
