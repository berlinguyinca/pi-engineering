# Evidence — Milestone: Relevance-ranked context + scout-guided required files

**Priority #2 (Context Broker improvements).** Goal: cut implementer context and
tool round-trips by giving workers the *relevant* code up front and by closing
the previously-unused `requiredFiles` hook.

## What changed

- **`ContextBroker.rankFiles(keywords, limit)`** — scores repo files by goal-keyword
  path matches plus *distinct* goal symbols found via `git grep`. Counts distinct
  keywords (not raw line frequency) so a test file that repeats one symbol is not
  over-weighted; deterministic tie-break prefers non-test files, then shorter paths.
- **`assembleContext()`** — now includes content slices of the top relevant files
  (bounded by the token budget) instead of only one-line symbol hits. Required
  files are truncated to the remaining budget, never silently dropped.
- **Scout-guided required files** — `scout()` returns the concrete files it
  identifies (`details.relevant_files`); `engineer()` re-assembles the
  implementer's context with those as REQUIRED, so the implementer starts with
  the scout's change surface.
- **Keyword extraction** strips punctuation (`'Implement add(a, b)'` → `add`), so
  a punctuated goal no longer yields an empty context package.
- **`searchAny(keywords)`** builds a safe per-keyword alternation; `search()`
  stays a literal single-query (regex metacharacters are never treated as regex).
- **Error containment** — a context-assembly failure degrades to an empty package
  + a ledger note rather than aborting the run.

## Machine evidence

- `npm run typecheck` (`tsc --noEmit`) — **passes**.
- `npm test` — **49/49 passing**.
- New tests:
  - `test/unit/context.test.ts`:
    - `rankFiles ranks goal-relevant files first`
    - `assembleContext includes content of relevant files, not only symbol one-liners`
    - `flagship goal with punctuation yields a non-empty context package`
    - `oversized required file is truncated, not silently dropped`
    - `repoMap matches ignore tokens against path segments, not substrings`
    - `searchAny matches any of several literal keywords`
  - `test/integration/vertical-slice.test.ts`:
    - `scout-identified files become required context for the implementer`

## Real-model dogfood (fresh fixture, `qwen3.8-27b`)

Goal: add `initials(input)` to `src/transform.js`, export from `src/index.js`,
add a passing test.

| Metric | Result |
| --- | --- |
| Outcome | **promoted** (1 round) |
| Blocked/failed workers | **0** |
| Tool calls (workers) | **30** |
| Aggregate input tokens | 40.6k |
| Aggregate output tokens | 7.5k |
| Max worker context tokens | **11.6k** |
| Fixture tests | **4/4 pass** |

Merged result verified: `initials()` present in `src/transform.js`, re-exported
from `src/index.js`, covered by a passing test in `test/transform.test.js`.

## Fresh-context review

An independent fresh-context reviewer (`scripts/fresh-review-context.ts`)
reported findings, all material ones fixed with regression tests:

- **HIGH** — `search('a|b')` escaped the whole query as a literal, so callers
  passing `keywords.join('|')` (rankFiles, symbol section, testsFor) got zero
  hits for any 2+-keyword goal. Fixed with `searchAny()` (per-keyword escaping).
- **MED** — punctuated goals yielded an empty context package (fixed: keyword
  extraction strips punctuation); oversized required file silently dropped
  (fixed: truncated to budget); ignore filter matched substrings dropping real
  files like `distribution.ts` (fixed: segment matching).
- **LOW** — scout file dedupe; empty-query grep matching every line; deterministic
  ranking tie-break; context-assembly error containment. All addressed.
