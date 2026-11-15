# Phase 3: one disposable `/engineer` slice through an OMP-backed worker

Status: implemented behind a flag; legacy remains the default. Pinned OMP: 18.20.0 (run under Bun 1.4.4).

## Design

`OmpWorkerExecutor` (`src/omp/OmpWorkerExecutor.ts`) implements `WorkerExecutor`. Each worker run
is one fresh `omp --mode rpc --no-session` process (INV-002), cwd = the run's worktree.

1. Wait for the `ready` frame, then send `set_host_tools` registering ONE host tool: the run's
   terminating tool, taken from PE's own definition (`worker_result`, or `review_result` for review
   runs; schema and `execute` come from `createWorkerResultTool` / `reviewResultTool`, so
   normalization, the already-satisfied guard and the partial-to-blocked rule are the Pi path's).
2. On the `set_host_tools` success send `prompt` (the kickoff).
3. OMP calls `host_tool_call`; PE runs the tool, replies `host_tool_result`, and keeps
   `details` as the structured result. `prompt_result` completes the run.
4. `rpcTranslate.ts` turns frames into `RpcEvent`s and `RunCollector` sums assistant `usage`
   into `WorkerUsage` and counts tool executions.

Fallback semantics. Anything that fails BEFORE the prompt is sent (binary absent, crash or silence
before `ready`, `set_host_tools` rejected) throws `OmpWorkerUnavailable`. `FallbackWorkerExecutor`
(`src/omp/selectWorker.ts`) catches only that, emits a `state` activity
`omp worker unavailable (<reason>); using legacy executor` through the run's own `onActivity`, and runs the
legacy executor. A failure AFTER the prompt (crash, silence, abort, no result tool) is a failed
`WorkerRun`; it is never silently re-run (a re-run could repeat side effects). No ledger schema, custody,
lease or fencing code was touched.

Selection. `selectOmpWorker` (called from `EngineeringRuntime.open` only when no explicit `worker` is
given): flag unset returns `undefined` and nothing changes; adapter flag off or negotiation Unavailable
returns the legacy executor with a deterministic reason (`disabled: ...`, `binary_absent: ...`,
`crashed: ...`); otherwise an OMP worker wrapped in the fallback.

## Flags

| Variable | Meaning |
| --- | --- |
| `PI_ENGINEERING_OMP_WORKER=1` | Use the OMP-backed worker (default off) |
| `PI_ENGINEERING_OMP_ADAPTER=1` | Existing adapter flag; must also be on |
| `PI_ENGINEERING_OMP_BIN`, `_BIN_ARGS` | Launch command and (whitespace-split) arguments; `_BIN_ARGS` is new |
| `PI_ENGINEERING_OMP_MODEL` | `provider/id` for `--model` (also for the handshake: omp will not start without a model) |
| `PI_ENGINEERING_OMP_HOME` | HOME for the worker process (isolation / offline mode) |
| `PI_ENGINEERING_OMP_TIMEOUT_MS` | Negotiation budget (existing) |

## Context firewall: every OMP setting used

Passed to EVERY OMP process PE launches (negotiation and workers) via `src/omp/firewall.ts`:
`--config <overlay>` plus flags. The overlay is a content-addressed 0600 file in the OS temp dir;
`--config` overrides user `~/.omp` and a cloned repo's `.omp/config.yml`.

Overlay keys: `autolearn.enabled: false`; `memory.backend: "off"`; `skills.enabled: false`;
`skills.enableSkillCommands: false`; `skills.enableCodexUser/ClaudeUser/ClaudeProject/PiUser/PiProject/AgentsUser/AgentsProject: false`;
`disabledProviders: [omp-managed]` (the managed-skills provider, priority 5, loaded even with auto-learn off).
Flags: `--no-skills --no-extensions --no-rules --no-context-files --no-lsp --no-pty --no-title`.
Worker-only: `--tools <allowlist>` (built-ins mapped from the request's tools; host tools survive),
`--system-prompt <PE role prompt>` (replaces omp's default; omp still adds ~450 chars), `--model`.

Proof, real omp, gated on `OMP_BIN` (`test/integration/omp-firewall.test.ts`). Fixture: repo with
`.claude/skills/x/SKILL.md` and `.omp/config.yml` (`autolearn.enabled: true`); HOME with
`~/.agents/skills/z`, `~/.omp/agent/managed-skills/y` and a user config with auto-learn on.
- Firewalled worker session: no skill marker in the system or user message, no skills section,
  tools offered are exactly the allowlist plus `worker_result`: no `manage_skill`, `learn` or skill tool. PASS.
- Control (same repo/HOME, no firewall): the project `.claude` skill and the managed skill appear in the
  system prompt and `manage_skill` is offered. PASS, so the fixture is not vacuous.

## Observed frames (real omp 18.20.0)

`ready` (protocolVersion 1) then `set_host_tools` response; `prompt` response; `agent_start`, `turn_start`,
`message_start/end`, `tool_execution_start/end`, `host_tool_call{id,toolCallId,toolName,arguments}`,
`turn_end`, `agent_end`, `prompt_result{status}`, `session_settled`. Assistant `message_end.message.usage`
= `{input,output,cacheRead,cacheWrite,totalTokens,cost}`. Captured and replayed:
`test/fixtures/omp-frames/agent-turn-write-then-worker-result.jsonl`. Not a `ready`-adjacent surprise but notable:
without `--no-title` omp makes a tool-less title request to the model first.

## Offline one-model mode

`test/support/ompOffline.ts`: temp HOME with `~/.omp/agent/models.yml` (provider `pelocal`, `openai-completions`,
model `scripted`) pointing at `test/support/scriptedModelServer.ts` (real local HTTP SSE server). `PI_CODING_AGENT_DIR`
must also point into that HOME or omp reads the Pi profile. No upstream install or skill script is run.

## Parity (`PARITY_PATH=omp`, real omp, byte-identical to the unmodified legacy goldens)

Command: `OMP_BIN=<bun> OMP_BIN_ARGS=<omp>/packages/coding-agent/src/cli.ts PARITY_PATH=omp node --test --import ./test/support/isolatedState.ts test/integration/legacy-golden.test.ts`

| Scenario | Status |
| --- | --- |
| engineer / happy | VERIFIED byte-identical |
| engineer / fix-round | VERIFIED byte-identical |
| engineer / persistent-findings-failed | VERIFIED byte-identical |
| engineer / review-not-completed | VERIFIED byte-identical |
| cmd-*, review, verify, plan, tournament, mission, recovery (21) | SKIPPED with printed reason (omp path covers /engineer only); legacy goldens still gate them |
| Any omp scenario when `OMP_BIN` unset (CI) | SKIPPED: `UNVERIFIED: OMP_BIN not set` |

No golden was edited and the legacy comparison is unchanged: legacy gate with `PARITY_PATH` unset is 26/26.
Goldens exclude usage figures, which is why token counts need no exemption.

## Metrics (engineer scenarios, this machine, scripted model)

| Scenario | legacy wall (ms) | omp wall (ms) |
| --- | --- | --- |
| happy | 1539 | 5452 |
| fix-round | 2493 | 7905 |
| persistent-findings-failed | 3475 | 11078 |
| review-not-completed | 3540 | 15922 |

Includes fixture repo setup and verification. Process count: legacy adds 0 child processes for workers
(in-process Pi); omp adds 2 for negotiation (version probe, handshake) plus 1 per worker run (3 for happy).
Each omp run costs about 1.3 s of startup. Tokens: the legacy fake reports a fixed 1500 context / 1 turn; omp
reports measured usage from the scripted server (synthetic: prompt 400+100n, completion 40 per request, at
least 2 requests per run: the result tool call and the closing turn). Not a real-model cost comparison.

## Security and semantics notes

- Overlay file: lives in `<PE state dir>/omp-firewall/firewall.yml` (0700 directory owned by the user, symlinks refused),
  verified byte-for-byte against the expected content before every use and rewritten atomically (temp + rename) on
  mismatch, so a planted, stale or truncated file cannot weaken the firewall.
- Negotiation runs under the same `PI_ENGINEERING_OMP_HOME` as workers.
- Abort is never a fallback: an owner abort (even before `ready`) is an aborted failed run; only genuine unavailability falls back.
- Environment: the full parent environment is forwarded to omp (no allowlist), the same exposure as the legacy in-process Pi worker, which runs in the parent process.
- Precedence: a recorded result tool call wins over the `prompt_result` status; a prompt error/abort with no recorded result is a failed run.
- Timeout: inactivity-based (re-armed on every frame), not wall-clock, matching the legacy executor's semantics.

## Known gaps

- PE custom tools (`repo_search`, `symbol`, `ledger_read`, `artifact_read`) are NOT exposed to OMP workers; only
  built-ins and the result tool. Scenarios do not need them; real use would (Phase 4 candidate: host tools).
- Only `/engineer` runs through the slice; tournament, missions, plan and review commands keep the legacy path.
- The 2 negotiation processes run once per `EngineeringRuntime.open`; there is no pooled process.
- Scripted model, not a real LLM: this proves the protocol and result contract, not model behavior.
- Skill-free workers by design; the skills workstream's per-worker skill allowlist is not wired in here.
- Windows unsupported (process-group signalling), as in Phase 2.

## Rollback

Unset `PI_ENGINEERING_OMP_WORKER` (default). Nothing else depends on the flag; the new code is inert unless it
is set. To remove: delete `src/omp/{OmpWorkerExecutor,selectWorker,rpcTranslate,firewall}.ts`, the 4-line hook in
`EngineeringRuntime.open`, and the `model`/firewall args in `negotiate.ts`.

## Verification (this branch)

- `npm run typecheck`: pass. `npm run lint`: pass (1593 files).
- `npm run test:coverage` (unit): 6955 tests, 6950 pass, 0 fail, 5 skipped; lines 85.61 / branches 83.24 / functions 83.35 (floors 85/83/83).
- New tests: `test/unit/omp-rpc-translate.test.ts`, `test/unit/omp-worker-executor.test.ts` (29 pass together),
  `test/integration/omp-worker-fallback.test.ts` (6 pass, real child processes), `test/integration/omp-firewall.test.ts` (2 pass with OMP_BIN; skipped without).
- Legacy golden gate, `PARITY_PATH` unset: 26/26. `PARITY_PATH=omp` with real omp: 4 pass, 21 skipped, 0 fail.
