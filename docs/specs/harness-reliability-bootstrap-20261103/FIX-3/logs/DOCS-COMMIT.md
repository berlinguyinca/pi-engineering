# FIX-3 — land the run state in the repository (conductor commit, NOT a bootstrap unit)

Commit `24f42fba3f711dbf62a2c61d58a5545b0234865d` on `harness-reliability-bootstrap-20261103`
(parent `e77904e73f3cffc9bd3bb1c628900d91bff4e020` = FIX-2 result).
131 files, 37 960 insertions, 0 deletions — all under `docs/specs/harness-reliability-bootstrap-20261103/`
(task specs `00`–`09`, `B00`, `E01`, `E02`, `FIX-1`, `FIX-2`, `manifests/`, `examples/`, `templates/`
including `handoff.schema.json` and `operator-approval.md`, plus every evidence log).
No file outside `docs/` changed; `git -C …/pi-fix3-schema-validator-20261104 status --porcelain` is empty at
this commit, so the next worker worktree branches from a clean tree that can actually see the schema.

## Why this unit has no manifest and no handoff (finding, recorded in the ledger)

`parseTaskManifest` (B01) is fail-closed and refuses this commit:

```
limits.maxChangedLines: 40000 exceeds bootstrap ceiling 100
mode: expected one of read-only, isolated-change
unknown field: limits.maxFilesPerFileBudget
unknown field: limits.maxLinesPerFile
```

i.e. the task-manifest contract caps **every** bootstrap unit at ≤100 changed lines and two modes, and has no
per-file/per-count knobs (`maxLinesPerFile`/`maxFilesPerFileBudget` exist in `TaskLimits`/the diff gate but are
not expressible in a manifest). Consequences, both real:

1. Documentation, vendor/generated or dependency commits **cannot** be gated as bootstrap units — they must be
   conductor commits outside the unit protocol, exactly like this one. Nothing in the spec says so.
2. `limits.maxLinesPerFile` and `limits.maxFilesPerFileBudget` are dead configuration: the diff-scope gate reads
   them, but no manifest can carry them (defaults 2000 / 10 always apply). The gate therefore rejects a
   legitimate 2 500-line generated file with no way to declare it.

Both are handed to **FIX-4** (authority derivation + the limits/ceiling contract) as explicit sub-findings, and
the deviation is recorded in the FIX-3B manifest: FIX-3B declares `parentHandoffHash: null` because the
intervening conductor commit is not a handoff; SHA continuity is instead `FIX-3B commit^ == 24f42fba` and
`24f42fba^ == e77904e7` (FIX-2 result).

Large committed file, deliberate: `B00/logs/04-npm-test.out` (1.85 MB) is the baseline `npm test` output that
proves the 59 pre-existing failures recorded in `B00/BASELINE.md`.
