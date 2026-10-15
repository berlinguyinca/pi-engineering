# pi-engineering audit for the Pi + AutoSpec autonomous delivery plan

- **Audited commit:** `dcb86b1` (pi-engineering `main` on 2026-10-14, after #162, #163, #165 and #166 merged)
- **Spec baseline:** `0b3e79e`, the SHA the design spec (section 3) audited. Every row below was re-checked at `dcb86b1`; the "Change since spec" column says where the code moved.
- **Source spec:** `docs/specs/2026-10-14-pi-autospec-autonomous-delivery-design.md` in `berlinguyinca/autospec`, section 3 (audit baseline), section 5 (requirements), section 6 (task DAG).
- **Legend:** `EX` existing, `PA` partial, `MI` missing, `CO` conflicting. Evidence is `path:line` at the audited commit. Lines drift; the statement next to each one is what was checked.

Rows about other repositories (autospec, autospec-orchestrator, autospec-dispatcher, autospec-db, autospec-gui, InferWeave, HerdR Engineering) are not re-verified here; they stay in the spec and are out of this repository's reach.

## 1. pi-engineering items (spec section 3)

| Item | Status | Evidence at `dcb86b1` | Change since spec |
|---|---|---|---|
| Mission state machine | EX | `src/orchestration/state.ts:14` first state is `NEW` (`NEW: ["CLASSIFYING"]`); no `RECEIVED` mission state (the only `RECEIVED` is a separate run state, `src/lifecycle/controller.ts:179`); pause is a stop reason, not a state | none |
| Ownership leases with monotonic fencing token | EX, session-scoped | `src/orchestration/ownership.ts:194` (mission lease) and `:254` (repository lease) increment `fencingToken`; `:365` rejects a stale epoch; the owner id is minted per session, `src/runtime/EngineeringRuntime.ts:917` (`session-${session.sessionId}-${randomUUID()}`) | none |
| Routing, fallback, circuit breaker | EX | `src/resilience/circuitBreaker.ts`, `src/resilience/retryWindow.ts`, `src/runtime/modelRouting.ts`, model takeover covered by `test/unit/orchestration-model-takeover.test.ts` | takeover reviewer selection is now family-aware (`src/orchestration/realBackends.ts:666`) |
| Stall and heartbeat detection | EX | `src/resilience/watchdog.ts:49` `classifyStall` returns `heartbeat_lost`, `inference_stalled` or `tool_stalled`; supervisor in `src/orchestration/supervisor.ts` | none. Not progress based for test processes (see R-WATCH, issues #146 to #149) |
| Intent router | PA | `src/orchestration/intentRouter.ts:25` `INTENT_SIGNATURES`: regex signatures for 12 intents mapping onto 10 workflow classes (`src/orchestration/types.ts:48`); no `autospec` or `mission` mode; no `PI_AUTOSPEC_*` or `PI_MISSION_DEPTH` anywhere in `src/` or `extensions/` | none |
| `AutoSpecAdapter` seam | CO | `src/adapters/Adapters.ts:12` interface exists and is exported (`src/index.ts:83`) but nothing implements or calls it in the submit direction | none |
| External submit/cancel entry point | PA | `scripts/pi-engineering.ts:36` exposes `missions list` and `missions cancel` (`src/orchestration/missionCancelCli.ts:96`); there is no submit, observe or JSON entry usable under fencing | spec said MI; the local cancel/list CLI exists, submit does not |
| Recursion guard | PA, structural only | `src/workers/PiWorkerExecutor.ts:109` worker sessions load no extensions (`getExtensions: () => ({ extensions: [], ...})`); no depth counter or refusal | none |
| Verifier failure baseline | **EX** | `src/verify/failureBaseline.ts` (`captureBaseline`, `compareToBaseline`, `failureIds`); `src/verify/Verifier.ts:286` `VerifyRunOptions` and `:282` `baselineVerdict`; tests `test/unit/verify-failure-baseline.test.ts` (10 tests, real git fixtures) | **was MI**; closed by #133 (PR #165, `e0bb00e`). Not yet wired into the merge path (T26) |
| Reviewer independence by model family | **EX** | `src/capability/modelRecord.ts:84` `sameFamily`, `src/orchestration/realBackends.ts:135` and `:666` family-aware reviewer choice, `src/cav/routing.ts:44` `assertReviewerDistinct`; tests `test/unit/review-family-independence.test.ts` | **was exact-id equality**; closed by #152 (PR #166, `dcb86b1`) |
| Tool registry | PA | `src/tools/coreTools.ts` registers 7 tools: `ledger_read:80`, `ledger_claim:157`, `artifact_read:206`, `repo_search:260`, `symbol:285`, `tests_for:309`, `mission:333` | none |
| ContextBroker cache | PA | `src/context/ContextBroker.ts:71` class has no cache of any kind (no occurrence of `cache` in the file) | none |
| Cleanup | PA | journaled branch cleanup exists: `src/git/GitRepo.ts:174` state machine `intent -> worktree_removed -> branch_deleted`; no other owned resource is journaled | none |
| Owned-resource registry | MI | no `ResourceRecord` type or registry anywhere in `src/` (searched `ResourceRecord`) | none |
| `npm test` health | **EX, was unverified** | `npm test` exits 0: 3650 tests, 3649 pass, 0 fail, 1 skipped, 171 s wall-clock on a loaded shared host (PR #163 body). Two fixes were needed beyond the two files the spec named: the `orchestrator-recovery` livelock (#160, `src/orchestration/scheduler.ts`) and two isolation tests broken by queued custody waits (#126) | spec said "incomplete, treat as unverified" |
| Snapshot contract (producer side) | EX | `src/orchestration/missionSnapshot.ts:17` `MISSION_SNAPSHOT_CONTRACT_VERSION = 3`, emitted at `:335` | none. Consumer side: see `CONTRACT_GAPS.md` |
| Capability vocabulary | CO | `src/capability/modelRecord.ts:17` `tool_calling`, `:21` `fast`, `:22` `low_cost`; the gateway side (`tool_use`, `coding.*`) is carried from the spec | none |
| InferWeave session header | MI | no `x-inferweave-session` in `src/`; response metadata is read in `src/inference/inferweaveMetadata.ts:58` (any `x-inferweave-*` header), but `x_capabilities`, `x_family`, `x_tools` are not read | none |
| Hard-coded legacy model names in CAV routing | CO | `src/cav/routing.ts:22` to `:31` `DEFAULT_ROUTES` names `deepseek-v4-flash`, `qwen3.8-flash-next`, `qwen3.8-27b`, `qwen3.8-27b-vision` directly | none (issue #157) |
| Pi version pin | PA | `package.json:45` to `:48` pins `@earendil-works/*` 0.87.1; compatibility checks read `minimumPiVersion` / `maximumPiVersion` (`src/runtime/host/extension.ts:901`, `src/update/validate.ts:209`) | none |

## 2. Rows carried from the spec, not re-verified here

| Item | Status per spec | Why not re-checked |
|---|---|---|
| pi-engineering-web rejects snapshot v3 (`index.ts:94`) | CO | lives in `pi-engineering-web`; this repo can only confirm the producer side above |
| autospec, autospec-dispatcher, autospec-orchestrator, autospec-db, autospec-gui, InferWeave, HerdR Engineering rows | as in spec section 3 | other repositories |

## 3. Not changed by this document

This is documentation only. No source file was touched by the audit.
