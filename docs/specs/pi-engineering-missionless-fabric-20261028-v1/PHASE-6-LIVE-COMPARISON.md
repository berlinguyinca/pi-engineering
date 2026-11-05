# Phase 6 live comparison: default (no implicit Mission) vs legacy auto-invoke

Evidence for criterion 3 of `PHASE-6-RETIREMENT.md` ("a live-model comparison exists showing no regression in verification outcome rate on the same prompts"). Raw per-run data: `PHASE-6-LIVE-COMPARISON.json`.

## Setup

- Code under test: origin/main `278c7468`, loaded with `pi --no-extensions -e <checkout>/extensions/index.ts --approve --no-session -p --mode json` (print mode never injects the Mission directive, so JSON mode is used for both arms).
- Arms. DEFAULT: no `legacy_auto_invoke`. LEGACY: repo policy `execution.legacy_auto_invoke: true`, `hold_mission_model: true`. Both arms: same single model, `metabolomics/qwen3.8-27b-modality-vision-quant-q8_k_xl`, every routing role pinned to it, identical plain-language prompts.
- Isolation: `PI_CODING_AGENT_DIR` = per-run copy of a sandboxed agent dir, `PI_ENGINEERING_STATE_DIR` = per-run dir, a fresh `git worktree` of the fixture per run. The real `~/.pi/agent/models.json` md5 was `30fd3d7f9f4f4e72f65b7686e40c28b8` before and after.
- Fixture: `shopkit`, a small offline JS library (cart, money, tax, discount, csv importer, report) with `node --test`. One branch per task. Hidden acceptance tests are never in the agent's tree; the harness runs them afterwards in a scratch dir, together with (a) the agent's own `npm test` and (b) the original visible tests restored from the task commit (so deleting or editing a failing test cannot count). Judges were validated against reference solutions (all pass) and the untouched starting state (all fail); T4 was validated for both the merge and the reject-duplicate designs.
- Tasks: T1 one-file bug from a failing test (truncate off-by-one); T2 multi-file feature (`formatPercent`, `describeDiscount`, report lines); T3 behaviour-preserving refactor (extract `renderLine`, byte-identical golden output); T4 ambiguous (same product added twice; hidden test accepts merge or reject-without-losing-data); T5 root cause in another file (CSV subtotal off by a cent, cause is `toCents` truncation in `money.js`).
- Prompts were checked with the real `decideAutoInvoke` so that all five invoke the directive in the legacy arm (a first draft of T1 and T4 would not have: one ended in "?" and one classified as conversation). Every LEGACY run shows the directive injected (15/15).
- Design: 3 runs per cell, 30 runs, interleaved by repetition (arm order alternates per repetition), concurrency 1. Wall caps: 40 min default, 90 min legacy. Correct = hidden pass AND own visible pass AND original visible pass.

## Results

Contaminated runs (gateway fell back to another model): **0 of 30** in this attempt. Timeouts are counted as outcomes, not dropped.

| Task | DEFAULT correct | DEFAULT wall median (range) | LEGACY correct | LEGACY wall median (range) |
|---|---|---|---|---|
| T1 failing-test fix | 3/3 | 34 s (24-40) | 3/3 | 591 s (475-758) |
| T2 multi-file feature | 3/3 | 222 s (158-247) | 2/3 (1 blocked, wrong) | 3286 s (2750-5401) |
| T3 refactor | 3/3 | 141 s (76-235) | 3/3 | 2085 s (1539-4741) |
| T4 ambiguous | 2/3 (1 timeout) | 144 s (80-2400) | 3/3 | 631 s (545-671) |
| T5 cross-file root cause | 3/3 | 91 s (68-182) | 2/3 (1 timeout, no fix) | 994 s (682-5400) |
| **Overall** | **14/15 (93%), Wilson 95% 70-99%** | **141 s (24-2400)** | **13/15 (87%), Wilson 95% 62-96%** | **994 s (475-5401)** |

Notes on the legacy 13/15: one of the 13 (T2 run 1) hit the 90-minute cap with the correct fix already in the worktree, so it is "correct but not finished". Counting only runs that both finished and were correct: DEFAULT 14/15 (Wilson 70-99%), LEGACY 12/15 (Wilson 55-93%).

Other per-run measures (medians over all 15 runs of each arm): time to first tool call 14.5 s default vs 11.4 s legacy (not a meaningful difference); foreground tool calls 12 vs 6 (the legacy foreground hands work to the Mission); `mission` tool calls 1 total in default (self-initiated, see below) vs 34 in legacy; foreground tokens (input+output) 12.1k vs 5.8k. Token figures cover the foreground session only. Mission worker tokens are not in the foreground events, so the legacy token figure is an undercount and no token-cost comparison is claimed.

Failures:
- DEFAULT T4 run 3: the foreground agent chose to call the `mission` tool itself (no directive was injected), then sat for the full 40 minutes with no change made (timeout, incorrect). It is the only default run that used a Mission.
- LEGACY T2 run 3: Mission ended BLOCKED, hidden test failed.
- LEGACY T5 run 1: 90-minute timeout, bug not fixed, own and original visible tests still failing.

## What the data supports

- Speed: every one of the 14 default runs that finished took at most 247 s; every one of the 15 legacy runs took at least 475 s. Default finished runs have median 116 s; legacy median 994 s, and 2 of 15 legacy runs consumed the whole 90-minute cap. On these tasks the Mission path cost roughly 5-15x the wall time at the median, with a heavy tail.
- Outcome rate: 14/15 vs 13/15 (12/15 if "not finished" is excluded). The intervals overlap almost completely. With n=15 per arm, a true difference of up to roughly 20 percentage points in either direction cannot be excluded. This is "no detected regression", not "equivalence".
- Both arms failed on cases involving a Mission (default T4 r3 self-invoked one; legacy failures were Mission blocked/hung). The default arm's single failure is a Mission-tool hang, which the retirement step does not remove (the explicit tool and `/mission` stay until step 3).

## What it cannot support

- Model variance: one model (Qwen3.8 27B q8), 3 runs per cell. A different or stronger model may use or finish a Mission better.
- Task size: all tasks are small fixture tasks that a single agent can finish in minutes. The Mission's verification and isolation machinery is designed for larger, riskier work; this test says nothing about it (no review gate, long-horizon or multi-hour tasks, or security-sensitive work).
- Shared endpoint load: one gateway, runs were sequential but other users were present, and the 27b worker showed 502/503 under 2-3 concurrent probes, so wall times carry unmeasured load noise. Time medians are robust to it only because the gap is an order of magnitude.
- Judging: hidden tests are the judge, but they are tests I wrote; T4 deliberately accepts two designs; no human review of patch quality. Interleaving was by repetition, not randomised.
- Token cost is not compared (see above).

## Archived attempts (not mixed into the table)

1. First attempt used `qwen3.8-flash_next-modality-text-quant-w3a8` at concurrency 2. The gateway then answered 429 (Retry-After 20) to every request, even with no benchmark load, and Pi fell back to the 27b mid-run. Of 5 completed runs, 3 were contaminated (`[gateway-fallback] switched ... qwen3.8-27b-...`), 2 were clean (default T1, T2 run 1, both correct); 2 more were in flight and were stopped (INTERRUPTED, no result). The attempt was abandoned and all of its data is excluded. The fall-back in the first attempt, not model quality, is why the endpoint choice changed.
2. In attempt 2, `legacy T2 run 2` was interrupted by ENOSPC (disk full on the host) and was re-run from scratch; the interrupted run directory is kept and excluded.

## State touched outside the scratch directories

- `~/.pi/agent/models.json`: unchanged (md5 identical before and after).
- `~/.local/state/pi-engineering/worktrees/`: all Mission state of the 30 runs went to per-run `PI_ENGINEERING_STATE_DIR` dirs under the scratchpad. The real directory gained one new entry during the window, `0cd9184409fa39ae988378a6` (created 2026-10-31 01:21, only an empty `events/` dir). Its creator could not be established from the data; nothing was deleted.
- `/home/wohlgemuth/IdeaProjects/pi-eng-bench`: a detached worktree of origin/main with a node_modules symlink (the checkout the extension was loaded from). `/home/wohlgemuth/IdeaProjects/pi-eng-benchdoc`: the worktree for this PR.

## Bearing on retirement criterion 3

The comparison now exists and shows no detected regression in verified-correct outcome rate (14/15 vs 13/15, intervals overlapping) and a large reduction in wall time for the default path. It is small-n, one model, small tasks: it satisfies "a live comparison exists and shows no regression" for the removal of the implicit directive (step 2), and it does not establish equivalence on large or high-risk work. Step 2 still needs criteria 1, 2 and 4 (operator review, `/work` clean, explicit written approval). Not part of this evidence: removing the `mission` tool itself (step 3).
