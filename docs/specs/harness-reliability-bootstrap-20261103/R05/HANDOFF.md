# R05 — Define idempotency classifier for recovery

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R05/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R04/R04.handoff.json (sha256:4f70f61636e9133c3657c86d47300dabd9d60cd316d154c41e536dfceb2b278f, status PASS, resultSha 5efe62fe00612c6e30e12e3a1c2f31ac4a852ef7 = your base).
Base commit: 5efe62fe00612c6e30e12e3a1c2f31ac4a852ef7. Mode: isolated-change.

## Objective (plan delta, verbatim)
Mark tool actions safe, unsafe or unknown for replay, default unknown to no replay; explicit safeguards for writes and external calls.
Evidence: Non-idempotent and unknown operations cannot be replayed automatically.

## Read first — the three adjacent seams, so you answer a question none of them answers
- `src/guard/toolCallGuard.ts` answers **permission**: `ToolCallGuardConfig` (`:25`) limits "identical consecutive calls allowed before the next one is blocked" (`:27`, defaults `:33`, env-resolved `:49`) and `ToolCallVerdict` (`:102`) is blocking-only (`{ block: true, reason }`, returned by `checkToolCall`). A call the guard *allows* is still not necessarily safe to **re-run after a crash**.
- `src/ledger/Ledger.ts` answers **duplicate durable event**: events carry `idempotency_key` (`src/core/types.ts:77`), the ledger indexes them (`:83`, `:294-295`) and rejects a reused key whose payload differs (`:287`). That fence protects the *event log*, not the *side effect* of re-executing a tool.
- `src/lifecycle/policy.ts` holds the risk vocabulary (`RiskPolicy` `:123`, `VerificationConfig` `:94`, `DEFAULT_POLICY` `:284`) — reference it in prose, do not import it.
So: this unit decides **only whether recovery may automatically replay a tool action**, and it must never default to "yes". `src/inference/endpointCircuit.ts` and `src/inference/retryBudget.ts` (both at your base) are the style siblings: pure, input-only, no clock, no RNG, ordered reasons.

## Scope (hard limits)
- Production file 1: `src/inference/recoverySafety.ts` (**new**).
- Test file 1: `test/unit/recovery-safety.test.ts` (**new**).
- Nothing else may change. `src/guard/**`, `src/ledger/**`, `src/lifecycle/**`, `src/resilience/**`, `src/models/**`, `src/inference/retryDelay.ts`, `src/inference/retryTrace.ts`, `src/inference/retryBudget.ts`, `src/inference/endpointCircuit.ts`, `src/workers/**`, `src/orchestration/**`, `src/runtime/**`, `src/plannerWorker/**`, everything under `scripts/**`, `templates/**`, `manifests/**`, `test/support/**`, `package.json` and `.gitignore` are denied. Total changed lines ≤ 100, at most 2 production and 2 test files.
- **Pure**: zero imports, no I/O, no `Date.now()`, no `Math.random()`, no `process.env`, no timers, no network. `nowMs` is not needed here — do not invent one.
- **No wiring**: no existing file may change, and nothing here may call `checkToolCall`, touch the ledger, or import `RiskPolicy`.

## Required shape (name things exactly, keep it small)
- `export type ReplaySafety = "safe" | "unsafe" | "unknown"`.
- `export interface ToolAction` — `name: string`, `writes?: boolean`, `external?: boolean`, `idempotencyKey?: string`.
- `export const READ_ONLY_TOOL_NAMES: readonly string[]` — exactly `["read", "grep", "glob", "ls", "symbol", "repo_search", "tests_for"]`, and the header comment must say this list is the harness's non-mutating tool surface and that adding a name is a **policy change requiring evidence**, not a convenience.
- `export type ReplayReason = "read_only" | "idempotent_key" | "mutating" | "external" | "unknown_tool" | "invalid_input"`.
- `export interface ReplayVerdict` — `safety: ReplaySafety`, `replayAllowed: boolean`, `reason: ReplayReason`.
- `export function classifyReplaySafety(action: ToolAction): ReplayVerdict`.
Precedence to implement and test: not-an-object / empty-or-non-string `name` → `{ safety: "unknown", replayAllowed: false, reason: "invalid_input" }`; `writes === true` → `unsafe` / `mutating` / false **even when the name is read-only** (the safeguard dominates the name); else `external === true` → `unsafe` / `external` / false; else a name **not** in `READ_ONLY_TOOL_NAMES` → `unknown` / `unknown_tool` / false, and this includes names merely cased differently (`"Read"`, `"grep "`) — match exactly, never normalise; else read-only **with** a non-empty trimmed `idempotencyKey` string → `safe` / `idempotent_key` / true; else read-only with no or blank key → `safe` / `read_only` / true. `replayAllowed` must be true **only** when `safety === "safe"`, and `classifyReplaySafety` must never return `safety: "safe"` for a `writes`/`external` action.

## Write tests for exactly these properties (one `it()` per property, dense, no narrative comments)
1. **Non-idempotent operations cannot be replayed.** `{ name: "bash", writes: true }` and `{ name: "edit", external: true }` → `unsafe`, `replayAllowed: false`, reasons `mutating` / `external`; and `{ name: "read", writes: true }` is still `unsafe` / `mutating` (safeguard beats name).
2. **Unknown operations cannot be replayed.** `{ name: "mystery_tool" }`, `{ name: "Read" }`, `{ name: "grep " }` → `unknown`, `replayAllowed: false`, `unknown_tool`; and `READ_ONLY_TOOL_NAMES` is exactly the seven names listed in the contract (assert the array contents).
3. **Missing information defaults to no replay.** `{}` (no `name`), `{ name: "" }`, `{ name: 42 as unknown as string }` and `null as unknown as ToolAction` → `unknown` / `replayAllowed: false` / `invalid_input`; and an action with `writes: undefined`, `external: undefined` on a read-only name is treated as its read-only default, never as unsafe *or* as proof of idempotency.
4. **Read-only is replayable, with the key recorded distinctly.** Each of the seven read-only names with no key → `safe` / `read_only` / `replayAllowed: true`; the same name with `idempotencyKey: "k1"` → `safe` / `idempotent_key` / true; `idempotencyKey: "   "` → `read_only` (blank is absent, not a key).
5. **The invariant holds over a table.** For every combination of the seven names × `{writes: undefined|true}` × `{external: undefined|true}` × two keys, assert `verdict.replayAllowed === (verdict.safety === "safe")` and that no verdict with `writes` or `external` true is ever `safe` (168 combinations — compute it, assert the count you evaluated).
6. **Pure and side-effect free.** Read the module's own source with `readFileSync` and assert it contains none of `import `, `Date.now`, `Math.random`, `process.env`, `setTimeout`, `fetch`, `writeFile`; and two calls with the same action object return deep-equal verdicts.

## Verify (must be green at the commit you produce)
1. `npm run typecheck`
2. `node --test --import ./test/support/isolatedState.ts test/unit/recovery-safety.test.ts`
Then report per-suite counts for `test/unit/endpoint-circuit.test.ts`, `test/unit/retry-budget.test.ts`, `test/unit/transient.test.ts`. Note: `npm run lint` (biome) already fails repo-wide at this base — do not chase it.

## Report
Write `WORKER_REPORT.md` in the worktree root (untracked is fine; the conductor copies it): `git diff --numstat 5efe62fe00612c6e30e12e3a1c2f31ac4a852ef7 HEAD`, exit codes for both verify commands, the three per-suite regression counts, the precedence table as implemented, and one paragraph on how `classifyReplaySafety` differs from `checkToolCall` (permission) and the ledger's `idempotency_key` fence (duplicate event). Commit as `feat(inference): replay-safety classifier defaulting unknown to no replay (R05)`.
