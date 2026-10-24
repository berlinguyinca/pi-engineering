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
with validated values into a private shadow common directory (`<state dir>/safegit/shadow/s-XXXXXX`, 0700, see
"Round 4" below), symlinks the rest of the real common directory into it with an empty `hooks` and a generated `info/attributes`,
and runs git with `GIT_COMMON_DIR` = shadow, `GIT_DIR` = the real
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
vector. Transports: `GIT_ALLOW_PROTOCOL` is `https:ssh` in strict mode and `https:http:ssh:git` in operator mode; `file` is
enabled for one call only when a local remote was allow-listed (Round 4).

Remote pin: the remote URLs of a repository are remembered the first time Pi sees a remote (keyed by the real common
directory, so a symlinked spelling is the same repository). Network commands (`fetch`, `pull`, `push`, `ls-remote`,
`lfs`, `remote update|prune|show|set-head`) are refused while the URLs differ. Pi's own reads never clear the pin; Pi's
own `remote add|set-url|rename|remove` (through safeGit) moves it by exactly what the command changed. An operator who
wants the pin to survive restarts lists allowed remotes in the global git config:
`git config --global --add pi.allowedRemote 'https://github.com/org/*'` (exact URL, or a prefix ending in `*`); a network
command is refused when any remote URL is not on that list, in both trust modes (strict mode ignores the operator's git
config for git itself, not for this check).

`operator` trust passes a short list of Pi's own process environment through (`OPERATOR_ENV` in `safeGit.ts`: config
isolation, CA bundle, proxy, ssh and identity variables) on the premise that the operator started Pi; it never passes
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`, `GIT_PAGER` or any
inherited `GIT_CONFIG_COUNT/KEY/VALUE`. A Pi started from inside a worker's shell would trust that shell's variables;
that is outside this module.

#### Round 4: same-user worker, shared `.git`, credentials

Threat model, stated plainly. Everything above defends against a worker that can write the repository (its work tree and
the shared `.git`) but is not Pi. A worker that runs as the SAME user and can read and write Pi's own private state
directory, the operator's home directory, or Pi's code is outside what git hardening can enforce: it can edit the pins,
the shadow, `~/.gitconfig` and the extension itself. Closing that needs a worker sandbox (a separate uid, or a mount /
user namespace). **What the sandbox must hide from the worker:** `<state dir>/safegit/` (the private shadow directories and
`pins.json`), the operator's `~/.gitconfig` and `~/.config/git/`, `~/.ssh`, Pi's installation under `~/.pi/pi-engineering`,
and `$TMPDIR` entries that are not the worker's own. Everything below is defence in depth plus tripwires for that case;
none of it replaces the sandbox.

- Private shadow. The shadow directories live in `<state root>/safegit/shadow/` (the machine-local state directory:
  `$PI_ENGINEERING_STATE_DIR`, `$XDG_STATE_HOME/pi-engineering` or `~/.local/state/pi-engineering`), created 0700, with
  `mkdtemp` names, and verified on every use (a directory, not a symlink, owned by the user; too-open permissions are
  repaired, anything else refuses the call). Nothing git reads is created in the shared `/tmp` any more, so a worker watching
  `/tmp` with `fs.watch` finds nothing to race (probe: the poller that hit 19/20 strict and 9/10 operator now sees 0/40).
- Read-only while git runs, verified afterwards. The generated `config` is 0400; for every subcommand that has no business
  writing config (everything except `config remote branch push pull fetch checkout switch worktree lfs submodule clone init
  maintenance sparse-checkout gc repack bisect rebase`) the shadow directory itself is 0500. After the command Pi checks the
  config, `info/attributes`, the attributes file, the empty `hooks` directory and every symlink: a changed shadow discards the
  result (code 128, empty stdout), copies nothing back, and emits an `error` notice `git-shadow-tampered`. This is a tripwire,
  not a barrier: a same-user process can `chmod` back, and the command has already run. For config writers only keys on the
  allow-list are replayed onto the real config (a key git was never meant to write into the generated file is reported as
  `git-shadow-config-unexpected` and not copied).
- Attributes cut off at the source. `GIT_ATTR_SOURCE` = the empty tree (git 2.40+; the measured git is 2.43), `info/attributes`
  of the shadow is empty and Pi-generated, and `core.attributesFile` is a Pi-generated file in the shadow: no `.gitattributes`,
  `info/attributes`, global attributes file or tree can select a filter, diff or merge driver, whatever the config says. Lost, on
  purpose: attribute-driven `text`/`eol`/`-text` normalisation (`core.autocrlf` and `core.eol` still apply), `ident`,
  `export-subst`/`export-ignore`, `working-tree-encoding`, `merge=union` and custom merge/diff drivers, `-diff`/`binary` hints,
  `linguist-*`; the operator's own per-user attributes file is no longer read either. Kept: git-lfs. In operator mode, when the
  operator's own config defines `filter.lfs.*`, Pi reads the repository's root `.gitattributes` (also while untracked) and the
  tracked nested ones itself and carries over ONLY `<pattern> filter=lfs diff=lfs merge=lfs -text` lines; any other driver name on
  the same line, any other attribute and any other driver are dropped. An untracked nested `.gitattributes` applies once tracked.
- Symbolic links in the shared git directories. Before every call Pi lists (readdir entry types, no per-file stat) the top level
  of the common and per-worktree git directories, `refs/**`, `logs/**`, `info/**`, `objects/` and its `info`/`pack`, and every
  `worktrees/<n>/` (and its `logs/**`), and refuses the call when an entry is a symbolic link, FIFO, socket or device where a
  regular file or directory belongs (`index`, `packed-refs`, `FETCH_HEAD`, `shallow`, `HEAD`, `config`, a ref, a reflog ...).
  Repositories that symlink `objects`, `logs` or another top-level entry to shared storage are refused too: they must use
  `objects/info/alternates` (a regular file) instead. More than 100,000 entries is refused (fail closed). The stderr relayed to a
  caller is bounded (1 KiB per line, 64 KiB total).
- Credentials and git-lfs. `GIT_LFS_SKIP_SMUDGE=1` for every command that writes the work tree (`checkout switch merge pull reset
  stash rebase cherry-pick revert worktree clone restore am apply read-tree checkout-index sparse-checkout submodule bisect`),
  so a `.lfsconfig` that arrives during the checkout contacts nothing and LFS content is not downloaded by Pi (the files stay
  pointers until the operator runs `git lfs pull`). `lfs.url`, `lfs.pushurl` and `lfs.locksurl` are forced on the command
  line (they beat `.lfsconfig`, measured with git-lfs 3.4): the endpoint git-lfs derives from the repository's own https remote, the
  operator's own configured value when the operator's global config sets one, or empty (git-lfs then fails with "missing
  protocol" instead of contacting anything) for ssh and other remotes. Hooks are off, so the `pre-push` hook that runs
  `git lfs push` never runs: a `push` of a repository that tracks LFS patterns (in either mode, see Round 5) is
  refused with a message that says why, instead of sending pointer files without their objects. Push such a repository from a
  shell, or untrack the patterns.
- Repository identity and transports. Pi remembers, per work tree, which repository it belongs to (recorded when Pi creates a
  worktree with `git worktree add`, otherwise at first sight) and refuses the call when the work tree's `.git` file now names
  another repository. `expectCommonDir` lets a caller that knows its repository say so. Local-path, `file://` and
  `<helper>::<address>` remotes, and URL-like arguments (`push /path`, `fetch file://...`, `clone /path`), are refused for
  network commands unless the operator listed them in `pi.allowedRemote` (helpers never run, listed or not): pushing to a local
  repository runs ITS hooks as the user. The pins and work-tree records are persisted in `<state root>/safegit/pins.json`
  (0600, atomic rename), so a restart no longer forgets them; a corrupt file is refused rather than read as "nothing pinned".
  After a deliberate remote change or a re-clone at the same path: `pi-engineering git-pins list`, `pi-engineering git-pins
  reset [<path>]`. git skips its own `safe.directory` ownership check when `GIT_DIR` is explicit, so Pi enforces it: a repository
  or work tree owned by another user is refused unless the operator's own git config lists it (`safe.directory`, or `*`).
- Housekeeping and identity probes. A sweeper (first shadow of each process) removes shadow directories of ours older than 30
  minutes that this process does not consider live, and the `pi-safegit-*` directories earlier versions left in `$TMPDIR`.
  `WorktreeIdentity` and `primaryWorktreeGuard` run `rev-parse` through safeGit, so a worker-written `core.worktree` / `core.bare`
  cannot change which work tree they report.

Residuals: the first sight of a repository is trusted unless `pi.allowedRemote` is set (a worker that repoints a remote
before Pi ever looks wins); a same-user worker with access to Pi's private state directory, the operator's home directory or
Pi's code defeats all of this and needs the sandbox above; nested repositories are handled for the commands measured with git
2.43 (the matrix in `test/unit/safe-git-nested.test.ts` is the regression guard for other git versions); the shadow is not a
sandbox (a worker that can write `.git` can still run its own git); the symlink scan and the shadow verification are checks
before and after a call, so a worker that swaps a path for a link while git runs is not stopped by the scan (the generated
config and attributes do not depend on it; see Round 5 for what that race can and cannot do); an LFS repository cannot be
pushed through Pi, and untracked nested `.gitattributes` files are not applied.

#### Round 5: the race that remains, and what was done about it

**The scan-to-spawn race is real and is not closed by anything in this module.** Pi looks at the shared git directories
(symlinks, hard links, special files) and then starts git. A same-user worker that writes the shared `.git` can replace
`worktrees/<n>/index`, `packed-refs`, `FETCH_HEAD`, `HEAD` or a ref with a link between that look and git opening the path.
The window is not "a few milliseconds": measured, a worker polling the path wins within tens to hundreds of milliseconds of a
call, and a long-running git (fetch, gc, a large add) hands it far more. What a won race gives the worker: git writes the
index / FETCH_HEAD / a reflog through the link (a file write at the victim path, with git-chosen content that includes
attacker-chosen path names), or reads the linked file as a ref file. The only things that close it are a separate uid for the
worker or a mount namespace in which the worker cannot create links inside Pi's repositories' `.git`: **a worker sandbox is
required**, and nothing below replaces it.

What Pi does to make the race smaller and less useful (none of it is a lock):

- The scan runs twice: before Pi's own internal git calls, and again as the very last step before the spawn (after the shadow
  is built and the nested-repository check has run), so the window starts as late as Pi can make it.
- For commands that only read them (`log show diff rev-parse rev-list ls-files ls-tree cat-file for-each-ref show-ref describe
  blame merge-base name-rev grep shortlog status add commit restore reflog`), `shallow` and `info/grafts` are read once with
  `O_NOFOLLOW` (a plain, single-name file only) into private copies in the 0700 shadow; git never opens the shared path. The
  copy is never written back. NOT done: private copies of the index, `FETCH_HEAD`, `packed-refs`, `ORIG_HEAD`, the refs and the
  reflogs. git takes those from `GIT_DIR` (the real per-worktree directory), which cannot be moved into the shadow without
  moving the index and refs with it, and copying the index in and out of a private directory would break git's own lock
  protocol (lost updates between concurrent Pi calls); that is too invasive for a hardening round, so those files remain
  exposed to the race.
- No quoted file content is relayed. git quotes the offending line of a malformed shared file in its error (`unexpected line in
  .git/packed-refs: <line>`, `bad shallow line: <line>`, `bad graft data: <line>`); if the file is a link the worker planted,
  that line belongs to some other file. Pi replaces the quoted part with `<line withheld>` (and `<content withheld>` for similar
  messages) in every stderr it relays. This removes the read-a-line-of-another-file leak, not the write.
- Hard links are refused on every regular file in the scan set (`config`, `HEAD`, `index`, `packed-refs`, `FETCH_HEAD`,
  `ORIG_HEAD`, `refs/**`, `logs/**`, `info/**`, and the same in each `worktrees/<n>/`): a hard link has no marker in the
  directory entry, so `nlink > 1` is the only sign. `objects/` is exempt (a local clone hard-links objects).
- The scan limit refusal says how to recover (`git pack-refs --all` / `git gc`), and `pack-refs` and `gc` alone are let through
  when the only problem is the amount; for them the scan is re-run with no entry limit, so padding the tree to exhaust the budget
  before a planted link is reached does not open the door.
- Removing a shadow never follows a link (`lstat` before every `chmod`, a link in place of a directory is unlinked, not entered).

Other changes in this round: a caller's own leading `-c key=value` cannot override a setting Pi forces or select a program,
endpoint, include or credential helper (both modes), and `--upload-pack`, `--receive-pack`, `--exec`, `clone -u`,
`--config-env` and `--exec-path` are refused; scp-like arguments (`host:path`, `user@host:path`) are URLs subject to the
operator's `pi.allowedRemote` (only the repository argument of fetch/pull/push/ls-remote/clone is tested for that form, so a
refspec such as `main:main` is not mistaken for a URL); git older than 2.40 is refused (no `GIT_ATTR_SOURCE`: attributes
could not be cut off), and the empty tree is asked of git per repository so sha256 repositories work; a `push` of a repository
whose attributes select `filter=lfs` is refused in strict mode as well, and a `[attr]` macro that sets a filter or an
attributes file over 1 MiB makes the push refused with the reason (Pi cannot tell, so it fails closed); the pin file is updated
under an advisory lock file (O_EXCL, stale after a minute or when its owner is gone, re-read under the lock, atomic rename), so
concurrent Pi processes cannot drop each other's pins; an unusable state directory is refused with its path and how to fix it
(Pi's state directory has no YAML key: its location is the existing machine-state setting, and this module reads no new
environment variable); a `git worktree add` whose results could not be moved back into the repository is rolled back (the work
tree and admin directory that call created), and the caller gets the failure.

Still not done, deliberately: private copies of the written files (above); a pre-push LFS upload step; a check that LFS pointer
files are actually present before refusing an LFS push (it would mean a `git grep` over every tracked blob per push, so a
repository that lists LFS patterns but has no LFS files is refused too); an in-memory pin store when the state directory is
unusable (the shadow needs the same directory, so the call is refused either way).
