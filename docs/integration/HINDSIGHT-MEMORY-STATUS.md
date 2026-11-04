# Hindsight memory integration status (OpenViking retired)

Branch `rebase/retire-openviking`, work tree
`.worktrees/pi-retire`, base commit `4e8834d3` ("WIP: reconcile #554 … tree does NOT
typecheck yet"). Nothing here is committed, pushed, or merged.

## Where it stands

| Surface | State | Evidence |
|---|---|---|
| Pi → `herdr-memory` CLI only (no HTTP, no URL/token in Pi config) | done | `src/blackhole/hindsight.ts`; `test/unit/blackhole.test.ts` "durable module: no HTTP adapter survives" |
| Env/config surface (`PI_HINDSIGHT_*`, scopes `project\|global\|infra\|mission:<id>`) | done | `test/unit/memory-setup.test.ts`, `test/unit/config.test.ts` |
| `/memory`, `/memory setup`, `/remember` | done | `src/blackhole/interactiveMemory.ts`, `test/unit/interactive-memory.test.ts` |
| Recall labelling (untrusted reference data, never instructions) | done | `memoryBlock()` header |
| `/blackhole` status truthfulness | done | `extensions/index.ts` `/blackhole` caveats: `shared-file` counts a local JSONL file; Hindsight rows are an overview probe, not a bank total |
| Typecheck (`npm run typecheck`) | passes | core + scripts |
| Lint (`npx biome check` on touched files) | passes | 27 files, no diagnostics |
| Memory test batch | 115/115 pass | `node --test` over `hindsight-memory`, `interactive-memory`, `memory-setup`, `blackhole`, `telemetry-sink`, `mission-memory`, `engineering-ledger`, `inspector-redaction`, `config`, `hindsight-harness-env`, `integration/everyday-memory` |
| Live client/service round-trip (read-only) | passes | see "Live verification" |
| **Automatic per-turn recall reaching the model in a real session** | **not working** | see "Open defect" |

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
5. **A healthy call takes 0.4–4.9 s**, which no in-turn budget can absorb reliably.

## Open defect (blocking "everyday memory" acceptance)

In four real `pi --no-extensions -e extensions/index.ts --no-tools -p …` sessions with
`PI_HINDSIGHT_ENABLED=1`, `PI_HINDSIGHT_SCOPES=project` and a wrapper CLI, the model
reported no recalled notes; per-turn budgets of 250 ms (default) and
`PI_HINDSIGHT_AUTOMATIC_MS=5000` both produced nothing, while the same
`HindsightDurableMemory.search()` call outside Pi returned 20 rows in ~1 s. No failure
notice was written to `~/.local/state/pi-engineering/memory-notices`, so the turn simply
proceeds with no memory and no explanation — silence where the surface should be explicit.

Fixed during verification (unit tests green, live sessions still show the defect):

- `automatic()` raced against a hard-coded 250 ms while the provider's own timeout was
  5 s, so the once-per-session readiness check always lost the race. Readiness now gets
  `READINESS_LOOKUP_MS` (5 s) and in-turn lookups get `PI_HINDSIGHT_AUTOMATIC_MS`
  (default 250 ms, clamped 100–5000 ms).
- `recallAll()` no longer sends `*`.

Next step: instrument `before_agent_start` → `context` in one real `-p` session (row count,
block length, whether the custom `pi-engineering-memory` message survives into
`event.messages`), then fix the delivery path — or make injection non-blocking (recall
during a turn, inject on the next) and say so in the status line, because a 1–5 s
subprocess cannot be awaited inside a turn at a 250 ms budget.

## Not done

- Commit, push, PR merge: **not authorised, not performed**.
- PR #569 (`docs/handoff-554`) merge: still open, needs explicit authorisation.
- Write-path (`retain`/`remember`/`correct`/`forget`) has **not** been exercised against
  the live service — only reads. Any live write test must name a throwaway project.
- macOS-only environmental failures remain in `test/integration/blackhole.test.ts` and
  `test/integration/interactive-memory-cache.test.ts`:
  `ARTIFACT INTEGRITY: secure descriptor-relative artifact access requires Linux`
  (`src/artifacts/ArtifactStore.ts`, untouched by this work; they pass on Linux CI).
