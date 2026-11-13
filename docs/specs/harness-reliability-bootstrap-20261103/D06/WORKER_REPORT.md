# WORKER_REPORT — D06 (Register /diagnose-errors Pi command)

- **Date:** 2026-11-04 · **Mode:** isolated-change · **Status:** PASS
- **Repo/worktree:** `berlinguyinca/pi-engineering` @ `/Users/wohlgemuth/IdeaProjects/worktrees/pi-d06-diagnose-command-20261104`
- **Branch:** `feat/d06-diagnose-command` (unchanged before and after the commit)
- **Base:** `57b81f9608339c8481151df4b27a4bee60040703` (clean tree; equals the contract's base)
- **Result:** `5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e` — `feat(runtime): expose read-only /diagnose-errors command (D06)`
- **Parent handoff (declared in `docs/specs/harness-reliability-bootstrap-20261103/D06/HANDOFF.md`):** D05, `sha256:c34af64aacca9ca1f2ecba8511730dbdd6a1334d610198fbcfa838606bb964de`, status PASS

## Convention discovered (before writing anything)

| Fact | Evidence |
|---|---|
| Commands are registered with `pi.registerCommand(name, { description, handler })` — no registry, dispatcher or plugin surface | base `src/runtime/host/entry.ts:109` (`"engineering"`), same call shape at HEAD `src/runtime/host/entry.ts:160` |
| Host-owned commands go through the same Pi call, wrapped for generation fencing | `src/runtime/host/piBridge.ts:224`, `:234` (`registerCommand` → `this.pi.registerCommand`); tracked again at `src/runtime/host/runtimeEntry.ts:232` |
| Handler contract is `(args: string, ctx: ExtensionCommandContext) => Promise<void>`; `ctx.cwd` and `ctx.ui.notify(msg, "info"\|"warning"\|"error")` exist | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:968`, `ExtensionContext.cwd`, `ExtensionUIContext.notify` |
| The events namespace of a worktree = `resolveOrchestrationOverride() ?? worktreeRuntimeDir(resolveStateRoot(), identity.worktreeId)`, with `join(dir, "events")` | `src/runtime/isolation/stateDir.ts:32,40,46`; `src/runtime/isolation/RuntimeBinding.ts:94`; consumer `src/runtime/host/missionHandover.ts:88`; identity from `src/runtime/isolation/WorktreeIdentity.ts:63` |
| `resolveRuntimeBinding()` **must not** be used here: it probes writability with `mkdirSync(join(dir,"events"))` | `src/runtime/isolation/RuntimeBinding.ts:38-45` — so the adapter does the path arithmetic only |

## What was implemented

`src/runtime/host/entry.ts` (+51 lines), `test/unit/diagnose-errors-command.test.ts` (new, 48 lines). Nothing else changed.

1. **Same convention, no new machinery** — `registerDiagnoseErrors()` calls `pi.registerCommand("diagnose-errors", { description, handler })` (`entry.ts:109-125`). No registry, dispatcher or plugin surface was added.
2. **Thin adapter over D05** — the handler imports `scripts/diagnose-errors.ts` relatively (`entry.ts:114`) and calls its `parseArgs` + `runDiagnoseErrors` only (`entry.ts:119`, `:122`). No parsing, aggregation, fingerprinting, clustering or reading is duplicated in `src/`. The import builds clean (`npm run typecheck` exit 0), so no BLOCKED condition arose. It is a **dynamic** import so the shim's own load path stays free of package imports, as the file header requires (`entry.ts:13-15`); a `import type` (`entry.ts:18`) supplies D05's types with no runtime edge.
3. **Read-only permission scope** — `DiagnoseHooks.deps` is `Omit<DiagnoseDeps, "writeFile">` (`entry.ts:84`): `read` (D01 `readHostErrorOccurrences`), `aggregate` (D03), `evidence` (D04), `hostname`, `exists` are injected; a writer cannot be injected at all, so `--export` dies in D05's existing path with `export failed: no export writer injected` → **exit 4** (proven, test 3). The command never writes, mkdirs, appends or creates a directory anywhere, and never opens the events namespace except through D01.
4. **Namespace discovery, existing convention only** — `productionDiagnoseHooks` (`entry.ts:90-95`) composes `resolveOrchestrationOverride() ?? worktreeRuntimeDir(resolveStateRoot(), (await resolveWorktreeIdentity(ctx.cwd)).worktreeId)` then `join(dir, "events")`. No new env var, no hardcoded path, no probe/mkdir. An explicit `--namespace` from the user wins over discovery (test 4 asserts discovery is not even called).
5. **Bounded output with the exit class visible** — `diagnoseReport()` (`entry.ts:97-101`) prints D05's three summary lines (`namespace=`, `read …`, `occurrences=… clusters=… recovered=… unresolved=…`), at most `DIAGNOSE_TOP = 5` `cluster=` rows plus a counted remainder line (`… N more clusters`), any refusal text, and `exit=<code> <class>` where the classes are `ok` / `usage refused` / `namespace refused` / `read or export failed`. Delivery is `ctx.ui.notify(...)` — the surface the existing `/engineering` fallback uses (`entry.ts:160-167`) — `"info"` on success, `"warning"` otherwise.
6. **Registration point** — `installPiEngineering()` registers it first (`entry.ts:127`), before the Host import, so the diagnosis exists even when the Host import or install fails (test 1 covers both branches).

## Diff summary

```
$ git diff --numstat 57b81f9608339c8481151df4b27a4bee60040703 HEAD
51	0	src/runtime/host/entry.ts
48	0	test/unit/diagnose-errors-command.test.ts
```

99 changed lines total (ceiling 100), 2 files (production ≤ 2, tests ≤ 2). Denied paths untouched: `scripts/**`, `src/bootstrap/**`, `package.json`, `.gitignore`, `test/support/**`, `manifests/**`, `templates/**`. No dependency change. `git status --porcelain` at commit time showed only these two paths.

## Verification (run at the produced commit `5a5a2a65`)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | **0** | no diagnostics |
| `node --test --import ./test/support/isolatedState.ts test/unit/diagnose-errors-command.test.ts` | **0** | 5 tests, 5 pass, 0 fail |
| `… test/unit/diagnose-errors-cli.test.ts` (info) | 0 | 6 pass |
| `… test/unit/error-reader.test.ts` (info) | 0 | 4 pass |
| `… test/integration/runtime-host-entry.test.ts` (regression, imports `entry.ts`) | 0 | 5 pass |
| `… test/integration/runtime-host-legacy.test.ts` (regression, imports `entry.ts`) | 0 | pass |
| `… test/unit/split-view-vendor.test.ts` (regression, imports `entry.ts`) | 0 | pass |

Test coverage against the contract: (1) registered with a description, and registered whether the Host installs or throws; (2) a read-only diagnose through injected deps reporting the exact clustered totals line `occurrences=3 clusters=2 recovered=0 unresolved=3 duplicateEvents=0 rejected=0`, exactly **one** read, over the namespace derived from `ctx.cwd`, and `Object.keys(deps)` is exactly `aggregate, evidence, exists, hostname, read` — no writer in scope; (3) `--export` refused (`exit=4 read or export failed`) with the namespace directory and the single `errors.jsonl` file verified byte-for-byte unchanged before/after and no export file created; (4) a refused namespace through the **real** D01 reader prints `namespace refused (missing)` + `exit=3 namespace refused` and the missing directory is not created; (5) 7 clusters → 5 shown + `… 2 more clusters`, and a bad flag is refused by D05 before anything is read.

## Broader run — reported, not fixed (outside scope)

`npm run test:unit` did **not** finish inside a 2400 s budget (command timeout, not a test verdict). The failures it had already printed are all in areas with no import path to this change (artifact store, `GitRepo` worktrees, `ExecutionBroker`; `entry.ts` is imported only by `test/unit/split-view-vendor.test.ts`, `test/integration/runtime-host-{entry,legacy}.test.ts` and the new test). They are **pre-existing on this host**: `test/unit/data-loss-wave2b.test.ts` gives byte-identical verdicts at the untouched base `57b81f96` in a throwaway detached worktree — 99 tests, 20 pass, 79 fail, same `Error: ENOENT: no such file or directory, mkdir '/private/private/var/folders/…/T/w2b-…/repo/.git/pi-engineering-locks'` (doubled `/private` prefix from this machine's `/var` → `/private/var` resolution). My two files are not implicated.

## Deviations / limitations (facts, not opinions)

- `docs/specs/harness-reliability-bootstrap-20261103/D06/fixtures/manifest.json` does **not** exist (that directory holds only `HANDOFF.md`), so `taskAuthorityHash = canonicalHash(parseTaskManifest(manifest))` could not be recomputed from the contract's own input. No fabricated hash was recorded.
- No `D06.handoff.json` was stamped: the stamping CLI is `scripts/bootstrap-one.ts` (an explicitly denied path) and the contract forbids self-approval. This report plus the commit is the deliverable for the independent reviewer.
- No push, no merge, no PR, no deploy, no retry, no model switch, no delegation. `nextBaseSha` for D07 is `5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e` in this repository, pending independent approval and the manifest SHA check.
- `evidence: () => null` is injected deliberately: no function in `src/` resolves durable `RecoveryEvidence` by `eventId` (grep for `RecoveryEvidence` finds only `src/incidents/recoveryOutcome.ts`), so per D04 a row stays `unresolved` rather than an invented one. Wiring a durable evidence source is D07+ work, not this task.
- `npx biome check .` fails repo-wide, including D05's own committed files (`scripts/diagnose-errors.ts`, `test/unit/diagnose-errors-cli.test.ts`) — pre-existing at base and not one of this task's verification commands; the new code follows the surrounding dense formatting of D01–D05 rather than reformatting neighbours.
- `/diagnose-errors` is registered from the shim, not through `piBridge`'s generation-fenced table, so it is deliberately generation-independent (stateless read-only). If a reviewer prefers it Host-owned, the move is one line (`registerDiagnoseErrors(pi)` → inside the Host's registration table) with the cost that it disappears when the Host is broken — which is exactly when it is needed.

`D06 result: PASS; repo=5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e; artifacts=src/runtime/host/entry.ts, test/unit/diagnose-errors-command.test.ts, WORKER_REPORT.md; verification=npm run typecheck=0; node --test --import ./test/support/isolatedState.ts test/unit/diagnose-errors-command.test.ts=0 (5/5); info: diagnose-errors-cli=0, error-reader=0, runtime-host-entry=0; limitations=no D06 manifest fixture (taskAuthorityHash not computable), no handoff stamped (denied CLI, no self-approval), broad unit suite not completed in budget with pre-existing base-identical failures. Next: D07, **only** after independent approval and manifest SHA check.`
