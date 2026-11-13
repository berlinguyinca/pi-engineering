# HANDOFF D05 — read-only diagnose-errors CLI (planned task, ordinal 18)

You are a **single microtask worker** on branch `feat/d05-diagnose-errors-cli`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-d05-diagnose-errors-cli-20261104` (base SHA
`68e70ed58b93ce31dc28dd4a07871ffa4347c02e`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

**The gateway cuts long turns.** Three turns: production → test → verify+commit. **Line budget spans both
files**: production ≤ 60 lines, test ≤ 40 lines (total ≤ 100 added+deleted, gate-enforced).

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `D05`)

> "Read-only diagnose-errors CLI" — "Expose `--last`, `--all-sessions`, `--session`, `--model`, `--json`,
> `--export`. **Default local-host read-only**; validate args. **Do not call an LLM or edit configuration.**"
> Evidence required: "**Fixture index prints exact clustered totals and exit codes.**" `dependsOn: [D04]`.

## Read first (modify none of them)

- `src/incidents/errorReader.ts` (D01 `readHostErrorOccurrences(namespaceDir, filter)` → `{ occurrences,
  scannedStreams, scannedEvents, skipped, truncated, refused }`) — your only read path; it never opens writers.
- `src/incidents/errorAggregate.ts` (D03 `aggregateErrorOccurrences`) — produce the clustered totals with it, do
  not re-implement grouping.
- `src/incidents/recoveryOutcome.ts` (D04) — feed `resolution` into aggregate rows from durable evidence you were
  given; where there is none, leave the default (`unresolved`). Never invent recovery.
- `scripts/bootstrap-one.ts` — the repo's script conventions: `--experimental-strip-types`, `--flag value`
  parsing, `process.exitCode`, diagnostics to `stderr`, machine output to `stdout`.

## Required change (two files)

1. `scripts/diagnose-errors.ts`:
   - `parseArgs(argv: string[]): { ok: boolean; opts?: DiagnoseOptions; errors: string[] }` with exactly these
     flags: `--namespace <dir>` (required: the one verified local namespace to read), `--last <n>` (positive
     integer ≤ 5000), `--all-sessions` (default true), `--session <id>`, `--model <id>`, `--host <id>` (local
     host is the default when omitted **only** if you can derive it from `os.hostname()` — pass it through, never
     guess), `--json`, `--export <path>`, `--help`; unknown flags, missing values, non-numeric/≤0 `--last`,
     `--last` with `--all-sessions` explicitly off, or a `--session`/`--model` value containing whitespace or
     control characters → `ok: false` with a stable message per problem;
   - `runDiagnoseErrors(opts, deps)` where `deps = { read: typeof readHostErrorOccurrences, aggregate?: …,
     writeFile?: (p, s) => void, hostname?: () => string }` so the test can inject a **fixture index** and assert
     exact numbers without touching the real store;
   - **read-only**: the only filesystem access is `deps.read` plus the explicit `--export` path. Never write
     inside the namespace directory (refuse if the export path resolves inside it), never create directories,
     never touch configuration (`~/.pi`, config files, env vars other than reading `os.hostname()`), never spawn
     a process, never call a model/provider/LLM (no network, no `fetch`, no provider imports) — state this in the
     header comment;
   - output: `--json` prints `{ namespace, read: { scannedStreams, scannedEvents, skipped, truncated, refused },
     totals: { occurrences, clusters, duplicateEvents, rejected, recovered, unresolved }, clusters: [...] }`; the
     default human summary prints the same totals as exact lines (e.g. `occurrences=7 clusters=3 recovered=1
     unresolved=6 duplicateEvents=2 rejected=1`) so the test can pin them;
   - **exit codes** (document in the file and honour exactly): `0` read succeeded (matched or not); `2` argument
     validation failed (nothing is read); `3` namespace refused/missing (D01 reported `refused`); `4` unexpected
     failure during read or export. `--export` writes the JSON to the given path, refuses to overwrite an existing
     file unless `--force`, and counts as exit `4` if the write fails.
2. `test/unit/diagnose-errors-cli.test.ts` (≤40 lines, dense style):
   - **evidence criterion**: with an injected fixture index (build 7 occurrences → 3 clusters with
     `duplicateEvents: 2`, `rejected: 1`, one recovered via D04 evidence), assert the printed human summary and
     `--json` contain those **exact** totals, and that exit code is `0`;
   - exit codes: invalid args (unknown flag, `--last 0`, `--last abc`, whitespace in `--session`) → `2` and the
     injected `read` was **never called**; refused namespace → `3`; read throwing → `4`; export write throwing →
     `4`;
   - filters pass through to `read` (`--last`, `--session`, `--model`, `--host`) — assert the filter object the
     injected read received;
   - `--export` writes the JSON exactly once to the given path, refuses an existing file without `--force`, and
     refuses a path inside the namespace directory (`stderr` message + `2`);
   - `--help` exits `0` and prints usage; nothing in the output contains a raw summary longer than the D01/E04
     sanitized form (assert no `sk-` and no absolute paths beyond the namespace you passed).

## Files you may change (nothing else — the merge is rejected otherwise)

- `scripts/diagnose-errors.ts`
- `test/unit/diagnose-errors-cli.test.ts`

Never touch `src/**` (including the D01–D04 modules), `scripts/bootstrap-one.ts`, `package.json`,
`test/support/**` or any other test. No LLM/provider/network calls, no configuration reads or writes, no
`node:child_process`.

## Acceptance criteria (each proved by output you paste)

1. Evidence criterion: fixture index prints exact clustered totals; exit `0`.
2. Exit codes `0`/`2`/`3`/`4` behave exactly as documented, and validation failures read nothing.
3. Flags are validated and forwarded to the read filter.
4. `--export` semantics (single write, no overwrite without `--force`, no write inside the namespace).
5. Read-only proof: `grep -nE "child_process|fetch|https?://|mkdir|writeFile|appendFile|SessionEventStore|openSync" scripts/diagnose-errors.ts`
   matches **only** the injected `writeFile` dependency line, and the module imports nothing from
   `src/inference`, `src/providers`, or `src/llm` (`grep -nE "from \"../src/(inference|providers|llm)"
   scripts/diagnose-errors.ts` prints nothing).
6. `npm run typecheck` and the two `verify` commands exit 0, and
   `node --experimental-strip-types scripts/diagnose-errors.ts --help` exits 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/diagnose-errors-cli.test.ts
node --experimental-strip-types scripts/diagnose-errors.ts --help > /tmp/d05-help.txt 2>&1; echo "help_exit=$?"
grep -nE "child_process|fetch|https?://|mkdir|writeFile|appendFile|SessionEventStore|openSync" scripts/diagnose-errors.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-reader.test.ts test/unit/error-aggregate.test.ts test/unit/recovery-outcome.test.ts
git diff --numstat 68e70ed58b93ce31dc28dd4a07871ffa4347c02e HEAD
```

All must exit 0 except the greps as noted; the numstat must list only your two files with total ≤ 100. If anything
fails, **stop and report the failure verbatim** — no workarounds, no scope widening.

## Commit and report

1. `git add` only your files; commit: `feat(scripts): read-only diagnose-errors CLI (D05)`.
2. Write `D05/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/D05/`:
   flag table, exit code table, the injection seam (`deps`) and what the test asserts through it, the read-only
   argument, export refusal rules, commands with exit codes, numstat totals, commit SHA, risks, disagreements.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, calling any model or
network API, writing inside the read namespace, editing configuration, `--no-verify`, or any state mutation
outside your worktree.
