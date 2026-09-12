# Pi Engineering Runtime — Validation and Dogfooding Mission

The initial autonomous bootstrap has completed.

Your task is to independently determine the current repository state, validate the implementation thoroughly, repair anything material that is broken, and prove that the package works in a realistic standalone Pi workflow.

Do not assume the bootstrap report was correct.

Read:

* `AGENTS.md`
* `docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`
* the current implementation
* existing tests
* git status/history

Work autonomously.

Do not ask the operator to confirm ordinary engineering choices.

## Phase 1 — Establish Current State

Determine:

* what portions of the specification are implemented;
* which intended bootstrap requirements are incomplete;
* whether implementation and documentation agree;
* whether there are uncommitted changes;
* whether there are obvious architectural shortcuts or temporary hacks.

Do not merely report gaps. Fix bootstrap-scope gaps when practical.

## Phase 2 — Deterministic Validation

Run all relevant:

* dependency installation checks;
* formatting;
* linting;
* TypeScript/type checking;
* unit tests;
* integration tests;
* end-to-end tests;
* package build;
* package loading checks.

Investigate and fix failures.

Do not treat model confidence as verification.

## Phase 3 — Standalone Installation Test

Prove that this repository behaves as an actual Pi package rather than only passing internal tests.

Create or use a disposable fixture/test repository.

Install the local Pi Engineering Runtime package into that repository using the supported local Pi package mechanism.

Verify that Pi successfully discovers and loads:

* extensions;
* commands;
* skills;
* configuration;
* runtime components required by the current milestone.

Do not publish the package.

## Phase 4 — Real Dogfood Scenario

Create a small but realistic fixture project with:

* more than one source file;
* tests;
* a behavior that can be modified;
* enough structure to require repository exploration.

Use Pi Engineering Runtime to perform a real engineering task against it.

The scenario should exercise as much of the current vertical slice as actually exists, especially:

1. repository inspection;
2. compact context acquisition;
3. Engineering Ledger usage;
4. fresh-context scout;
5. implementation;
6. targeted deterministic verification;
7. fresh-context reviewer or challenger;
8. repair of material findings;
9. concise evidence reporting.

Instrument and record where possible:

* parent context/token usage;
* worker context/token usage;
* number of worker invocations;
* tool calls;
* verification actions;
* questions requested;
* autonomous decisions;
* large output kept outside model context;
* failures found by verification;
* findings found by independent review.

If a required capability from the bootstrap specification is not actually implemented enough to dogfood, implement the smallest correct version required to demonstrate it.

## Phase 5 — Independent Fresh Review

Run a genuinely fresh-context review of the resulting Pi Engineering Runtime implementation.

The reviewer should not inherit the bootstrap conversation or implementation reasoning.

Provide only:

* specification requirements relevant to the bootstrap milestone;
* implementation diff/current code as necessary;
* architectural constraints;
* verification evidence.

The reviewer must specifically inspect for:

* accidental transcript/context inheritance;
* fake rather than real fresh-context workers;
* oversized prompts;
* unbounded worker responses;
* mutable shared-state hazards;
* incorrect Pi API assumptions;
* tightly coupled provider interfaces;
* AutoSpec or InferWeave dependencies leaking into core;
* shell/process safety issues;
* test gaps;
* false claims of validation;
* unnecessary dependencies;
* premature complexity.

Fix all material findings.

Rerun affected validation afterward.

## Phase 6 — Architecture Reality Check

Compare the implementation against the authoritative specification.

Classify each major bootstrap requirement as:

* IMPLEMENTED AND VERIFIED
* IMPLEMENTED BUT NOT VERIFIED
* PARTIAL
* NOT IMPLEMENTED
* DEFERRED BY DESIGN

Do not pretend future abstractions already exist.

Create or update:

`docs/ROADMAP.md`

The roadmap must describe actual repository state rather than merely copying the specification.

Prioritize subsequent work based on:

1. correctness;
2. actual dogfooding pain;
3. token/context reduction;
4. autonomous operation;
5. verification quality;
6. worker isolation;
7. only then broader orchestration features.

## Phase 7 — Determine the Next Slice

If the initial vertical slice is healthy, identify and implement the highest-value small next slice that naturally follows from dogfooding.

Prefer, in this order when supported by evidence:

1. artifact-backed large-output handling;
2. context broker improvements;
3. autonomy and context telemetry;
4. clean-room `/challenge`;
5. worktree isolation;
6. risk-adaptive orchestration.

Do NOT jump yet to:

* full candidate tournaments;
* large parallel DAG scheduling;
* AutoSpec integration;
* InferWeave integration;
* dashboard work.

Only implement additional work if the bootstrap is already verified and the next slice is clearly bounded.

## Git

Preserve unrelated work.

Use coherent conventional commits.

Do not push or publish.

If the repository was left with valid uncommitted bootstrap changes, validate them first and commit them coherently.

## Completion Gate

Do not finish until:

* the project builds;
* deterministic tests pass;
* Pi can load the package;
* a standalone fixture repository has exercised the package;
* a fresh-context review has occurred;
* material findings have been repaired;
* verification has been rerun;
* the roadmap reflects reality.

At completion report concisely:

* what the bootstrap actually implemented;
* what validation was performed;
* the dogfood scenario and outcome;
* fresh-review findings;
* fixes made;
* context/autonomy metrics obtained;
* commits created;
* current limitations;
* exact recommended next milestone.

Begin immediately.
