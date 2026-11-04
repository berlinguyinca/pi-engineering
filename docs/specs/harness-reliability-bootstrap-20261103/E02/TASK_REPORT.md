# E02 Task Report

- Work item: E02 — Define normalized error event types (`docs/harness-reliability-bootstrap-20261103.md`)
- Outcome: `ErrorOccurrence` v1 defined and validated by `parseErrorOccurrence()` in
  `src/incidents/errorEvent.ts`; `incidents/types.ts` untouched (backward compatible by construction).

## Changed files

| File | Insertions | Deletions |
| --- | --- | --- |
| `src/incidents/errorEvent.ts` (new) | 58 | 0 |
| `test/unit/error-event.test.ts` (new) | 40 | 0 |
| **Total** | **98** | **0** |

Within budget: 2 files (limit 2), 98 lines (limit <100). Proof: `logs/04-diff-scope.txt`.

## Verification results

| Check | Command | Exit code | Log |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | 0 | `logs/01-typecheck.txt` |
| New tests | `node --test --import ./test/support/isolatedState.ts test/unit/error-event.test.ts` | 0 | `logs/02-unit-error-event.txt` — 4 tests, 4 pass, 0 fail |
| Regression | `node --test --import ./test/support/isolatedState.ts test/unit/autospec-incident-sink.test.ts test/unit/incident-controller.test.ts test/unit/incidents-fingerprint.test.ts test/unit/security-redaction-regression.test.ts` | 0 | `logs/03-unit-regression.txt` — 57 tests, 57 pass, 0 fail |
| Diff scope / budget | `git diff --numstat` | 0 | `logs/04-diff-scope.txt` |
| Parent chain + plan | `node scripts/bootstrap-one.ts --manifest manifest-e02.json --parent-handoff E01.handoff.json` in a clean worktree at the base commit | 0 | `logs/06-parent-accepted.txt` — `parent=E01 accepted sha256:2077162a05a…`, `plan exit=0` |
| Handoff stamping | `node scripts/bootstrap-one.ts … --proofs … --handoff-record … --emit-handoff` in a clean worktree at `cc036f2f` | 0 | `logs/05-cli-accepted.txt` — `gate=accepted` |
| Handoff hash + schema | recompute `canonicalHash`, validate against `templates/handoff.schema.json` | 0 | `logs/07-handoff-hash-and-schema.txt` — MATCH, 0 schema errors |
| Gate negative controls | same run with an out-of-scope manifest and with `maxChangedLines: 50` | 0 / 5 | `logs/08-gate-scope-gap.txt` |

## What the schema enforces

Required: `version` (= 1), `timestamp` (ISO-8601 UTC), `host`, **`sessionId`**, `runtime`, `layer`,
`code`, `severity`, `summary`, `correlationIds` (>= 1). Nullable, never guessed: `runId`, `taskId`,
`model`, `quantization`. `artifactRefs` must be repo-relative (absolute paths and `..` segments are
refused). Every string is restricted to printable ASCII, so NUL, CR/LF and ANSI/VT sequences cannot
enter a stored error record. `summary` is refused unless it is already redacted — the check is
`redactSecrets(summary) === summary`, the same redactor the persisted-payload path uses.

## Findings (two of them are about the gate, not about this task)

- **[high] The result gate validates paths on the working tree, never on the task commit.**
  `evaluateDiffScope()` checks allow/deny grants and the per-file budgets against
  `git status --porcelain`, while the stamping run is required to have a *clean* tree, so those checks
  are vacuous; only `added + deleted <= maxChangedLines` (from `HEAD^1..HEAD` numstat) bites. Negative
  control (`fixtures/manifest-e02-negctl.json`, `logs/08`): a manifest whose `allowPaths` omits
  `test/unit/error-event.test.ts` and whose `denyPaths` contains `test/**` was **accepted**, even though
  commit `cc036f2f` adds exactly that file. Control 2 (`maxChangedLines: 50`) correctly rejected
  (`98 added + 0 deleted > limit 50`), so the gate is not wholly inert — the scope half is. Fix in E05/E06:
  feed `git diff --name-status HEAD^1 HEAD` paths through the same path policy, and count files from the
  commit, not from porcelain.
- **[high] The handoff is stamped without validating `parentHandoffHash`.** Stamping happens at the task
  commit, so `HEAD != manifest.baseSha`, `bootstrapOne()` returns exit 3 before the parent checks, and
  exit 3 is not a gate blocker (`bootstrap-one.ts`: only exit 2 and 4 block). The chain is therefore
  asserted but never verified at the moment of writing. Proof: `logs/05` (no `parent=` line) vs `logs/06`
  (separate run at the base commit, which does verify). Fix: validate the parent in the emit path
  unconditionally, and record its canonical hash in the handoff.
- **[medium] `taskAuthorityHash` has no defined derivation.** The spec requires the field
  (`tasks/*.md`:43) and never says what is hashed; `canonicalHash()` of the stored E01 manifest (raw or
  post-parse) does not reproduce E01's recorded value, so that link is unverifiable after the fact. E02
  fixes a derivation going forward — `canonicalHash(parseTaskManifest(manifest).manifest)` — and states it
  in the handoff, the approval checkpoint and `logs/07`.
- **[medium] `writeHandoff()` still performs no schema validation** (carried from E01, unresolved):
  it hashes whatever object it is given, so a structurally invalid handoff is still "sealed". Fixing
  it belongs with the evidence-retention task (E05), which owns the artifact writer.
- **[info] Redaction is a refusal, not a repair.** A summary containing a secret-shaped substring is
  rejected rather than silently rewritten, so E03 must call `redactSecrets()` before constructing an
  occurrence. This keeps "who redacted it" unambiguous at the cost of one extra call per producer.
- **[info] Layer vocabulary is the owning subsystem, not the telemetry `kind`** — see TASK_PLAN.md.
  E03 must map E01's kinds explicitly (`inference` → `gateway`/`worker`, `scheduler-window` → `aps`,
  `incident-*` → `incident`, `state-commit` → `session-store`).

- **[info] Correction to the stamped record.** The immutable `E02.handoff.json` says the E01 handoff was
  "verified by the CLI before this handoff was emitted". Precisely: the *stamping* run did not verify it
  (finding above), and verification happened in a separate plan-only run at the base commit
  (`logs/06-parent-accepted.txt`). The handoff cannot be rewritten (immutability is deliberate), so the
  correction lives here.

## Follow-ups
- **For E03:** emit `ErrorOccurrence` from the durable paths E01 lists (provider retry budget,
  `inference.retry_exhausted`, model fallback, model health, tool failure, persistence failure) using
  the mapping above, and never emit an occurrence with an unredacted summary.
- **For E05:** schema-validate handoffs at write time; make the gate evaluate the *commit's* paths and
  file counts; validate the parent handoff in the emit path (see the two high findings above).
- **For E04:** the printable-ASCII rule means the incident journal must escape, not pass through,
  any producer-supplied text.
