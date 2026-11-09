# WORKER_REPORT — D08 (bounded local-model diagnostic task package)

- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-d08-diagnostic-task-20261104` (branch `feat/d08-diagnostic-task`, not `main`; not pushed — the handoff asked for the commit, not a PR)
- Base: `925836054ca7b8def51b4b2a636706e6c375e53b` (D07 resultSha, verified as the parent commit)
- Result: `7be362d6` — `feat(incidents): bounded local-model diagnostic task package (D08)`
- Parent handoff: `docs/specs/harness-reliability-bootstrap-20261103/D07/D07.handoff.json`, status PASS, `handoffHash: sha256:5a604be0f0fc7e488066185289d087a9d48ce31efaa8ea05a3a6ee04e3ad1d23` (read from the file, matches the assignment)

## Diff scope (`git diff --numstat 925836054ca7b8def51b4b2a636706e6c375e53b HEAD`)

```
55	0	src/incidents/diagnosticTask.ts
44	0	test/unit/incident-diagnostic-task.test.ts
```

99 changed lines (≤ 100), 2 files (1 production, 1 test), no other path touched. `git show --stat` confirms: `2 files changed, 99 insertions(+)`.

## Commands and exit codes (all re-run at commit `7be362d6`)

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | 0 | clean |
| 2 | `node --test --import ./test/support/isolatedState.ts test/unit/incident-diagnostic-task.test.ts` | 0 | 4 tests, 4 pass, 0 fail |
| 3 | neighbour `node --test --import ./test/support/isolatedState.ts test/unit/error-evidence-bundle.test.ts` | 0 | 4 tests, 4 pass, 0 fail |
| 4 | neighbour `node --test --import ./test/support/isolatedState.ts test/unit/error-aggregate.test.ts` | 0 | 6 tests, 6 pass, 0 fail |

The full unit suite was **not** run (baselined red per the handoff).

## No-dispatch-surface proof (exact grep, run in this worktree)

```
$ grep -rnE 'fetch|node:(http|https|net|tls|dns|dgram)|child_process|worker_threads|XMLHttpRequest|WebSocket|node:fs|node:os|node:path|new Date|Date\.now|performance\.|Math\.random|process\.env' src/incidents/diagnosticTask.ts test/unit/incident-diagnostic-task.test.ts; echo "exit=$?"
exit=1 (1 = no match)

$ grep -oE '(from|import)[[:space:]]*\(?[[:space:]]*"[^"]+"' src/incidents/diagnosticTask.ts
from "./evidenceBundle.ts"
from "./errorEvent.ts"
from "./errorAggregate.ts"

$ grep -oE 'from "[^"]+"' src/incidents/diagnosticTask.ts | grep -E 'inference|llm|provider|router|transport|models'; echo "exit=$?"
exit=1 (1 = no match)
```

The module reads exactly three specifiers, all inside `src/incidents/`: D07's `evidenceBundle.ts` (runtime), and `errorEvent.ts` / `errorAggregate.ts` as **type-only** re-exports (`export type { … }`, erased at runtime) so a consumer needs only this module. Nothing in `src/inference/`, `src/llm`, or any transport is reachable; nothing constructs a client; `modelHint` is a plain string.

## Determinism proof (two separate node processes, reversed input order)

```
byte_identical_across_input_order=true   bytes=3722 maxBytes=4000 truncated=true dropped={"items":1,"bytes":585}
sha=b3cb53f413d7e3a42f10e6c06f86b266a21992d1c79b56dabe0a7fff5c71730b   (identical in both runs)
```

## What was built

`src/incidents/diagnosticTask.ts`
- `buildDiagnosticTask(input, limits)` → `{ version, modelHint, hintFallback, systemContract, prompt, requiredFields, constraints, evidenceIds, fingerprints, maxBytes, bytes, truncated, dropped }`.
- `modelHint` is a hint string for the routes this repo already names for Qwen Flash / 27B: `metabolomics/qwen3.8-flash_next`, `metabolomics/qwen3.8-27b` (convention from `src/models/aliasCatalog.ts` + `src/plannerWorker/roles.ts` + D07's own fixtures). An unknown hint is refused and recorded as `hintFallback: true`, never quietly used. No client is constructed anywhere.
- The prompt **carries the D07 bundle itself** (`JSON.stringify(kept)` over the caller's `EvidenceItem` objects — by reference, never re-derived), plus `EVIDENCE_IDS=` naming every event id it supplies, so the package and the bundle cannot disagree about an id. The caller's bundle array is copied before capping; the test asserts it comes back byte-identical.
- `systemContract` states the hard limits in auditable words: *read-only diagnosis*, *no source modification*, *no self-repair*, *no automatic dispatch*, *no new tooling*, *answer from the supplied evidence only*, *name every evidence id you rely on*.
- `maxBytes` bounds the **whole package**; when it bites, trailing bundle items (the bundle's own total order) are withheld and reported as `dropped: { items, bytes }` with `truncated: true`, never silently trimmed.
- `parseDiagnosticResponse(text, bundle)` fails closed with a stable reason list: `not_text`, `unlabelled_text`, `missing_section:<LABEL>`, `empty_section:<LABEL>`, `duplicate_section:<LABEL>`, `unknown_event_id:<id>`, `hypothesis_restates_summary`, `evidence_bundle_unusable`. Nothing missing is repaired or invented; an answer must carry hypothesis, supporting event ids, disconfirming evidence, uncertainty and what further evidence would change the verdict.

## Deviations / notes

1. **`node_modules` was absent** in this fresh worktree; symlinked to the primary checkout's `node_modules` per `AGENTS.md` ("Symlink `node_modules` into the new worktree rather than reinstalling"). No `npm install`, no dependency change, nothing committed.
2. **`docs/specs/harness-reliability-bootstrap-20261103/D08/fixtures/manifest.json` does not exist** in this worktree at HEAD (D07's own `fixtures/` and `logs/` are absent too — the conductor keeps them outside the repo). The task-authority `canonicalHash` therefore could not be recomputed locally; authority was taken from the assignment plus `D07/D07.handoff.json` (`handoffHash` and `nextBaseSha` both match). Not blocking: the scope was fixed by the handoff text.
3. **`bytes` is a worst-case-width measure**: the serialized package with `bytes`/`truncated`/`dropped` rendered at their widest, so a reported `bytes ≤ maxBytes` always implies the real package fits (D07 uses the same reserve idea). Documented at the call site.
4. **Cap smaller than the fixed contract envelope**: every item is withheld (`dropped.items === bundle.items.length`), `truncated: true`, and `bytes > maxBytes` stays visible in the account rather than trimming the contract itself — the prohibitions are never silently cut. Asserted by the test.
5. **Two refusals beyond the named list**, added because fail-closed was the stated intent: unlabelled prose before the first section (`unlabelled_text`) and a section repeated (`duplicate_section`). Section *order* is requested in the contract text but not enforced by the validator — contents, not ordering, are the safety property.
6. **`npx biome check` on the two files** reports `format` + `organizeImports` — the same two categories the committed D07 baseline reports for `src/incidents/evidenceBundle.ts` and `test/unit/error-evidence-bundle.test.ts` (verified in the same run). Lint is not in D08's verify list, and `biome format --write` would explode the dense one-statement-per-line style past the ≤ 100-line budget, so it was deliberately not applied. No lint-rule violations (only formatter/import-order cosmetics), same as baseline.
7. The amended commit `7be362d6` drops the unverifiable claim "in that order" from the contract text rather than adding an order check; line counts unchanged (55 / 44).

## Exact next steps for the conductor

- Re-stamp `D08/D08.handoff.json` with `resultSha: 7be362d6…` (full sha via `git rev-parse HEAD`), `nextTaskId` per the plan, and the log artifacts for commands 1–4 above.
- D09 may import `buildDiagnosticTask` / `parseDiagnosticResponse` from `src/incidents/diagnosticTask.ts` and the forwarded `ErrorOccurrence` / `AggregateRow` types from the same module; dispatch (if ever) stays outside this module.
- If the repo ever turns on a biome gate, these two files need `biome format --write` together with the D07 baseline files, not alone.
