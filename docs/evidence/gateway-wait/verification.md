# Gateway-wait verification — 2026-09-15

Scope: the model-gateway saturation path in the engineering harness — unbounded
waiting for the interactive turn, `/gateway` visibility, context-safe model
fallback, and `/refresh-models` — plus two supporting fixes (evidence-recorder
path scoping, and a global `git worktree prune` removed from candidate
isolation).

Baseline: the last accepted manual evidence was recorded at `7bf3d64`. The delta
since then also includes upstream `f22c75e` (transient-error recovery, #6) and
`297b9ad` (generation guard, gateway backpressure, status bar, panel, #7), both
already merged to `main` without refreshed evidence.

## The defect

Pi's agent loop calls `modelRuntime.streamSimple` (`pi-coding-agent
core/sdk.js:194`) wrapped in `retryAssistantCall` (`pi-ai utils/retry.js`). That
wrapper retries an assistant message whose `stopReason` is `"error"` at most
`settings.retry.maxRetries` times — three by default — sleeping
`baseDelayMs * 2 ** (attempt - 1)` and ignoring any wait the gateway advertised.
`ExtensionAPI` exposes no accessor for that budget. A saturated gateway
therefore ended the operator's turn with "Retry failed after 3 attempts" while
every engineering worker, which runs with Pi's retry disabled and waits on the
admission controller instead, eventually succeeded.

## Automated evidence

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 752 tests, 751 passed, zero failed, one optional PostgreSQL test
  skipped.
- `npm run test:e2e`: package loads with 16 commands and six core tools.
- 40+ new tests covering the retry pump, the installer, admission scoping,
  fallback selection and the `/gateway` report.
- `test/integration/gateway-stream-retry-registry.test.ts` drives a real
  `ModelRuntime`, not a double, through the same entry point Pi's agent loop
  uses.
- `test/integration/git-worktree-concurrency.test.ts` covers concurrent
  worktree creation, a failed creation not wedging its neighbours, and removal
  interleaved with creation.

## Live use

`node scripts/dogfood-gateway-wait.ts` passed all four phases.

Phase 1 ran against the operator's own configured provider rather than a
fixture: provider `metabolomics`, api `openai-completions`, base URL
`https://llm.metabolomics.us/v1` — the gateway the reported 503s came from.
Installing the wrapper succeeded, and all four models plus their availability
survived it. That provider takes the extension-config install path, not the
native-provider path.

Phase 2 rode out ten consecutive `503 no worker for model` refusals with the
synthesized wait escalating 5s → 10s → 20s → 40s → 60s and capping, ending
`stopReason: stop` after eleven provider attempts. Pi's own budget would have
surfaced a failure at the fourth.

Phase 3 honoured an advertised `retry_after_ms` of 30000 exactly rather than
substituting a backoff guess, and confirmed the queue position (30 of 100) is
available to the status bar. Phase 4 confirmed that abort ends a hold and does
not keep retrying behind the operator.

`node scripts/dogfood-narrator.ts` passed, making the panel's narrator produce a
real narrative from a live model for the first time — the one part of the panel
that had never been observed working, and whose failures `Narrator` swallows by
design. The first run exposed output cut mid-word at exactly 400 characters;
narratives are now cut at a sentence boundary.

`node scripts/dogfood-roadmap.ts` passed the incomplete → verified → invalidated
→ reverified lifecycle in a disposable repository.

## Defects found by testing against a real registry

Unit tests against fake registries passed while three real defects stood:

1. `registerProvider(id, config)` deletes a provider previously registered via
   `registerNativeProvider` (`model-runtime.js:562`). Verified live: a built-in
   keeps all fourteen of its models across the call, a native extension provider
   loses every one, silently and with no composition error. The installer would
   have emptied another extension's catalogue as a side effect of adding retry.
2. The wait-escalation ladder was scoped to a single `pumpWithGatewayRetry`
   call, so it restarted at the base wait on every tool round-trip.
3. Resetting that ladder from the returned outcome landed one microtask after
   the stream's result resolved — after the agent loop had already issued its
   next call.

## Independent review

Two fresh-context reviews were run against the implementation, each a new
session with no inherited reasoning, reading the code and tests directly and
running the suite itself. Both reported **zero critical and zero high**
findings. A third confirmatory review was run after the second round of fixes.

The first review (against the original implementation) found two genuine
requirement-level defects:

* the retry-safety flag tracked only NON-terminal events while only
  `type: "error"` terminal events were withheld, so a `done` event carrying
  `stopReason: "error"` was forwarded — completing the stream — and then retried
  anyway, burning a provider call whose output the completed stream discards;
* the `message_end` handler armed the process-wide cooldown for any retryable
  signal including a bare 503, contradicting the scoping rule stated a few lines
  away in the same file.

Both were fixed. A third finding — that an in-stream hold is not abortable
because the turn's signal travels on `context` rather than on the provider
options — was checked against the installed package and is **incorrect**:
`pi-agent-core/dist/agent-loop.js:195` passes `signal` inside the stream options
object, which is exactly what the wrapper reads.

The second review (against the fixed tree) reported no critical and no high
findings, and three medium ones, all real and all fixed:

* an aborted hold left its `setTimeout` pending, keeping Node's event loop alive
  so an aborted 60-second wait delayed process exit by the full 60 seconds;
* a saturation delivered as a `done` event with `stopReason: "error"` was still
  not waited out — the first round's fix made that case safe (no duplicated
  output) without making it correct;
* the model-fallback counter was cumulative rather than consecutive, so widely
  separated holds across a session could trip a spurious model switch.

A low-severity finding — that the three scoping decisions
(`after_provider_response`, `message_end`, and the pump's hold) disagreed about
which refusals are account-wide — was also resolved: all three now share one
predicate keyed on what a refusal is about rather than on where its wait came
from.

Both reviews independently confirmed, by reading the installed package rather
than this repo's documentation, that pi's `AssistantMessageEventStream`
completes on the first `done`/`error` event and drops every later push — the
fact the whole retry-safety rule rests on.

The reviews are scoped to this delta and its interaction with the existing
admission controller and transient-retry layers. They are not a fresh audit of
every unrelated module.

## Model catalogue refresh

`/refresh-models` reads `GET {baseUrl}/models` and reconciles Pi's configured
catalogue with what the gateway actually serves. Measured live against
`https://llm.metabolomics.us/v1`, the configured catalogue had drifted:
`deepseek-v4-flash` was set to 1,048,576 tokens against a real per-request limit
of 262,144, `qwen3.8-27b-q4-250k` to 131,072 against 250,112, and
`qwen3.8-27b-vision` was absent entirely.

The over-statement is the damaging direction. Pi fills the context believing it
fits, the request fails, and because Pi computes its usage percentage from the
configured window, compaction fires far too late to save the turn.

`ctx_per_request` is written, never `ctx_total`: this gateway reports both, and
the total (2,359,296) is its aggregate across nine slots rather than a bound on
one call.

`models.json` holds the operator's API key, so the write preserves the file
mode, is atomic through a same-directory rename, and leaves a timestamped
backup. A malformed config is refused rather than replaced, and a failed fetch
or an empty catalogue leaves the configuration exactly as it was. Values the
gateway does not report — input modality, output limits — may be inferred but
are reported as inferred rather than presented as read.

## Gateway readiness

The same endpoint reports `slots` and `x_state` per model, which explain a
`503 no worker for model` better than any retry counter: the model that refuses
is the one with no free slots. `/gateway` lists them and flags a model at zero
capacity; fallback ranking places readiness above head-room, and spare capacity
breaks ties below it. Readiness ranks but never vetoes, because the reading is a
snapshot seconds old and treating "cold at the last poll" as disqualifying would
refuse a fallback that would have worked. The probe is cached, coalesces
concurrent callers, and backs off on failure rather than retrying — under
saturation it is the first thing to fail, and hammering it would add load to the
problem it describes.

## Repository release evidence

Manual `dogfood` and `fresh_review` records are recorded against the
implementation commit with paths `src/`, `extensions/`, `test/` — the scope that
actually spans this delta. `scripts/record-roadmap-evidence.ts` previously
hardcoded the review scope to `src/roadmap/`, `src/blackhole/`, `src/benchmark/`
and `services/`, which would have produced a record that passes the gate's
freshness check indefinitely while covering none of this work; `--paths` is now
required and a documentation-only scope is rejected.

No gate, required milestone or validation assertion is disabled for this work.

## Known limits

The intermittent `could not open '.git/worktrees/…/HEAD'` failure in
`dag-parallel` is **not** explained. `git worktree prune` was confirmed to
destroy the administrative directory of freshly created sibling worktrees, and
the resulting breakage was demonstrated directly, so the hazard is real and has
been removed; `dag-parallel` then ran 20/20 clean. But the exact reported
message was never reproduced, so this is a plausible mechanism rather than a
diagnosis, and the flake should be treated as open.

Model fallback has been exercised against its decision table in tests, including
the operator's real four-model catalogue, but no live session has yet been
driven through an actual mid-session model switch under sustained saturation.
