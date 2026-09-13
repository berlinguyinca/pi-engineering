# Usage

`pi-engineering-runtime` runs as a pi extension inside a normal pi install and
works in any git repository. It requires no GitHub, AutoSpec, InferWeave, or
distributed infrastructure. The interactive pi session is used as usual; the
engineering runtime is available **on demand**.

## Install

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Running the full workflow

```bash
/engineer implement an isEven(n) helper in src/utils.js
```

The pipeline runs **asynchronously** with progress notifications:

1. **Scout** (fresh context) inspects the repo and recommends the smallest
   coherent change and the files to touch.
2. **Implement** a fresh worker edits an **isolated git worktree** (the main
   branch is never touched by the worker).
3. **Verify** runs deterministic gates (`node --test` etc.) and records evidence.
4. **Review** a fresh, independent reviewer inspects the candidate diff.
5. **Promote** — if clean, the verified change is merged into your working tree
   and the ledger records it. Material findings spawn a fix round (a child
   candidate) instead.

## Individual commands

| Command        | Effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `/engineer G`  | Full adaptive workflow (scout → implement → verify → review). |
| `/tournament G [n]` | Candidate tournament: n independent implementations, verify+review each, promote the deterministic winner (default 3, `--parallel` opt-in). |
| `/plan G`      | Decompose `G` into a dependency-aware task DAG (recorded in the ledger). |
| `/execute [plan]` | Execute a planned task DAG in dependency order via the engineer pipeline. |
| `/review`      | Fresh independent review of the latest candidate.             |
| `/challenge`   | Clean-room challenge of the current approach (fresh context, no prior reasoning). |
| `/verify [full]` | Detect a verification profile and run it, recording evidence (`full` = lint + test:full). |
| `/ledger [kind]` | Show work items + candidates + entities (optionally filter by `kind`, e.g. `/ledger finding`). |
| `/context`     | Show active context usage, ledger size, artifact count, budgets. |
| `/roadmap-status` | Show derived Roadmap 1.0 completion status for this repository. |

## Verifiable roadmap completion

`node scripts/pi-engineering.ts roadmap check` (or `npm run roadmap:check`)
returns a machine verdict: **exit 0** when the roadmap is complete. Completion
is **derived** from evidence bound to commit SHAs (unit/integration/typecheck/
lint/package_load/roadmap_test) + dependencies + freshness + a release gate
(deterministic suites + independent fresh-context review + dogfood). A relevant
change invalidates evidence (`NEEDS_REVERIFICATION`); completion is never
declared by a model. `roadmap status` prints the human summary. The structured
definition lives in `docs/roadmap/roadmap.yaml`; model-dependent evidence is
recorded by `node scripts/record-roadmap-evidence.ts --critical 0 --high 0`
into `docs/roadmap/evidence.yaml`.

## Durable state

State lives in `<repoRoot>/.pi-eng/` and is git-ignored:

```
.pi-eng/ledger.jsonl            append-only event stream (work items, candidates, entities)
.pi-eng/artifacts/              candidate diffs, verification logs, scout context
.pi-eng/roadmap/evidence.jsonl  regenerated roadmap evidence (bound to commit SHAs)
```

The ledger is event-sourced and replayed on open, so **no run depends on the
interactive transcript surviving** — you can close and reopen pi and `/ledger`
still shows prior work items, candidates, and evidence.

## Interacting with the ledger

- `/ledger` — all work items and their incumbent candidates.
- `/ledger finding` — open reviewer findings.
- `/ledger hypothesis` — claims not yet promoted to facts.
- `/verify` — run verification yourself and see the captured log artifact.

## Real-model smoke tests

After installing the package, from the repo directory:

```bash
node scripts/smoke-worker.ts    <repo>                 # real fresh worker
node scripts/smoke-engineer.ts  <repo> "your goal"     # full real /engineer
```

These require a configured model endpoint (pi's normal model config). The
deterministic unit/integration tests do **not** require a model.
