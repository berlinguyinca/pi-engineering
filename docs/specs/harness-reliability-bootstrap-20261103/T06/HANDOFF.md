# T06 — Attach task authority to APS actions

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T06/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T05/T05.handoff.json (sha256:3af76be362edfe86b710d934ec9a484bf00e25fa914bda8449ef46ec93f58709, status PASS, resultSha 75a15f0bce7b3f21ccae8a04d1525283eaf7fec7 = your base).
Base commit: 75a15f0bce7b3f21ccae8a04d1525283eaf7fec7. Mode: isolated-change.

## Objective (plan delta, verbatim)
Add optional task contract/hash + model quantization provenance fields to APS events; maintain backward compatibility with existing event consumers.
Evidence: trace links every classified action to known original task or marks unknown.

## Scope (hard limits)
- Exactly 2 files: `src/aps/types.ts` (production ≤ 2 — `src/aps/index.ts` may be the second only if it does not already re-export `types.ts`; check first and say what you found) and the NEW `test/unit/aps-task-authority.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- Denied: every other file — notably `src/aps/{observability,fingerprint,progress,workerActivity,supervisor,recovery,escalation,context,rollout,index}.ts`, `src/bootstrap/**` (T01's `taskAuthority.ts` is the authority source: import it, do not edit it), `src/workers/**` (the quantization convention lives in `PiWorkerExecutor.ts:2541-2549`), `src/runtime/**`, `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus `npm run build` is NOT needed; instead rely on `npm run typecheck` for repo-wide backward compatibility and report its exit code.

## Current shape (src/aps/types.ts)
`AgentAction` (line 77) carries `role, iteration, tool, normalizedArguments, toolResultSummary, contentFingerprint, phase, sessionId, runId, workItemId` — no link to the original task and no model provenance. `AgentLoopCandidateEvent` (line 220) and `AgentLoopPreventedEvent` (line 308, `Omit<AgentLoopCandidateEvent,"type">`) are the trace events; `AgentLoopEvent` is their union. Authority hashes are produced by `deriveTaskAuthority()` in `src/bootstrap/taskAuthority.ts` as `sha256:<64 hex>`; model quantization is derived elsewhere from the model id with `/[-_]quant[-_]([a-z0-9._]+)/i` → captured group, else `null` (`src/workers/PiWorkerExecutor.ts:2545`).

## Required behaviour (all additive, all optional — nothing existing may break)
1. Add to `AgentAction` (so every classified action and both loop events inherit it):
   - `taskProvenance?: TaskProvenance` where `TaskProvenance` is a discriminated union: `{ state: "known"; authority: string; taskId: string }` (authority is the T01 canonical original-task hash, `sha256:<64 lowercase hex>`) or `{ state: "unknown"; reason: string }`.
   - `modelProvenance?: ModelProvenance` = `{ provider: string | null; model: string | null; quantization: string | null }`.
2. Export pure, deterministic constructors so producers cannot invent shapes:
   - `describeTaskProvenance(input: { authority?: unknown; taskId?: unknown }): TaskProvenance` — `"known"` only when `authority` matches `^sha256:[0-9a-f]{64}$` AND `taskId` is a non-empty trimmed string; otherwise `"unknown"` with a reason naming what failed (missing authority / malformed authority hash / missing task id — a malformed hash must say it is malformed, not merely missing). Never throw; never coerce numbers or booleans into strings.
   - `describeModelProvenance(input: { provider?: unknown; modelId?: unknown }): ModelProvenance` — keeps the trimmed strings (or `null` when absent/not a string) and derives `quantization` with the same `/[-_]quant[-_]([a-z0-9._]+)/i` convention the worker seam already uses, `null` when the id does not name one. Never throw.
   - `isKnownTaskProvenance(p: TaskProvenance | undefined): p is Extract<TaskProvenance, { state: "known" }>` type guard.
3. Backward compatibility is a hard requirement: no existing field changes shape, requiredness or order; no new required field on any existing interface; existing object literals of `AgentAction` / loop events must keep typechecking (that is what `npm run typecheck` proves across the repo — do not "fix" callers by adding fields, and if typecheck fails, your change is wrong).
4. Do not wire producers: `src/aps/observability.ts`, `workerActivity.ts` and the runtime stay untouched, so the fields are absent (not `unknown`) until a later unit emits them; state that in your report.
5. Document each new field with a one-line comment saying who is expected to fill it (the action-classification seam / the worker dispatch) and that absence means "not recorded", which is distinct from `state: "unknown"` (recorded as unattributable).

## Tests (new test/unit/aps-task-authority.test.ts)
Pure unit tests, no fs beyond `test/support/isolatedState.ts`: a valid sha256 authority + task id produces `state: "known"` carrying both; missing authority, `sha256:abc`, 64 uppercase hex, `sha256:` + 63 hex, empty/whitespace task id, and non-string authority (number, object) each produce `state: "unknown"` with a reason that distinguishes malformed from missing; `describeModelProvenance` extracts quantization from `qwen3.8-max_next-quant-int8` → `int8`, returns null quantization for `qwen3.8-flash_next`, null provider/model for absent or non-string inputs, and never throws; `isKnownTaskProvenance` narrows correctly for both states and `undefined`; and an `AgentAction` literal built with ONLY the pre-existing required fields still typechecks and has `taskProvenance === undefined` / `modelProvenance === undefined` (backward-compatibility proof).

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/aps-task-authority.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 75a15f0bce7b3f21ccae8a04d1525283eaf7fec7 HEAD`, each command with exit code, whether `src/aps/index.ts` needed a change, and any deviation or BLOCKED clause. Commit only the two files as `feat(aps): optional task authority and model provenance on actions (T06)`.
