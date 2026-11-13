# D06 — Register /diagnose-errors Pi command — conductor report

Task authority: sha256:4437b624546742e082530d3fac016d9e8305e28cfaf11370987b34698f142f19
Plan delta: Discover existing command registration convention; add thin adapter to D05 local read-only diagnostics. No new slash-command registry. (production 2 / tests 2 / ≤100 lines / verify: typecheck; node --test test/unit/diagnose-errors-command.test.ts)
Worker pane: d06 (pane w8:p4), base 57b81f96. Model: metabolomics/qwen3.8-flash_next — the first attempt used openai-codex/gpt-5.1-codex and never started a turn because the provider credential was revoked mid-run ("No API key found for openai-codex"), so the worker was restarted on the provider this host can actually authenticate.
Result: 5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e — parent 57b81f960833; 51 + 48 = **99 changed lines** over `src/runtime/host/entry.ts` and `test/unit/diagnose-errors-command.test.ts` (production 1 ≤ 2, tests 1 ≤ 2, lines 99 ≤ 100).

## What the unit provides
`/diagnose-errors` registered through the existing `pi.registerCommand` convention already used in `src/runtime/host/entry.ts`, available on both the Host path and the legacy-fallback path. The handler is a thin adapter: it dynamically imports the D05 module and calls `parseArgs` + `runDiagnoseErrors`, so D05 owns every argument, read, cluster and verdict; no registry, dispatcher or duplicated logic. Permission scope is expressed in the type — the injected deps are `Omit<DiagnoseDeps, "writeFile">`, which makes D05's own `--export` path fail closed (exit 4 class) and leaves no write, mkdir or append surface in the command. The events namespace is discovered through an injectable hook (no hardcoded path), and output is bounded to three lines plus the top five clusters with a counted remainder.

## Conductor verification (logs/D06/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-diagnose-command.txt` — the task's own verify command: 5/5 pass 0 fail (registration with description whether the Host installs or fails; read-only diagnose through injected deps reporting exact clustered totals with one read and no writer; `--export` refused with the exit-4 class while the namespace stays byte-identical; exit 3 for a refused namespace that is never created; bounded output and a bad flag that reads nothing).
- `03-unit-neighbours.txt` — D05 CLI + D01 reader: 10/10 pass 0 fail.
- `04-unit-entry.txt` — entry/protocol suite: 14/14 pass 0 fail.
- `05-unit-host.txt` — host loader/resources/config suites: 33/33 pass 0 fail.
- `06-stamp.txt` / `07-stamp-accepted.txt` — first stamp REJECTED (exit 3, "worktree is not clean") because `WORKER_REPORT.md` sat in the worktree; the report was moved to the run-artifact directory (the established pattern: unit commits contain unit files only, run artifacts stay untracked), and the second stamp accepted: `parent=D05 accepted sha256:c34af64aacc…`, `authority=D06 sha256:4437b624…`, `schema=D06 conforms`.

## Integration
`git merge --ff-only feat/d06-diagnose-command` → HEAD `5a5a2a65`; `git show --stat HEAD` lists exactly the two files, 99 insertions. Handoff `D06/D06.handoff.json` (sha256:7c4a903f0f483e4bfd9fc49be3f733ca9e439bb233c3b96a74926441d60799ce) recomputes and validates against `templates/handoff.schema.json`; next task D07@5a5a2a65.

## Residual risk / observations carried forward
- The worker ran `npm run test:unit` (the whole suite) for ~25 minutes and it exceeded its own budget with the same pre-existing host-dependent failures recorded in `BASELINE-unit-suite-at-c349613b.txt`; the handoff already says the base suite is not green, so future worker prompts will forbid the full-suite run explicitly.
- `src/runtime/host/entry.ts` now imports from `scripts/diagnose-errors.ts` (type-only import plus dynamic import). That cross-boundary reuse is deliberate (reuse over duplication) and typechecks, but it is the first src→scripts dependency in the repo; V06 should confirm it does not distort packaging or startup cost.
- Provider credential loss (openai-codex) is an operator-level condition: workers must be started on a provider this host can authenticate. `herdr agent prompt` did not deliver input on this host; input had to be sent through a focused pane (`pane send-text` + `pane send-keys Return`).
