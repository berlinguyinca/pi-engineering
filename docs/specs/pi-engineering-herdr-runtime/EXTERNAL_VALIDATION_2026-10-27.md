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

## Herdr: live health passed; live canary remains blocked

Read-only local commands:

```sh
~/.local/bin/herdr --version
~/.local/bin/herdr --help
~/.local/bin/herdr status server
~/.local/bin/herdr --skill
test "${HERDR_ENV:-}" = 1
```

Observed: client/server **0.9.1**, protocol **22**, endpoint and private protocol
compatible. `HerdrAgentRuntime.health()` through `RealHerdrCli` also returns
`ok: true`, `activeWorkers: 0`, server `0.9.1`, protocol `22`.
This checks availability, not provisioning or model execution.

The environment check exits 1. The installed skill (`herdr --skill`) explicitly
requires: "Before issuing any control command, verify that this agent is running
inside a Herdr-managed pane" and "If the check fails, say that you are not running
inside Herdr and stop. Do not inspect or control the focused Herdr session from
outside Herdr." Therefore this agent issued no pane, workspace, agent, session,
or handoff control commands. No existing agents or leases were stopped.

Independent code blocker: `HerdrAgentRuntime.provision()` still uses its opaque
runtime ID as the start target without worktree isolation. With worktree isolation
it uses `createWorktree().workspaceId` as that target. `RealHerdrCli.startAgent()`
passes the target to `agent start --pane`, which needs an actual pane ID.
`createWorktree()` reads top-level `workspace_id`/`path`; the actual response
topology also needs validation before treating it as pane provisioning.
These paths do not yet prove real pane provisioning. This validation scope
does not change runtime code.

To unblock a real canary, coordinate a dedicated, owned Herdr test session/pane
under the installed control requirements, repair and validate the real pane
mapping, and obtain from the session owner the intended InferWeave endpoint,
discovered model ID and authentication mechanism. Credentials stay outside
evidence files. Before sending any model prompt, coordinate the ephemeral
worker profile and session with the leader; never reuse the user's conversation.
The canary must prove planner → two engineers → tester → reviewer, artifacts,
isolation, routing and restart reconciliation from spec 15. None of those live
claims follows from a healthy server or a fake CLI test.

## Deterministic contracts and rollback readiness

```sh
node --test --import ./test/support/isolatedState.ts \
  test/integration/runtime-canary.test.ts \
  test/unit/agentruntime.test.ts test/unit/herdr-runtime.test.ts \
  test/unit/herdr-cli-argv.test.ts
```

Observed: **20 passed, 0 failed, 0 skipped**. This includes the deterministic
canary, both runtime contracts, selector negotiation, and CLI argument checks.
The canary uses `FakeWorkerExecutor`; the Herdr contract uses a fake client.

`createAgentRuntime` retains legacy as the default and accepts Herdr explicitly.
These selector tests establish availability of the legacy selection path, not
a live rollback drill. Spec 14's migration state machine, live canary gate,
rollback drill and telemetry window remain unproved. Keep the migration/default
decision unchanged until those gates have independent live evidence.

## Static verification

`npm run build` (both core and scripts typechecks), `shellcheck
scripts/test-openviking-postgres.sh`, Biome on the changed TypeScript test, and
`git diff --check` pass. The leader owns the full-suite and integration review.
