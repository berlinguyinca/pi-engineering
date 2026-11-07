# T04 — Improve goal keyword extraction — conductor report

Task authority: sha256:69761cae6f8167787182f4e96e9ae919610517ce0ba72e7d095a4021914318eb
Plan delta: Filter stopwords, weight identifiers/path tokens and later distinctive terms; retain deterministic ordering; avoid expanding context budget. Evidence: Bluetooth/settings example ranks relevant files ahead of generic text. (production 1 / tests 1 / ≤100 lines / verify: typecheck; node --test test/unit/context-keyword-ranking.test.ts)
Worker pane: t04 (pane w8:pC, metabolomics/qwen3.8-flash_next), base c4acd645. Orchestration note: the first prompt was misrouted to the just-closed `w8:pA` and had to be re-sent to `w8:pC`; the unit then ran ~100 min because the worker reworked its own drafts to land inside the 100-line budget (a 104-line attempt was reverted).
Result: 5b1ab0a465152673ac0bf29ab0956f8750c6fab1 — parent c4acd6455a57; 50 + 14 deleted in `src/context/ContextBroker.ts` and 36 added in the new `test/unit/context-keyword-ranking.test.ts` = **100 changed lines** (exactly the cap; production 1 ≤ 2, tests 1 ≤ 2).

## What the unit provides
`goalKeywords` is now exported and no longer turns prose into search terms: a frozen case-insensitive stopword set is dropped, survivors are scored (path-like tokens with an extension and identifier-shaped tokens — `snake_case`, `CamelCase`, `ACRONYM` — above plain words, later tokens and repeats earning a bonus), ordered by score then first-appearance position, de-duplicated, and still bounded by `limit = 6`; an all-stopword goal keeps its first raw token instead of returning `[]`, so `assembleContext` never searches with an empty keyword list. `rankFiles` keeps its cheap path-substring + distinct-symbol-hit scoring and gains a final lexicographic tie-break, so ranking no longer depends on `git ls-files` order when score, test-ness and length are equal. No budget moved: `rankFiles` still defaults to 10 results, the symbol search still caps at 200 hits, `repoMap` at 500, and no new content read was introduced.

## Conductor verification (logs/T04/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-keyword-ranking.txt` — the task's own verify command: 2/2 pass 0 fail (keyword behaviour end-to-end; `rankFiles` tie-break order score → test path → length → lexicographic).
- `03-unit-context-neighbour.txt` — pre-existing `test/unit/context.test.ts` (the only other caller of `rankFiles`, including its "ranks goal-relevant files first" milestone test): 10/10 pass 0 fail.
- `04-conductor-keyword-probe.txt` — independent probe of the plan's named evidence: `'Fix the Bluetooth pairing flow in the settings screen'` → `["Bluetooth","flow","settings","screen","pairing"]` (the distinctive nouns lead, no `the`/`in`/`to`); the doc comment's own example `'Implement add(a, b) to return a + b'` → `["add","Implement"]` (`to`/`return` filtered, `add` surviving via the all-stopword fallback); an all-stopword goal returns `["please"]`; `'max_attempts in SettingsRouter for HTTP config.json retry'` → `["HTTP","SettingsRouter","config.json","max_attempts","retry"]` (identifier/path shapes lead); later distinctive tokens outrank generic earlier ones (`tagging` before `support`); output bounded by `limit`, de-duplicated, identical across repeated calls.

## Integration
`git merge --ff-only feat/t04-keyword-ranking` → HEAD `5b1ab0a4`; `git show --stat HEAD` lists exactly the two files, 86 insertions / 14 deletions. Handoff `T04/T04.handoff.json` (sha256:a72b9d8d49b4978c9c1af0df652c0c176ca5f2800f83f8b04229db769c95d9e3) recomputes and validates; next task T05@5b1ab0a4.

## Residual risk / observations carried forward
- The stopword list is a frozen English set inside `ContextBroker.ts`; a goal phrased in another language, or jargon that collides with a listed word (`add`, `use`, `make`, `return`, `fix` are stopwords here), loses that term unless the identifier/path shape rescues it — observable in the probe (`add(a, b)` survives only through the fallback rule).
- Scoring is length/shape-based, not corpus-based: a rare identifier in a prose-only goal still scores as prose. A later unit that wants TF-IDF-style weighting must keep the `limit = 6` budget this unit preserved.
- The worker's own report notes it kept the scoring function deliberately simple for readability and biome formatting; the unit test is two coarse cases (the plan's example and the tie-break), so finer weight boundaries rest on the conductor probe rather than committed tests.
