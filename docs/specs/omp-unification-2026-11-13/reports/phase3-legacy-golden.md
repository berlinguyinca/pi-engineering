# Phase 3 prerequisite: legacy golden outputs and parity gate

Pinned legacy SHA: `24a66588e93b3ad9cb3a65f0b71b3fb6d5f61736` (constant `LEGACY_SHA` in `test/support/legacyGolden.ts`, stamped into every record).

## What exists

- `test/support/ledgerNormalizer.ts` (unit tests: `test/unit/ledger-normalizer.test.ts`): pure normalization.
- `test/support/legacyGolden.ts`: the `scenarios` table, `ParityPath`, `legacyPath`, `renderScenario`.
- `test/integration/legacy-golden.test.ts`: renders each scenario through `legacyPath`, compares byte for byte with `test/fixtures/legacy-golden/<command>-<scenario>.golden.json`.
- No production code changed. `biome.json` ignores the golden directory (as it does the other golden fixtures) so byte-exact output is not reformatted.

## Scenarios (25 records)

| command | scenarios |
| --- | --- |
| engineer | happy, fix-round, persistent-findings-failed, review-not-completed |
| review | approve, findings |
| verify | green, red |
| plan (+executePlan) | happy, blocked-downstream, idempotent-rerun, invalid-deps, unknown-plan |
| tournament | serial-n3-winner, failing-leg |
| mission | complete, findings-repair-blocked, validation-fail-then-pass, block-then-resume, restart-restores-state |
| recovery | torn-tail-reopen-append |
| slash-command notices (`cmd-*`) | review no-work-item, review no-candidate, execute unknown-plan, engineer missing-goal |

Drivers: `EngineeringRuntime.open` with `FakeWorkerExecutor`, real `CommandVerifier`, real git fixture repos (`makeFixtureRepo`), real ledger files for engineer/review/verify/plan/tournament/recovery. Mission scenarios use `Orchestrator` + `MissionStore` over an in-memory event store with the `BrokerBackends` harness (same doubles as `orchestrator-e2e.test.ts`). Notices come from the real extension registered on a minimal pi host.

## Normalization rules

- Ids `PREFIX-xxxxxx` (`evt`, `WI`, `CAND`, `TASK`, `EVID`, `ART`, `RUN`, `CTX`, `MSN`, entity kinds) become `<PREFIX#n>`, ordinals per prefix in first-seen order, one table per record.
- Dropped keys: timestamps, `*_at`, `durationMs`. Replaced: temp roots -> `<ROOT>`, 40-hex -> `<SHA>`, `sha256:` -> `<HASH>`, uuid -> `<UUID>`, `repo-<16hex>` -> `<REPO>`.
- Events keep `type` order, actor type, scope (work item or mission id), and "key facts": enum-like keys (status, outcome, verdict, decision, role, severity, kind, action, category, trust, from, to, exit_code, passed, completed) and `*_id` references up to 4 levels deep. Free text, prompts and diffs are not recorded in events.
- Report fields are curated per scenario (outcomes, statuses, counts, stage results, candidate lineage), not dumped.

## Regenerate

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH UPDATE_GOLDEN=1 node --test --import ./test/support/isolatedState.ts test/integration/legacy-golden.test.ts
```

Commit the diff on purpose. Goldens must only change when the legacy contract is intentionally changed; they are tied to the pinned SHA.

## Parity-gate contract for the OMP path

1. Implement `ParityPath` (`openRuntime`, `makeOrchestrator`, `loadCommandHost`) for the OMP-backed implementation.
2. Run the same `scenarios` through `renderScenario(s, ompPath)` and compare with the same golden files with `assert.equal` on the text. No tolerance, no per-path goldens.
3. A difference is resolved by fixing the OMP path, or by an explicit, reviewed golden change that states why legacy behavior is being changed.
4. Equivalence is decided only by this deterministic comparison, never by model judgment.

## Known gaps / UNVERIFIED

- LLM wording: workers are fakes; real model output text, ordering and token usage are not covered.
- TUI/UI: only `notify` text is captured; no rendering, panels, footers or screenshots.
- Parallel ordering: only serial tournament and serial DAG execution are in the gate (parallel event interleaving is nondeterministic by design).
- Real process kill: recovery covers a torn ledger tail by reopen, not a genuinely killed process, lock-takeover or lease races.
- Mission scenarios use a stubbed git provider and fake backends, so they do not exercise real worktree integration; promotion over real git is covered by the engineer/tournament scenarios only.
- Notices for successful commands (`/engineer`, `/plan`, `/tournament` happy paths) need a worker injected into the extension runtime cache and are not captured; only error/usage paths are.
- Determinism was demonstrated on one machine/OS (macOS, Node 22); other platforms are UNVERIFIED.
- CI: `test:coverage` runs `test/unit` only and includes only `src/**` and `extensions/**`, so these `test/` files do not change the coverage numbers; the integration golden test runs in the full `npm test`.
