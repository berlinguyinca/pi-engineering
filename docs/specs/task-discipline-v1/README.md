# Task Discipline & Context Integrity v1 — Pi-side spec of record

**Status:** the Pi-side policy engine is implemented and enforced
(`src/taskDiscipline/`); the Herdr control-plane side (contract/approval storage,
event types, dashboard panels, egress binding) is not built yet. Operator
runbook: [`docs/operations/task-discipline.md`](../../operations/task-discipline.md);
user-facing section: [`docs/usage.md`](../../usage.md) ("Task Contract gate").

**Provenance.** The program-wide design package (also `CONTEXT.md`,
`DASHBOARD.md`, `TEST_PLAN.md`, `IMPLEMENTATION_PROMPT.md`) lives in the Herdr
repository at
`docs/specs/herdr-task-discipline-v1-20261102-145938-43302/herdr-task-discipline-v1/`.
`SPEC.md` and `POLICY.md` here are verbatim copies of the two documents this
repository implements against, so a reviewer can read the requirement next to the
code. `task-contract.schema.json` and
`examples/peak-picking-investigation.json` are **updated** copies: the schema in
the upstream package predates the implementation and omits `scratchRoots`,
`protectedPaths`, `allowedTools` and `allowedCommands`, and the upstream example
used `${REPO_ROOT}` placeholders — the parser does not expand placeholders, so the
example here carries literal paths.

## Spec requirement → implementation

| SPEC.md requirement | Where it lives |
|---|---|
| Trusted contract, versioned, model cannot self-approve | `src/taskDiscipline/contract.ts` (`parseContract` rejects unknown fields, rejects an `investigation`/`review` contract carrying `writeRoots` or effects beyond `remote_read`); file read by `FileContractProvider` in `config.ts`, never by a tool |
| Wide read, narrow write, narrower external effects | `engine.ts` decision table; `contractHash` binds every decision to the exact authorization |
| Canonicalised paths including symlinks, cwd, env | `pathScope.ts` (`~`, `.`/`..`, deepest-ancestor `realpath`, segment boundaries; unexpandable `$VAR`/`$(…)`/glob reported unresolved) |
| Classify effects after parsing command chains; unknown → conservative | `shell.ts` (nested shells, `eval`, `$(…)`, pipes, `xargs`, `find -exec`, `sudo`, interpreters, `make`/`npm run`, wrappers, env prefixes) + `effects.ts` (git remotes with `insteadOf`, cloud/K8s/docker, scp/rsync/ssh destinations) |
| Deny at the execution boundary even when the model retries or explains | `hook.ts` `tool_call` / `user_bash` handlers, independent of the lifecycle controller; incident → `terminate` so the batch ends |
| Child tasks get a narrowed contract, never a widened one | `narrowContract()` in `contract.ts` (tested). **Pending:** `PiWorkerExecutor`/`scheduler` do not call it yet, so a worker inherits the parent's contract file |
| Fail closed when the policy service is unavailable | `config.ts` `lockdown` (missing/unreadable/invalid contract → nothing readable, writable or remote) |
| Redacted audit of allow/deny decisions with stable ids | `config.ts` `appendDecision` through `platform/redact.ts`; fields documented in the runbook |
| `audit_only` cannot be claimed protective | `verdict` is separate from `enforced`/`wouldDeny`; the block text says "not executed" only when enforced |
| >3 similar blocks in a rolling window → policy incident | `hook.ts` `track()` |
| Investigation must not modify data or deploy | mode/authority cross-check in `parseContract` + `write.readonly_mode` |

Deliberately **not** claimed by this repo: OS-level isolation on macOS (Linux has
the control plane's sandbox profile and egress allowlist; macOS has no
equivalent), coverage of adapters that spawn outside `tool_call`/`user_bash`, and
any defence against a local root shell. Those limits are stated in
`docs/operations/task-discipline.md` and must appear in reports.

## Parity

`test/unit/task-discipline-schema.test.ts` keeps `task-contract.schema.json` in
step with the parser: the property set, the required set, the mode and effect
enums, and the mode/authority rule. It also proves behaviourally that every field
documented as required fails to parse when absent.
