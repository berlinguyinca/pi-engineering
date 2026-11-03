# Spike: `herdr agent prompt` against a `pi` agent (vision reuse, Task 7)

Date: 2026-11-02. herdr client and server 0.9.1 (protocol 22), macOS.
Run in a throwaway workspace; no user pane was touched. Live local model
`metabolomics/qwen3.8-text`, prompts kept to one word.

## Setup

```sh
herdr workspace create --cwd /tmp --no-focus
# -> workspace "wF", root pane "wF:p1"
herdr agent start vision-spike --kind pi --pane wF:p1 -- \
  --provider metabolomics --model qwen3.8-text --no-session
# -> {"type":"agent_started","agent":{"agent_status":"idle","interactive_ready":true,...},
#     "argv":["pi","--provider","metabolomics","--model","qwen3.8-text","--no-session"]}
# 3.76 s, exit 0
```

## 1. `prompt --wait --until idle --until done` (by agent name)

```sh
herdr agent prompt vision-spike "Reply with the single word OK." \
  --wait --until idle --until done --timeout 120000
# -> {"type":"agent_prompted","agent":{"agent_status":"done","revision":1,
#     "agent_session":{"source":"herdr:pi",...},...}}
# 3.30 s, exit 0
```

`herdr agent read vision-spike` afterwards shows the answer `OK` on screen. The command returned
only after the agent answered: **`--wait --until idle --until done` works for a `pi` agent.**

## 2. What `RealHerdrCli.prompt` sends today: `agent prompt <target> <text>` (no `--wait`), then `agent wait`

```sh
herdr agent prompt vision-spike "Reply with the single word YES."
# -> {"type":"agent_prompted","agent":{"agent_status":"done",...}}   0.33 s, exit 0
herdr agent wait vision-spike --until idle --until done --timeout 120000
# -> {"agent":{"agent_status":"done",...}}                              total 0.36 s, exit 0
```

The answer `YES` appeared on screen about five seconds **later**. Without `--wait` the prompt
returns at submission, and a following `agent wait --until idle --until done` matches the
**previous** turn's `done` state at once (herdr's help: "It does not track turns"). So the
existing `prompt()` + `wait()` pair is **not** a completion signal.

## 3. `prompt --wait` by pane id

```sh
herdr agent prompt wF:p1 "Reply with the single word OK." --wait --until idle --until done --timeout 120000
# -> "type":"agent_prompted", "agent_status":"done"   1.18 s, exit 0; screen shows "OK"
```

A pane id works as the target, so the registered `paneId` can be prompted directly.

## Cleanup

```sh
herdr pane close wF:p1   # -> {"result":{"type":"ok"}}; workspace wF no longer listed
```

## Conclusion for the build

- `pane send-text` is not needed; `agent prompt` delivers to a `pi` agent.
- Reuse delivers with the existing `HerdrCli.prompt(paneId, text, timeoutMs)` (submit only) and then
  polls `results/<requestId>.json`, which stays the only source of truth (design: "Pane output is
  never parsed for the result"). Completion is the result file, not herdr state, so no interface
  change and no `--wait` are needed.
- Do **not** use `prompt()` followed by `wait()` to detect completion: the wait can match the prior
  turn's `done`. If a caller ever needs herdr-side completion, `prompt` must pass
  `--wait --until idle --until done` in a single call.
- herdr rejects a prompt with `agent_blocked` when the agent is blocked; `prompt()` then throws and
  the reused delegation fails explicitly.
