# Paste this into the main Pi Engineering session

You are in the **main local `pi-engineering` repository directory**.

Implement the complete Pi Engineering orchestration specification contained in the ZIP/spec bundle I provided. Treat the files under `docs/specs/pi-engineering-orchestration/` as the authoritative requirements.

## First: install the specs

If the ZIP is still in `~/Downloads`, locate the newest matching file:

```bash
ls -lt ~/Downloads/*pi-engineering*orchestration*.zip 2>/dev/null | head
```

Create the destination and extract it:

```bash
mkdir -p docs/specs/pi-engineering-orchestration
unzip -o ~/Downloads/pi-engineering-orchestration-spec.zip -d docs/specs/pi-engineering-orchestration
```

If the ZIP has a slightly different generated filename, use the actual matching file. Do not ask me to manually copy files if you can locate them.

Then read:

1. `docs/specs/pi-engineering-orchestration/README.md`
2. `docs/specs/pi-engineering-orchestration/00-master-spec.md`
3. all numbered specs in order
4. `docs/specs/pi-engineering-orchestration/14-acceptance-criteria.md`

## Critical constraints

- **PI WEB is the existing external project `jmfederico/pi-web`. Do not reimplement or replace it.**
- Integrate with existing PI WEB APIs/plugins/providers/tracked-session mechanisms wherever possible.
- **Pi Forge is out of scope. Do not install, evaluate, integrate, or implement it.**
- Reuse existing Pi Engineering code, existing engineering/review workflows, Pi child/subsession features, `pi-subagents`, and current process infrastructure wherever appropriate.
- Do not create duplicate orchestration systems.
- Normal-language user intent must automatically invoke engineering/review workflows. Slash commands may remain optional controls, but correctness must never depend on the user remembering them.
- Runtime policy must enforce validation/review/completion gates; do not rely only on prompts telling the model to remember them.
- The parent Pi Engineering session is the long-lived developer-facing orchestrator. Heavy work should be delegated.
- Deterministic commands belong in supervised subprocesses.
- Parallel mutating workers require safe write-domain/worktree isolation.
- Fresh independent review is mandatory for material code changes.
- InferWeave remains responsible for model/hardware placement.
- OpenViking may be used for durable shared semantic memory, but execution state must live in an authoritative state/event store.

## Implementation behavior

Do not merely produce a plan.

1. Inspect the current repository thoroughly.
2. Map the existing architecture against the specification.
3. Identify functionality that already exists and reuse it.
4. Write a concise implementation ledger mapping each spec requirement to:
   - existing/reused,
   - needs modification,
   - needs implementation.
5. Implement the system incrementally in the order described in `13-implementation-plan.md`.
6. Run tests continuously.
7. Add missing tests for lifecycle gates, retries, restart recovery, concurrency, worktrees, review automation, and intent routing.
8. Run the project's normal lint/typecheck/build/test suites.
9. Exercise end-to-end scenarios from the acceptance tests.
10. Use fresh independent review of the implementation before declaring completion.
11. Fix all blocking/major review findings.
12. Re-run validation after fixes.
13. Update architecture/developer documentation.
14. Do not stop after partial scaffolding if you can continue implementing.

## Progress reporting

Keep a concise running ledger such as:

```text
[done] mission/state model
[done] durable event store
[working] unified execution broker
[pending] scheduler/write domains
[pending] review/completion gate
[pending] PI WEB plugin integration
```

Show meaningful command/test output, but do not flood the parent context with huge logs. Summarize and reference artifacts/log files when output is large.

## Before completion

Prove at least these scenarios:

1. `"Add a health endpoint"` automatically invokes engineering + validation + fresh review without `/engineer` or `/review`.
2. `"Find out why login fails"` can begin as investigation and automatically escalate if code is changed.
3. Independent backend/frontend tasks can execute concurrently with safe isolation.
4. A reviewer finding blocks completion and creates repair work.
5. A user constraint added mid-run steers/cancels affected work correctly.
6. State can be restored/reconciled after orchestrator restart.
7. Existing PI WEB is used as the UI/session integration surface rather than rebuilt.

## Final output

When finished, report:

- architecture implemented
- files/modules added or changed
- existing components reused
- PI WEB integration mechanism used
- automated workflow routing behavior
- review/completion enforcement
- tests run and results
- remaining non-blocking limitations
- commands to launch/use the new system
- one example normal-language mission showing the complete orchestration path

Continue through implementation, testing, review, repair, and final validation. Do not stop at planning.
