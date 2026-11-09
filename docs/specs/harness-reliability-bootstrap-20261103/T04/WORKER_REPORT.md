# WORKER_REPORT — T04 Weighted goal keywords with stopword filtering

- Branch: `feat/t04-keyword-ranking` (worktree `pi-t04-keyword-ranking-20261104`)
- Base commit: `c4acd6455a57a5cbbe19185353b661cbb69f5086`
- Result commit: `5b1ab0a465152673ac0bf29ab0956f8750c6fab1` — `feat(context): weighted goal keywords with stopword filtering (T04)`
- Mode: isolated-change. This report is deliberately **untracked** (only the two contract files are committed).

## git diff --numstat c4acd6455a57a5cbbe19185353b661cbb69f5086 HEAD

```
50	14	src/context/ContextBroker.ts
36	0	test/unit/context-keyword-ranking.test.ts
```

Added = 86, deleted = 14, **added + deleted = 100** → `Total changed lines vs base ≤ 100` holds under both
readings (added-only: 86; added+deleted: 100). Files changed: 2 (1 production, 1 test) — within
`production ≤ 2`, `tests ≤ 2`.

## Verification (run after the commit, from the worktree root)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | 0 `error TS` (both `tsconfig` projects) |
| `node --test --import ./test/support/isolatedState.ts test/unit/context-keyword-ranking.test.ts` | 0 | 2 tests, 2 pass, 0 fail |
| `node --test --import ./test/support/isolatedState.ts test/unit/context.test.ts` | 0 | 10 tests, 10 pass, 0 fail (no regression) |
| `npx biome check src/context/ContextBroker.ts test/unit/context-keyword-ranking.test.ts` | 0 | clean (repo formatter is authoritative) |
| `git status --porcelain` | 0 | empty (worktree clean apart from this untracked report) |

Full suite **not** run, per handoff instruction.

## Stopword set

`STOPWORDS` = **116 entries, 116 unique** (counted by re-parsing the committed `STOPWORD_LIST` literal),
covering articles, prepositions, copulas/auxiliaries, pronouns, question words, quantifiers, and the
imperative verbs (`add`, `adds`, `adding`, `return`, `returns`, `fix`, `fixes`, `fixing`) that previously
turned into useless search terms. Stored as a frozen-derived `ReadonlySet<string>` built from a concatenated
string rather than a 116-element array literal: identical content, ~108 fewer lines, which is what keeps this
change inside the 100-line budget while `biome check` stays green.

## What changed

`src/context/ContextBroker.ts`
1. `goalKeywords` is now `export`ed (the new unit test exercises it directly; no new public surface beyond that).
2. Tokenization: `[A-Za-z][A-Za-z0-9_]*(?:[/.][A-Za-z][A-Za-z0-9_]+)+|[A-Za-z][A-Za-z0-9_]+` — runs are joined
   across `/` and `.` so `src/add.js` / `config.json` stay ONE token, while `add(a, b)` still yields `add` and
   never the broken `add(a,`.
3. Stopword filtering, with one deliberate exception: a token written as a `name(` call site is code, not prose,
   so `Implement add(a, b) …` → `['add', 'Implement']`. An all-stopword goal keeps its first raw token instead
   of returning `[]`, so the broker never loses its only search term.
4. `tokenWeight` (new, pure arithmetic — no model, clock, or file I/O): base 1; +3 path-like (`/` or `.ext`) or
   written as a call site; +2 identifier-shaped (`snake_case`, camel hump, ALL-CAPS acronym); +2 mid-sentence
   capital (proper noun); +min(repeats−1, 2); +0.5 for the back half of the goal. Keywords are ordered by
   weight, ties by first appearance, de-duplicated case-insensitively, capped at `limit` (default 6, unchanged).
   The stale doc comment claiming `'Implement add(a, b) to return a + b'` yields
   `['Implement', 'add', 'to', 'return']` is replaced, since `to`/`return` are now filtered.
5. `rankFiles`: path-substring score is now `3 * tokenWeight(kw, …)` instead of a flat `+3`, so a distinctive
   keyword outranks a generic one; tie-break gained a final lexicographic comparison
   (`length || path`), so equal scores no longer inherit `git ls-files` order. The git-grep hit term stays
   distinct-keyword count (`min(size, 5)`), as the contract marks hit weighting optional.

`test/unit/context-keyword-ranking.test.ts` (new, 2 pure unit tests)
- stopword filtering (`Fix the Bluetooth pairing flow in the settings screen` → `Bluetooth, flow, settings,
  screen, pairing`; `the`/`in`/`fix` never appear);
- shape weighting (`SettingsRouter`, `HTTP`, `config.json`, `max_attempts` outrank `refactor`/`field`);
- tail-over-head (`add support for the settings page` → `settings, page, support`), stable ordering with
  explicit score ties, `limit` bounding, case-insensitive de-duplication, call-site handling, all-stopword and
  no-match inputs;
- `rankFiles` tie-break chain (score → non-test → shorter path → lexicographic), proven with two added
  equal-length `src/` files: `src/aaa.js`, `src/add.js`, `src/bbb.js`.

## Deviations

1. **Budget interpretation**: reported above — 86 added / 14 deleted = 100 total, compliant either way.
   Reaching that required storing the 116 stopwords as a split string (content unchanged) and letting the
   formatter (`biome`, lineWidth 120) dictate line breaking; a one-word-per-line array literal alone would
   have cost 116 lines and failed the same budget.
2. `tokenWeight` is called with neutral position arguments (`index 0, total 1, repeats 1, callSite false`)
   inside `rankFiles`: goal position/repetition are meaningless for a bare keyword list there, and call-site
   shape is unrecoverable after tokenization, so ranking uses shape/proper-noun weight only.
3. `node_modules` in this worktree is a symlink to the primary checkout's `node_modules` (build-environment
   only, untracked) so `tsc`/`biome` resolve; no dependency change.

No BLOCKED items.
