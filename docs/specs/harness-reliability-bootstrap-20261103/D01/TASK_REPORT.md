# D01 report — read-only merged host error reader (ordinal 14)

**Status: PASS, merged.** `feat/d01-error-reader` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`8f33cfbb` → `a3f9b8820a389bc94920c4b5461c39cc68f3bc88` (single commit, `HEAD^` = approved base).

| item | value |
| --- | --- |
| diff | `src/incidents/errorReader.ts` 50/0, `test/unit/error-reader.test.ts` 49/0 → 99 changed lines (budget ≤100) |
| handoffHash | `sha256:73f5a03c5685d6e65ad301c6632d206286ac9fe74120520a0227e499d84c1e16` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:2419c23f2e8b29c9c4ef1e8e0f148bd92f257ac291d17bd5d9fe1d1eda149777` |
| parent | **strictly verified**: `parent=E07 accepted sha256:5c2b097b2cc…` (the regenerated E07 record, `nextTaskId: D01`) |
| base / result / next | `8f33cfbb6cd0…` / `a3f9b8820a38…` / `D02 @ a3f9b8820a38…` |

`readHostErrorOccurrences(namespaceDir, filter?)` reads one namespace through `listStreamFiles` + the JSONL
readers only — `grep -nE "SessionEventStore|mkdir|writeFile|appendFile|open\(" src/incidents/errorReader.ts`
matches **only** the `listStreamFiles` import, so the writer class is never instantiated. It selects E05
occurrence events that still pass E02, reports `scannedStreams`/`scannedEvents`/`skipped{foreignType,corrupt,
unparsable}`/`truncated`, orders by timestamp then `event_id`, defaults to `DEFAULT_ERROR_INDEX_LIMIT = 500`
(cap 5000), and marks a missing namespace as `refused` without touching the filesystem.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/error-reader.test.ts` (4/4) (spec `verify` 2) | 0 | `logs/02-unit-error-reader.txt` |
| neighbours: `session-error-writer`, `error-sanitize`, `error-normalize`, `error-event` (19/19) | 0 | `logs/03-unit-neighbours.txt` |
| conductor's own 12-combination filter sweep | 0 | `logs/04-conductor-readonly-check.txt` |

Evidence criterion, independently reproduced: with two sessions writing through the E05 writer, one foreign
`incident.raised` event and one corrupt stream appended by hand, **every** filter combination printed
`after=UNCHANGED` (sha256 per stream file + directory name set + no `recovery/` or lock entries), `limit: 1`
reported `truncated=true`, `skipped={"foreignType":1,"corrupt":1,"unparsable":0}` was stable, ordering was
identical across two runs, and a nonexistent namespace returned `refused: "missing"` with `nothing created for
missing dir: true`.

## Budget handling (conductor-guided, gate-enforced)

The first draft of `errorReader.ts` came out at 85 lines, which would have blown the 100-line combined budget
once the test landed; the conductor told the worker to compress before writing the test ("rewrite to ≤55 lines,
keep behaviour"), it became 50, and the test 49 → 99 total. The gate therefore passed on the first stamp
attempt. This is the unit where the "one step per turn" prompting (production → test → verify+commit) paid off:
no turn was lost to the gateway.

## Deviations

None in content. Conductor-side history actions: **none** on this unit (no reset, no squash, no push); the
stamping script now merges only when `STAMP=0` and the handoff validates.
