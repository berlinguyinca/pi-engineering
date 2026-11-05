# WORKER REPORT — E04: sanitization before durable error capture

Branch `feat/e04-error-sanitize` (base `a0eca33248a368a45ea8208314f048db754bf35e`, E03) in worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e04-error-sanitize-20261104`.

## Commit

`c349613b` — `feat(incidents): sanitize before durable error capture (E04)` — the only commit on the branch.

## Exported API + constants (`src/incidents/errorSanitize.ts`)

- `sanitizeForPersistence(input: unknown, policy?: SanitizePolicy): ErrorOccurrence | null` — the single entry
  point. Pure, deterministic for a given environment (no clock, no randomness, no I/O; one snapshot of
  `process.env`), never throws, idempotent (`sanitize(sanitize(x))` deep-equals `sanitize(x))`). Returns `null`
  when there is nothing attributable to store (non-object input, hostile getters, or an infeasible budget) —
  E02 refuses the unattributed, so E04 never invents attribution. Reuses `redactSecrets`/`redactDeep` from
  `src/platform/redact.ts`; nothing is re-implemented there.
- `SanitizePolicy` — `{ summaryMaxChars?, maxArtifactRefs?, maxCorrelationIds?, maxRefChars?, maxFieldChars?, maxPersistedBytes? }`.
  A policy value only ever shrinks the record; invalid (non-integer / <1) values fall back to the defaults.
- Constants (documented at the top of the file): `SUMMARY_MAX_CHARS = 400` (E02 admits 500; past 400 a
  "summary" is a transcript), `MAX_ARTIFACT_REFS = 8`, `MAX_CORRELATION_IDS = 8`, `MAX_REF_CHARS = 60`,
  `MAX_FIELD_CHARS = 120`, `MAX_PERSISTED_BYTES = 4096` (hard budget for the serialized record),
  `ENV_NAME` (a name that means "secret": `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PASSWD*`,
  `*PASSPHRASE*`, `*CREDENTIAL*`, `*AUTHORIZATION*`, `*CERT*`), `ENV_VALUE_MIN = 8` (shorter env values like
  `1`/`linux` would redact themselves out of every record).
- Behavior: env values are replaced by `[env:<NAME>]` (name only); absolute local paths (`/Users/…`, `/home/…`,
  `/private/…`, `C:\…`) by `<path>`; any string longer than the summary cap, or transcript-shaped
  (`system:`/`user:`/`assistant:`/`human:`/`prompt:`/`>`), by `<redacted-prompt len=N sha256=…>` (32 hex chars of
  the full sha256 — length + digest only, never content). List caps drop the tail and append `[refs+N dropped]`
  / `[ids+N dropped]` to the summary (never silent; the marker is rewritten, never stacked, on re-sanitize).
  Relative artifact refs survive unchanged. Unknown input fields are not persisted. A truncated summary that
  would split a redaction marker (and so fail E02's own redaction check) is truncated deeper, and a budget
  below the ~455-byte minimum record yields `null` rather than a record that breaches it.

## Secret fixtures used in `test/unit/error-sanitize.test.ts`

- OpenAI-style key `sk-proj-YWJjZGVmZ2hpamtsbW5vcA`
- `Bearer` token `c2VjcmV0dG9rZW4udG9rZW4`
- AWS access key id `AKIA1234567890ABCDEF`
- PEM private key (body `MIIEowIBAAKCAQEA0Z3Baseline` between `-----BEGIN/END RSA PRIVATE KEY-----` markers)
- Env value `zq7Kx9V2-env-value-never-real` under a test-set entry `E04_TEST_SECRET_KEY` (the only `process.env`
  entry the test mutates; restored in an `after()` hook)
- Absolute local path `/Users/wohlgemuth/private/agent.log`
- Long raw prompt transcript (`system: …` × 20 repeats, > 1000 chars)

Each fixture is asserted absent from `JSON.stringify(out)` per fixture; the env variable's *name* is asserted
present. Also asserted: digest stability across two runs, relative ref `logs/run-42.jsonl` surviving unchanged,
size caps + counted drop markers, byte budget at defaults and at a 512-byte policy, `sanitize(sanitize(x))`
deep-equality, `parseErrorOccurrence` validity, non-throwing behavior on `null`/`undefined`/number/string/bool/
array/`Error`/hostile-getter input, the E03→E04 pipeline (`normalizeError` → `sanitizeForPersistence`), and a
clean occurrence passing through unchanged apart from the caps.

## Verification (from the worktree root)

| # | Command | Exit |
|---|---------|------|
| 1 | `npm run typecheck` | 0 |
| 2 | `node --test --import ./test/support/isolatedState.ts test/unit/error-sanitize.test.ts` | 0 (6/6 pass) |
| 3 | `node --test --import ./test/support/isolatedState.ts test/unit/error-normalize.test.ts test/unit/error-event.test.ts` | 0 (8/8 pass) |
| 4 | `git diff --numstat HEAD~1 HEAD` | 0 |

Numstat: `49 0 src/incidents/errorSanitize.ts` + `51 0 test/unit/error-sanitize.test.ts` = **100 added, 0
deleted — exactly the 2-file / ≤100-line budget**. No other file touched; no installs; no forbidden git ops.

## Risks

- **Env scanning is whole-process**: every `*KEY*`-named env entry with a value ≥ 8 chars is scanned for
  substring equality in every string. A legitimate long token-like value (e.g. a deployment id stored in
  `DEPLOY_KEY_MATERIAL`) will be replaced by `[env:DEPLOY_KEY_MATERIAL]` — over-redaction, never under-redaction,
  and the marker names the variable so it stays diagnosable.
- **Digest stability is per-environment**: the sha256 covers the *cleaned* string (after secret redaction), so
  the same raw prompt on two hosts with different env tables yields the same digest only if the redaction input
  was identical. Determinism on one host (the contract's requirement) holds.
- **`[env:<NAME>]` markers and `<path>` are new persisted vocabulary** downstream consumers (E05+) have not seen
  yet; they are printable and pass E02, but incident grouping (future dedup) should treat them as wildcards.
- **Minimum record ≈ 455 bytes**: budgets below that (policy, not default) yield `null` by design.
- Transcript detection is a shape heuristic (`system:`/`user:`/`…:` prefixes): a summary that merely *starts*
  with such a word followed by `:` is digested, not stored — acceptable over-redaction for a field E02 calls a
  "summary".

## Disagreements / notes

- **Model gateway note (required by the contract)**: the session's environment reports
  `PI_PROVIDER=metabolomics`, `PI_MODEL=qwen3.8-27b-text` — i.e. this worker ran on
  `metabolomics/qwen3.8-27b-text`, not `metabolomics/qwen3.8-flash_next`. Reporting per the contract; no
  verification outcome depended on it.
- The contract's example signature `sanitizeForPersistence(occurrence: ErrorOccurrence, …)` would make the
  "never throws on a malformed input (`null`, string, hostile keys)" acceptance criterion untypeable, so the
  parameter is `unknown` (a `ErrorOccurrence` input still typechecks). Return is `ErrorOccurrence | null` for
  the same reason (unattributable input is refused, not repaired — matching E02's documented stance).
- `sanitizeForPersistence` returns `null` rather than a synthesized unattributed record for non-occurrence
  input: E02's own tests treat `UNATTRIBUTED` as "caller gave no attribution, a durable sink must refuse it",
  so E04 refuses at the sink instead of laundering it.
