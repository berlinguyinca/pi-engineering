# Phase 1: OMP public surface (read-only scout)

Repo: oh-my-pi @ 57263720c818ab3baaeb74bf415b03592b806ae0 (can1357/oh-my-pi). Root pkg `omp`, MIT, "Stencil Labs, Inc." (package.json:1-5).
Method: static read of docs/ and src/ only. Nothing run. No Pi Engineering compatibility is claimed. Line numbers are from docs unless a src path is given; "UNKNOWN" = not verified in source.
Paths below are relative to the repo root; `ca/` = `packages/coding-agent/src/`.

## 1. Packages (packages/*/package.json)

| Dir | Name | Version | Role (package.json description) |
|---|---|---|---|
| agent | @oh-my-pi/pi-agent-core | 18.20.0 | agent loop, transport abstraction, state, attachments |
| ai | @oh-my-pi/pi-ai | 18.20.0 | unified LLM API, provider config |
| catalog | @oh-my-pi/pi-catalog | 18.20.0 | model database / discovery descriptors |
| coding-agent | @oh-my-pi/pi-coding-agent | 18.20.0 | the CLI (`bin omp` -> src/cli.ts, package.json:28); SDK, extensions, task, RPC, LSP/DAP, memory |
| mnemopi | @oh-my-pi/pi-mnemopi | 18.20.0 | local SQLite memory engine |
| natives | @oh-my-pi/pi-natives | 18.20.0 | Rust N-API (grep, PTY, shell, vcs, ...) |
| tui | @oh-my-pi/pi-tui | 18.20.0 | terminal UI lib |
| utils | @oh-my-pi/pi-utils | 18.20.0 | shared utils |
| wire | @oh-my-pi/pi-wire | 18.20.0 | shared wire-protocol types (collab) |
| omptype | @oh-my-pi/omptype | 18.20.0 | ArkType-compatible runtime schema validation |
| snapcompact | @oh-my-pi/snapcompact | 18.20.0 | bitmap-frame context compression |
| stats | @oh-my-pi/omp-stats | 18.20.0 | local usage dashboard |
| collab-web | @oh-my-pi/collab-web | 16.3.6 | browser guest for `omp collab` |
| browser-relay | @oh-my-pi/browser-relay | 0.1.0 | Chrome extension relay |
| metaharness | @oh-my-pi/pi-metaharness | 0.0.1 | benchmark runners + dashboard |
| typescript-edit-benchmark | @oh-my-pi/typescript-edit-benchmark | 0.0.1 | edit benchmark |

Also: `crates/` (pi-ast, pi-builtins, pi-diff, pi-edit, pi-iso, pi-natives, pi-predict, pi-shell, pi-vcs, pi-vfs, pi-voice, pi-walker, vendor); `sdk/{go,python,rust}/omp-rpc`; `python/robomp`; root workspaces `packages/*` + `python/robomp/web` (package.json workspaces).

Namespaces: the real namespace is `@oh-my-pi/*`. `@earendil-works/*` is NOT a package here. It appears only as a legacy specifier that the extension loader rewrites onto host-bundled copies, along with `@mariozechner/*` and bare `@sinclair/typebox` (docs/extension-loading.md:285; docs/custom-tools.md:114). Compat shims: `ca/extensibility/legacy-pi-ai-shim.ts`, `legacy-pi-coding-agent-shim.ts` (incl. `DefaultResourceLoader`), `legacy-pi-tui-shim.ts`, `legacy-typebox.ts`. Native roots are `.omp`; legacy `.pi` is accepted only in package manifests (`pi.extensions`) and project override lookup (extension-loading.md:49-53). Whether the shims cover the full `@earendil-works` API: UNKNOWN.

## 2. Extension API

| Item | Evidence |
|---|---|
| Declaration | TS/JS module, default-export factory `(pi: ExtensionAPI) => void \| Promise<void>` (extensions.md:17-35). Types in `ca/extensibility/extensions/types.ts`; runner `runner.ts`, wrapper `wrapper.ts`, loader `loader.ts`. |
| Load order | Modules imported concurrently; factories run sequentially in path order (extensions.md:46-52). Action methods (`sendMessage` etc.) throw `ExtensionRuntimeNotInitializedError` during load; `pi.exec()` OK; provider registration queued (extensions.md:67-72). |
| Discovery sources | `<cwd>/.omp/extensions`, `~/.omp/agent/extensions`, `settings.json#extensions`; `.omp/hooks/pre\|post/` JS/TS hooks; plugin manifests `package.json#omp.extensions` / `pi.extensions`; explicit `--extension` paths (extension-loading.md:30-107). `--profile`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` redirect roots. |
| Disable/allowlist | `disabledExtensions`, exact module allowlist, discovery off (extension-loading.md:108-200). |
| Registration | `on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`/`unregisterProvider`, renderers, `registerFileWriteFallback`/`DeleteFallback`, `sendMessage`/`sendUserMessage`/`appendEntry`, `exec`, `getActiveTools`/`setActiveTools`, `setModel`, shared `events` bus (extensions.md:122-147). `pi.zod` supplies the schema lib (extensions.md:80). |
| Events: session | `session_start`, `session_before_switch`/`_switch`, `_before_branch`/`_branch`, `_before_compact`/`session.compacting`/`_compact`, `_before_tree`/`_tree`, `_before_shutdown`/`session_shutdown` (extensions.md:514-570). `session_before_*` can return `{cancel}`; 30 s handler budget, 2 s for shutdown. |
| Events: tool | `tool_call` (can block / revise input / add `additionalContext`), `tool_result` (middleware-style patch), `tool_execution_start/update/end`, `tool_approval_requested/resolved` (extensions.md:639-646). |
| Events: context/turn | prompt/turn lifecycle + `input` / `before_agent_start` hooks (extensions.md:571-640, only skimmed); `user_bash`, `user_python`; `mode_changed`; `plan_review_requested/resolved`; MCP notifications; `auto_compaction_*`. |
| Events: subagent | `before_subagent_spawn` -> `{model?, block?, reason?, note?}`; fires once per child, at dispatch (extensions.md:659-661; types.ts:1222). The `block:true` gate is relevant to a lease/fencing adapter. |
| `resources_discover` | Implemented in the runner but NO `AgentSession` callsites (extensions.md:703-706). |
| Context | `ExtensionContext`: `ui`, `cwd`, `runEphemeralTurn`, `startLive`, `setInterval`/`setTimeout`, `models`, `invokeTool` (delegates to built-ins), `sessionModes` (extensions.md:367-500, 763). |
| Custom tools / hooks / commands | Separate legacy-ish surfaces: `ca/extensibility/custom-tools`, `hooks`, `custom-commands` (docs/custom-tools.md, hooks.md; extensions.md:1496 "Extensions vs hooks vs custom-tools"). |
| Skills | Native layout is `<root>/skills/<name>/SKILL.md`, one level, non-recursive (skills.md:25-50). Frontmatter: name, description, globs, alwaysApply, hide, disable-model-invocation, enabled. Exposed to the model as `skill://` via `read`, plus `/skill:<name>`. Plugin roots (`omp-plugins`) also scan `skills/`, `hooks/`, `tools/`, `commands/`, `rules/`, `prompts/`, `agents/`, `.mcp.json` (plugin-manager-installer-plumbing.md:26,212). Agent Plugins 1.0.0 packages use a root `plugin.json` with strict validation (plumbing:213). Whether an extension module's own sibling `skills/` is auto-loaded: partly (`src/discovery/omp-extension-roots.ts`, extension-loading.md:25 "sibling capability roots from extension packages"); exact rules UNKNOWN. |
| Version/capability negotiation | No extension-API version field or capability handshake found in extensions.md or types.ts (grep for version/capab hit only unrelated items). Install-time validation imports the entry against a throwaway registration surface (plumbing:120). Status: UNKNOWN (no negotiation found; not proven absent). RPC does have protocol negotiation (see 5). |
| Failure isolation | Load failures per-module; restricted children and revival; runtime isolation model (extension-loading.md:298-361). |

## 3. Subagent / task / session / worker model

| Aspect | Finding | Evidence |
|---|---|---|
| Spawn | `task` tool (docs/tools/task.md), eval `agent()`, workpool workers, `vibe_spawn`. Agents are `AgentDefinition` (name, description, systemPrompt, tools, spawns, model list, thinkingLevel, output schema, blocking, structured, autoloadSkills, prewalk, advisor). | task-agent-discovery.md:25-50; `ca/task/{index,executor,agents,workpool,spawn-policy}.ts` |
| Bundled agents | `scout`, `reviewer`, `security-reviewer`, `task`, `sonic` | task-agent-discovery.md:142-150; `ca/prompts/agents/*.md` |
| Discovery of agents | bundled / user / project / plugin `agents/` dirs, merge and collision rules | task-agent-discovery.md:159-195 |
| Guards | spawn policy, recursion-depth gating, self-recursion env guard, plan-mode read-only | task-agent-discovery.md:365-402; `ca/task/spawn-policy.ts`, `read-only-policy.ts` |
| Isolation | Optional per-spawn isolated copy via a PAL ("native mount", "ovnfs", fallback). NOT plain `git worktree`: backends come from crate `pi-iso`; `IsolationHandle{mergedDir, backend, fellBack}`. Settings `task.isolation.enabled` / `task.isolation.apply` / `isolation.backend` (`ca/config/settings.ts:3156-3190`; `ca/task/index.ts:843-893`). Baseline capture, delta patch (`captureDeltaPatch`), `commitToBranch`, `mergeTaskBranches`, nested-repo patches. | `ca/task/worktree.ts:35-1086` (exports at 293-1077); `isolation-runner.ts:1-40` |
| Isolation ownership | Marker file `.omp-isolation-owner.json` `{pid, id, startToken}`; `hasLiveIsolationOwner` guards against pid recycling; retained-backend file `.omp-retained-backend.json`. Process-liveness ownership only; no lease/fencing-token semantics found. | `ca/task/isolation-ownership.ts:16-117` |
| Context passing | Task call params; child gets its own session with `taskDepth`, `parentTaskPrefix`, `outputSchema`, `requireYieldTool` (sdk.md:386-399). Parent `autoloadSkills` injected. | sdk.md; `ca/task/executor.ts` |
| Result return | Structured `yield` tool + output schema; `SingleResult`; `result-summary.ts`, `yield-assembly.ts`. | task-agent-discovery.md:235-245 |
| Persistence/recovery | Session = append-only JSONL tree (`id`/`parentId` + leaf pointer), versioned and migrated; `CURRENT_SESSION_VERSION`. Subagent transcripts are persisted and cold-revivable (`persisted-revive.ts`, `restore.ts`); isolated children "cannot be cold-revived" (session.md:428). `session_exit` + synthetic aborted message on resume (session.md:339). `vibe-session-lifecycle` entries replay spawn/turn/tombstone (session.md:335). | docs/session.md:1-30,335-339,428; `ca/session/session-entries.ts` |
| Event-sourced? | Session JSONL is an append-only tree log, not documented as a hash-chained or tamper-evident ledger. Ledger/lease/fencing: UNKNOWN beyond the above. The only "lease" found is memory job leases in SQLite (`ca/memories/storage.ts:100,180-230`; memory.md config `stage1LeaseSeconds`, `phase2HeartbeatSeconds`). |
| Observability | `subagentEventBus` (`task:subagent:*`); RPC `get_subagents`, `get_subagent_messages`, `cancel_subagent` (hard kill, tombstone, revivable), `steer_subagent`, `set_subagent_subscription` off/progress/events (rpc.md:1083-1157). |
| Other orchestration | goals (`ca/goals`), autoresearch (docs/autoresearch.md), advisor/watchdog (docs/advisor-watchdog.md), agent hub, workpool, vibe mode, IRC bridge. Mission-level orchestration with review/verify/tournament: UNKNOWN (not read). |

## 4. Review, LSP/DAP, memory

| Module | What exists | Config / interface | Evidence |
|---|---|---|---|
| Review | `/review [<dir>] [<ref> \| #N \| !N] [instructions]` bundled custom command: resolves local diff or GitHub PR / GitLab MR, builds prompt, runs `reviewer` agent (tools read/find/grep/glob/bash/lsp/web_search/ast_grep; spawns `scout`; model `@slow`; structured output `overall_correctness: correct\|incorrect`, `explanation`, `confidence`, ...). Headless and custom-request prompt templates exist. `security-reviewer` agent and `security_scan` tool. | frontmatter-defined agent output schema | `ca/extensibility/custom-commands/bundled/review/{index,prompt,target}.ts`; `ca/prompts/agents/reviewer.md`; `ca/prompts/review-*.md`; docs/tools/security_scan.md |
| Verify / tournament | No dedicated verify or tournament module identified. `ratchet/`, `judgment/`, `ca/prompts/judge` exist but were not read: UNKNOWN. |
| LSP | Client, mux (`lspmux`), diagnostics ledger, write-through formatting, `lsp` tool, bundled `defaults.json`. Config files `lsp.{json,yaml,yml}` at user/cwd/plugin levels with precedence; `ServerConfig`: command, args, fileTypes, languageId, rootMarkers, initOptions, settings, disabled, warmupTimeoutMs, isLinter, watchFiles, capabilities. | docs/lsp-config.md:11-130; `ca/lsp/*` |
| DAP | Client/session/config with `defaults.json`, `debug` tool. Dedicated docs file: none found (`docs/tools/debug.md` exists, unread). | `ca/dap/{client,config,session,types}.ts`; docs/tools/debug.md |
| Memory backends | `memory.backend` = `off` (default) \| `local` \| `hindsight` \| `mnemopi` \| `sharpshooter` (memory.md:3-12). | `ca/memory-backend`, `ca/memories`, `ca/hindsight`, `ca/mnemopi`, `ca/sharpshooter` |
| Hindsight | REMOTE Hindsight server (default `http://localhost:8888`, `HINDSIGHT_API_TOKEN`); 18 `HINDSIGHT_*` env overrides; scoping `per-project-tagged` (default) / `per-project` / `global`; `hindsight.globalScope`; auto recall on first turn, retain every 3 user turns; durable outbox `<agentDir>/hindsight-outbox/` with quarantine; mental models; tools `recall`, `retain`, `reflect`, `learn`; subagents alias parent client. | memory.md:134-158; `ca/hindsight/{backend,bank,client,config,outbox,mental-models}.ts`; docs/environment-variables.md#hindsight |
| Mnemopi | Local SQLite engine + embed worker/server; package `@oh-my-pi/pi-mnemopi` | docs/mnemosyne-memory-backend.md (unread); `packages/mnemopi` |
| Hindsight wire compat with Pi Engineering's "Hindsight memory": UNKNOWN (not verified; no claim). |

## 5. SDK / embedding / RPC / headless

| Surface | Detail | Evidence |
|---|---|---|
| Embedding SDK | Package root `@oh-my-pi/pi-coding-agent` is the full surface: `createAgentSession`, `SessionManager`, `Settings`, `AuthStorage`, `ModelRegistry`, `AgentRegistry`, discovery helpers, `createTools`/`BUILTIN_TOOLS`. Narrower `/sdk` subpath (no SessionManager/AuthStorage/ModelRegistry). Returns `{session, extensionsResult, setToolUIContext, mcpManager, lspServers, eventBus, subagentEventBus, ...}`. In-memory or file-backed session managers. | docs/sdk.md:19-37,102-146,401-424 |
| RPC (JSONL over stdio) | `omp --mode rpc` (`rpc-ui` for UI sub-protocol; `--no-ui` headless). Emits `ready` frame with `protocolVersion:1`, `supportedProtocolVersions:[1,2]`, `maxFrameBytes`; client sends `negotiate_protocol` for v2 (chunked `rpc_chunk` frames, 64 MiB reassembly). Commands: prompt, abort, state, model, thinking, queue, compaction, bash, session (fork/open/tree), messages, login, subagent control, goals, `set_host_tools`, `set_host_uri_schemes`. Inbound `host_tool_call`/`host_uri_request` let the host supply tools and URI schemes. Events = `AgentSessionEvent` stream plus `prompt_result` / `session_settled`. Extension UI sub-protocol for dialogs. | docs/rpc.md:19-125,792-880,1083-1157,1300-1460; `ca/modes/rpc/*` |
| RPC clients | TS `ca/modes/rpc/rpc-client.ts`, `rpc-frame.ts`; Python `sdk/python/omp-rpc` (0.1.0, py>=3.11); Rust `sdk/rust/omp-rpc`; Go `sdk/go/omp-rpc` | those dirs |
| ACP | `omp --mode acp` / `omp acp` Agent Client Protocol server (`ca/modes/acp/*`, `ca/commands/acp.ts`; extensions.md:1173) |
| Print / JSON | `omp -p`, `--mode json`, `--wait-async` (cli-reference.md:148,182,208); `ca/modes/print-mode.ts` |
| Other transports | MCP client/server (`ca/mcp`, docs/mcp-*.md), `omp collab` live sessions (`packages/wire`, `collab-web`), auth broker/gateway commands (docs/auth-broker-gateway.md) |
| Adapter drive path | An external host can drive OMP via RPC (host tools + steering + subagent control) or the embedded SDK. Mapping to a ledger/lease model: UNKNOWN; no design here. |

## 6. Tests

| Item | Finding | Evidence |
|---|---|---|
| Runner | Bun. Root `test` -> `bun scripts/ci-test-ts.ts local`; `test:ts`, `test:rs`, `test:py` (pytest on `sdk/python/omp-rpc/tests` and `python/robomp/tests`). coding-agent `test` -> `ci-test-ts.ts coding-agent-heavy --full`. Buckets: singleton / ui / runtime / native. Not run here. | package.json:82-127; packages/coding-agent/package.json:523; scripts/ci-test-ts.ts:1-25 |
| CI | `.github/workflows/{ci,bun-cache-warm,nix}.yml`; PR branches `main`, `omp2`; Bazel and Cargo files tracked. Coverage thresholds: UNKNOWN. | .github/workflows/ci.yml |
| Layout | `packages/coding-agent/test/` holds ~1065 flat entries (`*.test.ts`) plus subdirs `task/`, `lsp/`, `hindsight/`, `advisor/`. Other packages have `test/`. Go tests and Rust tests under `sdk/`. | `ls packages/coding-agent/test` |
| Coverage of extension API | `extensions-runner`, `extensions-discovery`, `extension-loader-*`, `extension-prepared-rebind`, `extension-session-modes`, `plugin-extensions-discovery`, `legacy-pi-extension-cache`, `cli-extension-*` | test dir |
| Coverage of subagents | `rpc-cancel-subagent`, `rpc-steer-subagent`, `rpc-subagents`, `task-executor-mcp-*`, `task-label`, `subagent-*`, `sdk-subagent-auth-inheritance`, `git-linked-worktree`, `test/task/` (13 isolation/task-named entries matched). Isolation/worktree-specific tests inside `test/task/`: not enumerated, UNKNOWN. |
| Coverage of RPC | ~20+ `rpc-*.test.ts` (frame, host-tools, host-uris, fork, goal, extension-ui, btw, live, dictation, client restart/start); Go/Rust/Python SDK tests (`sdk/go/omp-rpc/*_test.go`, incl. `fake_test.go` fake server) |
| Coverage of memory | `hindsight-*.test.ts` (backend, bank, client, outbox, mental-models, recall-failure), `test/hindsight/`, `mnemopi-*.test.ts`; hindsight client tests: real vs fake server UNKNOWN |
| Coverage of LSP/DAP | `lsp-*.test.ts`, `test/lsp/`, `dap-config-precedence.test.ts`; DAP runtime tests: UNKNOWN |
| Coverage of review | No `review*` test file in the name-filtered listing: UNKNOWN (not grepped by content) |

## Gaps to resolve before any unification design
- Extension API version/capability negotiation (none found; confirm in `types.ts` / `loader.ts`).
- `ratchet/`, `judgment/`, `goals/`, `autoresearch/` as candidate mission/verify analogues (unread).
- Isolation PAL semantics (`crates/pi-iso`) vs git worktrees; no fencing/lease on isolation dirs found.
- Mnemopi docs; DAP docs; review tests; test mocks policy of OMP (not assessed).
