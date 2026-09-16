# Pi Engineering Runtime — Agent Policy

## Operating Mode

This repository is autonomous by default.

Recommendation equals action.

When there is a clearly preferable engineering choice, make it and continue. Do not ask the operator to confirm recommendations, implementation details, refactors, filenames, type names, dependency choices, test additions, documentation updates, or other normal software-engineering decisions.

The authoritative product and architecture specification is:

`docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`

Read the relevant portions before making architectural decisions.

## Questions and Escalation

Do not ask the operator a question unless all of the following are true:

1. The decision materially changes product behavior, public API, persisted data, security posture, or project scope.
2. Neither the specification, existing repository conventions, tests, nor upstream documentation resolve it.
3. There is no clearly preferable reversible choice.

If uncertainty can be resolved by inspecting code, tests, documentation, upstream projects, package APIs, or running an experiment, do that instead of asking.

If one task is blocked, document the blocker and continue all unblocked work.

Do not stop merely to report progress.

## Engineering Behavior

Prefer working software and evidence over discussion.

For every substantial change:

1. inspect the relevant code and architecture;
2. determine affected behavior;
3. implement the smallest coherent solution;
4. add or update tests;
5. run formatting;
6. run type checking;
7. run targeted tests;
8. run broader tests when warranted;
9. review the resulting diff independently;
10. fix material findings;
11. rerun verification.

Do not claim success based on model judgment alone.

Tests, compiler results, linters, static analysis, and reproducible runtime behavior are evidence.

## Scope

Pi Engineering Runtime must remain usable independently.

Core code MUST NOT require:

* AutoSpec;
* InferWeave;
* a distributed cluster;
* multiple models;
* GitHub.

AutoSpec and InferWeave are optional adapters.

## Context Discipline

Keep model context small.

Prefer:

* symbol-level retrieval;
* bounded structured worker output;
* fresh-context workers;
* persistent external state;
* artifact references;
* lazy retrieval of large output.

Do not pass full transcripts between workers.

Do not insert large compiler logs, test logs, repository dumps, or generated artifacts into model context when a compact summary plus artifact reference is sufficient.

## Implementation Discipline

Do not prematurely implement the entire long-term architecture.

Build vertical slices that prove interfaces.

Prefer abstractions that permit later expansion over speculative implementations.

Do not build a custom LSP implementation before evaluating available integrations.

Keep dependencies minimal and justified.

Use small coherent commits with conventional commit messages.

## Merge and PR workflow

Always integrate work into `main`/`master` through a pull request. Do not push
commits directly to `main`/`master`, and do not create merge commits on
`main`.

For every unit of work:

1. do the work on a dedicated feature/fix branch off an up-to-date `main`;
2. push the branch to `origin`;
3. open a PR against `main` (or `master`) describing the change and its
   verification evidence;
4. only merge the PR once it is green.

If a direct merge into `main` has already happened, prefer a clean branch +
PR for the next change rather than force-rewriting shared history.

## One agent, one worktree

This repository is worked on by several agents at once. Each one MUST work in
its own git worktree, and MUST NOT run `git checkout`, `git switch` or
`git reset` in a directory it does not own.

This is not a new rule. INV-004 already requires that "every implementation
candidate MUST execute in an isolated git worktree, branch, container overlay,
or equivalent sandbox", and the runtime enforces it for the candidates it
creates (`GitRepo.createWorktree`; `docs/architecture.md`, "Candidate
isolation"). Agents editing the repository directly were the exception, and the
exception is what broke.

    git worktree add ../pi-engineering-runtime-<topic> -b <branch> origin/main

Symlink `node_modules` into the new worktree rather than reinstalling. The
object store is shared, so every commit is visible from every worktree
immediately.

### Why this matters more than it sounds

A shared checkout has ONE `HEAD`. When an agent switches branches it does so
for everyone in that directory, including an agent halfway through a task.
Observed in a single session:

- Commits landed on another agent's branch, because the checkout switched
  between `git add` and `git commit`. The PR was then rejected with "No commits
  between main and ..." while the work sat, invisible, on a branch nobody was
  looking at.
- Recovering it required a cherry-pick, which gave the commits new hashes,
  which orphaned the roadmap evidence bound to them, which failed CI. An hour
  of cascade from one branch switch.
- `npm test` reported failures belonging to another agent's in-flight work, so
  a green change looked red. Telling the two apart needed
  `npx tsx --test $(git ls-files 'test/**/*.test.ts')`, which is not something
  anyone should have to think of.

Nothing was lost — git does not lose committed objects — but every recovery
above was avoidable, and none of it would have happened in separate worktrees.

### If you are in a shared checkout anyway

- Check `git rev-parse --abbrev-ref HEAD` immediately before committing, not
  only before starting.
- Treat `git status` as a snapshot another process can invalidate.
- Recover orphaned commits from `git reflog`; they are not gone.
- Never `git reset --hard` a branch another agent may be on. Move your own
  commits to your own branch and leave theirs alone.

## Completion

Continue working until the requested milestone satisfies its acceptance criteria.

A milestone is not complete merely because the initial implementation exists.

Before completion:

* tests pass;
* type checking passes;
* formatting passes;
* package loading is verified;
* material review findings are fixed;
* documentation matches the implementation.

Only stop early for a genuine blocker that cannot be safely resolved autonomously.
