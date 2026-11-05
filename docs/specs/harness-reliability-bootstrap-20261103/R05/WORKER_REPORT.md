# R05 — Replay-safety classifier (worktree report)

Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-r05-recovery-safety-20261108`
Branch: `feat/r05-recovery-safety` (base `5efe62fe00612c6e30e12e3a1c2f31ac4a852ef7`, parent handoff `sha256:4f70f61636e9133c3657c86d47300dabd9d60cd316d154c41e536dfceb2b278f`)
Commit: `62f190ff feat(inference): replay-safety classifier defaulting unknown to no replay (R05)`
Authority: `docs/specs/harness-reliability-bootstrap-20261103/R05/HANDOFF.md`

## Files changed (numstat over the base)

```
$ git diff --numstat 5efe62fe00612c6e30e12e3a1c2f31ac4a852ef7 HEAD
33	0	src/inference/recoverySafety.ts
54	0	test/unit/recovery-safety.test.ts
```

87 added lines, 2 files (limits: ≤ 100 lines, ≤ 2 files) — both new, no existing file touched, no wiring
(`src/inference/index.ts` untouched), no call to `checkToolCall`, no ledger or `RiskPolicy` reach.
`node_modules` is a symlink to `/Users/wohlgemuth/IdeaProjects/pi-engineering-runtime/node_modules`
(untracked, ignored) added because a fresh worktree has no install.

## Verify

| command | exit |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/recovery-safety.test.ts` | 0 (6 tests, 6 pass, 0 fail) |

Sibling suites re-run green at this commit (same isolated-state loader):

| suite | exit | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/unit/endpoint-circuit.test.ts` | 0 | 6 | 6 | 0 |
| `test/unit/retry-budget.test.ts` | 0 | 6 | 6 | 0 |
| `test/unit/transient.test.ts` | 0 | 40 | 40 | 0 |

`npm run lint` (biome) still fails repo-wide at this base, as the contract says; not chased.

## Precedence as implemented (`classifyReplaySafety`)

Evaluated top-down, first match wins; `replayAllowed` is true only on the two `safe` rows.

| # | condition | safety | reason | replayAllowed |
| --- | --- | --- | --- | --- |
| 1 | `action` is not an object (incl. `null`) | `unknown` | `invalid_input` | false |
| 2 | `name` not a string, or `""` | `unknown` | `invalid_input` | false |
| 3 | `writes === true` (even on a read-only name, even with a key) | `unsafe` | `mutating` | false |
| 4 | `external === true` | `unsafe` | `external` | false |
| 5 | `name` ∉ `READ_ONLY_TOOL_NAMES` (exact match: `"Read"`, `"grep "` are unknown) | `unknown` | `unknown_tool` | false |
| 6 | read-only + `idempotencyKey` a non-blank trimmed string | `safe` | `idempotent_key` | true |
| 7 | read-only + absent / non-string / blank key | `safe` | `read_only` | true |

`READ_ONLY_TOOL_NAMES` is exactly `["read", "grep", "glob", "ls", "symbol", "repo_search", "tests_for"]`;
absent `writes` / `external` are their read-only defaults, never evidence of idempotency. The property table
covers 7 names × `{writes: undefined|true}` × `{external: undefined|true}` × 6 key variants (`undefined`,
`""`, `"   "`, `"k1"`, `"k2"`, `" k3 "`) = 168 evaluated combinations, and asserts both
`replayAllowed === (safety === "safe")` and that no `writes`/`external` action is ever `safe`.
Purity is pinned by reading the module's own source and rejecting `import `, `Date.now`, `Math.random`,
`process.env`, `setTimeout`, `fetch`, `writeFile` (zero matches), plus deep-equality over repeated calls.

## How this differs from the two adjacent fences

`checkToolCall` (`src/guard/toolCallGuard.ts`) answers *permission within a live session*: it counts identical
consecutive calls against `ToolCallGuardConfig` ceilings and returns a blocking-only verdict. A call it allows
is merely "you may make this call now" — it says nothing about whether re-running that call after a crash, on
a different process and possibly with a different filesystem underneath, is harmless. `classifyReplaySafety`
answers the later question, and it does so over an action it never executes: the guard's `allow` and this
classifier's `safe` are independent, so recovery must consult both and may only replay when permission holds
*and* the action is provably read-only or explicitly keyed. The ledger's `idempotency_key`
(`src/ledger/Ledger.ts`, `src/core/types.ts`) answers a third question: whether a *durable event* was already
recorded, rejecting a reused key whose payload differs. That fence keeps the event log single-write; it does
not retroactively undo the side effect of re-executing `bash`, and a tool call with no ledger event at all
(e.g. a read) is invisible to it. The `idempotencyKey` here is therefore a classifier input, not a ledger
write: its presence upgrades a read-only action's reason from `read_only` to `idempotent_key` so recovery can
carry the key forward as evidence of intent, while an unsafe action's key never rescues it — which is exactly
the ordering the plan delta demands ("default unknown to no replay; explicit safeguards for writes and
external calls").

## Blockers / follow-ups (non-blocking for this unit)

1. **No task-manifest authority is stamped for the R05 commit.** `docs/specs/harness-reliability-bootstrap-20261103/R05/fixtures/manifest.json`
   does not exist in this worktree (only `HANDOFF.md`), so `canonicalHash(parseTaskManifest(manifest).manifest)`
   could not be computed or attached; `62f190ff` carries no `Task-authority:` footer, matching the base commit
   `5efe62fe` (R04), whose commit message likewise carries none. Same standing finding the R04 handoff recorded
   against `5efe62fe`; conductor-side stamping is the fix.
2. **`READ_ONLY_TOOL_NAMES` drifts from the live harness tool surface.** The list is pinned by contract
   (exact seven, exact case). `ls` names the read-only shell tool while the harness exposes `bash`; if a real
   read-only tool is added to the harness it must be added here deliberately, with evidence, per the header
   comment — never to make a replay succeed.
