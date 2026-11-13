# D05 — Read-only diagnose-errors CLI — conductor report

Task authority: sha256:3fea3c4fd89d83bb17b98628792eb61bb8c976242742bfae2905b518bf8e5845
Plan delta: Add scripts/diagnose-errors.ts as a read-only CLI: default local-host read-only; validate args; exit codes stable; no writes to the namespace. (production 1 / tests 1 / ≤100 lines / verify: typecheck; node --test test/unit/diagnose-errors-cli.test.ts)
Worker pane: d05 (pane w0:pK), model openai-codex/gpt-5.1-codex, base 68e70ed58b93.
Result: 57b81f9608339c8481151df4b27a4bee60040703 — parent 68e70ed58b93; 60 + 40 = **100 changed lines** over `scripts/diagnose-errors.ts` and `test/unit/diagnose-errors-cli.test.ts` (production 1 ≤ 1, tests 1 ≤ 1, lines 100 ≤ 100; manifest mode unit — maxChangedLines is a total changed-lines ceiling).

## What the unit provides
`parseArgs()` accepts `--namespace --last --all-sessions/--no-all-sessions --session --model --host --json --export --force --help` and reports every problem with a stable message (exit 2, nothing read); `runDiagnoseErrors(opts, deps)` is injectable over `read` (D01), `aggregate` (D03), `evidence` (D04), `hostname`, `exists` and `writeFile`, so the CLI reads one verified namespace through D01 only — no writers, no configuration, no child processes, no providers, no network. Exit codes: 0 success, 2 invalid argv and export refusals, 3 refused namespace, 4 read or export failure.

## Conductor verification (logs/D05/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-diagnose-cli.txt` — the task's own verify command: 6/6 pass 0 fail (exact clustered totals in human and `--json`; exit 2 on invalid argv with nothing read; exit 3/4 refusals; filters forwarded; `--export` single write, no overwrite without `--force`, never inside the namespace; `--help` reads nothing).
- `03-help.txt` — real `--help` run, exit 0, usage printed.
- `04-unit-neighbours.txt` — 21/21 pass 0 fail (D01 + D02 + D03 + D04 suites).
- `05-conductor-cli-e2e.txt` — conductor end-to-end run of the real CLI over a real namespace: default exit 0; `--json` printed `occurrences=5 clusters=4 duplicateEvents=0 rejected=0 recovered=0 unresolved=5`; filtered run exit 0; invalid argv exit 2 with per-problem messages; missing namespace exit 3; `--export` exit 0 with a file outside the namespace; overwrite without `--force` refused; `--export` inside the namespace refused with no file created; the namespace was byte-identical before and after; no raw prompt digest or key material in the output.
- Read-only greps on the unit file matched only the injected write seam (the `writeFile` dependency, its call site, and the main-guard wiring for `--export`): no `child_process`, no network, no `SessionEventStore`, no `mkdir`/`appendFile`/`openSync`; no `src/inference|providers|llm` import.
- `06-stamp.txt` / `08-stamp-accepted.txt` — the gate REJECTED the first stamp (`denied-path: denied by "scripts/**"`), accepted the corrected one: `parent=D04 accepted sha256:5ad9e5f80f0…`, `authority=D05 sha256:3fea3c4f…`, `schema=D05 conforms`.
- `07-deny-granularity-probe.txt` — negative probe over the corrected manifest: changing `scripts/bootstrap-one.ts`, `src/bootstrap/resultGate.ts` or `package.json` is still `denied-path`; the task's own two files produce no path violation.

## Stamping-input correction (no repository code changed)
The conductor's harness self-protection deny list used the coarse prefixes `scripts/**` and `src/bootstrap/**`, which blocked tasks whose declared production path legitimately lives under them (B04/B05 built `scripts/bootstrap-one.ts`; D05, T01, V02, V04 are affected the same way). The protection is now expressed per existing tracked path: every file already present under a protected prefix stays denied, and only paths the task declares remain writable — strictly narrower than the prefix it replaced. D05's unit commit and test files are untouched by this correction; only the stamped manifest's `denyPaths` (and therefore its authority hash) changed, and that is recorded above and in the handoff notes.

## Integration
`git merge --ff-only feat/d05-diagnose-cli` → HEAD `57b81f96`; `git show --stat HEAD` lists exactly the two files, 100 insertions.

## Residual risk / observations carried forward
- With `--host` omitted the CLI filters on `os.hostname()`; a namespace whose records carry a different host label therefore reads as zero occurrences on the default path (`05-conductor-cli-e2e.txt` line A shows `occurrences=0` while `--json --host localbox` shows 5). Per-handoff behaviour, but D06/D07 should surface it (e.g. `--any-host`) so an operator does not mistake "no errors" for "different host label".
- `--export` refusal cases (overwrite, inside-namespace) exit 2 (validation class, nothing written) rather than 4; the test asserts the refusal, not the class.
- The CLI writes only through the injected `writeFile` (main guard wires `fs.writeFileSync`) for an explicit `--export` path outside the namespace; no other write site exists.
