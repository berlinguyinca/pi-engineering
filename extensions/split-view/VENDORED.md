# Vendored: pi-split-view

| | |
|---|---|
| Upstream | https://github.com/Hugo-W/pi-split-view |
| Pinned commit | `6b6b98a3166d1d58b26e81c1f31109e829d336e8` (`6b6b98a`) |
| License | MIT (see `LICENSE`, copied verbatim) |
| Files | `split-view.ts` (extension), `layout-manager.ts`, `ui-panels-config.ts` (shared modules) |
| Modifications | **None.** The only difference from upstream is a 2-line provenance comment at the top of each `.ts` file. |

`ui-panels-config.ts` is a shared module (it has a no-op default export) and is
deliberately NOT listed in `package.json` `pi.extensions`; only `split-view.ts` is.

## Integration

- `package.json` -> `pi.extensions`: `["./src/runtime/host/entry.ts", "./extensions/split-view/split-view.ts"]`.
  Pi's loader (`core/extensions/loader.js`) loads each entry independently with its own
  jiti import and factory call; a load/factory error in one entry is recorded and skipped, it
  cannot break the other. So the `entry.ts` shim's fallback behaviour (Host -> legacy
  extension) is unaffected by this extension.
- Off by default: upstream's config default is `split=false` (no `~/.pi/agent/ui-panels.json`
  means no panels, native Pi layout). Nothing changes until the operator runs `/split`
  (or `/files`). `pi --no-split` forces bare start even if `ui-panels.json` enables panels.
- Excluded from this repo's `tsc` (`tsconfig.json` `exclude`) and Biome (`biome.json`
  `files.ignore`) because upstream targets looser compiler options (`erasableSyntaxOnly`
  parameter properties, no `noUncheckedIndexedAccess`) and tab indentation. Pi loads it with
  jiti, which handles that syntax. The code is not rewritten to satisfy our lint rules.

## Security audit (at the pinned commit)

- No network access (`fetch`, `http`, `net`, sockets absent) and no process execution
  (`child_process`, `exec`, `spawn` absent). Imports: `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `node:fs` (`existsSync`, `statSync`, `readFileSync`, `writeFileSync`),
  `node:os` (`homedir`), `node:path`.
- The only write is `~/.pi/agent/ui-panels.json`, and only on the explicit `/split-save` command.
  Reads: that same file, plus `existsSync/statSync` on paths of files the agent touched (files panel).
- Registers commands only. No `registerShortcut`, no terminal-input interception, no tools.
  It registers one CLI flag, `--no-split`.
- It observes `message_*`, `tool_*`, `session_*` events and `subagents:tool_call` to render panels.
  It sees the same data any extension sees (including thinking text) but never transmits it.

## Conflict review against pi-engineering

- Commands vs. every `registerCommand` in `extensions/`, `src/`: no overlap
  (`/split`, `/split-thinking`, `/split-tools`, `/split-tools-view`, `/split-tools-width`,
  `/split-height`, `/split-trim-response`, `/split-save`, `/files`). Enforced by
  `test/unit/split-view-vendor.test.ts`.
- Shortcuts: none registered by either side.
- UI surfaces: split-view uses `ctx.ui.setWidget("split-view", ...)` and, only when panels are
  on, a fullscreen layout layer / overlay. It never calls `setFooter`, `setHeader` or `setStatus`,
  so `src/status/footer.ts` (the only `setFooter` caller) and the status keys
  (`openviking`, `pi-engineering:*`, `inference-admission`, widgets `engineering`, admission
  widget) are untouched. Residual (cosmetic, only after the operator enables `/split`): its
  layout layer shares the screen with pi-engineering's widgets above/below the editor.

## Update procedure

1. `git clone https://github.com/Hugo-W/pi-split-view /tmp/sv && cd /tmp/sv && git log -1`.
2. Diff the three files against `extensions/split-view/` (ignoring the 2-line header):
   `diff <(tail -n +3 extensions/split-view/split-view.ts) /tmp/sv/split-view.ts`.
3. Re-audit the diff for: network/exec imports, new `registerShortcut`/input handlers,
   new filesystem writes, new `setFooter`/`setStatus` use.
4. Copy the files, re-add the header with the new commit hash, update the table above.
5. Run `npm run typecheck && npm run lint && node --test --test-concurrency=1 test/unit/split-view-vendor.test.ts`.

## Rollback

Remove `"./extensions/split-view/split-view.ts"` from `package.json` `pi.extensions` and restart
Pi (or `/reload`). Optionally delete `extensions/split-view/` and `~/.pi/agent/ui-panels.json`;
the vendor test then fails by design - delete `test/unit/split-view-vendor.test.ts` with it.
