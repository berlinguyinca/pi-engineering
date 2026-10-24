# Architecture

This document describes how `pi-engineering-runtime` is built. The authoritative
**product** specification is `docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`;
this document describes the *implementation*.

## Design goals

- Work with a normal pi install in an ordinary git repo.
- **No** AutoSpec, InferWeave, GitHub, multiple models, or distributed infra.
- Deterministic tests (no model endpoint required in CI).
- Context discipline: workers run in fresh sessions, receive bounded context,
  and return bounded structured results. No parent transcripts are passed to
  workers (INV-001).
- Evidence before promotion: nothing becomes the incumbent without passing
  deterministic gates (INV-005).

## Components

```
extensions/index.ts          pi entry point: registers /commands + semantic tools
src/runtime/EngineeringRuntime.ts   facade + adaptive /engineer pipeline
src/orchestration/           mission orchestration (spec pi-engineering-orchestration)
                             IntentRouter, MissionStore, Scheduler, Broker, CompletionGate, Orchestrator
src/ledger/                  event-sourced Engineering Ledger (append-only JSONL)
src/artifacts/               filesystem artifact store (artifact:// URIs, lazy reads)
src/git/GitRepo.ts           worktree isolation, diff capture, controlled merge
src/context/ContextBroker.ts bounded task-context package (repo map + git grep -E)
src/verify/Verifier.ts       CommandVerifier + VerificationProvider abstraction
src/workers/                 role prompts, worker_result tool, executors
src/tools/coreTools.ts       semantic tools bound per-cwd
src/capability/              model discovery, capability modeling, observed perf, routing
src/lifecycle/               automatic lifecycle controller + harness, gates, vision,
                            destructive-op gating, telemetry, persistence
src/inference/              InferWeave admission-retry transport, parser, policy,
                            events/metrics, status UI (see inference-admission-retry.md)
```

## InferWeave admission retry

When an InferWeave node is busy it replies `429` with a structured
`type: "inference_admission"` body. The harness converts those rejections into
abortable wait/retry states instead of terminal inference failures: the agent
stays alive across waits, the UI shows a waiting-for-capacity state, and retries
are never multiplied with the provider transport or the agent layer. See
`docs/inference-admission-retry.md`.

Admission handling spans two layers that share one contract parser:

- **`src/inference/`** — the per-call admission-retry transport
  (`executeWithAdmissionRetry`), which parses each inference response
  structurally and drives abortable waits with an elapsed-time budget + attempt
  limit. It serves the interactive-session registry and `localProviders`.
- **`src/gateway/` + `src/guard/`** — a process-wide `AdmissionController` that
  gates concurrency across every session before calls go out, and honours the
  gateway's advertised wait for worker backpressure.

Both interpret the same `inference_admission` envelope: `src/gateway/signals.ts`
delegates envelope parsing to `src/inference/admissionContract.ts`
(`parseAdmissionPayload`) and shares the `Retry-After` parser from
`src/inference/retryDelay.ts`, so the two layers cannot drift on what a wait
means.

## Durable state

Repository-scoped state lives under `<repoRoot>/.pi-eng/`:

- `ledger.jsonl` — append-only event stream; replayed into an in-memory
  materialized view on open (INV-001).
- `artifacts/<category>/<id>.json` (meta) + `<id>.txt` (content) — candidate
  diffs, verification logs, scout context. Read lazily by `artifact://` URI.

Orchestration state (missions, tasks, executions) is machine-local runtime
state, not repository content. It lives under the XDG state directory
(`$XDG_STATE_HOME/pi-engineering`, default `~/.local/state/pi-engineering`;
`PI_ENGINEERING_STATE_DIR` overrides it) — see `src/runtime/isolation/` and
`docs/specs/zero-config-runtime-isolation.md`:

- `registry.db` — SQLite (WAL, busy_timeout) machine registry: sessions (pid,
  boot id, process start time, binding, heartbeat, state, generation) and
  generation-fenced leases (mission/repository custody). Kept on a local
  filesystem even when the state dir is on a network filesystem.
- `worktrees/<worktree-id>/events/<session-id>.jsonl` — one append-only stream
  per session; the `EventStoreBackend` (`SessionEventStore`) reads all streams
  of the worktree merged by timestamp. A legacy `.pi-eng/orchestration.jsonl`
  is imported as `events/legacy-<hash>.jsonl` and never modified.
- `worktrees/<worktree-id>/recovery/` — quarantined evidence (torn tails,
  corrupt metadata); never deleted automatically.
- `sessions/<session-id>/runtime.jsonl` — structured runtime decisions.

Only one live session drives a given mission (custody lease); every session sees
every mission of the worktree. `PI_ENGINEERING_ORCHESTRATION_DIR` relocates the
orchestration namespace but keeps per-session writers.

A stale session generation cannot release leases during shutdown. A matching
live process incarnation retains custody even when its heartbeat or lease TTL
is old; contention alone does not justify reclamation.

Lease contention diagnostics aggregate counts within a reporting window
(default five minutes, `PI_RUNTIME_CONTENTION_SUMMARY_MS`). The first attempt
per resource/holder is logged, and repeated attempts are summarized. Windows
flush early at 200 distinct pairs to bound memory and summary size, and reset
when the session log changes. Summary counts include the first attempt in that
window; they are not cumulative process-lifetime totals.

## The Engineering Ledger

The ledger is **event-sourced**: every mutation appends an event
(`entity_created`, `entity_status_changed`, ...). On `open()` it replays the
stream to build materialized work items, candidates, and entities. Entities:

- `work_item` — a goal plus lifecycle (`OPEN` → `COMPLETED` / `FAILED`).
- `candidate` — an implementation attempt in an isolated worktree, with
  `base_commit`, `diff`, `changed_files`, `parent_id` (fix-lineage), `status`
  (`pending` → `verified` → `promoted` / `rejected`).
- `hypothesis` — a claim from a scout/worker. **Never silently promoted to a
  fact** (INV-006); promoted only when backed by evidence.
- `finding` — a reviewer finding with a severity.
- `requirement` / `decision` — recorded goals and decisions.

Worker hypotheses remain open even when they cite captured observations. A
reference proves that an observation was recorded, not that the worker's causal
interpretation is correct. `ledger_claim` resolves artifact and evidence IDs
against local stores; invented IDs and records marked unverified cannot verify
a fact. Its result explicitly reports whether the evidence reference resolved.
For example, a heartbeat establishes liveness, while an unauthorized live probe
leaves the requested production state unknown.

## Workers (fresh context, bounded results)

A worker is a **fresh** pi SDK session (in-process `createAgentSession`) with a
role-specific system prompt, a restricted toolset, and a budget. It must finish
by calling the terminating **`worker_result`** tool, which returns a bounded
structured result:

```ts
{ status: "completed"|"blocked"|"failed",
  summary: string,
  claims: [{ claim, evidence }],
  evidence_refs: string[],
  new_hypotheses: string[],
  proposed_tasks: string[] }
```

`FakeWorkerExecutor` provides a deterministic executor for tests;
`PiWorkerExecutor` drives real model sessions (and registers local
Ollama-style providers from `~/.pi/agent/qwen-nodes.json` when present).

## Candidate isolation (INV-003 / INV-004)

Each implementation candidate runs in a **git worktree** on its own branch
created at the incumbent's base commit. The worker can only mutate the
worktree. If the candidate passes verification and review, the runtime performs
a **controlled merge** (`git merge --no-ff`) of the candidate branch into the
incumbent branch — the worker never writes to the incumbent directly, and a
conflicting merge is aborted without mutating the incumbent.

The broker passes its allocated path, repository root and branch separately from
the worker's session cwd. Before inference, the worker verifies the canonical
root, shared Git directory and expected branch against that allocation. A
mismatch fails the attempt before tools or model calls run.

For workers marked `isolatedWorktree`, native `write` and `edit` operations
resolve their filesystem destination and reject paths outside the assigned
root, including symlink escapes. Read tools may inspect external references.
This file-tool guard does not sandbox arbitrary shell commands; shell isolation
remains the responsibility of the runtime's execution environment.

Git run by Pi itself against a repository a worker can write (every call in `GitRepo`, the worktree janitor, the
change observer, post-merge reverts, `worker_result`, the result caches, review guards, the update host and the source
watcher) goes through `src/git/safeGit.ts`. A worker can plant `core.fsmonitor`, hooks, `filter.*`, `diff.*.textconv`,
`merge.*.driver`, `gpg.*`, `core.sshCommand`, credential helpers, `remote.*.uploadpack`, `url.*.insteadOf`,
`branch.*.remote`, `extensions.partialclone`, `.lfsconfig` or an attributes file in the shared `.git` or the work tree.
`safeGit` does not filter that config: git is run against a GENERATED config that contains only an allow-list of keys
(see "git hardening" below). `test/unit/safe-git-callers.test.ts` fails when a source file spawns `git` outside it
unless the file is listed, with a reason, in `RAW_GIT_EXCEPTIONS`. The verifier and CAV runner intentionally run
worker-authored commands (they are the point of a verification gate); they get a scrubbed environment
(`src/lifecycle/workerEnv.ts`) but are not sandboxed.

A mutating worker with a known base cannot report `completed` without a tracked
file diff against that base. Empty or reverted commits do not count, and Git
inspection failures require a blocked/partial report until evidence is available.
Untracked files must be staged or committed before they substantiate completion.
Candidate verification and review still determine mission completion.

## Verification (INV-005)

`CommandVerifier.detect(cwd)` inspects the repo's `package.json` (and fallbacks)
to pick a risk-appropriate profile (`typecheck`/`test`/`build`, plus a
`syntax-check` fallback). `run()` executes each stage, captures the log to an
artifact, and returns a deterministic pass/fail outcome. `VerificationProvider`
abstraction permits alternate backends later.

## The `/engineer` pipeline

1. Classify risk (`low`/`medium`/`high`) from the goal.
2. Assemble bounded task context (repo map + symbol search) within the
   implementer budget.
3. If `medium+`, run a fresh scout; record claims as hypotheses.
4. Loop (max `MAX_ROUNDS`):
   - create an isolated candidate worktree;
   - run a fresh implementer that edits the worktree;
   - verify deterministically; record evidence;
   - if verification fails → reject, spawn a **child** candidate;
   - run a fresh independent reviewer; collect material findings;
   - if clean (or last round) → controlled-merge + promote; else fix round.
5. Mark the work item `COMPLETED`/`FAILED` and return a compact `EngineerReport`.

## Automatic lifecycle & model router (`src/lifecycle/`, `src/capability/`)

The lifecycle harness activates automatically on `agent_settled` and runs one
pass (classify → implement → verify → review → gate). Completion is
harness-owned; the parent model cannot self-declare success. The model router
discovers models from configured providers and routes each role by capability,
availability, observed performance, and cost with overrides and fallback.

- `src/capability/registry.ts` — `ModelCapabilityRegistry`, penalties, saturation.
- `src/capability/router.ts` — `RoleRouter` (async select/fallback), explainable decisions.
- `src/lifecycle/controller.ts` — `LifecycleController`, the automatic pass.
- `src/lifecycle/harness.ts` — `LifecycleHarness`, Pi event wiring + `/engineering` command.
- `src/lifecycle/gate.ts` — `evaluateGate`, completion gating.
- `src/lifecycle/destructive.ts` — command risk classification and gating.
- `src/lifecycle/vision.ts` — vision routing, cache, hand-off.
- `src/lifecycle/store.ts` — run persistence under `.pi-eng/lifecycle/`.
- `src/lifecycle/telemetry.ts` — lifecycle + admission telemetry.

State persists under `<repoRoot>/.pi-eng/lifecycle/`. See
`docs/specs/pi-automatic-engineering-lifecycle-model-router-spec.md`.

## Extension surface

- Commands: `/engineer`, `/ledger`, `/context`, `/verify`, `/review`, `/challenge`.
- Tools: `ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
  `tests_for` — resolved against the runtime for the calling cwd, so worker
  sessions and the interactive session share one durable ledger.

### git hardening: allow-list config, shadow common directory, remote pin

Round 3 replaced the deny-list (blank every vector the listing mentions) with an allow-list.

For each call `safeGit` finds the repository without running git (walk up from the cwd, `.git` directory or
`gitdir:` file, `commondir`, bare `HEAD+objects+refs`; `core.worktree` and `core.bare` are never read; a `.git` file that
is malformed is refused, an empty `.git` directory is skipped like git does), lists the repository's `config` once with
`git config --file` (reads one file, follows no includes), writes a generated config containing only allow-listed keys
with validated values into a private shadow common directory (`$TMPDIR/pi-safegit-*`), symlinks the rest of the real
common directory into it with an empty `hooks`, and runs git with `GIT_COMMON_DIR` = shadow, `GIT_DIR` = the real
per-worktree directory and `GIT_WORK_TREE`. Refs, packed-refs, the index, HEAD and objects are the real files (git takes
refs from the real directory and its `commondir` file), so their locks are the real locks. Afterwards files git created
in the shadow (for example `shallow`) are moved into the real directory, the shadow path is mapped out of stdout/stderr
and out of a new worktree's `.git` file, and the config rows the command itself added or removed (`remote add|set-url`,
`config`, `branch --set-upstream-to`, LFS `lfs.<url>.access`) are replayed onto the real config. The shadow is removed
after each call.

What this closes, by construction rather than by naming: there is no window between "inspect the config" and "run the
command" (the flip loops run 400 iterations per mode and case with 0 hits, against 109/400 and 82/400 for the deny-list
design on ignored attribute files and `core.attributesFile`); a key nobody has named is dropped like a named one; a
subsection spelling cannot matter because nothing is matched by name; LFS access writes no longer change a digest.
Allowed repository-local keys: a small set of `core.*` / `extensions.objectformat|refstorage` format and
platform settings, `user.name|email`, `branch.<b>.merge|rebase`, `remote.<n>.url|pushurl|fetch|push|tagopt|prune`,
`push|pull|merge|fetch|rebase|diff|rerere` behaviour switches, and `lfs.<url>.access=basic|none|negotiate`.
`branch.<b>.remote|pushRemote` and `remote.pushDefault` are kept only when they name an existing remote (or `.`).

Operator-visible behaviour changes: repository-local `credential.*`, `http.*`, `url.*`, `include*`, `filter.*`,
`diff.<driver>.*`, `merge.<driver>.*`, `alias.*`, `core.editor|pager|hooksPath|sshCommand|attributesFile` and
`submodule.*` are not honoured by Pi's git calls (the operator's own global/system config is, in `operator` trust);
hooks of the repository do not run; `git submodule update|add|sync|foreach` and `--recurse-submodules` are refused
(URLs in `.gitmodules` live in the work tree); `git lfs` is refused while a `.lfsconfig` exists and smudge is skipped
(`GIT_LFS_SKIP_SMUDGE=1`) when one exists; `gc.auto` is off for Pi's calls; `diff`/`status` ignore submodule changes;
`git add` leaves tracked nested repositories out (`:(exclude)` pathspecs) and `describe --dirty` is refused while one
exists; an ignored key is announced once per repository with an `info` notice when it looked like an exec or network
vector. Operator trust defaults `GIT_ALLOW_PROTOCOL` to `https:http:ssh:file:git`.

Remote pin: the remote URLs of a repository are remembered the first time Pi sees a remote (keyed by the real common
directory, so a symlinked spelling is the same repository). Network commands (`fetch`, `pull`, `push`, `ls-remote`,
`lfs`, `remote update|prune|show|set-head`) are refused while the URLs differ. Pi's own reads never clear the pin; Pi's
own `remote add|set-url|rename|remove` (through safeGit) moves it by exactly what the command changed. An operator who
wants the pin to survive restarts lists allowed remotes in the global git config:
`git config --global --add pi.allowedRemote 'https://github.com/org/*'` (exact URL, or a prefix ending in `*`); in
`operator` trust a network command is refused when any remote URL is not on that list.

`operator` trust passes a short list of Pi's own process environment through (`OPERATOR_ENV` in `safeGit.ts`: config
isolation, CA bundle, proxy, ssh and identity variables) on the premise that the operator started Pi; it never passes
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`, `GIT_PAGER` or any
inherited `GIT_CONFIG_COUNT/KEY/VALUE`. A Pi started from inside a worker's shell would trust that shell's variables;
that is outside this module.

Residuals: the first sight of a repository is trusted unless `pi.allowedRemote` is set (a worker that repoints a remote
before Pi ever looks wins); a worker that can write the operator's home directory can change the operator's config;
nested repositories are handled for the commands measured with git 2.43 (the matrix in
`test/unit/safe-git-nested.test.ts` is the regression guard for other git versions); the shadow lives in the temp
directory and is not a sandbox (a worker that can write `.git` can still run its own git).
