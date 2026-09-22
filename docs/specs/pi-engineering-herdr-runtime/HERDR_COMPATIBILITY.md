# Herdr Compatibility Record (PHASE D)

This document records the actual, inspected Herdr installation and API before any
integration code is relied upon. It satisfies spec 03 ("compatibility spike
against actual current Herdr and pi-herdr versions/APIs").

## Versions (inspected live, 2026-09-21)

```
$ herdr --version            -> herdr 0.9.1
$ herdr status
  client:  version 0.9.1, channel stable, protocol 22, endpoint_protocol_generation 1
  server:  status running, version 0.9.1, endpoint_compatible yes, protocol 22 compatible yes
           socket /home/wohlgemuth/.config/herdr/herdr.sock
$ herdr api schema           -> protocol 22, schema_version 1
```

- Binary: `~/.local/bin/herdr`. Server: running on local socket.
- API schema: `herdr api schema --json` (276 KB) — JSON schema `$defs` for every
  request/response/event/error type, protocol-versioned.

## Supported operations (from `herdr api schema --json`, request `oneOf`)

Agent / process runtime:
- `agent.list`, `agent.get`, `agent.read`, `agent.explain`
- `agent.prompt` (submit a prompt → the persistent agent runs it)
- `agent.wait` (wait until an `AgentStatus` in `until[]`, with `timeout_ms`)
- `agent.start` (start a supported interactive agent in an existing pane)
- `agent.send_keys`, `agent.rename`, `agent.focus`, `agent.view.*`
- `agent.attach` (attach directly to the agent terminal)

Workspace / worktree / session:
- `workspace.create/list/get/focus/rename/move/close`
- `worktree.create/list/open/remove`  ← **Git worktree support is native**
- `tab.create/list/get/focus/rename/move/close`
- `session.list/attach/stop/delete`, `session.snapshot`

Remote hosts:
- `machine.list/add/rename/remove/enable/disable` (saved SSH machines)
- `--remote <ssh-target>`, `--machine <label-or-id>` (run API commands on a remote server)

Events / output:
- `events.subscribe`, `events.wait`
- `pane.wait_for_output`, `pane.read`, `pane.send_text/send_keys/send_input`

Server / integration:
- `server.status`, `server.reload_config`, `server.stop`, `server.live_handoff`
- `server.agent_manifests`, `server.reload_agent_manifests`
- `integration.list/install/uninstall` (built-in agent integrations)
- `plugin.*`

## Agent lifecycle fidelity

`AgentStatus` enum (schema `$defs/AgentStatus`):

```
idle | working | blocked | done | unknown
```

Mapped to the normalized `AgentStatus` in `src/runtime/AgentRuntime.ts`:

| Herdr AgentStatus | Pi normalized AgentStatus |
|---|---|
| `idle` | `READY` (waiting for a task) |
| `working` | `WORKING` |
| `blocked` | `BLOCKED` |
| `done` | `COMPLETED` (idle after finishing; confirm via output/revision) |
| `unknown` | `LOST` |

`agent.list` returns per-agent: `agent_status`, `cwd`, `foreground_cwd`, `pane_id`,
`tab_id`, `workspace_id`, `terminal_id`, `revision`, `state_change_seq`. `revision`
and `state_change_seq` are monotonic — usable as an idempotency/generation signal
for reconciliation (spec 13).

## Structured errors

`error_response` schema:

```json
{ "id": string, "error": { "code": string, "message": string } }
```

Live example (`herdr agent get pi`):
```json
{"error":{"code":"agent_not_found","message":"agent target pi not found"},"id":"cli:agent:get"}
```

Error `code`s are machine-checkable (e.g. `agent_not_found`) — ideal for the
structured-error requirement.

## Worktree support

Native: `worktree.create` (create and open a Git worktree), `worktree.open`,
`worktree.remove`, `worktree.list`. This is exactly what spec 07 needs; Herdr
owns worktree lifecycle as the process runtime, Pi-Engineering persists the
repo/base/branch/worktree/worker/task mapping.

## Recovery support

- `server.status` + `agent.list` give a live snapshot for restart reconciliation.
- `session.list/attach/stop/delete` manage persistent sessions.
- `revision`/`state_change_seq` enable classifying a persisted worker as
  alive/resumable/completed-offline/failed/missing before retry (spec 13).
- `--machine`/`--remote` allow recovery across hosts.
- NOTE: there is no first-class "resume a half-done agent task" primitive; the
  pattern is reconcile state via `agent.get`/`agent.explain`, then only retry
  when the work is known not to have mutated Git (Pi-Engineering policy).

## Remote-host support

`machine.*` (saved SSH machines) + `--remote <ssh-target>` + `--machine <label>`.
Host scheduling stays process placement (Herdr), not inference placement
(InferWeave). Secure connectivity (Tailscale/SSH) is below Herdr.

## Pi compatibility

- Agent `kind` is `pi`; `integration.list` shows built-in agent integrations.
- Pi-Engineering talks to Herdr as the runtime; it does NOT fork or reimplement
  Herdr. `agent.prompt` carries the objective; the worker's terminating
  `worker_result`/`review_result` tool output is read back via `agent.read` +
  `pane.wait_for_output`.

## Identified gaps (Pi-Engineering must handle)

1. **No structured `WorkerResult`** in Herdr. Results are terminal output
   (`agent.read`). Pi-Engineering must parse the terminating tool JSON
   (`worker_result`/`review_result`) out of bounded output. This is already a
   Pi-Engineering concern (`src/workers/workerResultTool.ts`).
2. **No explicit `interrupt`** — use `agent.send_keys` (Ctrl-C) or
   `pane.close`/`pane.release_agent`. Bounded by Pi policy.
3. **No context/request-byte budgeting in Herdr.** `agent.prompt` has no budget
   field. Pi-Engineering MUST budget tokens and serialized bytes BEFORE sending
   (spec 06) — Herdr is not the place to fix 413.
4. **No first-class "create a fresh isolated agent per task"** — a new worker
   needs a new pane/workspace/worktree (`worktree.create`, `pane.split`,
   `agent.start`). Pi-Engineering drives that.
5. **Silence ≠ death** — use `agent_status` + `state_change_seq` + heartbeat, not
   terminal silence, to classify (spec 12/13).

## Live integration smoke test (2026-09-21)

`RealHerdrCli` was exercised against the running server (protocol 22):
- `status()` → `{ok:true, serverVersion:"0.9.1", protocol:22}` ✔
- `listAgents()` → 9 agents with `agent_status`, `cwd`, `pane_id`, `workspace_id` ✔
- `HerdrAgentRuntime.health()` → `{runtime:"herdr", ok:true, serverVersion:"0.9.1", protocol:22}` ✔
- `create()` → opaque id `HERD-…` ✔
- `start()` → FAILS with `agent_start_failed: could not start Herdr agent: unknown option: HERD-B5zyql`

**Finding (medium):** provisioning a NEW isolated agent requires an existing
`pane_id`; an opaque Pi id is not a real pane. Full real provisioning (Phase E)
must create a pane (`pane.split`) or a worktree-backed workspace first, then
`agent start` in it. The opaque-id path is correct for the runtime-neutral
contract (verified with a fake CLI) but not yet wired to real pane creation.

## Install / bootstrap posture

Pi-Engineering does NOT auto-install or auto-start Herdr on any request path.
Herdr is an external dependency with its own install/upgrade lifecycle
(binary + long-running socket server). The normal selection path
(`negotiateHerdr`) fails **closed** with an actionable error when Herdr is
missing or its server is down, and points at `herdrEnsureLocal()`.

`herdrEnsureLocal()` is an explicit, operator-gated utility:
- `detectHerdr()` — side-effect-free binary + server check.
- returns `install-needed` / `start-server` / `ok` with guidance.
- runs an install command ONLY when the operator supplies BOTH
  `installCommand` AND `autoInstall: true` (never an embedded command).

Live check (2026-09-21): `herdrEnsureLocal()` against the running server →
`ok: true`, server 0.9.1, protocol 22.

## Selected integration mechanism

Drive the **Herdr CLI over the socket API** (`herdr <method> <args>`), not a raw
socket client and NOT a fork. Rationale:
- The CLI is the documented, stable automation surface ("Control Herdr panes,
  agents, or workspaces"), versioned with the server (protocol 22).
- It is testable with a fake `herdr` executable in unit tests (contract tests),
  and real in integration/canary.
- No forking/reimplementation; Pi-Engineering remains a thin consumer.
- JSON output (CLI returns JSON for API methods) is parsed directly.

All Herdr access is confined behind `HerdrAgentRuntime` (implements the
`AgentRuntime` seam from spec 02), selected by a runtime selector/feature flag.
Pi-Engineering code never touches Herdr directly.
