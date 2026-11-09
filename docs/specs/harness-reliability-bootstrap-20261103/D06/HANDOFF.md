# D06 — Register /diagnose-errors Pi command

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/D06/fixtures/manifest.json (printed by the CLI at stamp time).
Parent: D04→D05 chain; parent handoff docs/specs/harness-reliability-bootstrap-20261103/D05/D05.handoff.json (sha256:c34af64aacca9ca1f2ecba8511730dbdd6a1334d610198fbcfa838606bb964de, status PASS).
Base commit: 57b81f9608339c8481151df4b27a4bee60040703. Mode: isolated-change.

## Objective (plan delta, verbatim)
Discover existing command registration convention; add thin adapter to D05 local read-only diagnostics. No new slash-command registry.

## Scope (hard limits)
- Exactly 2 files may change: `src/runtime/host/entry.ts` (production ≤ 2) and `test/unit/diagnose-errors-command.test.ts` (tests ≤ 2).
- Total changed lines across the commit ≤ 100 (mode: isolated-change — the ceiling is the sum of added + deleted lines).
- Denied: `scripts/**` existing files (including `scripts/bootstrap-one.ts`), `src/bootstrap/**` (the gate you are judged by), `package.json`, `.gitignore`, `test/support/**`, `docs/specs/harness-reliability-bootstrap-20261103/manifests/**` and `templates/**`. Do not touch any other file.

## Required behaviour
1. Reuse, do not reinvent: read how commands are already registered (`pi.registerCommand` in `src/runtime/host/entry.ts`, plus whatever the Host path registers) and register `diagnose-errors` through that same convention. Do not create a registry, dispatcher or plugin surface.
2. Thin adapter over D05: call `parseArgs` and `runDiagnoseErrors` from `scripts/diagnose-errors.ts` (relative import) — no duplicated parsing, aggregation or reading logic. If the build refuses that import, STOP and report BLOCKED with the exact error text instead of copying D05 code into `src/`.
3. Read-only permission scope: inject `read` (D01 `readHostErrorOccurrences`), `aggregate` (D03), `evidence` (D04), `hostname`, `exists` — and no `writeFile`, so `--export` from the command is refused with the existing exit-4 path. The command must never write, mkdir or append inside the events namespace.
4. Namespace discovery: use the existing state/events-directory convention already used in this repo (discover it; do not hardcode a path or invent an env var).
5. Output: bounded (totals + top clusters at most) through the existing UI notify/report surface used by other commands; exit-code class must be visible in the message.

## Tests (test/unit/diagnose-errors-command.test.ts)
Assert: the command is registered with a description; the handler runs a read-only diagnose through injected deps and reports the exact clustered totals; `--export` is refused because no writer is injected; a refused namespace surfaces the exit-3 class; nothing writes to the namespace (assert the injected deps receive no write call and no fs write happens).

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/diagnose-errors-command.test.ts`
Also run, for information only (report failures, do not fix outside scope): `node --test --import ./test/support/isolatedState.ts test/unit/diagnose-errors-cli.test.ts` and `test/unit/error-reader.test.ts`.

## Report
Write `WORKER_REPORT.md` in the worktree root: what convention you discovered (file:line), the exact diff summary (`git diff --numstat 57b81f9608339c8481151df4b27a4bee60040703 HEAD`), each verify command with its exit code, and any deviation or blocked condition. Commit message: `feat(runtime): expose read-only /diagnose-errors command (D06)`.
