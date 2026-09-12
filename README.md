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
transcript surviving — all state is on disk in `.pi-eng/` (ledger + artifacts).

## Install as a pi extension

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Commands

| Command       | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `/engineer G` | Run the full adaptive workflow for goal `G`                    |
| `/review`     | Fresh-context independent review of the current candidate      |
| `/challenge`  | Clean-room challenge of the current approach (no prior reasoning) |
| `/verify`     | Run risk-appropriate verification, record deterministic evidence |
| `/ledger [k]` | Show work items, candidates, and ledger entities (optionally filtered) |
| `/context`    | Show context budget, sources, and worker usage                 |

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
src/workers/         role prompts + bounded worker_result tool + executors
src/runtime/         EngineeringRuntime facade (scout/verify/review/challenge/engineer)
src/tools/           semantic tools bound per-cwd
scripts/             real-model smoke tests
test/                unit + integration tests
docs/specs/          authoritative design spec
```

## License

MIT
