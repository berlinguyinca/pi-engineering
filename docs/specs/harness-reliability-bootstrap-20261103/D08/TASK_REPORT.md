# D08 — Add bounded local-model diagnostic adapter — conductor report

Task authority: sha256:10334bcb754bb7ff9682a4c6f06ab16680f94d8bdef400b6d44b25f47c746082
Plan delta: Build a pure contract/prompt package for Qwen Flash or 27B with evidence and read-only constraints; no automatic dispatch, no source changes, no self-repair. Evidence: output requires hypothesis, supporting events, disconfirming evidence and uncertainty. (production 2 / tests 2 / ≤100 lines / verify: typecheck; node --test test/unit/incident-diagnostic-task.test.ts)
Worker pane: d08 (pane w8:p6), model metabolomics/qwen3.8-flash_next, base 92583605.
Result: 7be362d657c5ed1de8d0a70ce56def5dcc60953f — parent 925836054ca7; 55 + 44 = **99 changed lines** over `src/incidents/diagnosticTask.ts` and `test/unit/incident-diagnostic-task.test.ts` (production 1 ≤ 2, tests 1 ≤ 2, lines 99 ≤ 100).

## What the unit provides
`buildDiagnosticTask(input, limits)` — consumes the D07 bundle (imports `./evidenceBundle.ts` and re-exports D01/D03 types; it does not re-derive evidence) and returns a deterministic, byte-bounded package: `modelHint` drawn only from the two local route names this repo already uses (`metabolomics/qwen3.8-flash_next`, `metabolomics/qwen3.8-27b`) — a hint string, never a client — with `hintFallback` set when a caller asks for another model; a `systemContract` that states the hard limits in words (`read-only diagnosis`, `no source modification`, `no self-repair`, `no automatic dispatch`, answer only in the named sections); a `prompt` carrying the question plus the bundle's own `EVIDENCE_IDS` and fingerprints; and `bytes`/`truncated`/`dropped` computed against the cap so a package that cannot fit says so instead of trimming silently. `parseDiagnosticResponse(text, bundle)` is fail-closed: `not_text`, `unlabelled_text`, `missing_section:<NAME>`, and — proven independently — `unknown_event_id:evt-999` for an id outside the bundle and `hypothesis_restates_summary` when the "hypothesis" is just the representative summary repeated. Required fields: hypothesis, supportingEventIds, disconfirmingEvidence, uncertainty, furtherEvidence.
Dispatch surface: `grep -nE 'fetch|node:http|node:net|child_process|node:dns|WebSocket|from "../inference/|from "../llm|require\(' src/incidents/diagnosticTask.ts` → no matches. No fs, no clock, no RNG.

## Conductor verification (logs/D08/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-diagnostic-task.txt` — the task's own verify command: 4/4 pass 0 fail (determinism + route hint + bundle fingerprints/ids in the package; the prohibitions in auditable words; `maxBytes` bounds the whole package with the account naming what was withheld; the validator accepts a complete answer and refuses an incomplete, out-of-bundle or restated one with reasons).
- `03-unit-neighbours.txt` — D07 bundle + D03 aggregate: 10/10 pass 0 fail.
- `04-conductor-task-probe.txt` — conductor probe over a 3-cluster bundle: identical output byte-for-byte for identical input; event ids `evt-1..evt-3` and the representative fingerprint present in the prompt; `read-only`/`no source modification`/`self-repair`/`dispatch` all present; `maxBytes 400` shrank the package and reported `dropped {items:2,bytes:1192}` with `truncated true`; a complete answer accepted; each of the five sections removed → refused with `missing_section:<NAME>`; `evt-999` → refused; hypothesis restating the summary → refused; bare prose → `unlabelled_text` + every missing section; bundle untouched; `gpt-5.1-codex` hint → `hintFallback true`, named local route → false.

## Integration
`git merge --ff-only feat/d08-diagnostic-task` → HEAD `7be362d6`; `git show --stat HEAD` lists exactly the two files, 99 insertions. Handoff `D08/D08.handoff.json` (sha256:a42ead207e17c03fe228d46c9ab97251fcc1d547d1e6a251d0b58caf55f2e602) recomputes and validates against `templates/handoff.schema.json`; next task T01@7be362d6.

## Residual risk / observations carried forward
- The read phase (D01–D08) is complete: occurrence reading, identity, aggregation, recovery classification, bounded CLI, host command, evidence bundle and the diagnostic task package all exist, none of them dispatching a model. Nothing yet *runs* the package; that is E06/T-series territory.
- `MODEL_HINTS` hardcodes two route names. If the local route names change, this file must change with them; V06 should confirm the names still match the operator's llama.cpp server before the diagnostic path is ever exercised.
- Byte accounting uses `Buffer` (Node-only). Consistent with the rest of `src/incidents/`; noted for any future browser-side consumer.
