# Hindsight memory: why automatic recall was silent, and what fixed it

Status: implemented on `fix/hindsight-recall-delivery-v2`, base `origin/main@0ee44711`.
Live evidence below is from macOS with `~/.local/bin/herdr-memory` against project
`canary` on 2026-11-04. Read-only: no memory was written or deleted.

## The symptom

With memory on by default, `pi -p` sessions answered questions about recorded facts
as though the bank were empty. Nothing was logged as broken; the footer said
`Memory: ready · 0 recalled`.

## Three independent causes

1. **The turn budget was below the client's floor.** `automatic()` raced every lookup
   against 250 ms. One `herdr-memory recall` over a real bank measures **0.4–4.9 s**
   (warm 390–1500 ms, cold 3.2–4.9 s), so automatic recall could only ever time out.
2. **A timed-out lookup injected nothing.** The `context` hook injected `recalled`
   when non-empty and stayed silent otherwise, so the model saw an ordinary turn with
   no notes and reported "no records" — a different claim from "the bank could not be
   read".
3. **The readiness probe asked a question the service refuses.** `probe()` and
   `recallAll()` ran `recall "*"`. There is no list endpoint and a wildcard is
   rejected: `{"error":"Memory service rejected request (HTTP 422)"}`, exit 1 (an
   empty query fails client-side). So every session started with a failed probe,
   which put automatic recall into the failure backoff before the first prompt —
   the bank looked empty even with a healthy service and a generous budget.

Cause 3 is the one that survives a budget bump, and it is why the failure looked like
a policy problem rather than a wire-contract problem.

## What changed

| Surface | Before | After |
| --- | --- | --- |
| In-turn budget | 250 ms, hardcoded | `memory.hindsight.automatic_recall_ms`, default **1200** (100–5000) |
| Headless (`pi -p`) | 250 ms | **5000 ms** — no spinner, and its single model call is the only chance to carry memory |
| Readiness probe | raced at 250 ms | **5000 ms**, paid once per session (`readinessDone`), so a healthy-but-slow client stops reporting "timed out" |
| Overview read | `recall "*"` → HTTP 422 | bounded `OVERVIEW_QUERY` (`project memory decision`); counts built on it are a probe, never a total |
| Budget miss | turn proceeds in silence | one `pi-engineering-memory` notice: *"could not be read this turn … treat it as unavailable, not empty"* |
| Late answer | discarded | adopted by the **same** turn's next `context` emit; fenced by turn counter, lookup epoch and session generation |
| Backoff after a timeout | 60 s | `min(failure_backoff_ms, 10 s)` — slow is not broken |
| CLI subprocess on a miss | killed at the turn budget, which also paused the provider | outlives the turn (`max(timeout_ms, budget)`); the turn is bounded by the hook's race, not by killing the read |

Two details are load-bearing and easy to undo by accident:

- The interactive hook must **not** pass `deadlineMs` to `search()`. That provider path
  answers a deadline miss with an empty list — indistinguishable from an empty bank —
  and pauses the provider, which is how a slow client became "0 recalled" instead of a
  timeout.
- `clearRecall(retirePending)` keeps this turn's own lookup alive on the automatic
  failure path. An explicit command or a new turn still retires pending work through
  the epoch.

## Live verification (macOS, `~/.local/bin/herdr-memory`, project `canary`)

| Run | Result |
| --- | --- |
| Headless, default budgets | readiness 398 ms, turn 385 ms, one `pi-engineering-memory` block of **4213 bytes** of `canary-facts` records in model context |
| Interactive, healthy client, default budget | readiness 288 ms, turn 556 ms, 4213 bytes delivered |
| Interactive, client delayed 1.2 s, `automatic_recall_ms: 200` | turn 205 ms → **232-byte notice** ("could not be read this turn (herdr-memory timed out)") |
| Interactive, client delayed 1.2 s, default budget | turn 1206 ms → notice; the next model call of the **same** turn carries **4213 bytes** once the client answers |
| `cli: /nonexistent/herdr-memory` | 283-byte notice naming the client, not a host or key |

## Tests

- `test/unit/interactive-memory.test.ts` — in-turn budget, headless-waits-longer,
  late-answer-adopted, late-answer-fenced-by-next-turn, wedged client bounded and not
  re-probed, and that a failed read injects the notice instead of nothing.
- `test/unit/hindsight-memory.test.ts` — the overview reads never send a wildcard; a
  hung client produces the notice.
- `test/unit/hindsight-settings.test.ts` — `automatic_recall_ms` in the YAML surface.

## Not covered here

- The write path (`retain` / `/remember` / `correct` / `forget`) has not been exercised
  against the live service — only reads. A live write test must name a throwaway project.
- Worker hydration keeps its own 250 ms cap (`HYDRATE_CAP_MS` in `BlackholeManager.ts`):
  a worker run is not a human waiting on a turn, and its fail-open silence is intended.
