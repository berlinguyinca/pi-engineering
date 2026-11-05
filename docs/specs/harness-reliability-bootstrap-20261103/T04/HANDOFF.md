# T04 — Improve goal keyword extraction

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T04/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T03/T03.handoff.json (sha256:0b55737f9edba1ff2eb75b5b96ce90a0f99a408059dfe2c0121b9c1a415e815c, status PASS, resultSha c4acd6455a57a5cbbe19185353b661cbb69f5086 = your base).
Base commit: c4acd6455a57a5cbbe19185353b661cbb69f5086. Mode: isolated-change.

## Objective (plan delta, verbatim)
Filter stopwords, weight identifiers/path tokens and later distinctive terms; retain deterministic ordering; avoid expanding context budget.
Evidence: Bluetooth/settings example ranks relevant files ahead of generic text.

## Scope (hard limits)
- Exactly 2 files: `src/context/ContextBroker.ts` (production ≤ 2) and the NEW `test/unit/context-keyword-ranking.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- Denied: `src/context/**` apart from `ContextBroker.ts`, `src/bootstrap/**`, `src/orchestration/**`, `src/plannerWorker/**`, `src/runtime/**`, `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `test/unit/context.test.ts` (pre-existing coverage you must keep green), `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus `test/unit/context.test.ts` and report its exit code.

## Current behaviour (ContextBroker.ts)
`goalKeywords(goal, limit = 6)` (line 51) takes `/[A-Za-z][A-Za-z0-9_]{1,}/g` matches, de-duplicates and slices the first `limit` — so prose function words become search terms ('Implement add(a, b) to return a + b' → ['Implement','add','to','return'], as the doc comment itself admits) and the first six tokens win whatever their value. `rankFiles(keywords, limit = 10)` (line 187) scores +3 per keyword contained in the path, +min(distinct keyword hits, 5) from `searchAny(keywords, 200)` hits, and sorts by score, then non-test-before-test, then shorter path. `assembleContext` (line 227) calls `goalKeywords(goal)` at line 269.

## Required behaviour
1. `goalKeywords` must drop English stopwords (a frozen `Set` you define: at minimum the, a, an, and, or, but, to, of, for, in, on, at, by, with, from, into, is, are, was, were, be, been, this, that, these, those, it, its, as, if, then, than, so, such, not, no, nor, do, does, did, can, will, would, should, could, may, might, must, shall, we, you, they, he, she, i, our, your, their, my, his, her, them, us, please, make, use, using, via, when, while, where, what, which, who, how, why, all, any, each, every, some, none, more, most, other, into, onto, over, under, again, once, about, against, between, during, before, after, above, below, up, down, out, off, too, very, just, also, there, here, add, adds, adding, return, returns — case-insensitive) so they never become keywords; keep at least one keyword — if every token is a stopword, fall back to the first raw token rather than returning an empty list.
2. Order the survivors by relevance, not by position: score each token, highest first, ties broken by first appearance (deterministic). Weighting to implement: path-like tokens (contain `/` or a `.ext` suffix) and identifier-shaped tokens (contain `_`, or a lower-to-upper camel boundary, or are all-caps acronyms of length ≥ 2) score above plain prose words; a token that appears later in the goal earns a small recency bonus so the distinctive tail of a request ("… to the settings page") outranks the generic head ("add", "support"); repeated tokens earn a small frequency bonus. Keep it a plain, readable scoring function — no model, no randomness, no clock, no file reads.
3. Do **not** expand the context budget anywhere: `goalKeywords`'s `limit` default stays 6, `rankFiles`'s `limit` default stays 10, `searchAny`'s 200-hit cap and `repoMap(500)` stay as they are, and no new content read, search call or larger slice may be added. `rankFiles` may weight a hit by the keyword's own token weight (reuse the same scoring helper you built in 2), but its sort must stay deterministic: score desc, then non-test before test (`isTestPath`), then shorter path, then lexicographic path — the final lexicographic tie-break is new and required so equal-score, equal-length paths never depend on `ls-files` order.
4. Export `goalKeywords` (the file already exports pure helpers such as `estimateTokens`) so its behaviour is directly testable; `assembleContext` keeps calling it exactly as now.
5. Update the doc comments that describe the old behaviour (the `goalKeywords` example listing `'to'`/`'return'`, and any `rankFiles` comment about scoring) so they match what the code now does.

## Tests (new test/unit/context-keyword-ranking.test.ts)
Pure unit tests, no git and no filesystem beyond what `test/support/isolatedState.ts` already provides. Cover at minimum: the plan's named example — `goalKeywords('Fix the Bluetooth pairing flow in the settings screen')` yields keywords whose first entries include `Bluetooth` and `settings` and contain none of `the`, `in`, `fix`-class stopwords … except that `fix`/`add` are listed as stopwords while `pairing`/`flow`/`screen` must survive, and an all-stopword goal keeps its first raw token instead of returning `[]`; identifier shapes (`max_attempts`, `SettingsRouter`, `HTTP`, `config.json`) outrank prose; later distinctive tokens outrank earlier generic ones; ties keep first-appearance order and the result is bounded by `limit` and de-duplicated; `rankFiles` ordering stays deterministic (drive it through the same fixture `test/unit/context.test.ts` uses, or assert on the exported helper if ranking needs a repo) — if a repo fixture is genuinely needed, build the smallest in-memory/temp one and say so in your report. Keep `test/unit/context.test.ts` green.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/context-keyword-ranking.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat c4acd6455a57a5cbbe19185353b661cbb69f5086 HEAD`, each command with exit code, the stopword set size, and any deviation or BLOCKED clause. Commit only the two files as `feat(context): weighted goal keywords with stopword filtering (T04)`.
