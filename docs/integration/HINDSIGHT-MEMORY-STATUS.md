# Hindsight memory integration status (OpenViking retired)

Branch `rebase/retire-openviking`, work tree
`~/IdeaProjects/worktrees/pi-retire-rebuild`, base commit `4e8834d3` ("WIP: reconcile
#554 … tree does NOT typecheck yet"). The retirement is committed as `de3f2e64` and
pushed to `origin/rebase/retire-openviking`; the recall-delivery fix below is the
follow-up commit on the same branch.

## Where it stands

| Surface | State | Evidence |
|---|---|---|
| Pi → `herdr-memory` CLI only (no HTTP, no URL/token in Pi config) | done | `src/blackhole/hindsight.ts`; `test/unit/blackhole.test.ts` "durable module: no HTTP adapter survives" |
| Env/config surface (`PI_HINDSIGHT_*`, scopes `project\|global\|infra\|mission:<id>`) | done | `test/unit/memory-setup.test.ts`, `test/unit/config.test.ts` |
| `/memory`, `/memory setup`, `/remember` | done | `src/blackhole/interactiveMemory.ts`, `test/unit/interactive-memory.test.ts` |
| Recall labelling (untrusted reference data, never instructions) | done | `memoryBlock()` header |
| `/blackhole` status truthfulness | done | `extensions/index.ts` `/blackhole` caveats: `shared-file` counts a local JSONL file; Hindsight rows are an overview probe, not a bank total |
| Typecheck (`npm run typecheck`) | passes | core + scripts, 0 errors |
| Lint (`npm run lint` = `biome check .`) | touched files clean | 7 paths fail format/JSON at the base commit too (`docs/specs/…PHASE-6-LIVE-COMPARISON.json`, `src/models/pinMigration.ts`, `src/models/refresh.ts`, `test/unit/hindsight-harness-env.test.ts`, `model-alias-catalog`, `model-pin-migration`, `models-catalog`); none is touched here |
| Memory test set (`node --test --import ./test/support/isolatedState.ts`) | 139 tests, 128 pass, 11 fail | the 11 failures are the Linux-only `ARTIFACT INTEGRITY` error (see "Not done"); the same 11 fail on the base commit, which runs 135 tests / 124 pass |
| Live client/service round-trip (read-only) | passes | see "Live verification" |
| Automatic per-turn recall reaching the model in a real session | works | live `pi -p` runs below; `test/unit/interactive-memory.test.ts`, `test/integration/everyday-memory.test.ts` |

## Live verification (2026-11-04, macOS, `~/.local/bin/herdr-memory`)

Read-only probes against the configured service (`https://memory.local.metabolomics.us`,
project `canary`). No memory was written or deleted; only `status`, `doctor`, `recall`.

- `herdr-memory --project canary status` →
  `{"project":"canary","harness":"codex","pending":0,"contract":1,"healthy":true, …}` (exit 0).
- `herdr-memory --project canary doctor` → `ok: true`, checks
  `credential:project|global|infra`, `server: reachable`, `outbox: 0 pending`; scopes
  `["project","global","infra"]`.
- Provider through the real CLI (`HindsightDurableMemory`, wrapper pinning
  `--project canary --harness pi`):
  - `probeHindsightStatus()` → `{ok:true, project:"canary", pending:0}`
  - `search("relief valve")` → 20 records, contract-normalised
    (`memory_id`, `bank_id: canary-facts`, `revision`, `status: verified`,
    `provenance.evidence_refs[]`)
  - `recallAll()` → 50 records; `cacheScope()` → `project#e0#r1`
- Latency per call (4 runs): `recallAll` 1065–1603 ms, `search` 1045–4732 ms.

### Live facts that corrected the implementation

1. **`recall "*"` is rejected** — `{"error":"Memory service rejected request (HTTP 422)"}`,
   exit 1; an empty query fails client-side. There is no list endpoint, so
   `recallAll()` now runs a bounded overview query (`OVERVIEW_QUERY`) and every surface
   that counts it says the count is a probe, not a total.
2. **A refused scope fails the whole recall** — `--scope infra` → HTTP 404,
   `--scope mission:x` → "Memory scope not permitted", both exit 1. Defaults stay
   `["project"]`; the test double now refuses the same way.
3. **`--json` does not exist** and `--version` is unsupported; `doctor` takes no flags.
   Guidance text must not tell operators to run `herdr-memory doctor --json`.
4. **Normalised rows differ from raw rows** — the CLI returns both `data.results[]` (raw)
   and `results[]` (contract-normalised). Pi reads `results` only.
5. **A healthy call takes 0.4–4.9 s**, longer than a turn may stall in front of a human.
   That is what the budgets below are built around: wait 1.2 s interactively (5 s
   headless), use a late answer in the same turn if it arrives, and tell the model when
   the turn got nothing.

## Fixed: automatic recall never reached the model (2026-11-04)

In real `pi -p -nt -ne -e extensions/index.ts --no-session` sessions with
`PI_HINDSIGHT_ENABLED=1` and a wrapper CLI pinning `--project canary --harness pi`, the
model answered as though the bank were empty. A trace observer on `session_start`,
`before_agent_start` and `context` showed why:

```
{"ev":"before_agent_start:search-error","code":"timeout","message":"Hindsight memory timeout"}
{"ev":"context","n":2,"roles":["user"],"memoryBytes":0}
```

Root causes, all in `src/blackhole/interactiveMemory.ts`:

1. `automatic()` raced every lookup against **250 ms** while the measured client takes
   **390–4900 ms**. Automatic recall could therefore only ever time out.
2. The once-per-session readiness check shared that same race, so the status line
   reported "timed out" for a healthy service.
3. A timed-out read left `recalled` empty and the `context` hook injected nothing:
   the model saw silence and reported "no records", which is a different claim from
   "the bank could not be read".

The fix:

- `AUTOMATIC_LOOKUP_MS` is 1200 ms (still overridable with
  `PI_HINDSIGHT_AUTOMATIC_MS`, clamped 100–5000 ms). A headless run (`pi -p`, no UI) gets
  `HEADLESS_LOOKUP_MS` = 5000 ms and the provider timeout is raised to match, because
  nobody is waiting on a spinner there and its single model call is the only chance to
  carry memory.
- Readiness keeps `READINESS_LOOKUP_MS` = 5000 ms and is no longer raced at 250 ms.
- A result that lands after the in-turn budget is still used: `adopt()` installs it and
  the next `context` emit in the **same turn** carries it. It is fenced by the turn
  counter, the automatic-lookup epoch (explicit commands and new turns retire pending
  work), and the session generation (a closed session must not touch context or UI).
- A turn that gets no memory now says why. `context` injects one custom
  `pi-engineering-memory` message — "Durable memory for this project could not be read
  this turn (…); treat it as unavailable, not empty." — on timeout, refusal and
  backoff-skipped turns. Recall and the notice never appear together.
- A timeout means slow, not refused: the retry backoff after a timeout is 10 s
  (`TIMEOUT_BACKOFF_MS`) instead of the 60 s used for hard failures.

Live proof, same command as the failing runs:

- Default budgets: `context` shows `roles:["custom/pi-engineering-memory","user"]`,
  `memoryBytes:3737`; the answer cites `mem-096e5bef…`, scope `canary-facts`,
  `status verified`, source PR #580, and reproduces the `--project`/`--harness` rule —
  in 4 s total.
- `PI_HINDSIGHT_AUTOMATIC_MS=250` (client forced to miss the budget): the model refuses
  to guess — "durable memory for this project failed to load this turn (memory request
  timed out), and an unavailable memory is not the same as an empty one".

Two tests asserted the old silent-fail contract and now assert the notice:
`test/unit/hindsight-memory.test.ts` ("automatic recall hangs") and
`test/integration/everyday-memory.test.ts` (client loses its credential mid-scenario).
Both still assert that the caller's `messages` array is never mutated.

## Not done

- PR merge for #554 and PR #569 (`docs/handoff-554`) merge: still open, needs explicit
  authorisation. `origin/rebase/retire-openviking` carries the work.
- Write-path (`retain`/`remember`/`correct`/`forget`) has **not** been exercised against
  the live service — only reads. Any live write test must name a throwaway project.
- macOS-only environmental failures remain in `test/integration/blackhole.test.ts` and
  `test/integration/interactive-memory-cache.test.ts`:
  `ARTIFACT INTEGRITY: secure descriptor-relative artifact access requires Linux`
  (`src/artifacts/ArtifactStore.ts`, untouched by this work; they pass on Linux CI).
