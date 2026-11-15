# Phase 5: parity tests for review, verify, tournament, recovery, Hindsight and context

Branch `test/omp-parity-suite`, stacked on `feat/omp-worker-integration` (PR #696). Tests only: the one support change is additive (`ScriptedModelServer.bodies`, the raw request bodies, used for size measurements). No `src/` change. Legacy stays the default.

Real-omp tests are gated on `OMP_BIN` and skip with `UNVERIFIED: OMP_BIN not set; no real omp available` (CI does not set it: local-only evidence). Environment used:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export OMP_BIN=<omp-sandbox-bun>/node_modules/@oven/bun-darwin-aarch64/bin/bun
export OMP_BIN_ARGS=<omp-sandbox>/packages/coding-agent/src/cli.ts
node --test --test-force-exit --import ./test/support/isolatedState.ts test/integration/omp-parity-*.test.ts
```

## Parity table

| Area | Test | Status | Evidence |
| --- | --- | --- | --- |
| /verify after an omp-produced candidate (pass and fail) | `omp-parity-suite.test.ts` "verify after an engineer run" | VERIFIED (real omp) | profile, stages, exit codes, evidence rows, the whole normalized ledger and the event-type sequence (including `evidence.recorded`) equal legacy |
| Tournament winner selection, 4 leg-outcome mixes (serial) | `omp-parity-suite.test.ts` "tournament winner selection" | VERIFIED (real omp) | winner index, per-entry status/passed/findings, evidence count, normalized ledger equal legacy; legacy winner asserted per seed. Existing goldens (serial-n3-winner, failing-leg) unchanged |
| Review | golden gate `PARITY_PATH=omp` (review approve/findings, engineer fix-round) | VERIFIED (Phase 4, re-run below) | no new test needed |
| Recovery after SIGKILL mid worker run | `omp-parity-recovery.test.ts` | VERIFIED (real omp) | see Recovery |
| Hindsight: one store per fact | `omp-parity-memory-context.test.ts` | VERIFIED (real omp, real stub script) | see Hindsight |
| Per-worker context | same file | VERIFIED (measured) | see Context |
| Firewall leak (skills, context files, rules) | same file | VERIFIED (real omp) | see Context |
| Offline one-model mode | same file | VERIFIED (real omp) | engineer flow `promoted`, verification passed, with every proxy variable at `http://127.0.0.1:9` and only loopback exempt |
| Full mission DAG on real omp | none | UNVERIFIED | unchanged from Phase 4 |

### Legacy nondeterminism found (not changed)

- A fixture where several clean, passing legs tie picked winner index 1 in one legacy run and 3 in another (same code, same inputs). It cannot be a parity target; the fixtures use a unique best leg.
- When several legs pass, the losers' `candidate.rejected` events are recorded in a run-to-run varying order. The ledger comparison drops which candidate each names (count, position and all other facts are still compared).

## Recovery evidence

`test/support/parityRecoveryChild.ts` is a real Node process running a real `EngineeringRuntime` and `/engineer`; the implementer never finishes (legacy: an executor that never settles; omp: a real omp process whose scripted model never answers). The parent waits for the implementer's `agent.started` (and, on omp, a live omp descendant), SIGKILLs the child, reopens the repository, records one more fact, then tears the ledger tail and reopens again.

Asserted equal between legacy and omp: ledger event types at the kill, after reopen (replay plus a new write), and after a torn tail plus reopen; exactly one run left in flight on both. On omp: every omp process that was a descendant of the killed runtime (walked by ppid, since workers run in their own process group) is gone 2.5 s after the kill: no orphan. omp exits when its RPC pipe closes; nothing relies on PE cleanup after SIGKILL. Torn-tail handling is unchanged (no ledger code changed).

## Hindsight evidence

The runtime runs with `blackhole.durable.kind = hindsight` and a logging shell wrapper around the repo's real `test/fixtures/herdr-memory-stub.sh` (a real process; no new mock), seeded with one fact. Engineer flow on legacy (FakeWorkerExecutor) and on omp (production selection under the flags):

- The herdr-memory call log (sorted, ids normalized) is identical on both paths.
- The seeded fact appears under `[hindsight durable memory]` in the legacy worker context and verbatim in the omp worker's system prompt (same `workerContext`).
- The omp isolated HOME holds no memory, autolearn, rollout, insight or managed-skills files. Files present: omp's own `agent.db`, `models.db`, `skill-descriptions.db` (skill description cache; skills are disabled), logs, and bun's cache. `agent.db` contents were not inspected (UNVERIFIED that it holds no memory rows; no file named for memory exists).
- The overlay keeps `memory.backend: "off"` and `autolearn.enabled: false` (asserted).

## Context metrics

Per-worker first request (`assistantTurns == 0`), from the scripted server's raw bodies; tokens approximated as chars / 4 (no tokenizer is a dependency). Same engineer flow and model script; legacy is the real `PiWorkerExecutor` against the same scripted server.

| Role | Path | System chars | Tools chars | Messages chars | Approx tokens | omp vs legacy |
| --- | --- | --- | --- | --- | --- | --- |
| scout | legacy | 2083 | 6951 | 207 | 2311 | |
| scout | omp | 2446 | 7582 | 437 | 2617 | +13% |
| implementer | legacy | 2572 | 9106 | 207 | 2972 | |
| implementer | omp | 2925 | 12539 | 445 | 3978 | +34% |
| reviewer | legacy | 2782 | 6951 | 207 | 2485 | |
| reviewer | omp | 3155 | 7582 | 437 | 2794 | +12% |

Budget (asserted): +15% for read-only roles, +40% for the implementer. The implementer overshoots because omp's built-in tool descriptions (bash, read, grep, find) are longer than legacy's and `pe_write`/`pe_edit` are added; omp also adds about 230 chars of user message. +40% leaves headroom over the +34% measured without allowing a doubling. Trimming omp's tool text would let the budget tighten.

Firewall: a fixture repo and an isolated HOME poisoned with `LEAK-SENTINEL` in AGENTS.md, CLAUDE.md, `.claude/skills`, `.omp/rules`, and skills in every user discovery root: no omp request body contains a sentinel.

## OMP's own ratchet, cleanse and reviewer (read from upstream, `packages/coding-agent/src`)

Findings come from a read-only source review (file and line references as read); not exercised at runtime.

| OMP feature | vs PE verify | vs PE tournament | vs PE review |
| --- | --- | --- | --- |
| `ratchet/ratchet.ts` | not equivalent | partial, weak | not equivalent |
| `cleanse/loop.ts` | partial | not equivalent | not equivalent |
| /review reviewer (`prompts/agents/reviewer.md`) | not equivalent | not equivalent | partial |

- ratchet: an eval hillclimb deciding keep/revert/rerun from paired train/test deltas and guardrail metrics (`ratchet.ts:860-902`); evidence is files under `.omp/ratchet/<flow>/` with sha256-bound approvals; no ledger, custody or fencing; sequential incumbent comparison, not N isolated candidates.
- cleanse: streams checker diagnostics into a bounded pool of repair subagents and re-checks (`loop.ts:12-45`, `:252`); in-memory ownership only; no durable evidence.
- reviewer: structured findings (P0-P3, confidence, file and line range, overall verdict); no INV-007 isolation, no durable record, no candidate selection.
- Common reason: none writes ledger entries or holds custody, so none yields the durable, fenced evidence PE relies on. The matrix verdict stays RETAIN for verify, tournament and review. Nothing is wired in.

## Known gaps

- Legacy tournament tie-break is nondeterministic (above).
- Implementer context is 34% larger on omp (above).
- Scripted-model parity proves the integration, not model behavior.
- Full mission DAGs on real omp, and `agent.db` contents, are UNVERIFIED.
- Real-omp tests are local-only; CI skips them.

## Rollback

Unset `PI_ENGINEERING_OMP_WORKER` (or the adapter flag). The tests are additive and self-skipping.

## Verification (this branch)

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npx biome check .` | exit 0 / exit 0 |
| New tests, real omp, 3 consecutive runs (`omp-parity-*.test.ts`, 12 tests each) | 12/12, 12/12, 12/12 |
| Legacy gate (`legacy-golden.test.ts`, no OMP_BIN) | 27/27, no golden edited |
| `PARITY_PATH=omp` gate | 27/27 |
| `npm run test:coverage` (no OMP_BIN) | exit 0; 6977 tests, 6972 pass, 0 fail, 5 skipped; lines 85.64, branches 83.29, functions 83.45 (floors 85/83/83) |
