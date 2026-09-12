# Pi Engineering Runtime — Autonomous Bootstrap Mission

You are Pi, bootstrapping an engineering runtime that will extend Pi itself.

The authoritative specification is:

`docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`

Read the specification and repository instructions before making architectural decisions.

This run is autonomous.

Do not stop after planning.

Do not ask the operator to confirm normal engineering choices.

Investigate, decide, implement, test, review, repair, and continue.

## Primary Goal

Create the first production-quality standalone Pi Engineering Runtime vertical slice.

It must work with a normal Pi installation in an ordinary Git repository.

It MUST NOT require:

* AutoSpec
* InferWeave
* GitHub
* multiple models
* distributed infrastructure

Those capabilities will be optional adapters later.

## Required Vertical Slice

Build enough functionality that a normal Pi coding session can:

1. inspect a Git repository;
2. maintain a compact Engineering Ledger;
3. spawn a fresh-context scout;
4. receive only a bounded structured scout result;
5. retrieve task-relevant repository context;
6. make an implementation;
7. execute deterministic targeted verification;
8. run a fresh-context independent review;
9. fix material findings;
10. report concise evidence of completion.

## Implement

Implement the smallest coherent architecture supporting:

* standalone Pi package metadata;
* TypeScript project structure;
* core runtime interfaces;
* Engineering Ledger;
* artifact/result storage abstraction;
* bounded worker result protocol;
* fresh-context worker execution;
* Context Broker interfaces;
* verification provider abstraction;
* minimal Git/repository provider;
* scout workflow;
* reviewer workflow;
* challenge workflow;
* `/review`;
* `/challenge`;
* `/verify`;
* `/ledger`;
* `/context`;
* unit tests;
* fixture repositories;
* end-to-end test of the complete vertical slice;
* installation and usage documentation.

## Use Pi Itself

Use Pi's supported extension, Skill, prompt, package, SDK, RPC, and session mechanisms where appropriate.

Do not fork Pi.

Inspect upstream Pi documentation and source when necessary rather than guessing Pi APIs.

The runtime should build ON Pi rather than duplicating functionality already supplied by Pi.

## Context Discipline

This project's primary goal includes reducing context footprint.

Therefore:

* do not propagate entire parent transcripts to workers;
* workers receive only task-specific context;
* worker responses must be bounded and structured;
* large logs remain external artifacts;
* tool output should be summarized with retrieval handles;
* repository contents should be retrieved incrementally;
* persistent engineering knowledge belongs in the ledger, not conversation history;
* clean-room workers must genuinely start without inherited reasoning.

Track context/token usage where Pi APIs expose it.

## Autonomy

Recommendation equals action.

Resolve uncertainty using, in order:

1. authoritative specification;
2. existing repository code and conventions;
3. tests;
4. upstream Pi documentation/source;
5. experiments;
6. sound engineering judgment.

Do not stop to ask about:

* filenames;
* directory placement;
* type names;
* implementation strategies;
* refactoring;
* test additions;
* documentation changes;
* reversible architectural choices;
* dependencies that are clearly justified;
* formatting or lint fixes.

If several reasonable options exist, choose the strongest one and continue.

Only a genuinely unresolved, materially consequential product decision may block progress.

If one part is blocked, record the blocker and continue everything independent of it.

## Scope Control

Do NOT yet implement:

* full AutoSpec integration;
