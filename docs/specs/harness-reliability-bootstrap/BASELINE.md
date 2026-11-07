# Baseline observation (B00)

Observation only. Written 2026-11-05 by the conductor as a back-fill record for B00, whose
deliverable was never committed. Raw command output lives in
`docs/specs/harness-reliability-bootstrap-20261103/B00/logs/`.

## Repository state
- Observed HEAD: `c2b75dc93885d246d712d656f72de1764cf198e0` (parent `3d644848`) — `logs/02-git-rev-parse.txt`
- `git status --short`: empty, working tree clean at that commit — `logs/01-git-status-short.txt`
- No source edits were made to obtain this baseline.

## Toolchain
- node `v26.3.0`, npm `11.16.0` — `logs/zz-env.txt`
- `package.json` version `0.2.0` (pi-engineering-runtime)

## Installed Pi extension revision
- Extension source is in-tree: `extensions/index.ts`, `extensions/split-view/`. It carries no
  separate published revision, so its identity is the repository commit above.
- **Unknown:** whether an externally installed copy of the pi package differs from this tree,
  and which revision the running agent harness loads. Not determinable from this checkout
  without inspecting the operator's global install, which B00 forbids ("never modify installed
  configuration" — reading it was also out of scope for the observation).

## Resolved role routes (`.pi/engineering.yaml`, 184 lines, `routing.mode: auto`)
| role | model | fallback_model |
|---|---|---|
| planner | `metabolomics/deepseek_v4-flash-modality-text-quant-mxfp4` | `metabolomics/qwen3.8-flash_next-modality-text-quant-q4_k_xl` |
| implementer | `metabolomics/qwen3.8-27b-modality-vision-quant-q8_k_xl` | `flint/flint-40b` |
| reviewer | `metabolomics/qwen3.8-27b-modality-vision-quant-q4_k_m` | `metabolomics/qwen3.8-27b-modality-vision-quant-q4_k_m` |
| verifier | `metabolomics/qwen3.8-27b-modality-vision-quant-q4_k_m` | `metabolomics/deepseek_v4-flash-modality-text-quant-mxfp4` |
| spec_verifier | `metabolomics/qwen3.8-27b-modality-vision-quant-q4_k_m` | `metabolomics/deepseek_v4-flash-modality-text-quant-mxfp4` |
| test_reviewer | `metabolomics/qwen3.8-27b-modality-vision-quant-q4_k_m` | `metabolomics/deepseek_v4-flash-modality-text-quant-mxfp4` |

Discrepancy recorded, not resolved: the rev-5 comment block (`engineering.yaml:36-52`) says the
text/vision roles "now pin LOGICAL route IDs owned by the inferweave edge" (`coding-planning`,
`coding-implementation`, `coding-review`), but every `model:` value above is a concrete model id,
not a route id. Either the comment is ahead of the config or the config was reverted; the baseline
records what the file actually says.

## Test commands
- `npm run typecheck` → exit 0 (both `tsconfig.scripts.json` and the main project) — `logs/03-npm-typecheck.txt`
- `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts` → the
  five bootstrap unit files at this commit pass (3, 3, 2, 4, 3 tests, 0 fail; see `B01`–`B05/logs/`)

## Baseline failures
- `npm test` did **not** terminate. After ~20 minutes the conductor terminated it; no
  `tests/pass/fail` summary line was ever printed — `logs/04-npm-test-partial.txt`
- Captured partial output: 20728 lines, **4615** `✔` test names, **1223** `✖` test names.
  These are partial-run counts from the captured stream, not a completed-suite total.
- A separate suite log at a different base (`c349613b`,
  `docs/specs/harness-reliability-bootstrap-20261103/BASELINE-unit-suite-at-c349613b.txt`)
  reports 2180 pass / 150 failure lines. Different commit — not comparable to the numbers above.

## Unknowns carried forward
1. Whether the `npm test` non-termination is deterministic or environment-dependent.
2. The true full-suite pass/fail totals at this commit.
3. The externally installed pi package revision and the routes the live harness actually used.

## Plan deviation
`manifests/tasks.json` declares B00 `mode: read-only`, yet B00's declared production path is the
new file this report is. `src/bootstrap/diffGuard.ts:62` rejects any changed path under
`read-only`, so this record is stamped `isolated-change`, bounded to exactly the declared
production path. The manifest is left unchanged so the contradiction stays visible.
