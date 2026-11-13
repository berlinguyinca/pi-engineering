# E04 report — sanitization before durable error capture (ordinal 10)

**Status: PASS, merged.** `feat/e04-error-sanitize` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`a0eca332` → `c349613b59ab6a0a9666633df68002394767cfa6`.

| item | value |
| --- | --- |
| diff | `src/incidents/errorSanitize.ts` 49/0, `test/unit/error-sanitize.test.ts` 51/0 → 100 lines (planned budget 2 production / 2 test / ≤100) |
| handoffHash | `sha256:44b2064fa51af5abffd992d78577b6a7937b536f50c46a6af0d93c6df5221e9b` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:3e42f907e014c17da3d4007517a9c0aac9c8d6f85912b93df9477c42a0a2bb87` |
| parent | **strictly verified**: `parent=E03 accepted sha256:72ebd9c3123…` (`nextTaskId: E04`, `nextBaseSha == baseSha`) |
| base / result / next | `a0eca33248a3…` / `c349613b59ab…` / `E05 @ c349613b59ab…` |

`sanitizeForPersistence(input, policy?)` documents its budget at the top of the file
(`SUMMARY_MAX_CHARS = 400`, `MAX_ARTIFACT_REFS = MAX_CORRELATION_IDS = 8`, `MAX_REF_CHARS = 60`,
`MAX_FIELD_CHARS = 120`, `MAX_PERSISTED_BYTES = 4096`), reuses `redactSecrets`/`redactDeep`, adds
env-**value** redaction keyed by secret-looking env **names** (`ENV_NAME`, values ≥ 8 chars, so `"1"`/`"linux"`
cannot wipe a summary), folds absolute local paths to `<path>`, reduces prompt transcripts and over-cap strings
to `<redacted-prompt len=N sha256=…>`, and refuses hopeless input by returning `null` instead of throwing.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/error-sanitize.test.ts` (6/6) (spec `verify` 2) | 0 | `logs/02-unit-error-sanitize.txt` |
| neighbours: `error-normalize`, `error-event` (8/8) | 0 | `logs/03-unit-error-neighbours.txt` |
| conductor's own secret fixtures (independent of the worker's tests) | 0 | `logs/04-conductor-secret-fixtures.txt` |

Conductor fixture result (evidence requirement "secret fixtures never appear in persisted representation"):

```
MAX_PERSISTED_BYTES = 4096 SUMMARY_MAX_CHARS = 400
secret apiKey  present in persisted record: false
secret bearer  present in persisted record: false
secret aws     present in persisted record: false
secret pem     present in persisted record: true      <-- header-only fixture, see note 1
secret env     present in persisted record: false
secret path    present in persisted record: false
prompt text present: false | transcript marker present: false
summary: rate limited with [REDACTED] and Bearer [REDACTED] for <path> (…) token [env:PI_E04_CONDUCTOR_…
parse valid: true | bytes: 480 <= budget: true
idempotent: true
relative refs kept: ["logs/run-42.jsonl","artifacts/x.tar.gz"]
oversized -> bytes: 555 <= budget: true | refs: 8 | ids: 8 | parse valid: true
malformed null/undefined/"boom"/42/[] -> null (refused)   {"hostile":{…}} -> valid=true
```

## Notes (clarified, not defects)

1. The only fixture that "survived" was the literal line `-----BEGIN PRIVATE KEY-----` with no key body and no
   `END` marker. `src/platform/redact.ts` matches a *complete* block
   (`/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/`), and a re-run with a full
   PEM block gives `summary: [REDACTED]` with the key body absent (`full pem survives: false`). No key
   material is persisted; a bare header line carries none.
2. "Clean occurrence passes through unchanged" is *not* literally true, and correctly so: an input missing the
   E02-required `runtime` field comes back with `runtime` filled, because the alternative is emitting a record
   `parseErrorOccurrence` rejects. All other fields are untouched.

## Deviations

The gateway interrupted this worker twice (`Error: Dispatch to the selected node failed; it was not started.`),
which is why the first two turns ended with the files written but uncommitted, and it switched the pane's model
from `metabolomics/qwen3.8-flash_next` to `qwen3.8-27b-text`. The work was re-prompted to completion; every
verification above was run by the conductor at the commit, not by the worker.
