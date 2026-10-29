# 04 — Optimization plan and measurements

## O1: Remove accidental mission overhead (P0)
Disable `before_agent_start` mission directive for ordinary interactive prompts; retain legacy flag only for old clients. Test prompts: hello, questions, fix, retry, continue, print, implement and plan. Measure time to first useful tool call, unnecessary subagent launches and task start overhead. Zero implicit Mission creations in new mode.

## O2: One routing decision, separate planning from scheduling (P0)
Deduplicate `chooseMode`, intent routing, model/role routing and orchestration classification decisions. Planning decides work and dependencies; scheduler owns work execution and conflict handling; InferWeave owns model admission/capacity, Slurm owns eligible compute placement. Prevent retries multiplying at gateway + Pi + broker. Expose per-layer ownership trace.

## O3: Event projection efficiency (P0)
Choose canonical write log; avoid duplicate persistence of identical task state. Incremental projection updates with cursor, bounded batched writes and snapshots. Measure write amplification, replay duration at 10k/100k/1M events, memory, cold start and reconnection latency. Avoid adding a global broker just to redraw a graph.

## O4: Scoped verification cache (P1)
Share proven immutable evidence keyed by revision, relevant files/dependency tree, test configuration, runtime and environment. Selective retest where dependency map is trustworthy; full test suite required for configured release/security gates. Never claim passing checks from incomplete cache. Measure CI minutes and test correctness.

## O5: Adaptive agent parallelism (P1)
Estimate value of parallel work before launch, not fixed agent count: runnable independent subtasks, write overlap, context packaging cost, inference queue, expected wall time, reviewer demand. Schedule ready non-colliding work only. Scale down when admission waits/serialization dominate. Track speedup vs single-agent baseline and collision cost.

## O6: Context budget optimization (P1)
Use ContextBroker retrieval on files/diffs/issues/artifacts with provenance; summaries and deterministic state only for handoffs; progressive expansion as needed. Avoid redundant full transcript forwarding or re-reading unchanged files. Report prompt/prefill, completion, cache hit and wasted repeat tokens; benchmark 131k and 200k contexts without assuming bigger means better.

## O7: Useful checkpoint cadence (P1)
Checkpoint on meaningful transitions (commit, test milestone, verified deliverable, handoff, operator steering), with adaptive periodic fallback; avoid timer-only write storms. Measure recovery time, duplicate work, checkpoint size and lost work.

## O8: Supervisor in shadow mode first (P2)
Second LLM detects loops/stalls, bad tools, degraded context, inappropriate model routing. Log proposed action + confidence, compare against independent reference/benchmark outcome; no auto prompt/policy rewrite initially. Promote only measured improvements under bounded capability. Track false positives, wasted inference, task success and regression rate.

## O9: Low-noise UI and event aggregation (P1)
Merge redundant polling/heartbeat loops where possible; preserve distinction heartbeat vs progress; adaptive refresh on change; compact terminal display; dashboard stream cursors and backpressure. Measure CPU overhead, redraw rate and time to notice genuine blockers.

## O10: Complexity budget (P0)
New services/schemas/controllers must show no reusable equivalent; track removed files/commands/branches/dependencies and net code complexity. Target zero duplicate schedulers for same responsibility; no extra user-facing orchestration wizard. Set benchmark *targets after* baseline measurements; never invent percent improvements before profiling.

## Benchmark matrix
Compare legacy mission, direct, adaptive, team over controlled fixtures: trivial fix, medium refactor, multi-repo API, security-sensitive change, review-only, 429 storm, model context ceiling, crash/restart, conflicting worktrees, stale CI, user pause, duplicate webhook, partial work and handoff. Capture task success, completeness, independent review validity, p50/p95 time to first tool / verified finish, LLM tokens and cost, number of worker launches, write amplification, failure recovery, operator turns, false completion. Preserve baseline and attach profiler traces.
