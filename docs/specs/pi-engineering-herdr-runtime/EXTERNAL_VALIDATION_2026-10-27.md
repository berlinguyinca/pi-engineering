# External integration validation — 2026-10-27

Baseline: `19729c49cb646332f0e084a080fcf2c0398efe63`. This evidence supplements
the historical reconciliation records; it does not mark the live migration gates complete.

## PostgreSQL: passed against an isolated real server

Prerequisites: Node 22, PostgreSQL server tools (`pg_config` on PATH, or set
`PG_BINDIR`), and the service's existing dependencies. Run from the repository root:

```sh
npm ci --prefix services/openviking --ignore-scripts --no-audit --no-fund
bash scripts/test-openviking-postgres.sh
```

The harness creates a private temporary PostgreSQL cluster, disables TCP, uses
a Unix socket inside its owned directory, creates its own database, and replaces
any inherited `TEST_DATABASE_URL`. Its exit trap stops only that cluster and
removes the temporary directory. It never reads deployment credentials or
connects to an existing database. Run as an unprivileged user.

Observed with Node 22.23.2 and PostgreSQL 16: **5 passed, 0 failed, 0 skipped**.
The actual `PostgresStore` test verifies every persisted field, token search,
primary-key updates without duplication, and persistence across closing and
reopening the connection pool. Other tests verify the HTTP/provider contract
using the memory backend; this run does not claim a PostgreSQL-backed HTTP test.
After exit, no owned cluster process or temporary cluster directory remained.

## Herdr: real provisioning, lifecycle and bounded model canary passed

Read-only checks of `herdr --version`, `herdr --help`, `herdr status server`
and `HerdrAgentRuntime.health()` show client/server **0.9.1**, protocol **22**,
compatible endpoints and healthy availability.

The outer validation process has no `HERDR_ENV`. The installed `herdr --skill`
requires control commands to originate inside a genuine Herdr-managed pane.
An owned named server resolves this without assigning a fake environment flag:

1. Create a private temporary directory containing a configuration whose documented
   `[terminal].default_shell` points to an owned bootstrap script, and set
   `[worktrees].directory` to an owned temporary worktree directory.
2. Start `HERDR_CONFIG_PATH=<owned-config> herdr --session <unique-name> server`.
   Headless startup has no initial pane, so attach a PTY client to that same named
   session solely to create its initial workspace. Send no keyboard input.
3. The bootstrap verifies Herdr's injected `HERDR_ENV=1` and checks that
   `herdr --session <unique-name> status server` reports exactly the named socket.
   After its readiness marker, terminate only the owned client process. Keep the
   bootstrap pane alive, including after command errors. CLI group-help commands
   can return nonzero and must not cause the last pane to exit.
4. Run every validation command from that genuine managed bootstrap pane,
   explicitly selecting the unique session and checking its socket before each
   mutation. An owned job-file loop permits this without further TUI input.
   Use an empty private Pi profile, a disposable Git repository and no model prompt.

Actual session: `pi-herdr-validation-xu2jbd3c`; its data and fixture repository
are under `/tmp/pi-herdr-validation-xu2jbd3c`. The genuine bootstrap reported
`managed=1 pane=w1:p1 workspace=w1`. No default-session API controls were issued;
no pre-existing agents, leases or servers were stopped.

The installed CLI/schema and real responses identified and verified these fixes:

- `workspace create --cwd <path> --no-focus` returns
  `result.workspace.workspace_id` and `result.root_pane.pane_id`.
- `worktree create --cwd <repo> --no-focus` returns those fields plus
  `result.worktree.path`. The old positional-repository invocation was invalid.
- Agent startup must target the returned root pane, never a workspace ID or
  a generated runtime ID. Creation now fails closed, and startup retries reuse
  their allocated pane. Parallel same-role workers get distinct legal names.
- `agent get` and `agent wait` return `result.agent`; treating the outer result
  as an agent reproduced a false `LOST` status for a real idle Pi process.
  Both operations now unwrap the actual response. `agent read` returns plain
  terminal text. Runtime waits no longer include `working` as a settled state.

Real probes through `RealHerdrCli` and `HerdrAgentRuntime` passed workspace
creation (`w4:p1`), worktree creation (`w5:p1`), real Pi startup (`w6:p1`), and
worktree-backed startup/get/wait/read (`w8:p1`). Startup returned `READY`, a
subsequent live get remained `READY`, and explicit owned-pane termination
completed. These initial probes sent no model prompt. A separately authorized bounded
model canary then used only a disposable profile and the session owner's selected
InferWeave model configuration, as recorded below.

The live arithmetic micro-canary ran planner → two parallel engineers → tester
→ reviewer, each in a distinct real Herdr/Pi worktree and fresh session. Tools,
extensions, MCP, skills and context-file discovery were disabled via documented
Pi CLI flags. The ephemeral profile selected provider `metabolomics`, model
`deepseek_v4-flash-modality-text-quant-mxfp4`, thinking off and at most 256 output
tokens per response. Only `models.json` and `auth.json` were copied from the
owner-approved private profile; credentials are excluded from repository evidence.

All five workers produced exactly one persisted assistant response, matched by
session-header checkout path. Every response ended with `stopReason: stop` and
runtime status `COMPLETED`. Output token counts were **99 / 115 / 84 / 146 / 150**.
The harness validated the actual JSON responses, materialized small artifacts,
passed both engineers' outputs to the tester, and passed all three artifacts to
an independent reviewer that approved them. It terminated each owned agent in a
`finally` block. Selected response and usage evidence is in
[`evidence/2026-10-27-herdr-canary.json`](evidence/2026-10-27-herdr-canary.json).

This proves bounded real model execution across the actual runtime seam, not
full spec-15 completion: the model workers had no tools and did not mutate Git;
artifacts were materialized by the harness. Restart reconciliation, final Git
integration and structured terminating worker-result extraction remain unproved.
The adapter still synthesizes its completion summary; response verification used
persisted assistant messages, never that summary as model-output evidence.

## Deterministic contracts and rollback readiness

```sh
node --test --import ./test/support/isolatedState.ts \
  test/integration/runtime-canary.test.ts \
  test/unit/agentruntime.test.ts test/unit/herdr-runtime.test.ts \
  test/unit/herdr-cli-argv.test.ts test/unit/herdr-ensure.test.ts \
  test/unit/lineage-emitter.test.ts
```

Observed after the provisioning fixes: **60 passed, 0 failed, 0 skipped**. This includes the deterministic
canary, both runtime contracts, selector negotiation, and CLI argument checks.
The canary uses `FakeWorkerExecutor`; the Herdr contract uses a fake client.

A bounded selector rollback check deliberately required protocol 999 against
the real owned protocol-22 server, verified negotiation rejection, selected the
legacy default, and completed an owned deterministic `FakeWorkerExecutor` task.
Result: `selectedRuntime: legacy`, `status: COMPLETED`; no production default
changed. This proves rejection followed by explicit legacy selection, not a
live server-outage recovery or model-backed legacy rollback drill.

Spec 14's migration state machine, full rollback drill and telemetry window
remain open. Keep the migration/default decision unchanged until those gates
have independent live evidence. All owned clients were detached before pane
cleanup; all owned test servers and temporary resources were then cleaned up.

## Static verification

`npm run build` (both core and scripts typechecks), `shellcheck
scripts/test-openviking-postgres.sh`, Biome on the changed TypeScript test, and
`git diff --check` pass. The leader owns the full-suite and integration review.
