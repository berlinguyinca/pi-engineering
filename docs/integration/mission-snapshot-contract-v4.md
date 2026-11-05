# Mission snapshot contract v4 (WC-001)

`.pi-eng/orchestration-snapshot.json`, `contractVersion` 3 -> 4. Strictly additive:
every v3 field keeps its name, type and meaning. A v3 reader that ignores unknown
keys keeps working; a v3 file on disk still parses (`test/fixtures/mission-snapshot-v3-legacy.json`).

## Diff (per mission entry, all optional)

| Field | Type | Source | Omitted when |
|---|---|---|---|
| `created_at` | ISO string | `Mission.created_at`, verbatim | the record has none |
| `completed_at` | ISO string | `Mission.completed_at`, verbatim | `null` (mission not finished) |
| `links` | `{kind: 'issue'\|'pull_request', repository: 'owner/name', number: int}[]` | stored, `active` `GithubLinkRecord`s of that mission only | the github layer holds none |

Rules for `links`: never derived from title, goal or branch text; deduped by
(repository, kind, number) across subjects; sorted by repository, kind, number;
capped at `MISSION_SNAPSHOT_MAX_LINKS` (100); `removed` / `not_found` links and
links of other missions are skipped; only `github.com` targets are projected (a
GHES `owner/name` would be ambiguous), and an unparseable target is dropped.
`nextAction` / `nextActionAt` are unchanged (note: `nextAction` can be the literal
"No further action is scheduled", an absence marker).

There is still no mission start time in Pi; `created_at` is the nearest honest value.

## Code

`src/orchestration/missionSnapshot.ts` (`snapshotLinksOf`, `buildMissionSnapshot`,
`buildMissionSnapshotFile({ githubLinks })`), fed by `listGithubLinks(missionId)` in
`src/runtime/EngineeringRuntime.ts`. Tests: `test/unit/orchestration-snapshot-v4.test.ts`,
golden `test/fixtures/mission-snapshot-v4.golden.json`.

## Rollback

Revert the commits on `feat/wc001-snapshot-v4` (or set `MISSION_SNAPSHOT_CONTRACT_VERSION` back to 3
and stop passing `githubLinks`). The next publish rewrites the file as v3; the additive keys
disappear. No stored data changes (nothing is written to the mission journal).
Consumers must feature-detect fields, not branch on the version number.

## Wire discovery: not wired, deliberately

`discoverGithubLinks` (`src/github/discovery.ts`) still has no production caller. Wiring it
is not small or safe in this change:

- It needs an async network client (`createGithubClient` -> `gh` CLI) and a loaded
  `github` settings block (`loadGithubSettings`); neither is constructed by `EngineeringRuntime`
  today (only `src/github/syncCli.ts` builds them).
- Missions are created at several sites (`orchestrator.ts`, `externalEntry.ts`,
  `standaloneEntry.ts`); each would need the hook, plus decisions on when to run
  (create vs. each task), rate limits / `gh` auth failures, and idempotent retry.
- Its `suggested` output (weak branch/keyword matches) needs an operator confirm UI path.
- Discovery spawning `gh` on the mission-creation path risks stalling mission start.

What would be needed: a `GithubLinkService` owned by the runtime, built only when
`loadGithubSettings` returns settings (`github.enabled: true`, default stays off), invoked
off the hot path after mission creation with a bounded timeout and fail-open logging, with
integration tests against a real `gh`-shaped HTTP/CLI fixture.

## Owed (not done here)

The operator must enable `github.enabled: true` in `~/.pi/agent/engineering.yaml` per host
and run the existing sync CLI / fork PR linking for links to exist at all. Without that,
`links` is simply absent. Herdr's feed allowlist must add the three fields. Not deployed, not pushed.
