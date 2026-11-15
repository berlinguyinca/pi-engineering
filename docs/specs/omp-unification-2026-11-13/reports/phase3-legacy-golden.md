# Phase 3 prerequisite: legacy golden outputs and parity gate

Golden baseline SHA (the legacy implementation the goldens were captured from): `24a66588e93b3ad9cb3a65f0b71b3fb6d5f61736` (constant `GOLDEN_BASELINE_SHA` in `test/support/legacyGolden.ts`, stamped into every record as `goldenBaselineSha`; the name is path-neutral so a second path does not claim legacy provenance).

## What exists

- `test/support/ledgerNormalizer.ts` (unit tests: `test/unit/ledger-normalizer.test.ts`): pure normalization.
- `test/support/legacyGolden.ts`: the `scenarios` table, `ParityPath` (factories plus observation hooks), `legacyPath`, `PATHS`/`resolvePath`, `renderScenario`, and the `runParity(path)` runner.
- `test/integration/legacy-golden.test.ts`: `runParity(resolvePath(process.env.PARITY_PATH))`; renders each scenario through the selected path (default `legacy`, an unknown name throws) and compares byte for byte with `test/fixtures/legacy-golden/<command>-<scenario>.golden.json`.
- No production code changed. `biome.json` ignores the golden directory (as it does the other golden fixtures) so byte-exact output is not reformatted.

## Scenarios (25 records; 26 integration tests = 25 scenarios + 1 unique-filename check; 14 unit tests for the normalizer)

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

- Ids `PREFIX-xxxxxx` become `<PREFIX#n>`, ordinals per prefix in first-seen order, one table per record. Only the prefixes `src/` passes to `id()` (src/core/ids.ts and its callers, plus `evt` and the upper-cased entity kinds) are recognized, so words like `HIGH-abcdef` survive.
- Dropped keys: the listed timestamp keys, every key ending `_at`, `durationMs`/`duration_ms`. Replaced: temp roots -> `<ROOT>`, 40-hex -> `<SHA>`, `sha256:` -> `<HASH>`, uuid -> `<UUID>`, `repo-<16hex>` -> `<REPO>`.
- Events keep `type` order, actor type, scope (work item or mission id), and "key facts": enum-like keys (status, outcome, verdict, decision, role, severity, kind, action, category, trust, from, to, exit_code, passed, completed) `*_id` references, id lists (keys ending `ids`, members kept in order) and the length of every other array, up to 4 levels deep. Free text, prompts and diffs are not recorded in events.
- Report fields are curated per scenario (outcomes, statuses, counts, stage results, candidate lineage), not dumped.

## Regenerate

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH UPDATE_GOLDEN=1 node --test --import ./test/support/isolatedState.ts test/integration/legacy-golden.test.ts
```

Commit the diff on purpose. Goldens must only change when the legacy contract is intentionally changed; they are tied to the pinned SHA.

## Parity-gate contract for the OMP path

1. Implement `ParityPath` for the OMP-backed implementation: factories (`openRuntime`, `openMission`, `loadCommandHost`) and observation hooks (`ledgerOf`, `readEvents`, `tearLedgerTail`, `verify`). Scenarios reach the implementation only through these; they never read ledger files or construct stores themselves. Register it in `PATHS`.
2. Run `PARITY_PATH=<name> node --test ... test/integration/legacy-golden.test.ts`: the same `scenarios` are rendered through that path and compared with the same golden files with `assert.equal` on the text. `UPDATE_GOLDEN=1` is refused in CI and for any path other than `legacy`. No tolerance, no per-path goldens.
3. A difference is resolved by fixing the OMP path, or by an explicit, reviewed golden change that states why legacy behavior is being changed.
4. Equivalence is decided only by this deterministic comparison, never by model judgment.

## Known exemptions

- The four mission goldens contain the minor finding "Mutation could not be verified against a base commit (no git provider, nothing to integrate)". It is a product of the in-tree stub `GitRepo` object the mission harness passes, not a defect in the legacy behavior. It is a known exemption: a real-git path must reproduce it through the same harness (the same stub), and it is deliberately not filtered out of the goldens.
- `recovery / torn-tail-reopen-append` reads its post-append ledger with `tornLinesExpected`: the store starts the next record on a fresh line, so the deliberately torn fragment stays mid-file. Everywhere else `parseLedger` tolerates only an unparseable final line and throws on mid-file corruption.

## Known gaps / UNVERIFIED

- LLM wording: workers are fakes; real model output text, ordering and token usage are not covered.
- TUI/UI: only `notify` text is captured; no rendering, panels, footers or screenshots.
- Parallel ordering: only serial tournament and serial DAG execution are in the gate (parallel event interleaving is nondeterministic by design).
- Real process kill: recovery covers a torn ledger tail by reopen, not a genuinely killed process, lock-takeover or lease races.
- Mission scenarios use a stubbed git provider and fake backends, so they do not exercise real worktree integration; promotion over real git is covered by the engineer/tournament scenarios only.
- Notices for successful commands (`/engineer`, `/plan`, `/tournament` happy paths) need a worker injected into the extension runtime cache and are not captured; only error/usage paths are.
- Determinism was demonstrated on one machine/OS (macOS, Node 22); other platforms are UNVERIFIED.
- CI: `test:coverage` runs `test/unit` only and includes only `src/**` and `extensions/**`, so these `test/` files do not change the coverage numbers; the integration golden test runs in the full `npm test`.
