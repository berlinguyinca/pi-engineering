# D02 report — stable cross-session error fingerprint (ordinal 15)

**Status: PASS, merged.** `feat/d02-error-fingerprint` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`a3f9b882` → `d4c056848107cfa3bddff4311c11e9017f6e8430` (single commit, `HEAD^` = approved base).

| item | value |
| --- | --- |
| diff | `src/incidents/errorFingerprint.ts` 55/0, `test/unit/error-fingerprint.test.ts` 43/0 → 98 changed lines (budget ≤100) |
| handoffHash | `sha256:5085f396a12a68f662b3d678ff511978dbedb4b1a73dda6667df6a9bf3b15e03` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:405e4dc03e9779a2757d137fe167ac8ff6e5a8ac721b77685be01a8d983a360b` |
| parent | **strictly verified**: `parent=D01 accepted sha256:73f5a03c568…` (`nextTaskId: D02`) |
| base / result / next | `a3f9b8820a38…` / `d4c056848107…` / `D03 @ d4c056848107…` |

Compared view (`fingerprintInput`) = `code` + `layer` + normalized `summary` + `tool`; dropped: timestamp, host,
session, run, task, runtime, model, artifact pointers, correlation ids. In-text folding: hex/uuid → `<id>`,
durations → `<dur>`, byte counts → `<size>`, absolute paths/worktree prefixes → `<path>`, urls → `<url>`,
`host:port` → `<addr>`, E04 prompt markers → `<prompt>`, `[env:NAME]` → `<env>`. Digits in **codes** are never
touched, which is what keeps `gateway.404.*` apart from `gateway.429.*`. Digest: sorted-key `fnv1a64` (16 hex),
consistent with the existing incident fingerprint; malformed input is total via `INVALID_FINGERPRINT =
"0000000000000000"`, with a documented coercion for a non-string `code`.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/error-fingerprint.test.ts` (5/5, one test per acceptance criterion) (spec `verify` 2) | 0 | `logs/02-unit-error-fingerprint.txt` |
| neighbours: `error-reader`, `incidents-fingerprint`, `error-sanitize`, `error-normalize`, `session-error-writer` (31/31) | 0 | `logs/03-unit-neighbours.txt` |
| conductor's own equivalence/separation probe | 0 | `logs/04-conductor-fingerprint-probe.txt` |

Independently reproduced evidence: two occurrences differing only in host/session/run/task/timestamp/uuid/
duration/byte-count/worktree-path/severity/model → **one key** (`62faf93823585c99`, with the input views printed
identical as `… request <id> after <dur> with <size> at <path>`); `gateway.404.not_found` vs
`gateway.429.rate_limited`, different layer, different tool, different root-cause noun and an added exception
class → **five distinct keys**; `null`/`undefined`/`{}`/`"x"` → `INVALID_FINGERPRINT`; differing
`<redacted-prompt len=… sha256=…>` digests do not split; no volatile text in the digest.

## Deviations

None. Conductor-side history actions: none. Budget respected on the first attempt because the handoff stated the
per-turn line ceilings up front (production ≤55, test ≤45), and the worker followed the three-turn protocol
without losing a turn to the gateway.
