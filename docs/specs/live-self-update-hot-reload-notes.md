# Live self-update / hot reload — implementation notes

Companion to `live-self-update-hot-reload.md`. Written before the code, kept
current with it. It records what the running Pi allows, because that, not
taste, decides the shape of the Host.

## How pi-engineering is loaded today (d553bcc)

- `package.json` `pi.extensions: ["./extensions"]`. Pi's loader resolves the
  directory to `extensions/index.ts` and imports it through **jiti**
  (`moduleCache: false`, alias map to Pi's own `@earendil-works/*`). The
  default export is a factory `(pi: ExtensionAPI) => void`. Pi awaits it, so an
  async factory is allowed.
- The factory registers about 60 `pi.on(...)` handlers, about 20 commands
  (`/engineer`, `/mission`, `/update`, `/panel`, and so on), and the core tools
  (`buildCoreTools(resolveServices)`). It also registers one provider
  (InferWeave) and calls `sendMessage`, `sendUserMessage` and `setModel`.
- The factory keeps a lot of state at module level: the `runtimes` cache of
  `EngineeringRuntime` per repo root, panels, footer, control socket, telemetry
  sink, and so on. It sets that state up on `session_start` and tears it down
  on `session_shutdown`. `shutdownCachedRuntimes()` calls
  `EngineeringRuntime.close()`, which stops the MissionSupervisor and flushes
  the mission store.
- No `/engineering` command is registered. `LifecycleHarness` has a
  `/engineering <sub>` dispatcher, but nothing wires it up.
- Today's update is the legacy `/update`: a `git merge --ff-only` into Pi's
  package checkout. It runs automatically at `session_start` and needs a Pi
  restart or a Pi `/reload` before the new code runs. This is the "git pull and
  hope" path that spec §61 rules out. It still exists, but `/engineering update`
  replaces it.

## What Pi's ExtensionAPI (0.87.1) permits

Verified from `dist/core/extensions/{loader,runner,types}.js` and from
experiments run under the real `loadExtensions()`.

| API | Undoable? | Notes |
|---|---|---|
| `pi.on(event, h)` | Returns an unsubscribe in 0.87.1 | Handlers live per extension, in a list per event. Each emit takes a snapshot of that list. Results chain **per handler**: `before_agent_start` re-renders `systemPrompt` between handlers; `tool_result`, `message_end` and `context` pass the modified event on; `tool_call` and `session_before_*` short-circuit. Older Pi typings returned `void`. |
| `registerCommand(name)` | No unregister | `Map.set` by name: re-registering overwrites and never duplicates. The command list is resolved on every lookup, so a command added after load still shows up. |
| `registerTool(def)` | No unregister | `Map.set` by name, then `refreshTools()`. An agent run that is already going keeps the tool list it captured. |
| `registerShortcut/Flag/MessageRenderer/Provider` | Overwrite by key | `unregisterProvider` exists. |
| action methods | n/a | After a Pi `/reload` or a session replacement they throw "ctx is stale". |

**Consequences for the Host**

1. Commands and tools cannot be removed. The Host therefore owns them, and each
   generation sees a proxy `ExtensionAPI`. The Host registers a forwarder with
   Pi once per name, and the forwarder dispatches to the generation that is
   active at call time. A tool that an older agent run captured still lands on
   the current generation.
2. Pi chains event results per handler, so one forwarder per event that fans
   out to N generation handlers would break `before_agent_start` and
   `tool_result` semantics. The Host uses **slots** instead. Handler *k* of
   event *e* in any generation maps to Pi slot *(e, k)*. A slot is registered
   with Pi the first time any generation needs it and is never registered
   again. The number of Pi handlers is therefore the maximum over generations,
   not the sum, and it does not grow on reload. This holds whether or not
   `pi.on` returns an unsubscribe.
3. Action methods on the proxy are **generation-fenced**. A call from a stale
   generation does nothing: void methods are dropped, and promise methods
   reject with `StaleGenerationError`.

## ESM caching: the experiment

Run under Pi's real jiti loader and under plain Node ESM. An entry imported
with `?generation=N` re-evaluates **only the entry**. Its relative imports keep
their cached instances. Editing `dep.ts` and importing `entry.ts?generation=2`
still returns the old `VALUE`. Importing from a **different directory** returns
the new code under both loaders.

So every generation loads from a unique, immutable directory: a snapshot of
the runtime source under `<installRoot>/generations/`, and the query string on
top of that. Generation 1 at startup imports straight from the package
checkout, so startup does not change. The Host also writes a baseline copy of
that checkout so that a failed reload can roll back to the exact code
generation 1 ran.

## Shape

```
Pi ── src/runtime/host/extension.ts   (Host: stable, registers once)
        ├─ PiBridge (slots, command/tool forwarders, fenced proxy API)
        ├─ RuntimeHost (generations, handover, health, rollback)
        ├─ OperationRegistry / safe points (host-tracked: tool exec,
        │   assistant streaming, forwarded commands)
        ├─ UpdateManager / journal / lock / migrations (src/update/*,
        │   src/runtime/migrations/*)
        └─ generation N ── src/runtime/host/runtimeEntry.ts
                             (adapter: the existing extensions/index.ts
                              factory driven through the proxy API)
```

`extensions/index.ts` is unchanged. It is the feature code of the reloadable
generation. Stopping a generation replays `session_shutdown` with reason
`reload` into that generation's handlers, which closes `EngineeringRuntime` and
leaves missions durable. Starting a generation replays `session_start` with
reason `reload`. The new runtime then reopens the stores and
`MissionSupervisor.reconcileOnStartup()` rehydrates the missions.

## Deliberate limits

- The legacy runtime does not report safe points itself. The adapter treats
  these as unsafe: a forwarded command or tool that is executing, and an
  assistant message that is streaming. A long `/engineer` command therefore
  holds the handover until it returns. The wait is observable and the user can
  cancel it (§23).
- Legacy `/update` only works in a generation loaded from the git checkout. A
  snapshot generation is not a checkout, so it reports "not a git checkout".
  Use `/engineering update`.
