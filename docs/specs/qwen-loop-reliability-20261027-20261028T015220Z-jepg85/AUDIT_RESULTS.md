# Phase-zero audit results — Qwen Loop Reliability (2026-10-27/28)

Execution host: **bender** (Linux, 24 cores), user `wohlgemuth`. Not the operator's Mac.
Canonical repos: `~/IdeaProjects/pi-engineering` (berlinguyinca/pi-engineering),
`~/IdeaProjects/inferweave` (InferWeave/inferweave), `~/IdeaProjects/herdr-engineering`
(berlinguyinca/herdr-engineering).

Spec transport (verified, not assumed): the ZIP existed only on the Mac
(`macbook-pro` / `100.84.185.100`, hostname `mac.lan`) at
`/Users/wohlgemuth/Downloads/qwen-loop-reliability-20261027.zip`; copied over Tailscale
ssh/scp; SHA256 `2a6fb3bdcb8e9203c71241c952afa3e03946cbd179ce7000d2995458f3d8346b` identical on
both hosts; extracted to `docs/specs/qwen-loop-reliability-20261027-20261028T015220Z-jepg85/`.
No prior `*qwen*` spec directory existed; nothing was overwritten.

## 1. Repository state (actual, not default-branch assumptions)

| Repo | Branch at audit | HEAD |
|---|---|---|
| pi-engineering (primary checkout) | `fix/pr372-reconstructed-candidate-replay` | `940a931` |
| origin/main (pi-engineering) | `main` | `9e6d985` (newer than primary checkout) |
| herdr-engineering | `main` | `06e3d50` |
| inferweave | `fix/upstream-scheme-strip` | `c375a68a` |

The primary checkout carries 40+ concurrent worktrees (candidate/orch/RCV trees plus hand-made
topic trees). All were preserved; none were checked out, reset, or reused. This audit's work is
isolated in worktree `../pi-engineering-runtime-qwen-loop-reliability` on branch
`feat/qwen-loop-reliability-audit` per AGENTS.md "One agent, one worktree".

## 2. Answers to AUDIT_MATRIX.md evidence questions (with evidence)

**Q2 — are Qwen thinking tokens accessible?** YES. Live gateway probes returned reasoning in a
distinct `reasoning_content` field alongside `content` and `tool_calls`
(e.g. `deepseek_v4-flash-modality-text-quant-mxfp4` → `"reasoning_content":"The user wants me to
call the worker_result function…"`). Reasoning is therefore a separately addressable stream, which
is what `src/guard/streamText.ts` currently excludes — the spec's priority 1 is implementable
without guessing at hidden text.

**Q4 — are guards enabled in worker and interactive paths?** Both wire through
`src/workers/PiWorkerExecutor.ts` (worker) and `extensions/index.ts` (interactive); the guard
config surface is `src/guard/config.ts` (`PI_GUARD_*`).

**Q7 — do prompt variant/replay/benchmark facilities already exist?** Yes: `package.json`
exposes `bench:planner-worker` (`scripts/planner-worker-benchmark.ts`) and a
`test/integration/mission-reliability-foundation.test.ts` reliability suite; verification profiles
live in `src/verify/`. The recipe registry must layer over these, not create a parallel benchmark.

**Q8 — edits underway elsewhere?** Preserved "worker" branches from the failed mission
(`pi-eng-orch-TSK-4W3jPv`, `-4vlSvx`, `-0DsJ23`, `-B2jvMH`, and the two
`pi-eng-candidate-MSN-9NlR4N-*` integration branches) contain **only orchestration bookkeeping**
commits (`0e9088a`, `c43e0e4`); `git log --all --since=2026-10-27 -- src/guard/ src/aps/` is empty.
No concurrent implementation collides with this spec's target paths.

## 3. Blocking defects found (both verified, neither is a code defect in the spec's scope)

### 3.1 Tool-schema grammar refusal — starves every worker (CRITICAL)

Both missions produced zero implementation. Failure text: `Worker returned no worker_result.
Failed to initialize samplers: failed to parse grammar`.

`src/orchestration/realBackends.ts:234-247` already classifies this precisely:

> "A server that cannot compile the request's tool schema into a sampling grammar (llama.cpp:
> 'Failed to initialize samplers: failed to parse grammar') refuses it with a 400 on every attempt.
> That is a property of the route, not a defect in the work: it is never retried there and hands
> over to the next."

and `realBackends.ts:655-661` explains why failover did not save the mission:

> "…it moves to another eligible model, **unless the operator pinned this one** (the pin is then
> waited on by the scheduler, not abandoned)."

Live bisection against the gateway using the real 2061-byte `worker_result` schema extracted from
`src/workers/workerResultTool.ts`:

| Variant sent | Route | Result |
|---|---|---|
| full schema | `deepseek_v4-flash-modality-text-quant-mxfp4` | **502 → 400 failed to parse grammar** |
| full schema | `qwen3.8-flash_next-modality-text-quant-w3a8` | 200 OK |
| minimal schema | both | 200 OK |
| **`maxLength` stripped** | `deepseek_…-mxfp4` | **200 OK** |
| `maxItems` stripped only | `deepseek_…-mxfp4` | **502 (still fails)** |
| anyOf/const → enum | `deepseek_…-mxfp4` | 502 (not the cause) |
| `maxItems` stripped only | `deepseek_…-mxfp4` | 502 |

**Root cause: `maxLength` on string schemas** is what llama.cpp's JSON-Schema→GBNF converter
cannot compile on the `deepseek_v4-flash-modality-text-quant-mxfp4` deployment — which
`~/.pi/agent/engineering.yaml:26` assigns as a role model. Releasing the operator pin does *not*
fix it, because routing lands on the same grammar-incapable deployment.

Minimal, backward-compatible fix (the spec's "modify only missing adapter/control contracts,
behind backward-compatible capability detection"): omit `maxLength` (and preferably `maxItems`)
from tool parameter schemas for grammar-compiling routes, keeping the bounds enforced client-side
so semantics are unchanged for validators.

Also observed: `qwen3.8-27b-modality-vision-quant-q8_k_xl` → `429
inferweave_backpressure / capacity_unavailable` ("Try another eligible deployment after the
declared delay"), so the local 27B deployment the config prefers is currently backpressured.

### 3.2 Failure-baseline timeout — no candidate can ever be published (CRITICAL)

`src/verify/baselineSubtraction.ts` runs the base suite `PI_ENGINEERING_BASELINE_RUNS` times
(default **2**, line 74) inside `PI_ENGINEERING_BASELINE_TIMEOUT_MS` (default **20 min**, line 73).
Measured on base HEAD on this host:

```
$ npm test          # 568 test files, --test-concurrency=4
# tests 6110   # pass 6097   # fail 2   # skipped 1
real  13m26.735s      EXIT=1
```

Two runs ≈ **26.8 min > 20 min cap** before `typecheck`/`lint`, so the baseline can never finish.
`docs/usage.md:910-918` states a timed-out run "is not cached", so each integration re-pays the
full cost and never converges — this is what produced the repeated
`failure baseline unavailable: the base verification run timed out` and the 2h13m mission that
shipped nothing. The cache dir `.git/pi-engineering-baselines/` holds only two baselines for older
base SHAs (`5aaf676d…`, `8332e47f…`), none for current `9e6d985`.

Base HEAD is also **not green**: `npm test` exits 1, dominated by pending
`redact-regression[SecurityPolicy.ts] … # TODO` cases (openai-sk, github-ghp, basic-auth-url,
env-api-key, json-apikey, slack-xoxb, jwt, google-api-key, plain-40hex-token),
`redact-regression[platform/redact.ts] … # TODO`, plus
"quiet mission activity refreshes locally each second…" and
"Pi loads the Host entry; the real extension reloads 5x…".
Because base failures must be subtracted, and because ACCEPTANCE requires *no secrets in
telemetry*, these pending redaction regressions are prerequisites for this spec's security
criteria, not unrelated noise.

Operator-level remedy (cannot be applied from inside a running session — it is process env of the
runtime, and restarting it would disturb concurrently running agents): set
`PI_ENGINEERING_BASELINE_TIMEOUT_MS` to ~45–60 min, or `PI_ENGINEERING_BASELINE_RUNS=1`, and/or
make base green first so no baseline is needed at all.

## 4. Resource / safety constraints verified

* `nvidia-smi` on bender: **RTX 4090 already holds 23875 MiB of 24564 MiB (~97 %)** at audit time,
  so the "optional live GPU test" path is unavailable; it was not touched, allocated, or restarted.
* Dual R9700 Pro GPUs are not on bender (bender exposes only the 4090) and were not touched.
  No GPU/model teardown, unload, eviction, or benchmarking was performed anywhere.
* Herdr host policy file located at `herdr-engineering/herdr_engineering/host_policy.py`;
  blacklists / manual-only placement (including the mobile Mac) were respected — the Mac was used
  only to read the spec ZIP it owns.
* Gateway probes were read-only inference requests against the operator's own deployment; no
  credentials or private repo content were written to logs or telemetry. Model keys were read from
  config and never printed.

## 5. Mission outcomes

* `MSN-2kTIzz` — blocked by `CROSS_REPOSITORY_MUTATION_UNSUPPORTED` (one mutating workset cannot
  span pi-engineering + InferWeave + herdr-engineering). Strategy: repo-scoped missions.
* `MSN-9NlR4N` (pi-engineering scoped) — ran 2h13m, 5 then 6 failed tasks, **no candidate and no
  implementation code**. Operator pin released via `clear_pin` ("the mission uses role pins and the
  router from its next dispatch"), but resume still fails, now on §3.2. Mission remains BLOCKED.

## 6. Next safe steps

1. Apply §3.1: strip `maxLength`/`maxItems` from tool parameter schemas for grammar-compiling
   routes behind capability detection (restores worker capacity for every mission, not just this one).
2. Apply §3.2 env remedy (operator), or fix the pending `redact-regression` base failures so base
   is green and no baseline is needed.
3. Resume `MSN-9NlR4N`; the P1 reasoning-channel guard work in `src/guard/streamText.ts` /
   `GenerationGuard.ts` is unblocked once a worker can actually run and a candidate can be gated.
4. Then proceed P1 → P4 per IMPLEMENTATION_PLAN.md with the existing tests extended first.
