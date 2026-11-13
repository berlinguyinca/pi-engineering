# E03 report — deterministic error normalization (first planned task on the verified harness)

**Status: PASS, merged.** `feat/e03-error-normalize` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`ba22f28a` → `a0eca33248a368a45ea8208314f048db754bf35e`.

| item | value |
| --- | --- |
| planned task | `E03` ordinal 9, "Build deterministic error normalization", `dependsOn: [E02]` (E02 landed earlier) |
| diff | `src/incidents/errorNormalize.ts` 54/0, `test/unit/error-normalize.test.ts` 45/0 → 99 lines (budget 2 production / 2 test / ≤100) |
| handoffHash | `sha256:72ebd9c31233581d10af0130bc9edcc44efecbc304beb3b5f5743394141232cc` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:bcd787677606e09750b58888ddd51c9328bcda554a72235c8f677a393cd91a83` |
| parent | **strictly verified**: `parent=FIX-5 accepted sha256:1e87cb429e7…` (`nextTaskId: E03`, `nextBaseSha == baseSha`) |
| base / result / next | `ba22f28a6b54…` / `a0eca33248a3…` / `E04 @ a0eca33248a3…` |

`normalizeError(input, ctx)` is a pure first-match-wins table walk over 10 rules
(`worker.result_missing`, crash signals, non-zero exit, 429, 404, 400/413, 5xx, network errno, timeout, explicit
`unknown.unclassified` fallback) producing E02 `ErrorOccurrence`s: no clock, no randomness, the caller's evidence
reference kept ahead of derived refs, redaction reused from `src/platform/redact.ts`.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` step 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/error-normalize.test.ts` (4/4) (spec `verify` step 2) | 0 | `logs/02-unit-error-normalize.txt` |
| incident suite: `error-event`, `incidents-fingerprint`, `incident-controller`, `autospec-incident-sink` (24/24) | 0 | `logs/03-unit-incident-suite.txt` |
| conductor's own shape table (independent of the worker's fixtures) | 0 | `logs/04-conductor-shape-table.txt` |

The conductor table (written without reference to the worker's fixtures) exercised every shape the plan demands:

```
rate_limited_429       gateway.429.rate_limited   warning  valid=true
not_found_404          gateway.404.not_found      error    valid=true
bad_request_400        gateway.400.bad_request    error    valid=true
upstream_5xx           gateway.5xx.upstream       error    valid=true
timeout                execution.timeout          error    valid=true
network                network.connection_failed  warning  valid=true
nonzero_exit           process.crash              fatal    valid=true
missing_worker_result  worker.result_missing      error    valid=true
crash                  process.crash              fatal    valid=true
junk / null / 42       unknown.unclassified       warning  valid=true
evidence refs: ["logs/run-42.jsonl","input/extra","derived/x"]
determinism: true
{"exitCode":2,…} -> tool.nonzero_exit   {"exit_status":"3",…} -> tool.nonzero_exit   {"exitCode":0,…} -> unknown.unclassified
```

Every emitted occurrence validates through E02's own `parseErrorOccurrence`.

## Notes / accepted behaviour

1. `{exitCode:137, stderr:"killed: 9"}` classifies as `process.crash` (fatal), not `tool.nonzero_exit`: the
   crash rule is deliberately earlier in the table, and `killed: 9`/`SIGSEGV`/OOM are crash evidence. A plain
   non-zero exit without crash evidence still yields `tool.nonzero_exit` (last line above), so the required
   "exit status" shape is covered.
2. `parseErrorOccurrence` (E02) refuses absolute, whitespace-bearing or `..`-escaping artifact refs, so the
   normalizer sanitizes refs before emitting them — evidence references are preserved when they are already
   storable (`logs/run-42.jsonl` above), otherwise dropped rather than producing an invalid event.
3. Plan metadata mismatch, recorded but not "fixed": `manifests/tasks.json` says `repoFullName:
   berlinguyinca/pi-engineering` for the 44 `pi` tasks while the checkout's origin is
   `https://github.com/berlinguyinca/pi-engineering-runtime`. The handoff records carry the plan's value; the
   repo identity used for gating is the checkout's. Worth correcting in the plan (docs-only task).
