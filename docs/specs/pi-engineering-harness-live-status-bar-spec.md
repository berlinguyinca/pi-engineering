# Pi Engineering Harness — Live Execution Context Status Bar

## Status
Implementation specification

## Scope

Implement this **inside the existing `pi-engineering-harness` extension**. Do **not** create or require a standalone footer/status-bar package.

The harness should own and render a compact, responsive execution-context footer that makes it immediately obvious:

- how fast the current model is generating,
- which model/provider is active,
- which repository is active,
- which Git worktree is active,
- which branch/ref is checked out,
- and which directory Pi is currently operating in.

This footer is part of the harness observability/telemetry subsystem and should be designed so subprocess/subagent telemetry can be added later without replacing the implementation.

---

## Primary UX

Example full-width footer:

```text
~/src/inferweave │ inferweave/inferweave │ wt:feature-routing │ feature/routing │ qwen3.8-27b │ ⚡ 73.4 t/s
```

If provider identity is useful/ambiguous:

```text
~/src/inferweave │ inferweave/inferweave │ wt:feature-routing │ feature/routing │ inferweave/qwen3.8-27b │ ⚡ 73.4 t/s
```

Medium width:

```text
inferweave │ wt:feature-routing │ feature/routing │ qwen3.8-27b │ ⚡73 t/s
```

Narrow width:

```text
feature/routing │ qwen3.8-27b │ ⚡73 t/s
```

The footer must never become unreadable merely because the terminal is narrow.

---

## Required Fields

### 1. Current throughput

Display live output throughput:

```text
⚡ 73.4 t/s
```

Requirements:

- Update while the assistant is streaming.
- Use a rolling time window so the displayed value represents **current** throughput rather than whole-response average.
- Default rolling window: 2.5 seconds.
- Update/redraw no more frequently than necessary; target approximately 4–8 UI refreshes/second while streaming.
- Avoid expensive tokenization on every character delta.
- Prefer provider-reported cumulative output tokens when those values update during streaming.
- If the provider does not report usable token counts until completion, use a lightweight live estimate during streaming and reconcile to authoritative final usage at `message_end`.
- Keep the most recent completed generation rate visible while idle instead of immediately displaying `0 t/s`.
- During a new generation before enough samples exist, display a neutral transient value such as `⚡ … t/s`.
- Do not invent a "maximum TPS" denominator unless the active provider exposes a meaningful capacity value.

The implementation should distinguish at least:

- `streaming`
- `idle`
- `waiting/no samples`
- `unavailable`

Do not show stale TPS from a prior model after a model switch without clearly resetting/rebinding the metric.

### 2. Current directory

Display the process/current Pi working directory.

Requirements:

- Prefer `~` abbreviation for paths beneath the user's home.
- Full mode may show a useful relative/full path.
- Compact modes may reduce it to the leaf directory.
- If Pi/harness supports changing cwd during a session, refresh this field after the change.

### 3. Git repository

Display canonical repository identity where possible.

Resolution order:

1. Parse `remote.origin.url` and derive `owner/repository`.
2. If origin is absent/unparseable, use the Git repository root basename.
3. If not inside a Git repository, omit the segment.

Support common origin formats:

```text
git@github.com:owner/repo.git
https://github.com/owner/repo.git
ssh://git@host/owner/repo.git
```

Do not assume GitHub specifically; parsing should be host-agnostic enough to derive the final owner/repo path when practical.

### 4. Git worktree

Show which worktree this Pi process is actually operating in.

Requirements:

- Resolve the current Git worktree/root using Git itself rather than guessing from the directory name.
- Use `git rev-parse --show-toplevel` and/or `git worktree list --porcelain` as appropriate.
- Prefer a short human-readable worktree label.
- For the primary/default worktree, an implementation may display `wt:main`, the root basename, or omit the worktree segment when doing so is unambiguous.
- For linked worktrees, make the worktree identity obvious.
- Worktree path must not be confused with branch name.
- Handle detached HEAD worktrees.

Examples:

```text
wt:feature-routing
wt:review-184
wt:/tmp/pi-worktrees/task-42
```

### 5. Branch/ref

Display the current Git branch.

Requirements:

- Use Pi's footer branch provider where appropriate so branch changes trigger rerendering.
- For detached HEAD, display a short commit SHA, for example:

```text
@9f12ab3
```

- Optionally append dirty state compactly if already available cheaply:

```text
feature/routing*
```

Dirty-state display is optional for the first implementation and must not add noticeable latency.

### 6. Active model

Display the model currently being used for the active Pi session/request.

Examples:

```text
qwen3.8-27b
claude-opus-4.1
openai/gpt-5.6-codex
inferweave/qwen3.8-27b
```

Requirements:

- Read from Pi's current model context rather than static configuration.
- Refresh after model changes.
- Include provider when useful to disambiguate models.
- Do not require a restart to reflect `/model` changes.

---

## Pi Integration

Use the existing Pi extension APIs.

The implementation should be integrated into the harness extension initialization and use:

- `ctx.ui.setFooter(...)` for rendering.
- `footerData.getGitBranch()` for Pi's branch-aware value where useful.
- `footerData.onBranchChange(...)` to trigger renders.
- `ctx.model` for active model information.
- Pi message lifecycle events for throughput tracking:
  - `message_start`
  - `message_update`
  - `message_end`
- Session/model events already available in the harness to refresh model/context state.

Do not shell out on every footer render.

All Git metadata that requires subprocess execution should be cached and invalidated intentionally.

---

## Architecture

Implement the feature as reusable harness components, e.g.:

```text
src/
  status/
    footer.ts
    state.ts
    throughput.ts
    git-context.ts
    layout.ts
```

Adapt paths to the existing repository structure rather than forcing this exact tree.

Suggested responsibilities:

### `StatusState`

Central lightweight observable state:

```ts
interface HarnessStatusState {
  cwd: string;
  repository?: string;
  repositoryRoot?: string;
  worktree?: string;
  branch?: string;
  detachedHead?: string;
  model?: string;
  provider?: string;

  throughput: {
    state: "idle" | "streaming" | "waiting" | "unavailable";
    currentTokensPerSecond?: number;
    lastCompletedTokensPerSecond?: number;
    outputTokens?: number;
  };
}
```

This state should be useful later outside the footer.

### `ThroughputTracker`

Responsibilities:

- consume streaming events,
- collect timestamped output-token samples,
- calculate rolling TPS,
- calculate final authoritative response TPS,
- reset safely when model/request changes,
- expose cheap reads to the renderer.

Keep the tracker independent of terminal rendering so it can later feed:

- subprocess telemetry,
- dashboards,
- RPC/JSON status,
- aggregate multi-agent metrics.

### `GitContextProvider`

Responsibilities:

- current repository root,
- canonical repo identity,
- current worktree identity,
- branch/ref,
- cache/invalidation.

Git lookup failures must never break Pi.

### `FooterRenderer`

Pure/mostly-pure renderer based on:

```ts
render(status, terminalWidth)
```

It must not execute Git commands, network requests, or expensive token calculations.

---

## Throughput Calculation

### Preferred source

If streaming events expose monotonically increasing cumulative output token usage, sample:

```text
(timestamp, cumulativeOutputTokens)
```

Rolling rate:

```text
(newestTokens - oldestTokens) /
(newestTime - oldestTime)
```

using only samples inside the configured rolling window.

### Fallback estimation

Some providers may report zero/unchanged usage until completion.

In that case:

- estimate generated tokens from streamed assistant deltas,
- avoid heavyweight tokenizer work for every delta,
- batch estimation or use an inexpensive approximation,
- replace/reconcile the estimate with final authoritative `message.usage.output` at message completion.

Document the estimation behavior in code.

### Idle behavior

After streaming ends:

- retain `lastCompletedTokensPerSecond`,
- do not display `0`,
- mark the internal state idle.

A later UI enhancement may visually dim idle throughput.

---

## Responsive Layout

Segments have explicit priority.

Recommended priority from highest to lowest:

1. TPS
2. model
3. branch/ref
4. worktree
5. repository
6. directory

At wide widths, show everything.

At progressively narrower widths:

1. abbreviate paths,
2. abbreviate provider/model if safe,
3. omit directory,
4. omit repository,
5. omit worktree only if branch still identifies context,
6. preserve model + TPS as long as practical.

Never allow uncontrolled wrapping.

The renderer should use Pi TUI width helpers such as visible-width/truncation utilities rather than raw JavaScript string length.

---

## Footer Ownership / Extension Compatibility

`ctx.ui.setFooter()` replaces Pi's footer, so `pi-engineering-harness` should deliberately own the footer while preserving useful harness/extension status.

Requirements:

- Preserve/compose `footerData.getExtensionStatuses()` where appropriate.
- Do not silently destroy critical status generated by other parts of the harness.
- Define one footer ownership point inside the harness; individual harness modules must not compete with multiple `setFooter()` calls.
- Other harness functionality should publish status fragments/state to this owner.

This should become the harness's common footer infrastructure.

---

## Configuration

Provide sensible defaults with optional harness configuration.

Suggested config:

```json
{
  "statusBar": {
    "enabled": true,
    "showDirectory": true,
    "showRepository": true,
    "showWorktree": true,
    "showBranch": true,
    "showModel": true,
    "showThroughput": true,
    "throughputWindowMs": 2500
  }
}
```

Follow the harness's existing configuration system and naming conventions.

The feature should be enabled by default unless doing so would break an established compatibility contract.

---

## Commands

If the harness already has a settings/status command, integrate there.

Otherwise add a small diagnostic command such as:

```text
/harness-status
```

It should report the fully resolved state for debugging, including:

```text
cwd
repository
repository root
worktree
branch/ref
provider
model
TPS state/current/last completed
```

A footer toggle command is optional if the normal harness configuration already supports toggling features.

---

## Subprocess / Agent Future Compatibility

Do not implement aggregate multi-agent TPS unless the existing subprocess orchestration already exposes enough data cleanly.

However, design the schema so the next step can represent:

```ts
interface WorkerStatus {
  id: string;
  kind: "main" | "subprocess" | "subagent";
  model?: string;
  tokensPerSecond?: number;
  state: string;
  worktree?: string;
  branch?: string;
}
```

The future main footer can then show:

```text
⚡247 t/s Σ │ main 82 │ workers:3
```

without rewriting the single-process throughput tracker.

---

## Performance Requirements

- Footer rendering should be effectively negligible.
- No Git subprocess on each render.
- No network request on each render.
- No full-session scan on each streaming delta.
- Bound throughput sample history to the rolling window plus a small margin.
- Clean up timers/listeners/subscriptions on footer disposal/session teardown.
- Avoid render storms from token-by-token events by throttling/coalescing TUI redraw requests.

---

## Failure Behavior

The status bar must never make Pi unusable.

If:

- Git is unavailable,
- current directory is not a repository,
- origin is missing,
- worktree metadata cannot be resolved,
- model is temporarily undefined,
- usage reporting is absent,

then omit or degrade only the affected segment.

Examples:

```text
~/scratch │ qwen3.8-27b │ ⚡71 t/s
```

or:

```text
feature/foo │ qwen3.8-27b │ ⚡…
```

Do not throw uncaught errors from the footer render path.

---

## Tests

Add unit tests for at least:

### Git parsing

- GitHub HTTPS origin
- GitHub SSH origin
- generic SSH origin
- `.git` suffix stripping
- missing origin
- non-Git directory
- linked worktree
- detached HEAD

### Throughput

- rolling-window rate
- samples expiring from the window
- provider usage available during streaming
- provider usage only available at completion
- fallback estimate
- final reconciliation
- idle keeps last completed TPS
- model/request reset

Use deterministic/fake timestamps rather than sleeping in tests.

### Layout

Snapshot/table-driven tests for several widths, e.g.:

```text
160
120
100
80
60
40
```

Verify:

- no overflow,
- no unwanted wrapping,
- model/TPS survival at narrow widths,
- sensible segment elision.

### Lifecycle

Verify listeners/subscriptions are cleaned up and the footer does not keep updating after disposal.

---

## Validation

Before completion:

1. Run the repository's normal format/lint/typecheck/test suite.
2. Launch Pi with the local harness extension.
3. Verify in a real Git repository.
4. Verify in a linked Git worktree.
5. Verify branch change updates without restart.
6. Verify model change updates without restart.
7. Generate a response and visually confirm live TPS updates.
8. Confirm final TPS remains visible when streaming ends.
9. Resize the terminal through wide/narrow widths.
10. Run outside a Git repository and confirm graceful degradation.
11. Confirm no continuous Git subprocess churn while idle or streaming.

---

## Acceptance Criteria

The work is complete when:

- `pi-engineering-harness` itself provides the footer.
- No separate footer extension/package is required.
- Directory is visible when space permits.
- Repository identity is visible when inside Git.
- Current worktree is visible when space permits.
- Current branch/ref is visible.
- Active model is visible.
- Live current output tokens/sec is visible while generation is occurring.
- Last completed TPS remains visible while idle.
- Model/branch/worktree information updates correctly.
- Narrow terminals degrade cleanly.
- The implementation does not materially slow streaming.
- Footer rendering does not execute Git/network work.
- Tests cover throughput, Git context, responsive layout, and cleanup.
- Existing harness functionality/tests remain passing.
- Documentation describes the new status bar and configuration.
- The implementation leaves a clean path toward subprocess/subagent aggregate telemetry.

---

## Implementation Principle

This is not merely cosmetic UI.

Treat it as the first user-visible surface of a shared **pi-engineering-harness runtime telemetry model**. The footer should consume structured harness state rather than independently rediscovering everything itself. That makes the same status information reusable by the subprocess orchestration, dashboards, logs, and future distributed/aggregate telemetry.
