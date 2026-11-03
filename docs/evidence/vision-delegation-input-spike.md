# Vision delegation: `input` handler spike (2026-11-02)

Task 9, Step 1. Commands and observations only. Two sources of evidence, marked on every answer:

- **[observed]**: ran the installed Pi (`/opt/homebrew/bin/pi`, `@earendil-works/pi-coding-agent` 1.4.0, the
  version the user runs) with a throwaway extension, in a throwaway herdr workspace.
- **[source]**: read the Pi code: the installed 1.4.0 (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist`)
  and the repo's dev dependency 0.87.1 (`node_modules/@earendil-works/pi-coding-agent/dist`). The relevant code
  is the same in both.

## Setup

Throwaway extension `spike-ext.ts` (in the session scratchpad, not in the repo): an `input` handler that
logs `{text, images.length, source, streamingBehavior, ctx.signal, ctx.isIdle(), ctx.model.input,
sessionId, HERDR_PANE_ID}` to a JSONL file, calls `ctx.ui.setStatus("vision-spike", "SPIKE-WAITING-<n>")`,
listens for `abort` on `ctx.signal` if there is one, sleeps `SPIKE_WAIT_MS` (default 5000), clears the
status and returns `{action: "handled"}` (so no model request is made). Test image: an 8x8 PNG.

```sh
# print mode, 5 s wait
pi -ne -e ./spike-ext.ts --no-session --offline -p @red.png "describe this"
# -> exit 0 after 6 s; log: start, then end 5003 ms later

# interactive, in a throwaway workspace (closed afterwards)
herdr workspace create --cwd <scratch>/vision-spike --label vision-spike --no-focus   # -> pane wG:p1
herdr pane run wG:p1 'SPIKE_WAIT_MS=20000 pi -ne -e ./spike-ext.ts --no-session --offline @red.png "first message"'
herdr pane read wG:p1                                  # footer shows SPIKE-WAITING-1
herdr pane send-text wG:p1 "second message"; herdr pane send-keys wG:p1 enter
herdr pane send-keys wG:p1 esc; herdr pane send-keys wG:p1 ctrl+c
herdr pane wait-output --match SPIKE-WAITING-2 wG:p1
herdr pane send-keys wG:p1 ctrl+c ctrl+c
herdr workspace close wG
```

Log of the interactive run (text shortened):

```
{"t":...131700,"k":1,"phase":"start","text":"<file name=\".../red.png\"></file>\nfirst message","images":1,"source":"interactive","streamingBehavior":null,"signal":"undefined","isIdle":true,"modelInput":["text","image"],...}
{"t":...151701,"k":1,"phase":"end","signalAfter":"undefined"}
{"t":...151701,"k":2,"phase":"start","text":"second message","images":0,"source":"interactive","streamingBehavior":null,"signal":"undefined","isIdle":true,...}
(no "end" for k=2: double Ctrl-C exited pi)
```

## 1. Does Pi await an async `input` handler, and does `ctx.ui.setStatus` show?

**Yes, and yes.** [observed] Print mode took 6 s for a 5 s handler; the interactive turn did not start until
the handler returned (20 s). The footer showed `SPIKE-WAITING-1` for the whole wait.
[source] `ExtensionRunner.emitInput` does `const result = await handler(event, ctx)` for every handler in
order; `AgentSession.prompt` awaits `_runInputHandlers(...)` before it validates the model or starts the agent
run. A handler that throws is caught by the runner (`emitError`) and the input continues unchanged.

## 2. A second message sent while the handler waits: queue or abort?

**Queue.** [observed] "second message" was submitted during the 20 s wait; its `input` handler started in the
same millisecond the first one ended (`k=2` at `...151701`), as a separate prompt with no images.
[source] The interactive main loop is `while (true) { const userInput = await this.getUserInput(); await
this.session.prompt(userInput) }`. While `prompt` awaits the handler, `session.isStreaming` is false (no agent
run is active yet), so the editor's submit handler pushes the text onto `pendingUserInputs`, which the loop
takes after the current `prompt` resolves. Nothing is aborted.

## 3. Ctrl-C / Escape on a waiting handler; is there an abort signal?

**No signal, and no cancel.** [observed] `ctx.signal` was `undefined` at the start and end of the wait;
`ctx.isIdle()` was `true`. Escape and a single Ctrl-C did nothing to the wait (no abort, the handler ran its
full 20 s). Double Ctrl-C exits Pi (the waiting handler is abandoned with the process).
[source] `ctx.signal` is `agent.signal` = `activeRun?.abortController.signal`, and there is no active run during
the `input` handler of an idle prompt. Escape only aborts when `session.isStreaming`; single Ctrl-C clears the
editor (`handleCtrlC`), a second within 500 ms shuts down.

Consequence for the contract: the delegator's wait cannot be cancelled by the user from the idle `input`
handler; it is bounded by `wait_seconds` only. `signal` is still passed through when Pi has one (it does only
while the agent streams, and streaming input is not delegated, see R17 below), so `delegate.ts` needs no change.

### Streaming input (R17)

[source only, flag for the Task 10 acceptance run] When the agent is streaming, the interactive editor submits
with `streamingBehavior: "steer"` (and `followUp` via its key), and `prompt` runs the `input` handlers first and
queues the steer/follow-up message only after they return. Waiting there for minutes would hold that submission
while the run continues and may end, after which the late message goes down the non-streaming path. Ruling R17
applied: streaming input is not delegated; the handler returns `continue` and notifies the user that the image
was not analyzed (agent busy). Not observed: a streaming run needs a live model.

## 4. How does a process inside a herdr pane learn its pane id?

**`HERDR_PANE_ID`.** [observed] In a fresh pane of the throwaway workspace, `env | grep -i herdr` printed
`HERDR_BIN_PATH`, `HERDR_ENV=1`, `HERDR_PANE_ID=wG:p1`, `HERDR_SOCKET_PATH`, `HERDR_TAB_ID=wG:t1`,
`HERDR_WORKSPACE_ID=wG`; `herdr pane current` in the same pane answered `pane_id: "wG:p1"`. Pi started in that
pane saw the same `HERDR_PANE_ID` (`herdrPane: "wG:p1"` in the log). The wiring uses
`process.env.HERDR_PANE_ID`; absent means herdr is unavailable (the delegator's existing path).

## Additional finding: pasted images do not arrive as `event.images` in the TUI

[source, both versions; flag for the Task 10 acceptance run] The interactive editor's paste-image action
(`handleClipboardPaste`) writes the clipboard image to `os.tmpdir()/pi-clipboard-<uuid>.<ext>` and inserts that
**file path into the editor text**; the main loop then calls `session.prompt(userInput)` with no `images`.
So in the TUI, `event.images` is non-empty for `source: "interactive"` only for images given on the command
line (`pi @image.png "..."`, the initial message; [observed] above, `images: 1`), and for SDK callers. RPC
`prompt`/`steer`/`follow_up` carry `images` but are `source: "rpc"`, which R16 excludes. A pasted screenshot in
the TUI therefore reaches the handler as a path in `event.text` and is not delegated by this task's handler.
