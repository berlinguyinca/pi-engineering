# D07 — Produce bounded diagnostic evidence bundle — conductor report

Task authority: sha256:37da992f5a87b06e1cdc7e057e46649f3525a7aac0950346e3fc761198306579
Plan delta: Collect representative sanitized occurrences, linked retries, affected versions and task/handoff IDs; enforce size and privacy limits. (production 2 / tests 2 / ≤100 lines / verify: typecheck; node --test test/unit/error-evidence-bundle.test.ts)
Worker pane: d07 (pane w8:p5), model metabolomics/qwen3.8-flash_next, base 5a5a2a65.
Result: 925836054ca7b8def51b4b2a636706e6c375e53b — parent 5a5a2a654a78; 58 + 35 = **93 changed lines** over `src/incidents/evidenceBundle.ts` and `test/unit/error-evidence-bundle.test.ts` (production 1 ≤ 2, tests 1 ≤ 2, lines 93 ≤ 100).

## What the unit provides
`buildEvidenceBundle(input, limits)` — a pure, read-only builder (no fs, no network, no child processes, no clock, no RNG; greps confirm none of `node:fs`, `node:net`, `child_process`, `fetch`, `Date.now`, `Math.random`, `process.` appear). It calls the existing modules instead of copying them: E04 `sanitizeForPersistence` runs on every occurrence *before* anything else, D02 owns the fingerprint, D03 owns clustering/representatives/counts, D04 owns the recovery outcome, E07 owns `failureIdentity`/`errorRef`. Each item carries: fingerprint, representative sanitized summary, code/layer/severity, count, first/last seen, distinct affected runtime/model/quantization, E07 failure ids (only the `sha256:<64 hex>` shape is trusted; anything else is caller text and is dropped rather than shortened into something id-shaped), correlation ids with `task:`/`handoff:` ids discovered from them, and the outcome class. `maxItems`/`maxBytes` are enforced after sanitization and `dropped: { items, bytes }` plus `truncated` make truncation visible; ordering is total (fingerprint → firstSeen → first eventId) so the same input re-serializes byte-identically; invalid caps fall back to the defaults rather than producing an unbounded bundle.

## Conductor verification (logs/D07/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-evidence-bundle.txt` — the task's own verify command: 4/4 pass 0 fail (reproducible context survives; bearer URL + sk- key + raw prompt sanitized before byte accounting and absent everywhere; `maxItems`/`maxBytes` enforced with the dropped count reported; total ordering with byte-identical re-serialization and no input mutation).
- `03-unit-neighbours.txt` — D03 aggregate + E04 sanitize + E07 retry suites: 16/16 pass 0 fail.
- `04`, `05` — two conductor probes that failed because **the conductor's probe fed the wrong input shape** (`buildEvidenceBundle` takes `{ eventId, occurrence, … }` rows, not bare occurrences, and refused the malformed input with `refused: n` while emitting no items). Recorded deliberately: the builder fails closed on malformed input instead of guessing.
- `06-conductor-bundle-probe.txt` — corrected probe over 25 occurrences: order-independent determinism true; `maxItems 4 / maxBytes 1200` produced 1 item with `dropped {"items":1,"bytes":1}`, `bytes 726`, `truncated true`; outcome classified `recovered` from durable evidence; versions `{runtime:["pi@aaa1111"], model:["m0","m1"], quantization:["q0","q1","q2"]}`; `taskIds ["D07"]`, `handoffIds ["D06"]`; failure id `sha256:3eaf1cb8…`; privacy check `clean` with the summary reduced to `<redacted-prompt len=568 sha256=9656b008…>`; inputs untouched; `maxItems 0 / maxBytes -5` fell back to defaults.

## Integration
`git merge --ff-only feat/d07-evidence-bundle` → HEAD `92583605`; `git show --stat HEAD` lists exactly the two files, 93 insertions. Handoff `D07/D07.handoff.json` (sha256:5a604be0f0fc7e488066185289d087a9d48ce31efaa8ea05a3a6ee04e3ad1d23) recomputes and validates against `templates/handoff.schema.json`; next task D08@92583605.

## Residual risk / observations carried forward
- `dropped` splits the two causes (item cap vs byte cap) but does not name *which* items were dropped; a consumer wanting the exact remainder must re-run with a larger cap. Acceptable for a bounded diagnosis, worth a note in the D08+ consumer.
- The bundle trusts only E07-shaped failure ids and `task:`/`handoff:`-shaped correlation ids; ids written in another convention by future callers simply do not appear (fail-closed, never invented).
- First src→D01..D07 aggregation seam now exists in `src/incidents/`; D08 should consume `buildEvidenceBundle` rather than re-derive clusters.
