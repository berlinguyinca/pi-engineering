# Live self-update and hot reload: implementation notes

Companion to `live-self-update-hot-reload.md`. The first two sections were
written before any code. They record what the running Pi allows, because the
shape of the Host follows from those limits.

## How pi-engineering was loaded (d553bcc)

- `package.json` `pi.extensions: ["./extensions"]`. Pi's loader resolves this
  to `extensions/index.ts` and imports it through **jiti** (`moduleCache: false`,
  with an alias map to Pi's own `@earendil-works/*`). The default export is a
  factory `(pi: ExtensionAPI) => void`. Pi awaits the factory, so an async
  factory is allowed.
- The factory registers about 60 `pi.on(...)` handlers, about 20 commands, the
  core tools and the InferWeave provider. It keeps a lot of state at module
  level: the `EngineeringRuntime` cache, panels, footer, control socket,
  telemetry sink and more. All of it is set up on `session_start` and torn down
  on `session_shutdown`. `EngineeringRuntime.close()` stops the
  MissionSupervisor and flushes the mission store without changing any
  mission's status.
- Nothing registered an `/engineering` command. `LifecycleHarness` contains a
  `/engineering <sub>` dispatcher, but nothing wired it up.
- Updating meant the legacy `/update`: a `git merge --ff-only` into Pi's
  package checkout, which then needed a Pi restart. This is the "git pull and
  hope" path that spec §61 rules out. It still exists, and `/engineering update`
  replaces it.

## What Pi's ExtensionAPI (0.87.1) permits

Verified from `dist/core/extensions/{loader,runner,types}.js` and by experiment
under the real `loadExtensions()`.

| API | Undoable? | Notes |
|---|---|---|
| `pi.on(event, h)` | returns an unsubscribe in 0.87.1 | Handlers are stored per extension in one list per event, and every emit snapshots that list. Results chain **per handler**: `before_agent_start` re-renders `systemPrompt` between handlers, `tool_result`, `message_end` and `context` hand the modified event on, and `tool_call` and `session_before_*` short-circuit. |
| `registerCommand(name)` | no unregister | Stored with `Map.set` by name, so registering again overwrites. The command list is resolved on every lookup, so a command added after load still appears. |
| `registerTool(def)` | no unregister | `Map.set` by name, then `refreshTools()`. An agent run that has already started keeps the tool list it captured. |
| action methods | n/a | Throw "ctx is stale" after a Pi `/reload` or a session replacement. Pi re-creates every extension for each new session. |

**What this forces on the Host**

1. Commands and tools cannot be removed, so the Host owns them. It registers
   one Pi forwarder per name, and the forwarder dispatches to whichever
   generation is active at call time. A tool captured by an older agent run
   still lands on the current generation.
2. Pi chains results per handler, so one forwarder per event that fans out to
   N handlers would break `before_agent_start`. The Host uses **slots**
   instead: handler *k* of event *e* in every generation maps to Pi slot
   *(e, k)*. A slot is registered once, the first time any generation needs
   it. Pi's handler count is therefore the maximum over generations, not the
   sum, and it never grows on reload.
3. `session_start` and `session_shutdown` are **Host-routed**. The Host
   delivers them to a generation itself, so a generation started in the middle
   of a session can replay `session_start`, and a stopped one can replay
   `session_shutdown`.
4. Action methods on a generation's API are **fenced**. Once a generation is
   retired, void actions do nothing and promise actions reject with
   `StaleGenerationError`.

## ESM caching, measured

The same result holds under Pi's jiti loader and under plain Node ESM. An entry
imported with `?generation=N` is re-evaluated, but its relative imports keep
their cached instances. Importing from a **different directory** gives fresh
code everywhere.

Every generation is therefore imported from its own immutable directory. That
directory is a snapshot of the runtime source under
`<installRoot>/generations/<pid>-…/`, and the generation query is added on top.
The one exception is generation 1 at Pi startup: it imports the package
checkout directly, so the legacy git-based behaviour is unchanged, and a
baseline copy is taken first so that a failed reload can roll back to the exact
code generation 1 ran. Installed versions are always snapshotted, so no process
ever runs code straight out of `versions/`.

## Shape

```
Pi ── src/runtime/host/extension.ts   EngineeringHostExtension (stable, loaded once)
        ├─ RuntimeHost (host.ts): generations, handover, health, rollback
        │    ├─ PiBridge (piBridge.ts): slots, forwarders, fenced API
        │    ├─ OperationRegistry (operations.ts): safe points, the gate
        │    ├─ RuntimeResourceRegistry (resources.ts)
        │    └─ RuntimeLoader (loader.ts): snapshot + unique import
        ├─ InstallLayout, RuntimeMutationLock, UpdateJournal, recovery,
        │  UpdateManager, gitSource, validate/probe, retention, rollback
        │  (src/update/*)
        ├─ migrations framework + schema marker (src/runtime/migrations/*)
        └─ generation N ── src/runtime/host/runtimeEntry.ts
                             adapter: the unchanged extensions/index.ts factory
```

`package.json` `pi.extensions` now points at the Host. `extensions/index.ts`
itself is unchanged and is the generation's feature code.

## User-visible behaviour

| Command | What happens |
|---|---|
| `/engineering reload` | Re-reads the runtime source (the checkout, the dev override, or the installed `current`), imports it as a new generation, and hands over. The same Pi process and conversation continue. |
| `/engineering update [--check] [--force] [--channel stable\|main] [--commit <sha>] [--verify-full]` | Runs CHECK → FETCH → STAGE → VALIDATE → install → handover → COMMIT. `--check` writes nothing except the download cache. |
| `/engineering rollback [version]` | Runs the same journaled handover to a retained version. If the state was migrated past what the target can read, it is restored from that migration's checkpoint. |
| `/engineering version` | Shows version, commit, channel, runtime API, generation, state schema, Pi compatibility, previous version, last update and last reload. |
| `/engineering status` | Shows the panel's Runtime/Update section as text. |
| `/engineering cancel` | Cancels a handover that is still waiting for a safe point. |

When a handover cannot start at once, the command returns straight away with
the reason, for example "Waiting for a safe runtime handover point… 1 running
command". The handover then finishes in the background and reports its result.
The panel's Session tab shows the same Runtime/Update section. A status line
reads "Pi Engineering X · Y available" when the automatic check (on by default,
every 4 hours) finds a newer version. Nothing is installed automatically
unless `autoInstall` is set in `update-preferences.json`.

### Configuration (environment)

| Variable | Meaning |
|---|---|
| `PI_ENGINEERING_HOME` | Install root (default `~/.pi/pi-engineering`). |
| `PI_ENGINEERING_RUNTIME_SOURCE` | Development override for the source tree to reload. |
| `PI_ENGINEERING_UPDATE_REMOTE` / `PI_ENGINEERING_UPDATE_TRUSTED` | Update source, and the comma-separated list of trusted sources. Default: the checkout's `origin`. |
| `PI_ENGINEERING_UPDATE_VALIDATION` | `quick` or `full`. The default validation already includes typecheck and critical tests when the candidate ships them. |
| `PI_ENGINEERING_UPDATE_CHECK=0` | Turns the automatic check off. |
| `PI_ENGINEERING_SAFE_POINT_TIMEOUT_MS` | Upper bound on the wait for a safe point. The default is to wait until cancelled. |

## Deliberate limits and residual risks

- **The legacy runtime reports no safe points of its own.** The adapter treats
  these as unsafe: a forwarded command or tool that is executing, and an
  assistant message that is streaming. A long `/engineer` call therefore holds
  the handover until it returns. The wait is observable, and the user can
  cancel it (§23).
- **Inference waits.** A mission parked durably (`PAUSED_INFRASTRUCTURE` /
  `WAITING_FOR_*`) does not hold an update. A mission waiting *inside* an
  in-flight `orchestrate()` call, in its auto-resume probe loop, does hold one,
  because that call cannot be fenced from outside. Generations that own their
  waits as disposable resources, as `test/support/missionRuntime.ts` shows, hand
  over immediately. Bringing the orchestrator itself to that model belongs in
  the orchestration code.
- **Restart resumption in the base runtime.** After a restart, an
  auto-resumable mission still `RUNNING` under the old owner's lease is
  reported by the supervisor as `MONITOR` until something resumes it. This is
  existing behaviour on a Pi restart, not something introduced by the handover.
- **Legacy `/update` only works when generation 1 runs from the git checkout.**
  A generation loaded from a snapshot reports "not a git checkout". Use
  `/engineering update`.
- **Dependencies.** An unchanged lockfile reuses the running dependency tree.
  A changed one runs `npm ci --ignore-scripts` in staging
  (`PI_ENGINEERING_UPDATE_INSTALL_DEPS=0` refuses instead).
- **Signatures.** Commits are not signature-verified. Source identity is the
  repository's root commit plus reachability from a fetched branch or tag. The
  trusted remote list, TLS and the protocol allow-list carry the rest.
