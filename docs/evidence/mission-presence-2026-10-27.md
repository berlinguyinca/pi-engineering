# Mission presence — terminal proof (2026-10-27)

Spec: `docs/superpowers/specs/2026-10-27-mission-presence-design.md` §8 · Plan: `docs/superpowers/plans/2026-10-27-mission-presence.md` Task 9.

Everything below was driven through a real `pi` TUI inside tmux (`tmux send-keys`, `tmux capture-pane`) — no test harness, no fake UI context. Panels are verbatim captures, with blank lines and the pi statusline kept as-is.

## Environment

| | |
| --- | --- |
| pi | 1.4.0 (`/home/wohlgemuth/.pi/agent/bin/pi`) |
| Extension under test | `/home/wohlgemuth/IdeaProjects/pi-eng-mission-visibility/extensions/index.ts` @ `793cb77` |
| Model | `paiton-local/Qwen3.8-Flash-Next` (local) |
| Scratch repo | `/tmp/presence-proof` (fresh git repo, one `README.md`) |
| Terminal | `tmux` 3.x, `x 140 y 40` |

The worktree extension had to be loaded explicitly, because the installed runtime package registers the same tool names and pi refuses the conflict:

```
$ pi --extension <worktree>/extensions/index.ts -p "Reply with exactly: OK"
Error: Failed to load extension ".../runtime/host/entry.ts": Tool "ledger_read" conflicts with .../extensions/index.ts
```

The working invocation for every run below:

```
pi --no-extensions --extension /home/wohlgemuth/IdeaProjects/pi-eng-mission-visibility/extensions/index.ts
```

(`pi --no-extensions` disables discovery of the installed package; the explicit `-e` path still loads. Print mode with the same flags returned `OK`, which is how the load path was checked first.)

## Step 1 — a mission in-session, the strip and the working line

Keys: `/mission add a file named HELLO.md containing exactly the word hello` ↵, then captures at +20s, +24s, +43s, +2m 33s.

+20s (strip appears while the mission is still planning):

```
 Routing intent and running orchestration mission...
 Missions · 1 running · 0 needs you
 > MSN-pDiOqd  add a file named HELLO.md co  R– TURN ENDED: →add   ~0%           acc 0/1         19s ago
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ACTIVE · Turn ended: stop=error tool_error=no for 1s · output 1s ago
Now: Turn ended: stop=error tool_error=none for 1s · output 1s ago · heartbeat 1s ago · progress 18s ago · workers 1 active/0 waiting/0 fai…
Memory: key invalid or revoked
```

+2m 33s (the strip's age and the footer's health both moved on their own; the footer escalated `ACTIVE` → `SLOW`):

```
 Missions · 1 running · 0 needs you
 > MSN-pDiOqd  add a file named HELLO.md co  R– TURN ENDED: →add   ~0%           acc 0/1         2m 33s ago
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SLOW · Turn ended: stop=error tool_error=no for 19s · output 19s ago
Now: Turn ended: stop=error tool_error=none for 19s · output 19s ago · heartbeat 3s ago · progress 2m 33s ago · workers 1 active/0 waiting/…
```

Observed, as designed:

- the strip renders **above** the editor separator, one header line (`Missions · N running · M needs you`) plus one row per mission;
- the row carries `>` (running), truncated objective, the scheduler token (`R–` = no recovery attempt yet, `TURN ENDED: →add` = scheduler action → next verb), `~0%` weighted progress, `acc 0/1` acceptance coverage, and the age of the last observability update;
- the pre-existing status footer keeps its own two lines **below** the editor, so the strip added no vertical noise;
- the strip refreshed without any keypress (the 1s controller tick), and the age advanced monotonically.

Not observed: the working-line substitution `Mission · MSN-… · <activity> · <age>`. The mission's foreground turn never returned to idle (the orchestration ran inside the turn), so the controller's idle guard declined the working message every time — pi's own `⠙ Working · Preparing tool call · …` line stayed in place (visible in Step 3). The handoff is pinned by unit tests only.

## Step 2 — typing while a mission runs

Keys: `typing while the mission runs` (literal), ↵. Capture after typing, before submit:

```
 Missions · 1 running · 0 needs you
 > MSN-pDiOqd  add a file named HELLO.md co  R– TURN ENDED: →add   ~0%           acc 0/1         24s ago
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
typing while the mission runs
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ACTIVE · Turn ended: stop=error tool_error=no for 6s · output 6s ago
Now: Turn ended: stop=error tool_error=none for 6s · output 6s ago · heartbeat 6s ago · progress 23s ago · workers 1 active/0 waiting/0 fai…
```

After ↵ the editor cleared and the strip kept updating (`24s ago` → `43s ago`): no focus change, no lost keystroke, no re-render of the chat area caused by the strip. The strip never took the editor's row.

**Esc did not pause the mission.** `Escape` was pressed at +48s while `MSN-pDiOqd` was running; the row stayed `> … R– TURN ENDED: →add` and the header stayed `1 running`, with no `PAUSED` token in the footer. The runtime's operator-pause surface (`formatMissionActivity`'s `R… PAUSED (operator)` token and `operator_paused_at`) never appeared. So the plan's expectation "`Esc` pauses the mission in that pane" is **not confirmed** by this run — Esc behaved as pi's normal turn-interrupt.

`/mission-status` typed while the mission's turn was in flight produced no output in the pane: the message queued behind the running turn (pi behavior, unrelated to presence). A non-slash message typed in the same window did reach the agent and it ran shell commands normally, so command input itself was unaffected.

## Step 3 — the disabled path

```
env PI_MISSION_PRESENCE=0 pi --no-extensions --extension <worktree>/extensions/index.ts
```

Same scratch repo, which still held the running mission `MSN-pDiOqd` in `.pi-eng/` (the durable store a seeded strip would have rendered from).

```
 pi-engineering-runtime: diverged from origin/main (10 ahead, 67 behind) — merge or rebase yourself. Run /update for detail.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SLOW · Turn ended: stop=error tool_error=no for 58s · output 58s ago
Now: Turn ended: stop=error tool_error=none for 58s · output 58s ago · heartbeat 26s ago · progress 4m 11s ago · workers 1 active/0 waiting…
```

`grep -c "Missions ·"` over the last 60 captured rows: **0**. With a mission running and a durable store to seed from, the disabled path rendered:

- no strip, no header, no row;
- pi's own working line, owned by the foreground agent: `── ⠙ Working · Preparing tool call · 0s · last output 0s ago · paiton-local/Qwen3.8-Flash-Next ──`;
- the pre-existing mission footer, unchanged from `origin/main` (`SLOW · …` / `Now: …`);
- no new notifications.

That is `origin/main` behaviour reproduced with the presence code present but switched off.

## Extra proof captured while the terminal was open

**Durable backfill (a fresh session with no `/mission` run in it)** — restart in the same repo; the strip rendered from `.pi-eng/` state before any activity:

```
 pi-engineering-runtime: diverged from origin/main (10 ahead, 67 behind) — merge or rebase yourself. Run /update for detail.
 Missions · 1 running · 0 needs you
 > MSN-pDiOqd  add a file named HELLO.md co  R2/8 FENCE_RECONC→fe  ~0%           acc 0/1         1m 18s ago
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ACTIVE · Turn ended: stop=error tool_error=no for 2m 35s · output 2m 35s ago
```

The token moved `R–` → `R2/8` across the restart, i.e. the recovery producers (Task 6) are feeding a real scheduler resume (`FENCE_RECONCILE`), and the row survived the process boundary without a `/mission` command in the new session.

**Terminal state** — `/mission cancel MSN-pDiOqd` ↵:

```
 Mission MSN-pDiOqd — add a file named HELLO.md containing exactly the word hello [CANCELED]
 Missions · 0 running · 0 needs you
 x MSN-pDiOqd  add a file named HELLO.md co  R2/8 FENCE_RECONC→fe  ~0%           acc 0/1         3m 10s ago
```

`x` replaced `>`, the header recount dropped to `0 running`, and the row stayed visible afterwards (terminal-notice retention) instead of vanishing.

## What this run did NOT prove

1. **The attention path at the terminal.** The header stayed `0 needs you` and the row never became `!`. The mission was `SLOW`, not `STALLED` — output kept arriving from the retrying worker, and only stalled/loop/blocked/failed/waiting raise attention. The `!` marker, the `needs you` count and the once-per-episode notification are pinned only by `test/unit/status-presence.test.ts`.
2. **The working-line handoff** — see Step 1; the idle guard never became satisfiable in a single-pane run.
3. **Esc-pause** — pressed, no pause observed (Step 2).
4. **Fleet behaviour** — `PI_MISSION_PRESENCE_ROWS`, `PI_MISSION_TITLE`, and ordering of several concurrent missions were never exercised at the terminal; only one mission existed.
5. **A mission that succeeds.** The local model errored on every worker turn (`stop=error tool_error=none`), so weighted progress never moved past `~0%` and `acc 0/1` never advanced. The happy path — progress climbing, `v` on completion — is unproven at the terminal.

## Incident worth recording

Cleanup used `tmux kill-server`, which also killed a pre-existing session named **`pieng-resume`** (created 12:03, before this verification started at ~13:18). No process from it survived (`pgrep` for pi/gateway/engine afterwards: none). Sessions created by this verification: `presence`, `presence-off`, `presence-backfill`, `bf`, `bf2`.

## Commands, for reproduction

```bash
# 1. load check
cd /tmp/presence-proof && pi --no-extensions --extension <worktree>/extensions/index.ts -p "Reply with exactly: OK"

# 2. live strip + typing
tmux new-session -d -s presence -x 140 -y 40 \
  "pi --no-extensions --extension <worktree>/extensions/index.ts"
tmux send-keys -t presence -l "/mission add a file named HELLO.md containing exactly the word hello"; tmux send-keys -t presence Enter
tmux send-keys -t presence -l "typing while the mission runs"; tmux send-keys -t presence Enter
tmux send-keys -t presence Escape
tmux capture-pane -t presence -S -60

# 3. disabled path
tmux new-session -d -s presence-off -x 140 -y 40 \
  "env PI_MISSION_PRESENCE=0 pi --no-extensions --extension <worktree>/extensions/index.ts"
tmux capture-pane -t presence-off -S -60 | grep -c "Missions ·"   # → 0

# 4. backfill + terminal state (fresh session, same repo)
tmux new-session -d -s bf2 -x 140 -y 40 \
  "pi --no-extensions --extension <worktree>/extensions/index.ts"
tmux send-keys -t bf2 -l "/mission cancel MSN-pDiOqd"; tmux send-keys -t bf2 Enter
tmux capture-pane -t bf2
```

## Tool namespace: two runtime copies, verified

Loading the installed runtime and a checkout at once fails the second load with
`Tool "ledger_read" conflicts with <the other path>`. Whether anything inside the
extension can survive that was tested with a minimal pair (pi 1.4.0):

```ts
// /tmp/ext-probe/a.ts and b.ts — identical tool name, registration wrapped
try { pi.registerTool({ name: "dup_tool", … }); } catch (e) { /* … */ }
```

```
$ pi --no-extensions --extension /tmp/ext-probe/a.ts --extension /tmp/ext-probe/b.ts -p "say OK"
probe A registered
probe B registered
Error: Failed to load extension "/tmp/ext-probe/b.ts": Tool "dup_tool" conflicts with /tmp/ext-probe/a.ts
```

Both `registerTool()` calls returned normally; Pi rejected the name **after** the
extension finished loading. So no try/catch in an extension can prevent it, and
the remedy is operator-level: one runtime per session
(`pi --no-extensions --extension <path>/extensions/index.ts`), now written down in
`docs/usage.md`.

The tolerance code is still worth having, for the case the runtime *can* handle —
a host that rejects a name synchronously, which is what a mid-session generation
handover can hit (`src/runtime/host/piBridge.ts` records it as
`shadowedTools(generation)` instead of losing the generation's whole tool
surface). That path is unit-tested (`test/unit/runtime-host-tool-collision.test.ts`);
the Pi post-load check is not something the package can influence.

## Verdict

The strip renders in a real terminal, updates without keypresses, survives a process restart through the durable store, marks terminal state, and disappears completely under `PI_MISSION_PRESENCE=0` while `origin/main`'s own surfaces keep working. Typing is not blocked.

Two of the plan's Step 1/Step 2 expectations are **not** satisfied by this run: the working-line handoff never became observable, and Esc did not pause the mission. Neither is disproven as a mechanism — both need a run where the mission's foreground turn returns to idle (and where a mission actually reaches stalled/blocked), which the local model did not produce here.
