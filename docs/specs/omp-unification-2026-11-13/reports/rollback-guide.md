# Rollback guide (OMP unification, phases 1-7 and skills)

Everything that runs OMP is behind two environment flags and is OFF by default. Each flag is on only when its value, trimmed and lowercased, is one of `1`, `true`, `yes`, `on` (`src/omp/config.ts`, `src/omp/selectWorker.ts`); any other value, including `0`, `false`, empty or unset, is off. Legacy is the default path and needs no bun and no omp. The fastest rollback of any OMP behavior is therefore a flag, not a revert.

## 1. Flag rollback (no code change)

| Variable | Effect when unset / not `1` |
| --- | --- |
| `PI_ENGINEERING_OMP_WORKER` | `selectOmpWorker` returns `undefined`; `EngineeringRuntime.open` keeps the legacy `PiWorkerExecutor`. No omp process is ever spawned. |
| `PI_ENGINEERING_OMP_ADAPTER` | Negotiation reports `Unavailable (disabled)`; with the worker flag set the runtime falls back to legacy with a stated reason. |
| `PI_ENGINEERING_OMP_BIN`, `_BIN_ARGS`, `_MODEL`, `_HOME`, `_TIMEOUT_MS` | Only read when both flags are on. |
| `PI_ENGINEERING_WORKER_SKILLS` | Workers (legacy and omp) are skill-less: the `workers.skillPacks` allowlist is not even read. Unset it to roll back the worker skill packs opt-in; no code change. |

```sh
unset PI_ENGINEERING_OMP_WORKER PI_ENGINEERING_OMP_ADAPTER PI_ENGINEERING_OMP_BIN PI_ENGINEERING_OMP_BIN_ARGS PI_ENGINEERING_OMP_MODEL PI_ENGINEERING_OMP_HOME PI_ENGINEERING_OMP_TIMEOUT_MS
```

A failure before the prompt is sent (binary absent, crash before `ready`, `set_host_tools` rejected) already falls back to legacy automatically. A failure after the prompt is a failed `WorkerRun` and is never re-run silently.

## 2. Revert order (code rollback)

The stack is linear: 695 (phase 3) -> 696 (phase 4) -> 697 (phase 5) -> phase 6 (PR number not yet assigned) -> this branch (phase 7, `docs/omp-unification-final`). Revert from the top down, newest first, so each revert applies cleanly:

1. phase 7 (this PR): reverts the overlay trimming in `src/omp/firewall.ts` (context +34% again, ratchet back to 0.4 / 4200), the bash in-flight inactivity pause and these docs.
2. phase 6 (Herdr activity bridge): removes the frame-to-activity mapping in `OmpWorkerExecutor`; omp workers then look idle in the UI.
3. phase 5 (parity suite): tests and the additive `ScriptedModelServer.bodies`; no `src/` change.
4. phase 4 (worker, session and tool integration): removes `hostTools.ts`, the `acceptsCustomTools` wiring and three `export` keywords; omp workers then serve `/engineer` only again.
5. phase 3 (`/engineer` slice, #695): removes `OmpWorkerExecutor`, `selectWorker`, `rpcTranslate`, `firewall`, the 4-line hook in `EngineeringRuntime.open` and the firewall/model args in `negotiate.ts`.

Not in the stack, revertable on their own (each independent of the others, in any order):

- #690 phase 1 (docs only), #692 phase 2 (adapter spike: new files only under `src/omp/`; reverting it after phase 3 requires reverting phase 3 first), #691 coverage gate (CI/`package.json` script; reverting it removes the 85/83/83 floors), #693 legacy golden gate (`legacy-golden.test.ts`, `test/fixtures/legacy-golden/`; reverting it removes the byte-parity safety net, so revert phases 3-6 first).
- #694 skills (independent branch `feat/omp-skills-adoption`): `skill-packs/pe-operator/`, `src/skillpack`, `src/promptcompress`, scripts and tests. No runtime path imports them; reverting cannot change behavior. Use `git revert <merge sha>`.

#690-#694 were squash-merged: each merge SHA has exactly one parent (checked with `git rev-list --parents -n1 <sha>`; confirm the SHA with `gh pr view <n> --json mergeCommit`). Revert them with a plain `git revert <sha>` (no `-m 1`): 2cb95221 (#690), 783058de (#692), 24a66588 (#691), 1294390c (#693), c8c4c6ba (#694). The merge method of #695-#697 and the phase 6 and 7 PRs is not known yet (UNVERIFIED): run the same `rev-list --parents` check; one parent means `git revert <sha>`, two parents means `git revert -m 1 <sha>`. Do not force-push `main`.

## 3. State each phase may have created

| Phase | State it may leave behind | How to remove |
| --- | --- | --- |
| 1, 2 | none (docs; the spike spawns `omp --version` style probes only) | nothing |
| 3 | `<PE state dir>/omp-firewall/firewall.yml` (mode 0600, dir 0700; state dir is `$PI_ENGINEERING_STATE_DIR` or `~/.local/state/pi-engineering`). Rewritten atomically on each launch. Also omp's own files in whichever HOME omp ran under (`agent.db`, `models.db`, `skill-descriptions.db`, logs, bun cache) | `rm -rf "${PI_ENGINEERING_STATE_DIR:-$HOME/.local/state/pi-engineering}/omp-firewall"`; delete an isolated omp HOME only if you set `PI_ENGINEERING_OMP_HOME` to a directory you created for it |
| 4 | worker processes (one per run, own process group, killed on finish/abort/timeout). No persistent files beyond phase 3's | `pgrep -fl "omp.*--mode rpc"` should be empty when idle |
| 5 | tests only; test runs create temp dirs under the OS temp dir (isolated HOMEs, `pi-eng-*` worktrees) and are removed by test teardown | nothing |
| 6 | none (activity is in-memory, through the existing `onActivity` seam) | nothing |
| 7 | none at runtime; same overlay file as phase 3 with three more keys (it is rewritten to match, so rollback self-heals) | nothing |
| worker skill packs (opt-in) | `<PE state dir>/worker-skill-packs/<digest>/` (verified copies, dir 0700) and `<PE state dir>/omp-firewall/firewall-skills.yml` | unset `PI_ENGINEERING_WORKER_SKILLS`; `rm -rf "${PI_ENGINEERING_STATE_DIR:-$HOME/.local/state/pi-engineering}/worker-skill-packs"` |
| skills | none at runtime. An operator who opts in with `omp -e skill-packs/pe-operator` gets omp's own skill store entries under their omp agent dir; if auto-learn was ever enabled, `~/.omp/agent/managed-skills/*` | remove the `-e` flag / `extensions:` entry; `rm -rf ~/.omp/agent/managed-skills/*` if auto-learn had been on |

The ledger, custody, lease/fencing code and schema were not changed by any phase, so there is no ledger migration to undo. Ledger events written by an omp-backed run have the same shapes as legacy (asserted by `omp-ledger-parity.test.ts`) and replay under legacy unchanged.

## 4. Verify the rollback

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
# flags are off in this shell
env | grep PI_ENGINEERING_OMP        # expect no output
pgrep -fl "omp.*--mode rpc"          # expect no output
ls "${PI_ENGINEERING_STATE_DIR:-$HOME/.local/state/pi-engineering}/omp-firewall" 2>&1   # absent after cleanup
npm run typecheck && npx biome check .
# legacy gate, with no omp and no bun on PATH, must be 27/27 and byte-identical to the goldens
env -u OMP_BIN -u OMP_BIN_ARGS node --test --test-force-exit --import ./test/support/isolatedState.ts test/integration/legacy-golden.test.ts
git status --short test/fixtures/legacy-golden   # no golden changed
npm run test:coverage                # exit 0; floors 85/83/83
```

After a full code revert, `git grep -l "src/omp" -- src` returns only files you chose to keep, and `git ls-files src/omp` is empty.
