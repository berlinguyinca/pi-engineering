# E01 — Inventory all existing error sources

- **Status:** PASS (read-only inventory; nothing implemented)
- **Task authority:** `manifests/tasks.json#tasks[id=E01]`, full entry canonicalized → `sha256:5dd2176930904126c7969a734bd0cac49dfece2f3421c40eebcddbc3b68e620e`
- **Task file:** `tasks/07-E01.md` — *"Document actual event paths …; classify what is already emitted and missing. No implementation."*
- **Base (B05 result, approved by operator blanket instruction):** `36cab891c696ff709d09fb2c4066186e5201c5d9`
- **Result commit:** `0cc5b21cb68caacd44bb09cb7a9674c616f02d9b` (parent = `36cab891c696…`, verified by the B05 gate)
- **Handoff:** `E01.handoff.json` — `handoffHash = sha256:2077162a05a98d11dc110bd63c59415aa86b033378843b41934ad18e297bcd89` (0 schema errors, `logs/06`)
- **Next:** `E02` on `nextBaseSha = 0cc5b21cb68caacd44bb09cb7a9674c616f02d9b`

## Deliverable

`docs/specs/harness-reliability-bootstrap/ERROR_SOURCES.md` — **100 lines**, 43 cited rows across seven owners:
`SessionEventStore`, APS supervisor, `IncidentController`/`AutoSpecIncidentSink`, the retry-trace layers,
`PiWorkerExecutor` + activity/transcript, `orchestration/broker` execution evidence, and the host entry point.
Each row gives `file:line`, the single owner, and a status: `D` durable · `E` thrown · `T` transient · `S` swallowed · `X` absent.

Headline findings (all cited in the file):

- **`X` — nothing catches process-level failure.** No `process.on("uncaughtException")` and no
  `process.on("unhandledRejection")` anywhere in `src`; the only `process.on("exit")` handlers
  (`verify/Verifier.ts:59`, `runtime/herdr/portableLock.ts:84`) do cleanup, not error flush.
- **`X` — the supervisor never records an exit code**: `aps/supervisor.ts:215` hardcodes `exit_code: null`.
- **`S` — the failure log can fail silently**: `SessionEventStore.ts:300` and `:336` do
  `appendChain = op.catch(() => undefined)`; `aps/supervisor.ts:200`/`:263` are empty `catch` blocks;
  `PiWorkerExecutor.ts:1770-1771` turns transcript capture off without emitting anything.
- **`T` — every retry/fallback/capacity decision is transient**: `inference/retryTrace.ts:61` emits on the
  telemetry bus only; `lifecycle/telemetry.ts:27-34` and `PiWorkerExecutor.ts:856`/`:1438`/`:1751` likewise.

## Verification (the manifest's verify command is `git diff --check`)

| Command | Exit | Evidence |
| --- | --- | --- |
| `git diff --check` | 0 | `logs/01-verify-git-diff-check.txt` |
| `git diff --numstat HEAD^1 HEAD` (scope/budget) | 0 | `logs/02-scope-and-budget.txt` — **100 insertions, 0 deletions**, 1 file, all inside the manifest's `production` path |
| B05 gate CLI in a clean detached worktree at `0cc5b21c` with `--proofs`/`--handoff-record`/`--emit-handoff` | 0 | `logs/05-cli-accepted.txt` — proofs for `git diff --check`, diff scope over `HEAD^1..HEAD`, `HEAD^1 == baseSha`, handoff written |
| Handoff hash recomputation + schema validation | — | `logs/06-handoff-hash-and-schema.txt` — hash MATCHes, **0 schema errors** |

## Deviations & corrections (recorded, not hidden)

1. **Two handoff-record attempts violated `templates/handoff.schema.json`** (`schemaVersion` instead of
   `specVersion`, `status: "complete"` outside the `PASS|ALREADY_SATISFIED|BLOCKED` enum, object-shaped
   `changedFiles`/`evidence`, `commands[].command`/`outputArtifact` missing, `operatorApproval.approved` missing).
   The tool **stamps** handoffs but does **not validate** them, so the non-conformant records were written before
   validation caught them — see `logs/03`, `logs/04`; the conformant record produced `logs/06`.
   **Protocol gap for E02+:** `writeHandoff` must validate against the schema (or the CLI must) before writing.
2. **The first E01 commit message quoted an authority hash that had not been computed**
   (`sha256:79a29d1a…` — invented). It was replaced by the computed value `sha256:5dd2176930904126c7969a734bd0cac49dfece2f3421c40eebcddbc3b68e620e`
   (amended; the tree is unchanged, only the message). The convention — canonical hash of the **full**
   manifest task entry — was confirmed by reproducing B04's and B05's `taskAuthorityHash` exactly.
3. **`taskAuthorityHash` has no written computation rule.** `templates/handoff.schema.json` requires the field
   (`type: string`) and no doc in the spec directory defines how to derive it. The full-entry canonical-JSON
   convention (matching B04/B05) is now in use and must be frozen into the protocol by a later task.
4. **Plan-phase noise (carried from B05):** the accepted run still prints the pre-task baseline line; the
   accepted line names the four gate conditions, so `logs/05` reads correctly.
