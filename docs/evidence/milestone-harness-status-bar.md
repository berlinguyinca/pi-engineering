# Evidence — Milestone: Live harness status bar (footer)

Implements `docs/specs/pi-engineering-harness-live-status-bar-spec.md` into the
existing `pi-engineering-harness` extension. The harness owns the Pi footer via a
**single composable footer implementation**; no competing `setFooter` calls.

## What changed

- **`src/status/`** — a reusable, structured runtime-telemetry layer (built for
  future subprocess/subagent contribution):
  - `config.ts` — env-driven `PI_STATUS_BAR_*` config (`windowMs` default 2500ms,
    `refreshMs` 150ms, git TTL 30s), `DEFAULT_STATUS_BAR_CONFIG`,
    `resolveStatusBarConfig`.
  - `state.ts` — `HarnessStatusState`, `ThroughputState` (phase, current/last
    TPS, output tokens), and the future `WorkerStatus` schema.
  - `throughput.ts` — `ThroughputTracker` with injected clock; authoritative
    cumulative-token samples over a rolling window, char-estimate fallback
    (chars/4, batch 32) when the provider doesn't report tokens; rolling rate =
    `(newest−oldest tokens)/(Δt)`; `endGeneration()` reconciles the final
    authoritative `usage.output`; idle retains `lastCompletedTokensPerSecond`;
    `reset()` on model/context switch.
  - `git-context.ts` — host-agnostic `parseRemoteOrigin` (strips `.git`), and
    `GitContextProvider` that caches per-cwd and only re-resolves on explicit
    invalidation (cwd/branch change, TTL) — **never during a render**. Detects
    linked worktrees (`wt:<name>`) from the git-dir `worktrees/<name>` segment
    and detached HEAD (short SHA); degrades gracefully to `insideGit:false`.
  - `layout.ts` — pure `renderStatus(state, width, config)`: progressive elision
    by priority (TPS > model > branch > worktree > repository > directory), path
    abbreviation, and truncation so the line never wraps; **always preserves
    model + TPS** as the irreducible core.
  - `footer.ts` — `FooterController`, the **single owner** of `setFooter`;
    throttles/coalesces redraws to `refreshMs`; handles message/model/cwd events;
    `dispose()` restores the default footer and unsubscribes.
- **`extensions/index.ts`** — module-level `activeFooter` + `statusBarConfig`
  guard so only one footer is ever active; `pi.on` wiring for
  `session_start`/`message_start`/`message_update`/`message_end`/
  `model_select`/`session_shutdown`; `/harness-status` diagnostic command.
- **`scripts/status-bar-demo.ts`** — repeatable live demo: primary/linked
  worktree, detached HEAD, non-git dir, multi-width layout, and rolling TPS over
  a simulated stream (fake clock, no sleeping).

## Requirements met

- Single composable footer — `FooterController` is the only `setFooter` owner.
- Shows cwd, canonical repo, worktree, branch/detached ref, provider/model, and
  live output tokens/sec while streaming.
- Rolling 2.5s TPS window; idle retains last completed TPS; updates on
  model/branch/worktree/context changes.
- No git/expensive work during render; throttled/coalesced streaming rerenders;
  graceful degradation outside git or without provider usage; reusable
  structured telemetry state.

## Machine evidence

- `npm test` — **345 pass / 0 fail / 1 opt-in skip** (346 total; up from 344).
  Status suite: `status-throughput` (10) + `status-git` (15, incl. new
  **"cached resolve spawns no git subprocess"**) + `status-layout` (11) +
  `status-lifecycle` (7) = **43 passing**.
- `npm run typecheck` (`tsc --noEmit`) — **passes**.
- `npm run lint` (`biome check .`) — **passes** (0 errors).
- `node scripts/status-bar-demo.ts` — all scenarios render: primary worktree at
  widths 140/100/70/50/40, live rolling TPS (800.0 t/s over 2.5s window),
  authoritative idle reconcile, `wt:statusbar-demo-wt`, detached `@<sha>`, and
  non-git graceful degradation.
- `HOME=<fresh> node scripts/smoke-extension.ts` — **EXTENSION LOAD OK**;
  `test:e2e` reports the `harness-status` command and all 12 commands / 6 tools.

## Git subprocess guarantee

`GitContextProvider.resolve` is cached per-cwd/TTL and only invalidated on
cwd/branch change. The unit test proves a second `resolve` within the TTL spawns
**zero** additional git subprocesses; `renderStatus` is pure (never touches git),
and `FooterController` only resolves git on session/cwd/branch events — never on
`message_update` — so streaming rerenders add no git work.

## Validation performed

- format, lint, typecheck, full test suite;
- live exercise via the status-bar demo (branch changes, linked worktree,
  detached HEAD, model switching, wide/narrow terminals, outside-git);
- extension load smoke test with a fresh HOME (isolating from the globally
  installed duplicate copy);
- verified no continuous git subprocess spawning (unit + code inspection).

## Limitations

- TPS is only live while the provider reports cumulative output tokens during
  streaming; otherwise it uses a char/4 estimate and reconciles to the
  authoritative `usage.output` at `message_end`.
- Interactive TUI visual inspection (actual terminal rendering) still requires a
  human at a real pi session; the demo validates layout math and live TPS
  deterministically without sleeping.
