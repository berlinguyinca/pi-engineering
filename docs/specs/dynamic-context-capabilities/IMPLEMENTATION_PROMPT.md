# Paste-Ready Implementation Prompt

Run this prompt from the **parent/main directory that contains all related projects/repositories**.

---

You are the main implementation/orchestration agent. Implement the InferWeave + Pi dynamic context capability/admission specification end-to-end. Do not stop after planning.

The implementation spec ZIP is in my Downloads directory and is named like:

`inferweave-pi-dynamic-context-capabilities-spec-*.zip`

## 1. Locate and unpack the spec

First show me the current directory and discovered repositories.

Run/perform the equivalent of:

```bash
pwd
find . -maxdepth 3 -type d -name .git -print
```

Locate the newest matching ZIP in `~/Downloads` (also tolerate `$HOME/Downloads` and a platform-equivalent Downloads directory if needed), unpack it into a temporary directory, and read **all** files before making architectural decisions.

Do not assume repository folder names. Inspect the repositories in this parent directory, their README files, manifests, existing `docs/specs`, architecture, configuration, tests, and current InferWeave/Pi integration. Identify at minimum:

- the InferWeave gateway/control-plane/admission/routing code;
- the `pi-engineering-harness` or equivalent Pi harness code;
- shared libraries/packages;
- observability/dashboard code if separate;
- integration/orchestration repo if one exists.

Copy the relevant specification documents into each owning repository under:

`docs/specs/dynamic-context-capabilities/`

Put the overview and acceptance criteria wherever needed so each primary repo has enough local context. Do not create duplicate projects because a guessed folder name was wrong.

## 2. Inspect the current implementation before changing it

Search all related repos for current assumptions and code paths involving:

- `260000`, `260k`, `262144`;
- context slots/seats;
- caller concurrency;
- session admission;
- context windows;
- model discovery;
- `/v1/models`;
- vLLM `max_model_len`;
- model routing;
- session affinity;
- KV/prefix cache;
- reservation/lease acquisition and release;
- Pi provider registration;
- `contextWindow`;
- `maxTokens`;
- Pi compaction settings;
- status/footer metrics.

Classify every 262144 occurrence: legitimate model capability vs generic/static reservation. Do not mechanically replace legitimate model limits.

Before editing, summarize the discovered architecture and identify exactly where the existing fixed/full-window reservation and `caller_concurrency` behavior originates.

## 3. Use subagents/worktrees where appropriate

Decompose the implementation and run independent work in parallel when safe.

At minimum use distinct workstreams/subagents for:

A. InferWeave capability API/runtime collectors  
B. InferWeave admission/request leases  
C. routing/affinity/KV lease separation  
D. Pi dynamic provider/context integration  
E. tests/load/failure validation  
F. independent review of concurrency/race/resource-leak correctness

Do not have multiple agents modify the same files concurrently. Use separate worktrees/branches if the harness supports them, then integrate deliberately.

Keep me informed in the terminal/output about what is running, what each subagent owns, and what has completed. Do not run silently.

## 4. Implement capability discovery first

Implement the normalized InferWeave model capability contract described in the specs.

Requirements include:

- runtime/deployment context discovery;
- vLLM `max_model_len` support where vLLM is used;
- normalized `context_window`/`max_model_len` and max-output metadata;
- capability provenance and generation;
- enriched `/v1/models` while preserving OpenAI compatibility;
- detailed model-capability endpoint or the equivalent existing API pattern;
- cache/ETag/refresh behavior;
- explicit stale behavior;
- heterogeneous deployment context calculation;
- hard route filtering by required total context.

A model alias may advertise a large context only when InferWeave guarantees routing requests of that size to a capable deployment.

## 5. Implement Pi dynamic discovery using supported Pi mechanisms

Use the existing Pi extension/provider APIs; do not fork Pi core unless the extension/provider API is demonstrably insufficient.

Prefer the existing Pi engineering harness provider architecture. Implement dynamic discovery/refresh so models get:

- `contextWindow` from InferWeave's guaranteed routable context;
- `maxTokens` from the server's output limit.

Support parsing, in precedence order:

1. InferWeave normalized guaranteed context;
2. `context_window`;
3. `max_model_len`;
4. explicit safe local override;
5. fresh last-known-good value;
6. conservative default (128K unless the existing project has an intentionally different safe default).

There must be no generic 260K fallback.

Implement cache TTL, request timeout, abort handling, stale-if-error behavior, ETag/conditional refresh where appropriate, diagnostics, and tests.

Integrate context usage into the existing Pi engineering-harness status bar so it shows approximately:

`model · ctx used/window % · tok/s · directory · repo:branch · worktree`

Do not create a competing duplicate footer if one already exists.

## 6. Replace static/full-window admission

Find the current admission logic that causes a Pi caller/session to hold a fixed/full context reservation.

Refactor it so:

- caller concurrency counts actual active/queued requests according to policy, not idle sessions;
- context capacity is a separate weighted resource;
- request reservation is based on actual/estimated prompt + bounded output budget + configurable safety margin;
- exact/authoritative token count corrects any early estimate;
- hard request reservations are released on completion, cancellation, disconnect, timeout, error, and routing failure;
- a watchdog/reaper cleans orphan reservations;
- structured rejection reasons distinguish caller concurrency, queue-full, context capacity, model-context exceeded, no capable backend, and backend saturation.

Preserve existing fairness/priority semantics unless the spec explicitly improves them.

Do not trust client token counts for server safety decisions.

## 7. Separate request, affinity, and KV leases

Implement/normalize three concepts:

- hard request lease;
- lightweight session-affinity lease;
- soft KV/cache lease.

Affinity and soft KV state must not hold a caller-concurrency permit after a request finishes.

Soft KV state must be TTL-bound and pressure-evictable. Preserve sticky-session/cache performance where possible, but never reject otherwise feasible work merely to preserve idle cache.

If a session grows beyond its preferred backend's context capacity, route/migrate to a capable deployment rather than forcing it onto the old backend.

## 8. Pi compaction

Use Pi's native compaction behavior with the dynamically registered `contextWindow`.

Do not build a second compaction engine.

Ensure:

- model switches update subsequent context behavior;
- large -> small model switching compacts before an impossible request or fails clearly before dispatch;
- overflow recovery still works;
- compaction telemetry includes model/window/tokens/reason/result.

Leave any adaptive percentage/reserve policy disabled by default unless tests prove it is necessary.

## 9. Observability

Add metrics/logs/dashboard/status integration described in the spec.

We need to be able to answer:

- What context window does the runtime expose?
- What does InferWeave guarantee?
- What does Pi believe?
- How much context is the active request actually reserving?
- Why was it rejected?
- Is a hard request permit still held?
- Is only affinity/KV soft state retained?
- How many 429s are `caller_concurrency` vs real context/backend capacity?

Never put full prompts in normal metrics.

## 10. Tests and benchmark

Implement and run the complete relevant test matrix, including:

- 32K/64K/128K/262K/1M capabilities;
- malformed/missing capability fields;
- Pi discovery/refresh/fallback;
- large->small model switch;
- heterogeneous backend routing;
- concurrent small vs large requests;
- 100 idle sessions with only a few active requests;
- cancellation/disconnect/error resource release;
- leak soak test;
- stale capability failure;
- old fixed reservation vs new weighted admission benchmark.

Produce machine-readable benchmark output and a concise before/after summary.

The key regression assertion is:

> Idle Pi sessions and cached affinity/KV state do not consume hard caller-concurrency permits, and ordinary small requests no longer reserve the entire model context window.

## 11. Review

After implementation, use an independent reviewer/subagent to inspect the diff specifically for:

- permit/resource leaks;
- race conditions;
- double-release;
- arithmetic overflow;
- stale capability hazards;
- unsafe context expansion;
- routing a request to a too-small backend;
- backward compatibility;
- auth/tenant separation for session/cache identity;
- missing error paths.

Fix issues found by review, then rerun affected tests.

## 12. Completion behavior

Continue through implementation, integration, testing, review, fixes, and documentation. Do not stop at a plan or TODO list.

Show commands/output and progress as you work.

At completion provide:

1. repositories/files changed;
2. architecture implemented;
3. old fixed-reservation behavior found and how it changed;
4. tests and benchmark results;
5. before/after admission/concurrency behavior;
6. feature flags/config added;
7. any migrations;
8. any remaining limitations with concrete follow-up issues.

Do not claim completion until the tests that can run in this workspace have actually been run.
