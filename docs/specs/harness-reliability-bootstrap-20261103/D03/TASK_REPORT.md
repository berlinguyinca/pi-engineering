# D03 report — aggregate occurrences into issue clusters (ordinal 16)

**Status: PASS, merged.** `feat/d03-error-aggregate` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`d4c05684` → `23e2d90501dab6271482d0420f9268e8e244092e` (single commit, `HEAD^` = approved base).

| item | value |
| --- | --- |
| diff | `src/incidents/errorAggregate.ts` 55/0, `test/unit/error-aggregate.test.ts` 45/0 → 100 changed lines (exactly the ≤100 budget) |
| handoffHash | `sha256:9e4972d15bee2fafc71d9859d217e92a871005f199dcb3e341b5eae77326be9d` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:dd8f083a670b0fd591e26c291a40cd350f57b08a530bd168735467c2331b9482` |
| parent | **strictly verified**: `parent=D02 accepted sha256:5085f396a12…` (`nextTaskId: D03`) |
| base / result / next | `d4c056848107…` / `23e2d90501da…` / `D04 @ 23e2d90501da…` |

`aggregateErrorOccurrences(rows, { maxEventIds = DEFAULT_MAX_EVENT_IDS 50, limit? })` is pure (purity grep
`Date.now|node:fs|process.env|Math.random` → exit 1, nothing printed) and groups by **the D02 key** — asserted
independently: cluster fingerprint `6859cd93bc3b16ad` === `errorFingerprint(occurrence)`. Clusters carry
`count`, `firstSeen`/`lastSeen` over deduped occurrences, sorted-unique `sessions`/`hosts`/`models`/
`quantizations`/`layers`/`codes`, `recovered`/`unresolved` (default unresolved, documented as D04's contract),
kept `eventIds` with `eventIdsTruncated`, and the total order is `lastSeen` desc → `count` desc → fingerprint
asc. Dedupe folds a repeated `eventId` and — the retry-trace case — a second `eventId` carrying an already-seen
E07 `failureIdentity`, keeping **both** ids as evidence and incrementing `duplicateEvents`, so one failure seen
through two paths is one failure.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/error-aggregate.test.ts` (6/6, one test per criterion) (spec `verify` 2) | 0 | `logs/02-unit-error-aggregate.txt` |
| neighbours: `error-fingerprint`, `error-reader`, `error-event` (13/13) | 0 | `logs/03-unit-neighbours.txt` |
| conductor's own aggregate probe | 0 | `logs/04-conductor-aggregate-probe.txt` |

Evidence criterion reproduced independently: 6 input rows (one `failureIdentity` spanning `e1`+`e2`, a literal
`e1` repeat, a malformed row) → 3 clusters, `duplicateEvents: 2`, `rejected: 1`, the 429 cluster `count: 1` with
`ids: ["e1","e2"]`, `recovered + unresolved === count` in every cluster, dimension sets sorted+unique,
`maxEventIds: 1`/`limit: 1` set both truncation flags, input deep-equal after the call, and a deterministic
shuffle produced **byte-identical** clusters JSON.

## Deviations

None. Conductor-side history actions: none. Note for D04: `resolution` is an input placeholder by design
(documented in the file header), and the worker used the full 100-line budget, so D04's handoff must set the same
per-turn ceilings.
