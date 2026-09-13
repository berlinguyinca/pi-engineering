# pi-engineering-runtime

An autonomous **engineering runtime** for the **pi** coding agent: a durable
Engineering Ledger, fresh-context scouts/implementers/reviewers, isolated
candidate worktrees, deterministic verification, and a risk-adaptive
multi-agent workflow — all in-process with a normal pi install, no GitHub,
no AutoSpec, no InferWeave, no distributed infra, and no extra models.

> The authoritative design specification is
> [docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md](docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md).
> Operating policy for agents working in this repo is in
> [AGENTS.md](AGENTS.md).

## What it does

Given a goal, `/engineer` runs the full vertical slice:

```
inspect repo ──▶ scout (fresh context) ──▶ bounded task context
    ──▶ implement (isolated git worktree) ──▶ deterministic verification
    ──▶ independent review (fresh context) ──▶ controlled merge/promotion
    ──▶ evidence recorded in the durable ledger
```

Material review findings trigger fix rounds; each fix runs as a *child*
candidate in a fresh worktree. Nothing about a run depends on the interactive
transcript surviving — all state is on disk in `.pi-eng/` (ledger + artifacts +
roadmap evidence). When the repository's Roadmap 1.0 is complete,
`/engineer`, `/plan`, `/tournament`, and `/execute` refuse to invent new work
(autonomous stop) — the runtime does not keep manufacturing work past "done".

## Install as a pi extension

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Commands

| Command            | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `/engineer G`      | Run the full adaptive workflow for goal `G`                    |
| `/tournament G [n]` | N independent implementations; verify+review each; promote the deterministic winner (default 3, `--parallel` opt-in) |
| `/plan G`         | Decompose `G` into a dependency-aware task DAG (recorded in the ledger) |
| `/execute [plan]` | Execute a planned task DAG in dependency order via the engineer pipeline |
| `/review`         | Fresh-context independent review of the current candidate      |
| `/challenge`      | Clean-room challenge of the current approach (no prior reasoning) |
| `/verify [full]`  | Run risk-appropriate verification, record deterministic evidence (`full` = lint + test:full) |
| `/ledger [k]`     | Show work items, candidates, and ledger entities (optionally filtered) |
| `/context`        | Show context budget, sources, and worker usage                 |
| `/roadmap-status` | Show derived Roadmap 1.0 completion status for this repository |

`pi-engineering roadmap check` (also `npm run roadmap:check`) returns a
**verifiable completion verdict**: exit **0** when every required milestone is
VERIFIED with fresh evidence, the release gate passes (deterministic suites +
independent fresh-context review + dogfood), and no unresolved critical/high
findings remain. Completion is **derived from machine evidence bound to commit
SHAs** — never declared by a model. `pi-engineering roadmap status` prints the
human summary. See `docs/roadmap/roadmap.yaml` and
`docs/specs/pi-engineering-verifiable-roadmap-completion-spec.md`. The roadmap
engine is also exported as a public API from `src/index.ts`.

## Semantic tools

`ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
`tests_for` — bound to the runtime for the current working directory, so
workers and the interactive session can retrieve task context cheaply.

## How to use it

1. `pi install /absolute/path/to/pi-engineering-runtime`
2. In any git repo: `/engineer implement an isEven(n) helper in src/utils.js`
3. Watch the scout → implement → verify → review → promote pipeline; the
   verified change is merged into your working tree, and the ledger records
   every claim, hypothesis, finding, and piece of evidence.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test (unit + integration, deterministic)
```

- Tests run via `node --test` (Node >= 22.6 native type-stripping); imports use
  explicit `.ts` extensions.
- `test/fixtures/make-fixture.ts` builds temporary git fixture repos.
- `test/integration/vertical-slice.test.ts` is the end-to-end slice using a
  deterministic fake worker; real-model execution is exercised by
  `scripts/smoke-*.ts`.

## Structure

```
extensions/          pi extension entry point (commands + tools)
src/core/            domain types + ids
src/ledger/          append-only event store + event-sourced ledger
src/artifacts/       filesystem artifact store (artifact:// URIs)
src/git/             worktree isolation + diff capture + controlled merge
src/context/         bounded task-context broker (repo map + git grep)
src/verify/          deterministic CommandVerifier + provider abstraction
src/plan/            dependency-aware task DAG planning
src/roadmap/         verifiable roadmap completion engine (check/status/evidence)
src/workers/         role prompts + bounded worker_result tool + executors
src/runtime/         EngineeringRuntime facade (plan/engineer/tournament/review/challenge)
src/tools/           semantic tools bound per-cwd
scripts/             real-model smoke tests + roadmap CLI + evidence recording
.github/workflows/   CI (typecheck, lint, tests, package-load, roadmap:check)
```

## License

MIT
