# 10 — Cross-Repo Work Breakdown

This work is intentionally decomposed so a main orchestration agent can delegate to subagents.

Repository names must be **discovered from the actual parent directory**. Do not assume exact folder names.

## Workstream A — InferWeave capability contract

Primary repository: InferWeave gateway/control plane.

Deliver:

- typed capability model;
- backend capability collector abstraction;
- current-runtime collector(s), including vLLM `max_model_len` support where applicable;
- normalized `/v1/models` extension fields;
- `/v1/models/{id}/capabilities`;
- ETag/generation/cache behavior;
- context-aware candidate filtering;
- unit/integration tests;
- API docs.

Dependencies: none.

## Workstream B — InferWeave dynamic admission

Primary repository: InferWeave gateway/scheduler/admission.

Deliver:

- identify current fixed context reservation path;
- separate caller concurrency from token/context capacity;
- request-scoped weighted reservation;
- two-stage estimate/correction where needed;
- exhaustive release semantics;
- lease watchdog/reaper;
- structured rejection reasons;
- queue/fairness integration;
- metrics/tests.

Dependency: capability model from A can be defined as interface/fixture first.

## Workstream C — routing/affinity/KV lease split

Primary repository: InferWeave routing/session/cache components.

Deliver:

- hard request lease;
- metadata affinity lease;
- soft KV/cache lease;
- TTL and pressure eviction;
- context hard filter before route scoring;
- session migration when context exceeds preferred backend;
- metrics/tests.

Dependencies: A and B contracts.

## Workstream D — Pi engineering harness dynamic provider

Primary repository: pi-engineering-harness.

Deliver:

- InferWeave provider adapter using `refreshModels` or existing provider infrastructure;
- robust capability parser;
- context/output precedence;
- TTL/ETag/shared cache;
- abort/timeout handling;
- local override rules;
- diagnostics command;
- tests.

Dependency: can begin with fixture from A.

## Workstream E — Pi context/status integration

Primary repository: pi-engineering-harness.

Deliver:

- status bar `used/window/%`;
- capability source/freshness diagnostics;
- model-switch safety;
- compaction telemetry;
- optional adaptive compaction only behind a disabled-by-default feature flag unless evidence demands it;
- integration with existing repo/branch/worktree/model/tok-s status bar.

Dependency: D.

## Workstream F — cross-repo integration and benchmark

Can be owned by parent workspace/orchestrator repository or the most appropriate integration repo.

Deliver:

- contract fixtures;
- parent-directory integration script;
- old-vs-new admission benchmark;
- idle-session test;
- cancellation/leak soak;
- mixed context routing test;
- rollout report.

Dependencies: A–E.

## Parallelization

Suggested:

```text
Wave 1:
  A capability contract
  D Pi adapter against fixtures
  baseline instrumentation

Wave 2:
  B dynamic admission
  C lease split
  E Pi status/model-switch behavior

Wave 3:
  F integration/load/fault tests
  docs/dashboard
  rollout cleanup
```

## Separation of responsibility

The implementation agent should use separate subagents for:

- server API/capabilities;
- admission/leases;
- Pi provider;
- tests/benchmark;
- review.

A reviewer should specifically inspect:

- leaked permits;
- arithmetic overflow;
- race conditions;
- stale capability behavior;
- context routing guarantees;
- backward compatibility.

## Required repo discovery from parent workspace

Before implementation:

```bash
pwd
find . -maxdepth 3 -type d -name .git -print
```

Then inspect READMEs/package/module manifests to identify:

- InferWeave gateway/control-plane repo;
- pi-engineering-harness repo;
- shared libraries;
- observability/dashboard repo if separate;
- integration/orchestration repo if present.

Do not create duplicate projects because a guessed folder name was wrong.

## Spec placement

Copy relevant specs under each affected repository's `docs/specs/` tree.

Recommended logical location:

```text
docs/specs/dynamic-context-capabilities/
```

The overview and acceptance criteria may be copied to both primary repos so each has enough local context. Repo-specific specs should live in their owning repo.
