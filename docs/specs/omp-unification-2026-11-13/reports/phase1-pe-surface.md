# Phase 1: Pi Engineering actual surface (read-only scout)

Repo: berlinguyinca/pi-engineering @ 5ab85965 (worktree wt-phase1-audit). LOC = `cat *.ts | wc -l` per dir (approx, src only). Nothing was run. UNKNOWN = not verified.

## 1. Package, entry, host loading
| Item | Evidence |
|---|---|
| Name/version | `pi-engineering-runtime` 0.2.0, ESM, node >=22.18 <26 (package.json) |
| Pi deps | peerDeps `@earendil-works/pi-{agent-core,ai,coding-agent,tui}` = `*`, `typebox` `*`; devDeps pinned 0.87.1; `piEngineering.minimumPiVersion` 0.87.0, max `1.x` |
| Runtime deps | axe-core ^4.13, playwright ^1.63, pngjs ^7, yaml ^2.9 (no sqlite npm dep: `src/runtime/isolation/sqlite.ts` wraps node's built-in sqlite, UNKNOWN exact module) |
| Extension entry | `package.json pi.extensions = ["./src/runtime/host/entry.ts"]` |
| Load chain | entry.ts (tiny shim, no package imports) -> dynamic import `src/runtime/host/extension.ts` (RuntimeHost, registers `/engineering`, lifecycle handlers, self-update/hot-reload) -> `runtimeEntry.ts` (`createRuntime`, `ExtensionGenerationRuntime`) -> wraps legacy factory `extensions/index.ts` (3398 LOC, registers all other commands/tools/handlers). |
| Fallback | If Host import/install throws: shim undoes tracked `pi.on` registrations (Proxy `tracking()`), sets `Symbol.for("pi-engineering.host-fallback.v1")`, loads `extensions/index.ts` directly (no hot reload / self-update). Shim also registers `/diagnose-errors` (read-only). |
| Hot reload | `host/loader.ts`: each runtime generation imported from an immutable snapshot dir (`?generation=` does not re-evaluate relative imports). `REQUIRED_COMMANDS = engineer, mission, plan, execute, verify, review`; `REQUIRED_TOOLS = ledger_read` (runtimeEntry.ts:39-41). |
| bin | `pi-engineering` -> `scripts/pi-engineering.ts` |
| Public exports | `./src/index.ts`; snapshot `test/fixtures/public-exports.txt` |

## 2. src/ module map (dir -> responsibility, LOC/files)
| Dir | LOC/f | Responsibility |
|---|---|---|
| orchestration | 38983/78 | Missions: orchestrator.ts (5196), missionStore, scheduler, broker, completionGate, supervisor, recovery, intentRouter, steering, lanes, forks, externalEntry/Admission/Supervision, handoffDriver, planReview, observability/ |
| runtime | 25612/92 | EngineeringRuntime.ts (4571; facade: engineer/plan/tournament/verify/review), host/ (entry, extension, loader, piBridge, contract), isolation/ (registry, leases, custody, recovery), herdr/ (room/fork/envelope/outbox/steering), migrations/ |
| git | 9640/16 | GitRepo.ts (3615; worktrees, diff, merge), safeGit.ts (2338; allow-list git config), worktreeJanitor, worktreeSafety, ownerMarker, trashStore, rustBuildCache |
| inference | 8232/29 | InferWeave admission-retry transport/parser/policy (optional adapter) |
| uieng | 7646/13 | UI engineering / own TournamentRunner (`uieng/tournament.ts:228`), rollout, web |
| plannerWorker | 6807/25 | planner/worker split: mode.ts, roles.ts, resolver, contract DAG, handoff, sessionHandoff, extension.ts (`/engineering-mode|status|plan|workers`, `/handoff`) |
| lifecycle | 6503/18 | LifecycleController/harness (auto pass on `agent_settled`), gate.ts, destructive.ts, vision, roleRunner |
| gateway | 6004/21 | AdmissionController, stream retry, settleRecovery, advisedSwitch, fallback, afterOutputRetry |
| workers | 5688/20 | PiWorkerExecutor (Pi SDK sessions), prompts, worker_result tool, worktree file tools, quarantinedBash, budgets |
| platform | 4947/21 | ControlPlane, WorkGraph, eventstore/ (jsonl backend, fileLock), McpRegistry, memoryOutbox, review, remote worker |
| verify | 3526/18 | Verifier.ts (CommandVerifier), farm/ (Adversarial, Differential, Mutation, Performance, PropertyTest, TestImpact), baseline/quarantine/cache |
| cav | 3244/28 | CAV (verification runs, vision; spec dir docs/specs/cav) |
| guard | 3403/9 | primaryWorktreeGuard (1093), toolCallGuard, GenerationGuard, RecoveryController, transient |
| taskDiscipline | 3080/8 | task-discipline hook (`tool_call`, `user_bash`) |
| models | 3000/12 | model catalog/sync, `/models` tabs UI |
| blackhole | 2984/19 | Memory: Hindsight provider (herdr-memory CLI), interactive `/remember` `/memory`, promotion, durable provider |
| github 2939 / status 2779 / resilience 2812 / update 3535 / aps 2224 / context 2159 / capability 1925 / integrations 1945 (autospec/) / vision 1924 / visionDelegation 1817 / incidents 1941 / artifacts 1762 / work 1706 / request 1681 / roadmap 1645 / sessionControl 1570 / tools 1134 / ledger 1794 / merge 1318 / bar 1267 / resources 996 / benchmark 993 / bootstrap 913 / adapters 780 / compaction 760 / panel 592 / core 439 / others <300 | | self-descriptive names; ledger = event store+Ledger; artifacts = ArtifactStore; context = ContextBroker; capability = router/registry; compaction/autoTune.ts = compaction tuning |
Total src ~ 190k LOC (sum above). extensions/index.ts 3398 LOC.

## 3. Ledger, custody, leases, safety, recovery
| Topic | Facts | Evidence |
|---|---|---|
| Ledger storage | Append-only JSONL `<repoRoot>/.pi-eng/ledger.jsonl`, replayed to in-memory view on open; cross-process lockfile `<file>.lock`; torn-tail tolerant | docs/architecture.md "Durable state"; src/ledger/EventStore.ts (248), Ledger.ts (922), fileLock.ts |
| Event envelope | `LedgerEvent{event_id, schema_version?(2 when EventMeta), work_item_id, timestamp, actor, type, payload}`; EventMeta: task_id, session_id, run_id, correlation_id, causation_id, idempotency_key, authority_generation | src/core/types.ts:87-96 and EventMeta |
| Event types (EventType union, partial) | candidate.created/changed/promoted, work_item.updated, entity.updated, evidence.recorded, verification.started/completed, review.started/completed, requirement/invariant/test-obligation.created, artifact.created, budget.warning/exhausted, merge.requested/completed, context.package.assembled, blackhole.* (lifecycle, package.validated, session.opened/closed, memory_worker, compacted, promotion.proposed/decided, recalled) | core/types.ts:40-62 (head of union at lines <40 not read: UNKNOWN) |
| Authority fencing (ledger) | `claimAuthorityGeneration(ledgerFile, floor)`: persisted strictly increasing epoch in `<ledger>.generation`; append with lower `authority_generation` than recorded -> `LedgerAuthorityStaleError`, event not written | src/ledger/authority.ts, core/types.ts EventMeta, ledger/errors.ts |
| Idempotency | second append with same `idempotency_key` returns first event | core/types.ts EventMeta |
| Claims vs evidence | `ledger_claim` resolves artifact/evidence ids; hypotheses never auto-promoted (INV-006/008) | docs/architecture.md; src/ledger/claimDiscipline.ts, citations.ts |
| State schema versioning | `.pi-eng/state-schema.json`; absent = baseline 1; runtime declares minReadable/maxReadable/writes = 1/1/1 (package.json `piEngineering.stateSchema`, `RUNTIME_STATE_SCHEMA`); migration framework: inspect -> plan -> dry-run on copy -> checkpoint -> migrate -> rollback; no migrations registered beyond framework: UNKNOWN | src/runtime/migrations/{schema,framework,index}.ts |
| Mission/orchestration events | per-session JSONL `<state>/worktrees/<worktree-id>/events/<session-id>.jsonl`, merged by timestamp via `SessionEventStore`; legacy `.pi-eng/orchestration.jsonl` imported read-only as `events/legacy-<hash>.jsonl`; mission events include lease.acquired/renewed/expired/fenced, lane.released, candidate/mission/resumption generation fields | docs/architecture.md; src/orchestration/missionStore.ts:143-146,329-331; runtime/isolation/SessionEventStore.ts, legacyMigration.ts |
| State dir | `$XDG_STATE_HOME/pi-engineering` (default `~/.local/state/pi-engineering`), override `PI_ENGINEERING_STATE_DIR`; `PI_ENGINEERING_ORCHESTRATION_DIR` relocates namespace | architecture.md; isolation/stateDir.ts |
| Custody registry (SQLite) | `registry.db` WAL+busy_timeout, tables `meta`, `sessions` (pid, boot id, proc start time, binding, heartbeat, state, generation_id), `leases`, `bindings`; must be on local FS | src/runtime/isolation/RuntimeRegistry.ts:61-93; sqlite.ts; fsType.ts |
| Leases/fencing | Every acquisition gets fresh `generation_id`; renew/release conditional on generation (no ABA); reclaim needs proof holder gone (dead PID, reused PID via start-time mismatch, reboot, dead row) or expiry when unverifiable; stale generation cannot release at shutdown; live matching incarnation keeps custody even if TTL old | isolation/LeaseManager.ts (260 LOC header), RuntimeRegistry.heartbeat/rebind (generation-conditional UPDATEs), docs/architecture.md |
| Mission custody | resources `mission:<id>` / `repository:<repoId>`; one live session acts on a mission, all see all; `claim` returns holder, never throws; `retainForReload` for hot reload | isolation/MissionCustody.ts, reloadCustody.ts |
| Recovery | startup reconcile (idempotent): orphan dead sessions, reclaim leases, quarantine+truncate torn JSONL tail into `recovery/`, prune ended sessions; doctor `--repair` reuses; quarantined evidence never auto-deleted | isolation/RecoveryManager.ts, leaseReconcile.ts, jsonlFiles.ts, doctor.ts; guard/RecoveryController.ts; orchestration/recovery.ts, supervisor.ts |
| Worktree safety | candidates in git worktree on own branch at incumbent base; controlled `merge --no-ff`, conflicting merge aborted; worker allocation (root, shared git dir, branch) verified before inference; `isolatedWorktree` write/edit reject outside root incl. symlinks; all Pi-spawned git via `safeGit` (generated allow-list config; refuses --git-dir/--work-tree; guarded by `test/unit/safe-git-callers.test.ts`); `withoutInjectedConfig` strips GIT_DIR etc.; primary-worktree guard blocks session mutations of primary checkout (`PI_ENG_PRIMARY=1` bypass); janitor never deletes (moves to trash), only `pi-eng-candidate-*`/`pi-eng-orch-*` branches with `pi-eng-owner.json` marker and COMPLETE/CANCELED missions; worktreeSafety keeps worktrees with ignored non-derived files; empty/reverted diffs cannot count as `completed` | docs/architecture.md "Candidate isolation"; AGENTS.md; git/GitRepo.ts, safeGit.ts, worktreeSafety.ts, worktreeJanitor.ts, ownerMarker.ts; guard/primaryWorktreeGuard.ts |

## 4. Pi API touchpoints (every import from @earendil-works/pi-*)
| Package/symbol | Where |
|---|---|
| pi-coding-agent `ExtensionAPI` (type; `pi.registerCommand/registerTool/registerProvider/on`), `ExtensionCommandContext`, `ExtensionContext`, `ContextEvent`, `ToolCallEventResult`, `UserBashEventResult`, `AgentSessionEvent`, `Theme`, `ReadonlyFooterDataProvider` | ~40 files: extensions/index.ts, runtime/host/{entry,extension,host,piBridge,contract,runtimeEntry}, plannerWorker/{extension,sessionHandoff}, lifecycle/{harness,reviewResultTool}, taskDiscipline/{hook,worker}, compaction/autoTune, models/registerModelTabs, status/footer, blackhole/interactiveMemory, gateway/{launcherLinks,terminalRefusalGuard,sessionAutoResume}, capability/{adapter,discovery}, tools/coreTools, update/probe, cav/vision, aps/workerActivity, runtime/herdr/{InspectorFeed,attachInspector,lineageConfig}, request/{thinkingPolicy,bodyBudget} |
| pi-coding-agent runtime: `createAgentSession`, `SessionManager`, `SettingsManager`, `ModelRuntime` (create, registerProvider, available models), `createBashToolDefinition`, `createExtensionRuntime`, `ResourceLoader`, `LoadExtensionsResult`, `ToolDefinition`, `defineTool`, `getShellConfig`, `BashOperations`, `getAgentDir`, `VERSION`, `estimateTokens`, `buildSessionProjection`/`SessionEntry` | workers/PiWorkerExecutor.ts (createAgentSession at :1677), workers/{localProviders,quarantinedBash,worktreeFileTools,tolerantFileTools,workerResultTool,checkpointProgressTool,claimDeliverableTool,requestBodyGuard,wallClockBudget}, inference/resilientInstall.ts, tools/coreTools.ts, update/probe.ts, host/piBridge.ts |
| pi-ai/compat: `Model` (type), `getApiProvider`, `isContextOverflow`, `isRetryableAssistantError` (+ others at admissionTransport.ts:30) | inference/admissionTransport.ts, gateway/{afterOutputRetry,settleRecovery,advisedPicker,advisedSwitch,fallbackLifecycle}, runtime/EngineeringRuntime.ts, workers/PiWorkerExecutor.ts |
| pi-ai (root): `createAssistantMessageEventStream` | extensions/index.ts:4 |
| pi-agent-core: `AgentMessage` (type) | plannerWorker/sessionHandoff.ts:20 |
| pi-tui: `AutocompleteItem` (type), `Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth` | runtime/host/{piBridge,completions,extension}, models/modelTabsComponent.ts, status/{footer,layout}.ts |
| Pi events subscribed (`pi.on`) | session_start/shutdown, session_before_{compact,switch,fork,tree}, session_compact(_failed), model_select, before_agent_start, agent_start, agent_settled, agent_before_settle, message_start/update/end, turn_end, context, input, tool_call, tool_result, user_bash, tool_execution_start/update/end, before_provider_request, after_provider_response |
| Pi provider seam | `registerProvider(id,{api,streamSimple})` used to wrap streams (gateway/installStreamRetry.ts, inference/admissionInstall.ts, context/provider.ts) |
| PiBridge | `runtime/host/piBridge.ts`: proxies ExtensionAPI for hot-reload generations; stubs list registerShortcut/Flag/MessageRenderer/Provider/unregisterProvider |
Coupling note: Pi internals are accessed loosely (`as never`, `as unknown as`) at several seams (e.g. `ctx.modelRegistry.getProviderAuth`); these will break first on an API change.

## 5. Orchestration: planner/worker, local/offline
| Item | Evidence |
|---|---|
| Worker = fresh in-process Pi SDK session via `createAgentSession`, role prompt, restricted tools, budget; terminating tool `worker_result` (or `review_result`); `FakeWorkerExecutor` for tests | workers/PiWorkerExecutor.ts:1677,1692; workers/prompts.ts (roles planner/scout/implementer/debugger/reviewer/summarizer; `MUTATING_ROLES`, `REVIEW_FAMILY_ROLES`) |
| WorkerResult | `{status, summary, claims[{claim,evidence}], evidence_refs, new_hypotheses, proposed_tasks}` | architecture.md |
| Mission pipeline | IntentRouter, MissionStore, Scheduler, Broker, CompletionGate, Orchestrator (orchestrator.ts 5196) | architecture.md Components; src/orchestration/ |
| Planner/worker split | `/engineering-mode auto|planner-worker|single`; `chooseExecutionMode`: auto -> planner-worker only if nontrivial goal AND gateway advertises role capabilities AND distinct planner/implementer models; else `single` | plannerWorker/mode.ts, roles.ts, resolver.ts, contract.ts |
| One-model / local mode | Spec 8.6 + INV-013/014: single model degrades to fresh sessions + context firewall; local Ollama/llama.cpp nodes from `~/.pi/agent/qwen-nodes.json` registered by `registerLocalProviders` (no live /models discovery; holds out no-tool_calls nodes unless `QWEN_ALLOW_NO_TOOLS=1`); `.pi/engineering.yaml` role pins (planner/implementer/reviewer on local qwen; auto routing falls back) | workers/localProviders.ts; docs spec v2 8.6; .pi/engineering.yaml; capability/router.ts |
| Model routing | `RoleRouter` (capability, availability, observed perf, cost, overrides, fallback); policy layers: defaults < ~/.pi/agent/engineering.yaml < repo .pi/engineering.yaml < env PI_ENGINEERING_POLICY | capability/{registry,router}.ts; .pi/engineering.yaml header |
| Separation of duties | INV-007; reviewer fresh session | spec v2 INV-007 |
| Loop/stall guards | APS (src/aps), toolLoopGuard, streamStall, wallClockBudget | workers/, aps/ |

## 6. Commands, tools (definition sites)
| Command | Defined | Behavior |
|---|---|---|
| /engineer <goal> | extensions/index.ts:3059 -> `EngineeringRuntime.engineer` (EngineeringRuntime.ts:4337) | risk classify -> bounded context -> scout (medium+) -> loop(isolated candidate worktree -> implementer -> verify -> reviewer; failed verify spawns child candidate) -> controlled merge+promote; returns EngineerReport |
| /tournament <goal> [n] [--parallel] | index.ts:3080 -> `tournament()` EngineeringRuntime.ts:3807 (`runTournamentCandidate` :3693) | N independent candidates (default 3), verify+review each, deterministic winner promoted |
| /plan <goal> | index.ts:3113 -> `plan()` :4009 | planner worker emits dependency-aware task DAG recorded in ledger |
| /execute [plan-id] | index.ts:3141 | runs DAG in dependency order, each task via engineer pipeline |
| /verify [full] | index.ts:3203 -> `verifier.detect/run` | risk-appropriate profile, records evidence to ledger; `full` = lint + test:full |
| /review | index.ts:3248 -> `rt.review` (:3487) | fresh-context reviewer of latest work item's candidate |
| Others in extensions/index.ts | mission, mission-status, room, work, summary, task, team, ledger, context, challenge, blackhole, roadmap-status, harness-status, pi-engineering, gc, update, model-refresh/refresh-models/model-sync, engineering-model, gateway, iw-context |
| Elsewhere | /engineering (host/entry.ts:203, extension.ts), /diagnose-errors (entry.ts:147), /engineering-{mode,status,plan,workers}, /handoff (plannerWorker/extension.ts), /models (models/registerModelTabs.ts), /remember, /memory (blackhole/interactiveMemory.ts) |
| Tools (tools/coreTools.ts) | ledger_read, ledger_claim, ledger_evidence, artifact_read, repo_search, symbol, tests_for, mission; worker-only: worker_result, review_result, checkpoint_progress, claim_deliverable |

## 7. Verification, tournament, review, memory, context
| Area | Facts | Evidence |
|---|---|---|
| Deterministic verify | `CommandVerifier.detect(cwd)` reads package.json (and Rust/nextest etc.) -> profile typecheck/test/build (+syntax-check fallback); each stage logged as artifact; inactivity guard 15 min; baseline subtraction, quarantine, result caches; `VerificationProvider` abstraction | verify/Verifier.ts (DEFAULT_STAGE_INACTIVITY_MS :40, interfaces :348-470); verify/*.ts |
| Verification farm | Adversarial, Differential, Mutation, Performance, PropertyTest, TestImpact | verify/farm/ |
| Tournament | candidates + hard gates + objective ranking; two impls: EngineeringRuntime.tournament and uieng/tournament.ts TournamentRunner | spec v2 s14; EngineeringRuntime.ts:3807 |
| Independent review | fresh reviewer session; `review_result` tool; reviewer context cap 48k chars; planner-worker review.ts; orchestration/reviewGuard.ts, planReview.ts | workers/prompts.ts:144; plannerWorker/review.ts |
| Completion gate | harness-owned; parent model cannot self-declare success | lifecycle/gate.ts; orchestration/completionGate.ts |
| Merge | MergeQueue, mergeGate, postMerge smoke, protectionDrift | src/merge/ |
| Hindsight | `herdr-memory` CLI contract v1 (recall/retain/correct/forget, one JSON on stdout); config only via YAML `memory.hindsight` in engineering.yaml (no env vars); results labeled untrusted; all read failures degrade to no memory; secrets redacted on write; optional (INV-013) | blackhole/hindsight.ts, hindsightSettings.ts, durableProvider.ts, interactiveMemory.ts; docs/integration/HINDSIGHT-MEMORY-STATUS.md |
| Platform memory outbox | platform/memoryOutbox.ts (UNKNOWN details) | |
| Context mgmt | ContextBroker (repo map + `git grep -E`, symbol retrieval, budgets per role); context/provider (Pi dynamic provider); compaction/autoTune.ts (hooks session_start, model_select, session_compact, turn_end, session_before_compact); plannerWorker/sessionHandoff + handoffProtocol (bounded HandoffArtifact, no transcripts, INV-009); orchestration/phaseBoundaryHandoff, contextHandoffTrigger; InferWeave context (iw-context) | AGENTS.md "Context Discipline"; context/*.ts; compaction/autoTune.ts |

## 8. Skills / prompts / instructions inventory
| Kind | Finding |
|---|---|
| SKILL.md | none tracked (confirmed by find outside node_modules: none) |
| Pi resources | `package.json` has no `pi.skills`/`pi.prompts` keys; only `pi.extensions`. `src/resources/` is buildBudget/buildGc/ResourceRegistry (disk resource accounting, not Pi skills) |
| Prompt templates | in code: `src/workers/prompts.ts` (149 LOC role prompts, CLAIM_DISCIPLINE, WORKER_KICKOFF), `src/plannerWorker/prompts.ts` (37 LOC); further prompts inline in lifecycle/, orchestration/ (UNKNOWN count) |
| Instruction files | AGENTS.md (240 lines, autonomous policy), README.md, PI_BOOTSTRAP.md, PI_NEXT_MILESTONE.md, PI_VALIDATE_AND_DOGFOOD.md, IMPLEMENTATION_PROMPT.md, `.pi/engineering.yaml`, `docs/specs/pi-engineering/prompts/IMPLEMENT.md`, `.spec-impl/pi-engineering-implementation-spec-2026-09-15/{prompts/IMPLEMENT.md,MASTER_SPEC.md,specs/01..18}` (tracked), `.superpowers/sdd/*` reports |
| Extensions dir | `extensions/index.ts` only (legacy factory; the real command/tool registrar) |
| Docs | docs/{architecture,usage,orchestration,ROADMAP,inference-admission-retry,...}.md; docs/specs/* (spec v2 3094 lines; INV-001..016 at lines 205-272); docs/operations/ci.md |

## 9. Tests and scripts (not run)
| Layer | Location / script |
|---|---|
| Unit | test/unit (588 files); `npm run test:unit` |
| Integration | test/integration (170 files; names like extension-mission-commands, gateway-*, git-worktree-concurrency, gate-*); `npm run test:integration` |
| `npm test` | unit + integration, `node --test`, concurrency 4, timeout 600s, `--import ./test/support/isolatedState.ts` (state isolation) |
| E2E | test/e2e (9 files s1..s7, smoke-plane, acceptance.yaml, fake_gh_*); `npm run test:e2e` = `scripts/smoke-commands.ts` + `smoke-load.ts` (note: the s*.e2e tests are not matched by npm test globs; invoked how: UNKNOWN) |
| Smoke | scripts/smoke-{commands,load,engineer,extension,installed,worker}.ts |
| Platform | `npm run test:platform` (test/unit/platform-*.test.ts, 11 unit + 3 integration), `platform:e2e`, `platform:serve` |
| Other | `test:mission-reliability`, `test:roadmap`, `test:dogfood:lifecycle`, `dogfood:mission-recovery`, `bench:planner-worker`, `roadmap:check|structural|status` |
| Quality | `lint` = biome check; `typecheck` = tsc core + scripts; `build` = typecheck. Fixtures: test/fixtures (herdr-memory-stub.sh, mission-snapshot-v3/v4 golden, public-exports.txt) |
| CI | `.woodpecker/ci.yaml` (lint, typecheck, unit, integration, structural roadmap) and `release-gate.yaml` (full roadmap check on release/* tags). No .github dir (docs/operations/ci.md: UNKNOWN content). Coverage gate 80%: UNKNOWN (no coverage script in package.json) |

## 10. Invariants: MUST NOT change in unification
| # | Invariant | Evidence |
|---|---|---|
| I1 | Ledger is append-only JSONL, replay-built; events immutable; transcript-independent (INV-001/012) | EventStore.ts, spec INV-001/012 |
| I2 | LedgerEvent envelope + `schema_version` additive-only; old lines replay unchanged; state schema marker 1/1/1 and migration framework (dry-run, checkpoint, rollback) | core/types.ts EventMeta; migrations/framework.ts |
| I3 | `authority_generation` fence: lower generation rejected with LedgerAuthorityStaleError; counter file monotonic, floor from log | ledger/authority.ts |
| I4 | `idempotency_key` dedupe at append, evaluated under the cross-process lock against true log tail | EventStore.ts header |
| I5 | Custody/leases: SQLite registry, fresh generation_id per acquisition, generation-conditional renew/release, reclaim only on proof of death or expiry for unverifiable holder, no resurrection of stale generation; registry on local FS | LeaseManager.ts, RuntimeRegistry.ts |
| I6 | One live session acts per mission; all sessions read all (per-session event streams merged by timestamp) | MissionCustody.ts, SessionEventStore.ts |
| I7 | Recovery never deletes evidence: quarantine torn tails, legacy log imported not modified | RecoveryManager.ts, legacyMigration.ts |
| I8 | Candidate isolation + immutable incumbent: worktree per candidate, `merge --no-ff` by runtime only, conflict aborts without mutating incumbent; allocation verified before inference (INV-003/004) | architecture.md |
| I9 | All git via `safeGit` (generated allow-list config, no --git-dir/--work-tree, env filtered by withoutInjectedConfig); test enforces callers | safeGit.ts, test/unit/safe-git-callers.test.ts |
| I10 | Primary-worktree guard blocks session mutations of primary checkouts; janitor never deletes (trash), only marked pi-eng-* worktrees of terminal missions, preserves ignored non-derived files | primaryWorktreeGuard.ts, worktreeJanitor.ts, worktreeSafety.ts |
| I11 | Evidence before promotion; claims are not evidence; hypotheses never silently facts (INV-005/006/008); parent cannot self-declare completion | spec; lifecycle/gate.ts |
| I12 | Separation of duties + fresh workers + bounded context (INV-002/007/009) | spec |
| I13 | Standalone core: no hard dependency on AutoSpec, InferWeave, GitHub, cluster, multi-model, or Hindsight; degrade to sequential single-model (INV-013/014) | AGENTS.md Scope; spec |
| I14 | Host shim stays import-free and falls back to legacy extension; hot-reload generation contract (`runtimeApi` 1, REQUIRED_COMMANDS/TOOLS) | entry.ts, runtimeEntry.ts, contract.ts |
| I15 | Hindsight is read-only-degrading, untrusted-labelled, YAML-only config, secret-redacted | hindsight.ts |

## 11. UNKNOWN / not verified
- Top of `EventType` union (core/types.ts before line 40) and full per-type payload schemas.
- Whether any state migrations beyond framework are registered (runtime/migrations/index.ts).
- Exact sqlite binding (node:sqlite vs other) in isolation/sqlite.ts.
- Count/location of inline prompt strings outside workers/ and plannerWorker/.
- How test/e2e/*.e2e.test.ts are run in CI (not in npm test globs); coverage threshold enforcement.
- Body of /execute, /ledger, /context, /challenge, /mission handlers beyond first lines; docs/usage.md not read.
- Whether Pi 0.87.1 API names map 1:1 to oh-my-pi (not examined here).
