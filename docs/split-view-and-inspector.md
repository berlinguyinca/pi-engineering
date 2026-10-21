# Split view and the Herdr agent inspector feed

Two independent, optional, off-by-default features. Core Pi Engineering requires neither.

## 1. split-view (vendored)

Upstream: https://github.com/Hugo-W/pi-split-view (MIT), vendored unmodified at commit `6b6b98a`
in `extensions/split-view/` (see `extensions/split-view/VENDORED.md` for provenance, audit, update procedure).

**Install**: nothing to do. `package.json` `pi.extensions` lists it after the main entry:

```json
"extensions": ["./src/runtime/host/entry.ts", "./extensions/split-view/split-view.ts"]
```

Pi loads each entry independently, so a failure in one never affects the other (the `entry.ts` Host ->
legacy fallback is untouched).

**Use**: off until you ask. Native Pi layout and keyboard shortcuts are unchanged (the extension
registers no shortcuts).

| Command | Effect |
|---|---|
| `/split` | toggle all panels (thinking + tools band over the transcript) |
| `/files` | toggle the files panel (edit diffs) |
| `/split-thinking`, `/split-tools` | toggle a panel within the band |
| `/split-tools-view`, `/split-tools-width <pct>`, `/split-height <rows>`, `/split-trim-response` | layout tweaks |
| `/split-save` | write the current layout to `~/.pi/agent/ui-panels.json` as startup defaults for new windows |

`pi --no-split` starts bare even if `ui-panels.json` enables panels. The thinking panel displays
reasoning text in your local terminal only; it is not sent anywhere.

**Conflicts**: none with pi-engineering commands; no shortcuts; no `setFooter`/`setStatus`; widget key `split-view`
(only used once enabled). Checked by `test/unit/split-view-vendor.test.ts`.

**Rollback**: remove `./extensions/split-view/split-view.ts` from `pi.extensions` and restart/`/reload`.

## 2. Agent inspector feed (Pi -> Herdr)

Streams bounded, observable per-agent detail (messages, tool calls, edit diffs, test runs, usage, model
switches, association, lifecycle, and optionally reasoning) to the Herdr control plane so Herdr's session
view can show what an agent is doing. Wire contract (authoritative, owned by the Herdr side):
`herdr-engineering/docs/contracts/agent-inspector-event.md`.

It reuses `src/runtime/herdr/ControlPlaneIngest.ts` (one added method, `emitBatch`, which is
`emit("inspector", sessionId, "inspector.batch", {events})`); there is no second HTTP client. Implementation:
`src/runtime/herdr/InspectorFeed.ts`; wired in `extensions/index.ts` via `attachInspectorWhenReady` (`src/runtime/herdr/attachInspector.ts`).
(`ControlPlaneIngest` is not constructed anywhere else in production today, so the feed builds its own
instance from the central config's URL.)

**Enable**: centrally, per host. The feed is configured by the fleet's central configuration, not by
environment variables. `herdr-eng fleet join` writes `~/.config/herdr-engineering/host.json`
(`control_plane_url`, `host_id`, `token`); Pi fetches `GET {control_plane_url}/api/v1/fleet/config` once at
startup (3 s timeout, in the background, never blocking the session; the last good copy is cached in
`~/.cache/herdr-engineering/fleet-config.json`). Nothing is subscribed or sent unless that config loads **and**
`inspector.enabled` is exactly `true`. A machine without `host.json` simply has no inspector.

| Central config key | Meaning |
|---|---|
| `inspector.enabled` | `true` to opt this host in to the inspector feed |
| `inspector.reasoning` | `off` (default), `summary` or `full` - see privacy |
| `agent.api_key` (else `ingest.api_key`) | ingest key sent as `X-API-Key` |

The control-plane URL comes from `host.json`. `HERDR_PANE_ID` (set by Herdr) is still used as the entity id, so it
equals the `session` entity; it falls back to Pi's session id. The old `HERDR_CP_URL`, `PI_INSPECTOR_FEED`,
`PI_INSPECTOR_REASONING` and `HERDR_CP_API_KEY` variables are no longer read.

**Disable**: set `inspector.enabled` to `false` centrally and restart Pi (config applies at process start only).
A revoked host token (HTTP 401) discards the cache and disables the feed. Nothing persists.

**Bounds and overhead**

- Queue cap 500 events; when full, streaming `update` events are dropped first, then ordinary events.
  Tool `end`, lifecycle and capabilities are never evicted for lower-priority events (hard ceiling 2x cap).
- Flush every 250 ms (unref'd timer) or at 50 queued events; batches <= 100 events.
- Tool `update`s coalesce per call id to the latest tail (<= 4KB); tool output on `end` <= 16KB head+tail
  (`truncated: true`); diffs <= 64KB; message text <= 16KB.
- One request in flight; after a failure the batch is dropped (no retry storm) and the feed backs off
  1s -> 30s. The number of dropped events is reported as `dropped` on the next `lifecycle` event
  (it repeats the last phase, which the server treats as a no-op besides adding to `client_dropped`).
- Handlers never throw into Pi and never await the network. On quit the final `ended` event is
  best-effort (the process may exit before it is delivered; Herdr then shows the session as interrupted).

**Event mapping** (Pi event -> contract kind): `session_start`/`session_shutdown` -> `lifecycle`
(`resume` => `restored`, `reload` or a repeated id => `restarted`) + `capabilities` + `association`
(worktree = cwd, branch via `GitRepo`); `message_start`/`message_end` -> `message`;
`message_end.usage` + `ctx.getContextUsage()` (through `contextReading`) -> `usage`;
`tool_execution_*` -> `tool`; `tool_call` (reads) and `tool_result` (edit/write, `details.diff`) -> `file`
(`details.diff` is Pi's display diff with `+`/`-` lines; additions/deletions count those lines);
`bash` commands that look like test runners (npm/pnpm/yarn test, node --test, jest, vitest, pytest, cargo
test, go test, ...) -> `test` start/end; `model_select` -> `model` (reason `fallback` when the automatic
fallback switch is active); `subagents:tool_call` -> `tool`/`file` with `agent_id` and `parent_agent_id: "main"`;
mission linkage (`/mission` start/resume) -> `association.mission_id`.

**Tests**: counts and failing names are parsed only from recognised summaries (node:test, jest, vitest,
pytest, cargo); otherwise only start/end and the exit code are sent. Counts are never invented.

**Privacy**

- Reasoning is **off by default** and **capability-dependent**. `capabilities.reasoning` is `none` until Pi
  actually delivers `thinking_*` stream events for the current model, then `full` (raw thinking) or `summary`
  (Responses-style APIs, which deliver provider summaries). `reasoning` events are sent only if thinking text
  was really received **and** the central `inspector.reasoning` is `summary` or `full`. Nothing is synthesised.
  With `off`, thinking text is never even buffered.
- The client does not redact content beyond truncation: Herdr redacts at its ingest boundary and gates access
  by role. The client adds `sensitive: true` for paths such as `.env*`, `*.pem`, `*.key`, `id_rsa`, `.ssh/`,
  `.aws/`, `.npmrc`, `credentials`, so the server withholds those bodies from non-operator roles. Tool output
  and diffs are otherwise sent verbatim (subject to the caps above). Only enable the feed against a control
  plane you trust (note: `ControlPlaneIngest` sends no auth header; use a network-restricted endpoint).

**Tests**: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/inspector-feed.test.ts`.
