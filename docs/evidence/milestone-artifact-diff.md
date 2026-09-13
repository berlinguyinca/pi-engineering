# Milestone Evidence — Artifact-Backed Lazy Candidate-Diff Review

Milestone: **artifact-backed large-output handling and lazy retrieval** (priority #1).

## Deterministic verification (machine output)

```
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm test
# tests 42
# pass  42
# fail  0
```

## Standalone package load

```
INSTALLED PACKAGE LOADS OK
```

## Real-model dogfood (fresh fixture `string-utils2`)

Goal: "Add a `titleCase(input)` function to `src/transform.js` that converts
`'hello world'` into `'Hello World'` (capitalize first letter of each word,
lowercasing the rest), export it from `src/index.js`, and add a passing test in
`test/transform.test.js`."

Captured `scripts/dogfood.ts` output:

```
================ DOGFOOD REPORT ================
work_item                  WI-KLnSYL [COMPLETED] risk=medium
outcome                    promoted (1 round(s), 145.9s)
incumbent                  CAND-QkTJ6L
changed files              src/index.js, src/transform.js, test/transform.test.js
evidence                   EVID-31flfA, EVID-NP8nyL, EVID-9Rk7WZ
verification passed        true

--- worker invocations ---
  implementer              1
  reviewer                 1
  scout                    1

--- context/autonomy telemetry ---
  tool calls (workers)     49
  verification stages      3
  evidence records         3
  blocked/failed workers   0
  aggregate input tokens   45852
  aggregate output tokens  10243
  max worker context tokens 11659
  aggregate worker turns   22
================ END ================
DOGFOOD OK
```

Review summary: "Independently reviewed candidate CAND-QkTJ6L ... The full diff
was read and each hunk's context verified against the pre-candidate working
tree ..."

### Context impact vs the pre-milestone baseline

| Metric | Pre-milestone dogfood | This milestone |
| --- | --- | --- |
| Max worker context tokens | 24,962 (overflowed the 24k reviewer budget → review failed) | 11,659 (well under budget) |
| Blocked / failed workers | 1 (reviewer budget overflow) | 0 |
| Rounds | 2 | 1 |
| Fixture tests | — | 8/8 pass |

The candidate diff is no longer inlined into the reviewer prompt; it is stored
as an `artifact://` reference (`diff_artifact_uri`) and read lazily via the
paginated `artifact_read` tool.

## Fresh-context review

A genuinely fresh-context architecture-reviewer (new in-memory session, no
inherited reasoning) reviewed the milestone. Findings and fixes:

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | HIGH | `artifact_read` capped at 12k chars with no pagination, so large diffs weren't fully retrievable via the instructed tool path | Added `offset` pagination; reviewer instructed to page until the full diff is read |
| 2 | MEDIUM | `ensureDiffArtifact` trusted a stale `diff_artifact_uri` without verifying content | Content is verified against `candidate.diff` and rewritten when stale (regression test) |
| 3 | MEDIUM | `artifact_read` silently returned empty when the content file was missing → possible silent clean review | Returns an explicit error (regression test) |
| 4 | MEDIUM | `changed_files` list in the reviewer prompt unbounded | Capped to 30 entries |
| 5 | MEDIUM | Dogfood metrics had no machine evidence; ROADMAP still listed lazy-diff as a future option | This evidence file + truthful ROADMAP update |
| 6 | LOW | Artifact-write failure would propagate as an unhandled exception, leaking a work item in EXECUTING | Treated as a review that could not complete (no promotion) |
| 7 | LOW | Empty-diff inconsistency between artifact and `candidate.diff` | Unified sentinel `"(no captured diff)"` |

## Regression tests added

- `test/integration/vertical-slice.test.ts`:
  - "review keeps the full diff out of context behind a lazy artifact reference"
    (diff > 12k chars; proves it is not inlined and is fully retrievable via
    paged `artifact_read`)
  - "ensureDiffArtifact reuses a fresh artifact but rewrites a stale one"
- `test/unit/tools.test.ts`: "artifact_read errors (not silently empty) when the
  content file is missing"
