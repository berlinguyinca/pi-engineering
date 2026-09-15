# Engineering panel and live status

The operator wants to see what the runtime is doing without reading the
transcript: which files changed, what they contain, what was reviewed and by
whom, which models ran, what was spent, and — when nothing appears to be
happening — why the runtime is waiting.

Two surfaces deliver this, both fed from one state layer:

- a **toggleable overlay panel**, anchored right, with keyboard-navigable,
  searchable, resizable tabs: changed files, reviews, token spend, a running
  session narrative, and memory counts;
- the **existing status footer**, extended to name the current task, the active
  model, and the reason for any wait.

Delivery is three tracks. Track 1 (status footer) ships first and validates the
state-feeding shape. Track 2 (panel) builds on the same state: the overlay, the
feeders, the tree, and the file view. Track 3 adds what makes the panel livable
— tabs, persisted layout, search, copy, the memory readout, and the generated
session narrative.

## Behavior — status footer (track 1)

The footer reports **why** the runtime is idle whenever it is not the operator's
turn to act. A gateway backoff renders as `⏳ gateway 30s · queue_timeout`,
counting down; verification and worker waits render in the same slot with their
own kind. The wait segment holds the highest layout priority — it is the single
piece of information that explains an apparently frozen session, so it survives
every width reduction that keeps any segment at all.

The footer names the current engineering task (`WI-12 implement`) while a run is
active, and clears it when the run settles. It names the model actually
producing tokens: the interactive model in ordinary chat, and the worker's model
during a run, so a routed or fallback model is never mistaken for the session
model.

Render remains free of git, network, and token work: the footer paints
precomputed state only, and coalesces updates rather than rendering per token.
Any unexpected state renders as an empty string rather than throwing into Pi's
render loop.

## Behavior — panel (track 2)

`/panel` toggles a right-anchored overlay at 35% terminal width, with a floor of
36 columns; below 100 terminal columns the overlay does not render at all, so it
never crowds the chat. Toggling focuses the panel; escape closes it and returns
focus to the editor. Closing preserves expansion and selection state for the
next open.

The extension API registers commands but not app keybindings, so the hotkey is
implemented with a raw input handler (`ctx.ui.onTerminalInput`) that consumes a
single configurable chord — `ctrl+p` by default — and passes every other key
through untouched. The chord is configurable, and settable to none, so it can
never shadow a binding the operator relies on.

Navigation is keyboard-first: up/down move the selection, right or enter expands
a node or opens a file, left collapses. Rows are additionally wrapped in
`MouseRegion`, so pointer clicks work when Pi runs in fullscreen TUI mode and are
inert otherwise. Mouse input is an enhancement; every action is reachable from
the keyboard.

During an engineering run the panel shows the active work item and phase, its
candidates, each candidate's changed files, the review findings recorded against
it (severity, reviewing role, and the model that produced the review), and token
spend grouped by model. Outside a run it shows the git working tree and the
operator's own session usage, so the panel is never empty.

Selecting a file replaces the panel body with a bounded content view. Candidate
diffs are read lazily through the artifact store by URI; working-tree files are
read from disk. Both are capped and scrolled rather than loaded whole, and
neither is inlined into model context.

## Behavior — tabs

The panel body is tabbed; `tab`/`shift+tab` cycle, and the active tab is
remembered:

| Tab | Content |
| --- | ------- |
| Files | changed files (candidate or working tree), opening into the content view |
| Reviews | findings grouped by candidate: severity, reviewing role, model |
| Tokens | spend grouped by model, for the run and for the session |
| Session | the running narrative of what this session has worked on |
| Memory | session memory counts, and what was promoted to durable memory |

### Session narrative

The Session tab answers "what have we actually been doing?" — a short prose
arc such as *"started on a status-bar update, moved to gateway error handling,
now working on the panel"*. It is model-generated, and it is the only generated
content in the panel, so it carries three constraints:

It is fed **deltas, not transcripts**: new work items, phase transitions,
commits, and changed-file sets since the last update. A summary is requested
only on meaningful events and is debounced, never per token or per turn, and
never more than once per configured interval.

It runs through the **same admission gate as every other model call**, so the
narrator can never compete with engineering work for a saturated gateway, and
it is skipped entirely while a cooldown is active — a narrative update is never
worth delaying a run. Note for the implementer: the gate is not automatic.
`AdmissionController.acquire()` is called from `PiWorkerExecutor` only, so a
narrator that reaches a model by any other path bypasses it silently. Route the
narrator through the worker executor, or acquire a slot explicitly.

It is **labeled as generated and never becomes evidence**. The narrative is
displayed with its source and is never written to the ledger as a fact, claim,
or hypothesis. Nothing downstream may read it back as input to a decision.

Failure is silent: no model, a refused gateway, or a failed summary leaves the
previous narrative in place with its timestamp, and the tab says when it was
last updated rather than pretending to be current.

### Memory readout

The Memory tab reports what this session put into memory: entries recorded,
promotion candidates, promotions to durable memory, and memory-worker runs.
Every one of those counters already exists on the Blackhole manager state and is
exposed by `blackholeTelemetry()`, so this is a read model like the rest of the
panel. Blackhole is off by default; when it is off the tab says so rather than
showing zeros that look like a failure.

## Behavior — layout, search, and copy

**Resizing and persistence.** The panel's width, the content view's split, the
active tab, and which nodes are expanded are all adjustable and all remembered.
Width adjusts with `<`/`>` in steps, bounded by the same floor and terminal-width
rules as the default. Layout persists to the **agent profile**, not the
repository — the same location and atomic, owner-only write used by the memory
connection settings — so it survives extension updates and never lands in a
project's git history. A corrupt or unreadable layout file degrades to defaults
rather than failing the panel.

**Vim-style search.** `/` opens a search prompt over the visible rows; `n` and
`N` step through matches; `esc` cancels and restores the prior selection. Pi's
TUI already ships the matching primitives (`findAltScreenSearchMatches`,
`AltScreenSearchIndex`, and a search component), so the panel reuses them rather
than carrying its own matcher, and inherits their match caching.

**Copy.** `y` copies the selected row, and `Y` the visible body, to the system
clipboard via OSC 52, which needs no dependency and works over SSH. In
fullscreen mode Pi's own selection copy remains available alongside it. Where a
terminal refuses OSC 52 the panel reports that the copy did not happen rather
than silently doing nothing.

## Architecture

State, feeders, rendering, and lifecycle are separate units, following the split
already proven in `src/status/`:

```
src/panel/
  PanelState.ts                structured state + subscribe/publish
  feeders/LedgerFeeder.ts      run view, derived from the ledger
  feeders/WorkspaceFeeder.ts   idle view: git status + session usage
  feeders/MemoryFeeder.ts      blackhole telemetry -> memory counts
  narrator/Narrator.ts         debounced, admission-gated session summariser
  narrator/deltas.ts           pure: state changes -> the prompt's delta list
  tree.ts                      pure: PanelState -> renderable rows
  search.ts                    pure: rows + query -> match positions
  layout.ts                    persisted layout (width, tab, expansion)
  clipboard.ts                 OSC 52 copy
  PanelComponent.ts            pi-tui Component: paint rows, move selection
  PanelController.ts           OverlayHandle lifecycle, toggle, focus, dispose
```

`tree.ts` is the load-bearing seam. All tree shaping — grouping, expansion,
selection clamping, truncation — is a pure function from state to a flat row
list (`depth`, `glyph`, `label`, `payload`, `selectable`). The component knows
only how to paint rows and move a cursor, so the behavior worth testing needs no
terminal.

`PanelState` and `HarnessStatusState` are distinct state objects with one
publish/subscribe shape. The footer subscribes for the task and wait segments;
the panel subscribes for its tree. Neither surface reaches into the other.

## Data flow

The `LedgerFeeder` is a read model over data the runtime already persists. No
new recording is required:

| Panel content | Existing source |
| ------------- | --------------- |
| changed files | `Candidate.changed_files` |
| file contents | `Candidate.diff_artifact_uri` via the artifact store |
| reviews | `LedgerEntity` of kind `finding` (`severity`, `candidate_id`) |
| who reviewed | `Candidate.producer_role`, `Actor.role` |
| which model | `Actor.model`, `WorkerUsage.model` |
| token spend | `WorkerUsage` (`input`, `output`, `cost`) |
| task and phase | `WorkItem` (`goal`, `status`, `risk`) |

The `WorkspaceFeeder` supplies the idle view from `git status` plus
`ctx.getContextUsage()` and `ctx.sessionManager.getEntries()`. Git results are
TTL-cached and invalidated on branch change, reusing the `GitContextProvider`
approach; git never runs on the render path.

Wait state reaches the footer from the gateway admission controller, which
already reports the wait, its machine reason, and the remaining cooldown.

## Boundaries

The panel is a read surface. It renders recorded state and never writes to the
ledger, never mutates a worktree, and never starts model work.

Register the command, the input handler, and the overlay only from the extension
entry point. Worker sessions load an empty extension set, which preserves
independent review and challenge; nothing here may change that.

Panel content is not model context. Artifact URIs travel; artifact bodies do not
enter any prompt as a side effect of being displayed.

The session narrative is generated text, not a record. It is labeled as such,
never written to the ledger, and never read back as input to any engineering
decision — the ledger's separation of machine evidence from agent-authored
claims (INV-006) is not weakened by a convenience summary.

Persisted layout lives in the agent profile, holds no repository content and no
credentials, and is written atomically with owner-only permissions.

Guard against the render contract already established for the footer: no git,
no network, no unbounded work while painting, and coalesced updates so a
streaming run cannot cause a render storm.

A feeder failure degrades to a marked, empty section carrying the last known
good data where available. A broken git invocation, an unreadable artifact, or a
malformed ledger record must never throw into Pi's render loop.

## Constraints

Pointer input is captured only in Pi's fullscreen TUI mode; regular mode leaves
the terminal owning its scrollback. Clicking is therefore conditional on the
operator's TUI mode, and the keyboard path is the contract.

Overlay width is a percentage with a minimum floor, and the overlay suppresses
itself on narrow terminals rather than crowding the chat.

Clipboard access from a terminal program is not guaranteed: OSC 52 is the
portable path and some terminals disable it. The panel reports a failed copy
instead of pretending to have copied.

The session narrative costs model calls. It is debounced, delta-fed, gated
behind admission control, and can be turned off entirely; a panel that is
expensive to keep open would not be kept open.

## Acceptance criteria

Track 1 is complete when the footer names the current task during a run, names
the model producing tokens, and renders a counting-down wait with its machine
reason during a gateway backoff — with the wait segment surviving width
reduction, and with no git or network call on the render path.

Track 2 is complete when the overlay toggles and returns focus cleanly, renders
the run tree and the idle tree from their respective feeders, opens both a
candidate diff and a working-tree file in a bounded content view, and survives a
failing feeder by degrading the affected section rather than the session.

Track 3 is complete when tabs cycle and the active tab, width, and expansion
survive a restart; `/`, `n`, `N` search the visible rows; `y` copies a row;
the Memory tab reports this session's counts (and says so when Blackhole is
off); and the Session tab shows a model-generated narrative that is debounced,
skipped during a gateway cooldown, labeled as generated, absent from the
ledger, and left intact with its timestamp when an update fails.

## Testing

Pure-function tests cover `tree.ts` (state to rows, expansion, selection
clamping, truncation) and the new footer segments, following
`test/unit/status-layout.test.ts`. Feeder tests run against an in-memory ledger
and a temporary git repository, following `test/unit/status-git.test.ts`.
Registration is covered headlessly in `scripts/smoke-commands.ts`, which asserts
the command loads without a TUI, and a unit test asserts the input handler
consumes only its configured chord and passes all other input through. The component itself stays thin enough that its
logic lives in the tested pure code.
