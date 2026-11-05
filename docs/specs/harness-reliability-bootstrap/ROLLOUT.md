# ROLLOUT — shadow mode, baselines, stop criteria, rollback, retention (V05)

Written read-only on base `fc471225`. Every flag name below was opened in source at that commit and is cited `file:line`; every number comes from a file I read. Where no flag exists the row says **no flag — revert**. Nothing here turns on new recovery by default.

## 0. Two corrections to the facts handed to this task

| Handed fact | What the source / filesystem actually shows |
| --- | --- |
| "the boolean parser is affirmative-only (1/true/yes/on); anything else, including a typo, is OFF" | **There are two parsers with opposite semantics.** `bool()` `src/inference/resilienceConfig.ts:88-93` is **negative-only**: `false` only for `false`/`0`/`off` (trimmed, any case), `true` for every other non-empty value — so a typo leaves the switch **on**. `optIn()` `:100-102` (`/^(1\|true\|yes\|on)$/i`) is **affirmative-only** and guards exactly one switch, `PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE` `:135`. Measured at `fc471225` through `resolveInferenceResilienceConfig`: `PI_INFERENCE_RESILIENCE_ENABLED=ture` → `true`, `=off` → `false`, unset → `true`; `..._INTERACTIVE=ture` → `false`, `=on` → `true`. 11 of 12 switches use `bool()`. |
| baseline file `docs/specs/harness-reliability-bootstrap-20261103/BASELINE-unit-suite-at-c349613b.txt` | **Absent from this checkout because it was never committed.** It is an untracked file (`git status` → `??`) in the conductor worktree `worktrees/pi-bootstrap-conductor-20261103`, and `git log --all -- '*BASELINE-unit-suite*'` returns no commit — so it belongs to no commit and is not reachable from `fc471225`. Read directly from that worktree it records **210** `✖` lines, **2971** `✔` lines over 3550 lines, and **no `ℹ` summary line** (0 matches), so its totals are line-counted, not runner-reported. |
| scope gate has no env flag; diagnose path read-only by construction; herdr `591264f9`, 36 tests | **All hold.** Herdr `main` = `591264f9bd4fc2fc07d88d94febde4cd0e919448`; re-running the six files here gives `tests 36 / pass 36 / fail 0`. |

## 1. Shadow-mode enablement

"Shadow" = the intervention records or decides **without changing the outcome**. Two are shadow-only by construction (drift detector, diagnosis); the rest act on the request and are listed in the state they are in today.

| Intervention | Exact env flag (verbatim) | Default | Shadow mode records / does |
| --- | --- | --- | --- |
| Inference-resilience master switch | `PI_INFERENCE_RESILIENCE_ENABLED` `resilienceConfig.ts:125` | **ON** (`enabled: true` `:71`; consumer `resilientInference.ts:258`) | wraps the stream; off → plain stream |
| Stream-retry ladder | `PI_INFERENCE_STREAM_RETRY_ENABLED` `:126`; tuning `PI_INFERENCE_STREAM_RETRY_INITIAL` `:127`, `PI_INFERENCE_STREAM_RETRY_MAX` `:128`, `PI_INFERENCE_STREAM_RETRY_ATTEMPTS` `:129` | **ON**, 30 s / 120 s / 4 (`:72-75`; consumed `resilientStream.ts:224-230`) | re-attempts an errored stream — **blocks**, does not merely record |
| Model circuit breaker | `PI_INFERENCE_CIRCUIT_FAILURES` `:130`, `PI_INFERENCE_CIRCUIT_WINDOW` `:131`, `PI_INFERENCE_CIRCUIT_COOLDOWN` `:132` | **ON**, 3 / 5 m / 2 m (`:76-78`; gate `resilientStream.ts:664`, `:678`) | refuses a tripped model; no on/off flag, floors at 1 (`:146`) |
| Health gate (`enabled && healthy && available`) | **no flag — revert** | always on | blocks candidate selection `resilientStream.ts:675`; also `isPenalized` `:660`, `:676` |
| Model fallback — autonomous workers | `PI_INFERENCE_MODEL_FALLBACK` ?? `PI_GATEWAY_MODEL_FALLBACK_ENABLED` `:133-134` | **ON for workers** (`modelFallbackForWorkers: true` `:79`; `resilientStream.ts:471`) | switches model on model-scoped availability failures |
| Model fallback — interactive | `PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE` `:135` | **OFF** (`:80`; forced `false` for interactive `resilientStream.ts:222`) | opt-in only — the sole affirmative-only switch |
| Fallback narrowing | `PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY` `:136`, `PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS` `:137` | **ON / ON** (`:81-82`; `resilientStream.ts:641`, `:635`) | constrains the candidate set |
| Activation window + unavailability penalty | `PI_INFERENCE_ACTIVATION_FALLBACK_AFTER` `:139`, `PI_INFERENCE_UNAVAILABLE_PENALTY` `:142` | 10 m / 2 m (`:83-84`; `recovery.ts:229`, `resilientStream.ts:237`) | times a fallback, penalises a model |
| R07 bounded stream recovery | `PI_RESILIENT_STREAM` `resilientStreamOptin.ts:15`, honoured only for `1`/`true` `:22` | **OFF**, and not on a live path (§6) | records only — `{retry:false, reason:"flag_off", log}` `:27`, `:35`; never executes |
| Mission planner | `PI_MISSION_PLANNER=on\|off\|auto` `missionPlanner.ts:16-19`; `PI_MISSION_PLANNER_TIMEOUT_MS` `:102-104` | `auto` / 600 000 ms (`:99`) | records why it fell back to one clamped task (`:38`) |
| Scope-integrity gate | **no flag — revert** (called unconditionally `executor.ts:772` → `:931`) | always on | blocks: task `blocked`, attempt kept on `superseded/*` (`:774-778`) |
| T07 drift detector | **no flag — revert** (`src/aps/taskAlignment.ts` reads no env) | pure function | records only — returns `AlignmentSignal[]` `:24`, never blocks |
| E05/E06 error capture | **no flag — revert** (injected writer `PiWorkerExecutor.ts:302`, called `:2122`) | on only when a writer is injected (§6) | records only — appends an occurrence |
| D01-D07 diagnosis + bundle | **no flag — revert** | read-only always | records only; the dependency type forbids writing (§5) |
| H07 `/diagnostics` view (herdr) | **no flag — revert** | read-only always | renders feeds; "no control, no handler, no timer" (H07 log) |

## 2. Metric baselines

| Metric | Value | Source I read |
| --- | --- | --- |
| Unit suite, raw `npm-test` log | **210** `✖` lines, **2971** `✔` lines, 3550 lines, **no summary line recorded** (0 `ℹ` matches) — so totals are line counts, not runner-reported | `docs/specs/harness-reliability-bootstrap-20261103/BASELINE-unit-suite-at-c349613b.txt` — **never committed, so not present in this checkout**; counts read from the untracked copy in the conductor worktree (§0) |
| Full suite at bootstrap start | tests 4079, pass 3761, **fail 315**, skipped 3 — with a runner summary | `docs/specs/harness-reliability-bootstrap-20261103/B00/logs/04-npm-test.out:26754-26761`, at `0b86fc127578422d81551abcf1b20d5eab5f86bb` (`B00/logs/02-git-rev-parse.out`) |
| Drift detector vs fixture | precision **1**, recall **0.667**, TP 2 / FP 0 / FN 1 / TN 2, `missedIds:["drift-03"]`, 5 tasks | `docs/specs/harness-reliability-bootstrap-20261103/V02/logs/03-runner-output.json`; reproduced byte-identically here by `node --experimental-strip-types scripts/bench-task-drift.ts` (exit 0) |
| V05 proof set (measured here) | **66 tests / 66 pass / 0 fail** | `node --test --test-force-exit --import ./test/support/isolatedState.ts` over `test/unit/{planner-worker-scope-gate,recovery-optin,gateway-fallback,diagnose-errors-cli,diagnose-errors-command,worker-error-events,session-error-writer,error-reader,recovery-recommend,resolution-evidence}.test.ts` |
| Herdr diagnostics view | 36 / 36 pass / 0 fail | `591264f9`: `node --test packages/diagnostics-{model,source,timeline,view,route}.test.js packages/task-drift-view.test.js` |

**These drift numbers measure a detector against a hand-labelled fixture, not model quality.** `test/fixtures/harness-drift/README.md:3-6`: "Nothing here is a workload, a benchmark of a model, or a statement about real model quality: it is a **detector-evaluation fixture only**"; `scripts/bench-task-drift.ts:3-5`: "No live models… main() always exits 0 — a missed task is a reported recall miss, and this is a measurement tool, not a gate." Do not read precision 1 as "the harness never over-flags".

## 3. Stop criteria — halt on any of these

| # | Measurable condition | How to measure |
| --- | --- | --- |
| 1 | `git diff --check` exits non-zero, or `git show --name-only HEAD` lists a path outside the task's declared scope | the task's own VERIFY command |
| 2 | The `✖` line count of the unit run exceeds the baseline recorded in §2, or the runner summary reports `fail > 0` where the same set passed before | `grep -c '✖'` on the captured log; compare against §2 |
| 3 | A scope-gate block whose flagged paths all lie inside `scope.allowed` — i.e. `blocked_reason` matching `evidence: scope gate:` (`executor.ts:218`) that scope drift does not explain | read the task state record and re-check each path against `contract.scope`; it has no flag, so a revert is the only rollback |
| 4 | Any write inside an events namespace directory, or an evidence artifact whose sha256 no longer matches the recorded value | `diagnose-errors.ts --export <path inside namespace>` must exit **2** and leave the directory empty (measured: 0 files); `resultGate.ts:36` names `evidence tampered` |
| 5 | A second retry owner acting for one failure class, or attempts beyond `streamRetryMaxAttempts` / `RESILIENT_STREAM_MAX_ATTEMPTS = 2` (`resilientStreamOptin.ts:16`), or an intervention shipping default-on with no way to disable it | `docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` ownership table vs observed behaviour; `docs/specs/harness-reliability-bootstrap-20261103/05-IMPLEMENTATION-SECURITY.md:8`, `:13` |

## 4. Flag rollback — disable, prove, observe

| Intervention | Disable with | Prove it is off | Expected observable difference |
| --- | --- | --- | --- |
| Resilience master | `PI_INFERENCE_RESILIENCE_ENABLED=off` (or `false`, `0`) | `node --experimental-strip-types -e` calling `resolveInferenceResilienceConfig({...})` → `enabled:false` (measured) | plain stream path (`resilientInference.ts:258`); no ladder, breaker or fallback |
| Stream retry | `PI_INFERENCE_STREAM_RETRY_ENABLED=off` | same call → `streamRetryEnabled:false`, fed to `StreamRetryPolicy` at `resilientStream.ts:226` | an errored stream fails instead of re-attempting |
| Circuit breaker | no on/off flag exists: raise `PI_INFERENCE_CIRCUIT_COOLDOWN` to a long window | `node --test … test/unit/resilience-circuit-breaker.test.ts` | **cannot be fully disabled** — `circuitFailures` floors at 1 (`:146`); partial rollback only |
| Worker model fallback | `PI_INFERENCE_MODEL_FALLBACK=false` or `PI_GATEWAY_MODEL_FALLBACK_ENABLED=false` | `test/unit/gateway-fallback.test.ts`; and `{PI_GATEWAY_MODEL_FALLBACK_ENABLED:'false'}` → `modelFallbackForWorkers:false` (measured) | availability failure ends the call on the current model (`:471`) |
| Interactive fallback | already OFF — undo `PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE` | unset → `optIn()` false; same test file | interactive sessions never switch model (`resilientStream.ts:222`) |
| R07 bounded recovery | unset `PI_RESILIENT_STREAM`, or any value other than `1`/`true` | `node --test … test/unit/recovery-optin.test.ts` asserts `reason:"flag_off"`, `retry:false`, `waitMs:null` | decision object still produced; nothing retried |
| Mission planner | `PI_MISSION_PLANNER=off` | `missionPlannerMode({PI_MISSION_PLANNER:'off'})` → `"off"` (`missionPlanner.ts:17-18`) | single clamped task; `fallbackReason` still populated (`:38`) |
| Scope-integrity gate | **no flag — revert** the commit, or narrow `contract.scope` | `node --test … test/unit/planner-worker-scope-gate.test.ts` | before: task `blocked`, work preserved on `superseded/*`; after: unauthorized diffs integrate — that loss **is** the cost of this rollback |
| T07 drift detector | **no flag — revert** | `node --experimental-strip-types scripts/bench-task-drift.ts` → `detectorKinds:["out_of_scope_write"]` | before: signals returned; after: no detector to call |
| E05/E06 error capture | **no flag — revert**; stop injecting `workerErrorWriter` (`PiWorkerExecutor.ts:302`) | `test/unit/worker-error-events.test.ts` + `test/unit/session-error-writer.test.ts` | occurrences stop appending; already-written records stay |
| D01-D07 diagnosis | **no flag — revert** (nothing to switch) | `test/unit/diagnose-errors-cli.test.ts` + `test/unit/diagnose-errors-command.test.ts` | `/diagnose-errors` disappears; stored evidence untouched |
| H07 `/diagnostics` | **no flag — revert** in `herdr-engineering` | `node --test packages/diagnostics-route.test.js` | nav entry and route removed; feeds unchanged |

## 5. Incident data retention

| Evidence | Where | Bound | Preserve before rollback |
| --- | --- | --- | --- |
| Session error occurrences (E05/E06) | `<state-root>/worktrees/<worktree-id>/events/<session>.jsonl`; root = `$PI_ENGINEERING_STATE_DIR` → `$XDG_STATE_HOME/pi-engineering` → `~/.local/state/pi-engineering` (`stateDir.ts:8-21`, `:32-38`) | one append stream per session; `recovery/` evidence "never deleted" (`:17`); transcripts "never auto-deleted" (`:21`) | copy the whole `events/` tree **before** touching the writer |
| Read-side index (D01) | `readHostErrorOccurrences(namespaceDir)` (`errorReader.ts:20`) | default 500 occurrences (`DEFAULT_ERROR_INDEX_LIMIT` `:10`), `--last` ≤ 5000 (`diagnose-errors.ts:17`); a relative path is refused, never walked (`:23`) | export it — the reader cannot create the namespace it reports on (`entry.ts:86-89`) |
| Diagnose evidence bundle (D07) | only where `--export <path>` names it (`diagnose-errors.ts:37`, `:54`) | 20 items / 32 768 bytes / 50 event ids (`evidenceBundle.ts:14`, `errorAggregate.ts:8`); refuses a path **inside** the namespace (exit 2, measured) and refuses overwrite without `--force`; the host dependency type is `Omit<DiagnoseDeps, "writeFile">` — `src/runtime/host/entry.ts:82-84`, the permission scope itself excludes writing, so `--export` fails closed with exit 4 | `--export <outside-path>` once, then hash it and compare |
| Handoff records | `<dir>/<taskId>.handoff.json` (`resultGate.ts:45`) | atomic tmp+rename, throws rather than overwrite (`:46-47`); stamped `handoffHash = sha256:` over key-sorted JSON (`:15-19`); artifact sha re-verified at the gate (`:36`) | **copy, never delete** — removing a record to make an audit pass is exactly what `evaluateResultGate` reports as `evidence tampered` / `evidence artifact absent` (`:36`) |
| Superseded attempts | branch `superseded/<worktree-branch>-<stamp>` (`executor.ts:935-940`) | one branch per blocked attempt, collision-suffixed `.1`, `.2` | keep the ref; it is the only copy of a gate-blocked attempt |

A rollback may revert code; it may never rewrite or delete evidence. Copy the evidence tree, then revert, then re-run §4's proofs against the copy.

## 6. Known gaps (verified at `fc471225`)

1. **The scope-integrity gate has no runtime flag.** `scopeGate` runs unconditionally at `executor.ts:772`→`:931`; `executor.ts` touches `process.env` at one unrelated site (`:1803`). Rollback is a revert or a narrowed `contract.scope`. Its fail-closed deny rules live in `contract.ts`: `scopeGlobError` rejects escaping, absolute, `.git` and unsupported globs (`:62-80`); an authorization deny wholly covering a grant rejects the contract rather than weakening the deny (`:137-146`); `forbidden_authorization` is never coerced from a non-string (`:102-110`).
2. **Not every resilience module is on a live path.** Wired (via `PiWorkerExecutor.ts:410` `wireResilientModelRuntime`): `resilienceConfig`, `resilientStream`, `resilientInstall`, `modelHealth`, `circuitBreaker`, `failureClassifier`, `recovery`, `streamResume`. **Not wired — tests only:** `resilientStreamOptin.ts` (R07), `recoveryRecommend.ts` (R06), `resolutionEvidence.ts` (R08), `diagnosticTask.ts` (D08 — no production importer), `taskAlignment.ts` (T07 — only `scripts/bench-task-drift.ts`), and `SessionErrorWriter.ts` (E05: `createSessionErrorWriter` has no production caller, so `workerErrorWriter` `PiWorkerExecutor.ts:302` has **no production supplier** and the E06 emit at `:2122` calls `undefined?.`). So `PI_RESILIENT_STREAM` is a real flag with no live effect, and R03 (`retryBudget`) / R04 (`endpointCircuit`) / R05 (`recoverySafety`) reach production only through `incidents/recoveryRecommend.ts`, which itself is unwired.
3. **Documented recall miss.** `drift-03` changes `src/ledger/claimDiscipline.ts` — inside `permittedScope` but off-objective — and the detector's only kind is `out_of_scope_write`, so it stays silent: recall 0.667, FN 1 (`V02/logs/03-runner-output.json`; `test/fixtures/harness-drift/README.md:24-29`). Relevance judgment is unimplemented, and precision 1 rests on 5 fixture traces.
4. **A mistyped disable does not disable** (§0, `bool()`), and the named baseline artifact is uncommitted (§0). Rollback proof must read the **resolved config**, never the env string.
5. `scripts/diagnose-errors.ts` reads no configuration and no environment (`:5`), caps `--last` at 5000 (`:17`), and `/diagnose-errors` shows at most 5 clusters and says so instead of truncating silently (`entry.ts:80`, `:99`).
