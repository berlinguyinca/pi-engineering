# Phase 1 legacy test baseline

SHA 5ab85965fce3f4343eff776ac23d11c1bc197799, branch docs/omp-unification-phase1-audit
Node: v22.22.3 (PATH=/opt/homebrew/opt/node@22/bin; engines >=22.18 <26 satisfied). No fixes applied.

| Command | Exit | Duration | Pass | Fail | Skip |
|---|---|---|---|---|---|
| npm ci | 0 | 6s | - | - | - |
| npm run typecheck | 0 | 17s | clean | - | - |
| npm run lint (biome, 1569 files) | 0 | 1s | clean | - | - |
| npm run test:unit | 0 | 311s | 6898/6903 | 0 | 5 |
| npm run test:integration | 1 | 350s | 1197/1198 | 1 | 0 |
| npm run test:e2e (smoke-commands + smoke-load) | 0 | 3s | COMMANDS OK; package load OK (36 commands, 8 tools) | 0 | - |
| npm run test:platform | 0 | 2s | 120/120 | 0 | 0 |
| coverage | UNKNOWN | - | no coverage script in package.json | | |

No suite hung or hit the 25 min cap.

## Integration failure: FLAKY (passed on rerun)

File: test/integration/mission-reliability-foundation.test.ts:865
Test: "keeps the incumbent unchanged when current-candidate validation is red"
(parent: "mission reliability foundation - synthetic MSN-qSLaeM", ERR_TEST_FAILURE)

First failure:
```
Command failed: git -C /private/var/folders/.../pi-eng-fixture-bJm2gi write-tree
fatal: Unable to create '.../pi-eng-fixture-bJm2gi/.git/index.lock': File exists.
Another git process seems to be running in this repository, or the lock file may be stale
code: 128
```
Rerun (`npm run test:mission-reliability`, same file): exit 0, 44/44 pass, 68s.
Classification: flaky, a git index.lock race in a fixture repo under --test-concurrency=4 (not deterministic).
Logs (scratchpad): /private/tmp/claude-501/-Users-wohlgemuth/7fe1d204-09c3-4474-b541-13bcff0e7036/scratchpad/bl/

Raw logs and SHA-256 manifest: `baseline-logs/`.
