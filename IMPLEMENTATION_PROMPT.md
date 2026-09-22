# Paste-ready implementation prompt

You are already in the root of the existing Pi-Engineering repository.

First copy/unpack the downloaded spec pack into the repository so the files end up at:

`docs/specs/pi-engineering-herdr-runtime/`

Then implement the pack.

Read:
1. `docs/specs/pi-engineering-herdr-runtime/00-master.md`
2. its `README.md`
3. every numbered spec 01–16
4. existing source/specs/tests for sessions, workers, subagents, processes, worktrees, events, Pi-Web, InferWeave and OpenViking.

HARD RULES:
- This is a staged migration, NOT a rewrite.
- Reuse working code; do not create duplicate subsystems.
- Herdr is an EXTERNAL dependency. Do not fork or reimplement it.
- Pi-Web is the existing EXTERNAL operator UI. Do not rebuild it.
- Pi Forge is excluded: do not install, integrate, evaluate or implement it.
- Pi-Engineering owns work/DAG/policy/review/repair.
- Herdr owns persistent process/agent runtime concerns.
- InferWeave owns model/runtime/GPU scheduling. Never add static model-to-GPU assignments.
- OpenViking remains semantic shared memory; PostgreSQL remains operational history.
- All Herdr access must be behind AgentRuntime.
- Inspect actual current Herdr/pi-herdr source/API/version before relying on commands.
- Keep the legacy runtime until parity, recovery, canary and rollback gates pass.
- Fix 413 architecturally using artifact-first communication, bounded output, dynamic token+serialized-byte budgeting, fan-out/synthesis and preflight rejection/transformation. Do NOT merely increase request limits.
- Do not use a fixed context size such as 260k; discover it from InferWeave/runtime metadata.

PHASE A — RECONCILIATION
Before modifying architecture, inspect the repo and create:
`docs/specs/pi-engineering-herdr-runtime/IMPLEMENTATION_RECONCILIATION.md`

For every requirement mark EXISTING / PARTIAL / MISSING / CONFLICTING / EXTERNAL and point to the real source/tests. Identify old runtime code that may eventually be deprecated, but delete nothing yet.

PHASE B — PLAN
Create a dependency-aware implementation DAG from the reconciliation. Show it in the implementation log. Do not blindly implement numeric files if current architecture changes dependencies.

PHASE C — ABSTRACTION
Put the CURRENT runtime behind AgentRuntime first. Add contract tests and make them pass without behavior regression. Commit/checkpoint this independently.

PHASE D — HERDR
Investigate the actual current Herdr and pi-herdr APIs and write:
`docs/specs/pi-engineering-herdr-runtime/HERDR_COMPATIBILITY.md`

Record versions, supported operations, gaps, lifecycle fidelity, structured errors, worktree/recovery/remote support and the selected integration route. Then implement HerdrAgentRuntime behind a feature flag/runtime selector with capability/version negotiation.

PHASE E — COMPLETE THE ARCHITECTURE
Implement normalized worker state/events; structured WorkerResult; artifact-first communication; dynamic context/request byte budgeting; reusable fan-out/synthesis; proactive 413 prevention; worktree isolation; integration phase; independent review and bounded repair; InferWeave capability routing and admission handling; remote host/security policy; Pi-Web normalized APIs/events/actions; observability; recovery/reconciliation; idempotency and rollback.

PHASE F — VERIFY
Implement all tests in spec 15. Specifically reproduce the previous 'many design references eventually cause 413 request body too large' failure and prove Pi-Engineering splits/delegates/materializes artifacts BEFORE an oversized network request is sent.

Do not fake unavailable external services; mark externally blocked verification clearly.

PHASE G — CANARY
Run the closest real end-to-end workflow available:
planner → two parallel engineers → tester → independent reviewer → repair if needed → re-review.

Demonstrate worktree isolation, structured artifacts, normalized events, InferWeave model selection, worker visibility, restart reconciliation, bounded repair and integration.

PHASE H — MIGRATE
Keep legacy runtime rollback available. Make Herdr default only when spec 16 gates pass. Remove duplicated legacy runtime only after a successful rollback drill and evidence window.

ENGINEERING QUALITY:
Use existing project conventions. Prefer small composable services. Do not create a second event bus/task DB/workflow engine. Never automatically paste child transcripts into coordinator context. Never silently retry non-idempotent tasks. Never allow parallel workers to unknowingly edit the same checkout. Never classify terminal silence alone as dead/blocked.

At every major phase:
1. run relevant tests/typecheck/lint/build;
2. fix failures before continuing;
3. record commands and results in:
   `docs/specs/pi-engineering-herdr-runtime/IMPLEMENTATION_LOG.md`
4. make logical commits/checkpoints if this repository workflow permits.

FINAL OUTPUT:
Create:
`docs/specs/pi-engineering-herdr-runtime/FINAL_RECONCILIATION.md`

It must list:
- implemented;
- reused existing;
- external dependency;
- deprecated/removed;
- deferred/blocked;
- tests and evidence;
- canary results;
- rollback result;
- remaining risks.

Then print a concise terminal summary with:
- current migration phase;
- Herdr default enabled: yes/no;
- tests passed/failed;
- externally blocked checks;
- legacy runtime retained/removed;
- next action, if any.

Start now with repository inspection and PHASE A. Do not ask me to manually invoke `/engineer` or `/review`; use the Pi-Engineering workflow automatically.
