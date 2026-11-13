# Correction to X10's blocking caveat (`worker-budget-build-hint.test.ts`)

Record corrected: `X10/out/X10.handoff.json` (and its chain generation `X10/out-chain/X10.handoff.json`).
Correcting unit: **X12** (merge sync + measurement), branch `task/x08-common-dir-repair`.
Both X10 generations stay byte-unchanged and hash-bound; this file is a pointer, not a rewrite — rewriting a
hash-bound record would break the X10 → X11 lineage links.

## What X10 said

X10/logs/05 (`05-budget-hint-load-flake.txt`) reported: `test/integration/worker-budget-build-hint.test.ts` fails 2 of
3 copies at `--test-concurrency=4` on this branch while passing alone and at `origin/main`, and carried it as the
blocking caveat for merging PR #616.

## What is actually true

The reproduction used `npx tsx --test …` with neither `--import ./test/support/isolatedState.ts` nor
`--test-force-exit`. The repository's gate is `npm test`:

    node --test --test-concurrency=4 --test-force-exit --import ./test/support/isolatedState.ts \
      "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"

Under the gate's own command the file passes; without the preload the same files do not. Measured at branch tip
`4be00c17` (full logs: `X12/logs/03-*.txt`, summary: `X12/logs/05-method-correction-budget-hint.txt`):

| invocation | target | result |
|---|---|---|
| gate command (preload + force-exit) | the four drifted integration files, concurrency 4 | 55 pass / 0 fail, 47.7 s, exit 0 |
| `npx tsx --test --test-timeout=180000` | the same four files | one leaf hits the 180 s ceiling; process never exits, killed at 2400 s |
| gate command | `worker-budget-build-hint.test.ts` × 3 copies | 3 pass / 0 fail, exit 0 |
| `npx tsx --test` (no preload) | `worker-budget-build-hint.test.ts` × 3 copies | 3 pass / 0 fail, exit 0 |
| `npx tsx --test` (no preload) | `worker-budget-build-hint.test.ts` alone | 3 pass / 0 fail, exit 0 |

The leaf asserts elapsed milliseconds against a 10 s budget, so it is sensitive to what shares the process' state
directory with it — which is exactly what `test/support/isolatedState.ts` exists to prevent. Nothing on this branch
makes it worse than `main`, and under the command the repository gates on the suite terminates with 0 cancelled.

## Consequence for the series

X10's attribution ("branch-introduced, blocks merge") is wrong, and its severity is not merge-blocking. The same
method also produced X10's whole-suite tally (5 failures) and the X08-era tallies; every number X12 reports is taken
with the gate invocation, and `X12/logs/02-whole-suite-canonical-at-4be00c17.txt` is the first whole-suite figure in
the X series measured with the command the repository actually gates on.
