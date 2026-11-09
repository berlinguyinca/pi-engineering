# WORKER_REPORT — T06 (attach task authority to APS actions)

Branch `feat/t06-aps-authority` · base `75a15f0bce7b3f21ccae8a04d1525283eaf7fec7` · commit `1fdccb18`
Message: `feat(aps): optional task authority and model provenance on actions (T06)`
Parent T05 handoff: `sha256:3af76be362edfe86b710d934ec9a484bf00e25fa914bda8449ef46ec93f58709` (PASS, resultSha = this base).

## Diff vs base (`git diff --numstat 75a15f0bce7b3f21ccae8a04d1525283eaf7fec7 HEAD`)

```
40	0	src/aps/types.ts
60	0	test/unit/aps-task-authority.test.ts
```

Total changed lines: **100** (production 1 file / 40 lines, tests 1 file / 60 lines) — inside the ≤ 100 limit.
`git status --porcelain` after commit: clean (only the untracked, gitignored `node_modules` symlink).

## Verification (exit codes)

| command | exit |
| --- | --- |
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | **0** |
| `node --test --import ./test/support/isolatedState.ts test/unit/aps-task-authority.test.ts` | **0** (4 tests, 4 pass, 0 fail) |
| `npx biome check src/aps/types.ts test/unit/aps-task-authority.test.ts` (extra, scope-limited style gate) | 0 |

`npm run typecheck` green repo-wide is the backward-compatibility proof: no existing field changed shape,
requiredness or order, and no caller was "fixed" by adding fields. The full unit suite was **not** run
(baselined red per the handoff); `npm run build` was not run (it is an alias of typecheck).

## Did `src/aps/index.ts` need a change?

**No.** It already re-exports `types.ts` — `src/aps/index.ts:9` is `export * from "./types.ts";` — so the new
types and helpers are already public through the APS barrel. Production change count is therefore **1 file**.

## What was added (all additive, all optional)

- `TaskProvenance` = `{ state: "known"; authority: string; taskId: string } | { state: "unknown"; reason: string }`.
- `ModelProvenance` = `{ provider: string | null; model: string | null; quantization: string | null }`.
- `AgentAction.taskProvenance?` / `AgentAction.modelProvenance?` (appended last; comment names the expected filler:
  the action-classification seam and the worker dispatch seam).
- The same two optional fields on `AgentLoopCandidateEvent`, so **both** loop events carry them —
  `AgentLoopPreventedEvent` inherits through `Omit<AgentLoopCandidateEvent, "type">`.
- Pure exported helpers: `describeTaskProvenance`, `describeModelProvenance`, `isKnownTaskProvenance`
  (never throw, never coerce; `"known"` requires `^sha256:[0-9a-f]{64}$` **and** a non-empty trimmed task id;
  a malformed hash is reported as malformed, not as missing; quantization uses the worker seam's own
  `/[-_]quant[-_]([a-z0-9._]+)/i`).
- Authority-hash and quantization conventions are **re-declared as local regex constants with source
  comments**, not imported: `src/bootstrap/taskAuthority.ts` was read but not edited or imported, keeping
  `src/aps/types.ts` dependency-free (it previously imported nothing) and avoiding an aps→bootstrap edge.

## Producers are NOT wired (as required)

`src/aps/observability.ts`, `workerActivity.ts`, `supervisor.ts` and the runtime are untouched, so for every
action and loop event produced today both fields are **absent** — which means "not recorded" and is distinct
from `{ state: "unknown" }` ("recorded as unattributable"). A later unit must fill them.

## Tests (`test/unit/aps-task-authority.test.ts`, new)

1. valid `sha256:<64 hex>` + `"  t-42  "` → `known` carrying both, trimmed id, guard true.
2. absent / `null` / `""` authority → `unknown: missing authority hash`; `sha256:abc`, 64 **uppercase** hex,
   `sha256:`+63 hex, `42`, `{ h }`, `true` → `unknown` with a **malformed** reason; `""`, `"   "`, `undefined`, `7`
   task ids → `unknown` naming the task id; guard false for every unknown shape and for `undefined`.
3. `describeModelProvenance`: `qwen3.8-max_next-quant-int8` → `int8`, `qwen3.8-flash_next` → null quantization,
   `{}` and `{ provider: 7, modelId: { id } }` → all-null (no coercion), trimming kept.
4. backward-compat proof: an `AgentAction` literal with **only** the pre-existing required fields typechecks
   (`tsconfig.json` includes `test`, so typecheck enforces it) and both provenance fields are `undefined`.

## Deviations / notes

- No BLOCKED clause. No file outside the allowed two was modified; no denied path was touched.
- Environment: this worktree had no `node_modules`, so it is a symlink to the primary checkout's
  `node_modules` (per repo policy "symlink `node_modules` rather than reinstalling"). It is gitignored and
  not part of the commit.
- `npx biome check` was run on only the two files to keep the commit format-clean (repo uses biome,
  `lineWidth` 120); no repo-wide lint was run.
