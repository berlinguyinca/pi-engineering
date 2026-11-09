# E05 report — record normalized error occurrences per session (ordinal 11)

**Status: PASS, merged.** `feat/e05-session-error-writer` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`c349613b` → `d19553b9601f616be01b65c5041c91ed2e9ff889`.

| item | value |
| --- | --- |
| diff | `src/runtime/isolation/SessionErrorWriter.ts` 50/0, `test/unit/session-error-writer.test.ts` 49/0 → 99 lines (planned budget 2 production / 2 test / ≤100) |
| handoffHash | `sha256:40b04647d4bcd398a6e304b2e107546dc1ae484879f846b4b36cb642b925db62` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:de966d455b1f5b1c8a5b18da14c7652594c8dd2c94a32a24a0f01d5deb55394d` |
| parent | **strictly verified**: `parent=E04 accepted sha256:44b2064fa51…` (`nextTaskId: E05`, `nextBaseSha == baseSha`) |
| base / result / next | `c349613b59ab…` / `d19553b9601f…` / `E06 @ d19553b9601f…` |

`SessionErrorWriter` is a thin adapter over the existing `SessionEventStore`: a distinct
`ERROR_OCCURRENCE_EVENT_TYPE`, sanitize-before-write through E04, a deterministic `event_id` derived from the
sanitized payload, the `incidentFingerprint` attached for the *incident* layer to deduplicate later, and
`listOccurrences()` which returns only occurrence events that still pass `parseErrorOccurrence`. No new storage
format was introduced. Worker's own tests (5/5) cover: concurrent sessions in one `eventsDir` staying isolated
while `readMergedEvents` sees both; drain + close + reopen with deep-equal payload; the secret never reaching the
bytes on disk; occurrence/incident separation with honest scope mapping; and a repeated record writing one line
while an E04 refusal writes nothing.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/session-error-writer.test.ts` (5/5) (spec `verify` 2) | 0 | `logs/02-unit-session-error-writer.txt` |
| neighbour suite as prescribed by my handoff | **1** | `logs/03-unit-neighbours.txt` — see finding below |
| same neighbour suite **at base `c349613b`** in the conductor worktree | **1**, same 5 tests | `logs/04-base-registry-at-base.txt` |

## Finding: the prescribed neighbour-suite criterion was unsatisfiable, and the baseline is not green

`test/unit/runtime-isolation-registry.test.ts` fails 5/13 (RuntimeRegistry + LeaseManager liveness tests, e.g.
`reason: 'pid_not_alive'` where `'pid_reused'` is expected) **at the base commit itself**, before any E05 code
exists — and a 30-minute partial sweep of all 529 unit test files at `c349613b` recorded ~150 ✖ lines
(`docs/specs/.../BASELINE-unit-suite-at-c349613b.txt`; the sweep was truncated by the timeout, so the true number
is larger). So (a) E05 broke nothing — identical failures with and without its commit; and (b) my handoff's
criterion 6 asserted a suite that is red on this host at base, which is a **conductor error in the handoff**, not
a worker failure. From E06 on, handoffs require only the task's own `verify` commands plus suites actually
baselined green (`bootstrap-*`, `error-event`/`error-normalize`/`error-sanitize`, `incident-controller`,
`incidents-fingerprint`, `session-error-writer`).

## Deviations

Commit subject is `feat(runtime): record E02 error occurrences on the session event stream` instead of the
prescribed `feat(runtime): record error occurrences per session (E05)` — same scope, same two files; noted rather
than rewritten (amending the worker's commit is forbidden). No gateway interruptions this unit.
