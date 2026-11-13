# T08 — WORKER_REPORT

Unit: T08 (carry authority through context handoff) · mode: isolated-change
Base: `fbb1258e7e69ae3184f6f4596e2dae53232100ac` (parent T07 handoff sha256:c4334ccd36eebbaac6c2ea1bb0a1778306d721445642a9e889027ed8bddb3d80)
Branch: `feat/t08-handoff-authority` · Commit: `11131ece` — `feat(planner-worker): sealed handoff authority (T08)` (parent = base, verified with `git rev-parse HEAD^`)

## Diff vs base (`git diff --numstat fbb1258e7e69ae3184f6f4596e2dae53232100ac HEAD`)

```
50	0	src/plannerWorker/handoff.ts
49	0	test/unit/task-handoff-integrity.test.ts
```

Total changed lines: **99** (≤ 100). Pure additions — no existing line of `handoff.ts` was touched, so
`buildHandoff`, `renderHandoff`, `estimateTokens` and `WORKER_INSTRUCTION` are byte-identical. Exactly the
2 allowed files; `src/plannerWorker/types.ts` and every other denied path are unchanged (`git status`
clean at commit time; `node_modules` is a gitignored symlink, see Deviations).

## Verify commands

| command | exit code |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | **0** (no diagnostics) |
| `node --test --import ./test/support/isolatedState.ts test/unit/task-handoff-integrity.test.ts` | **0** — 5 tests, 5 pass, 0 fail |

Full unit suite NOT run (baselined red per the contract; only the two commands above were executed).

Pre-existing planner handoff test: **not run.** The contract restricts this worker to the two verify
commands above, so `test/unit/planner-handoff-command.test.ts` (the closest pre-existing planner-handoff
test) was deliberately not executed. Compatibility of existing callers rests on the pure-addition diff
(calls in `src/plannerWorker/executor.ts`, `src/plannerWorker/handoffCommand.ts`,
`test/integration/planner-worker-*.test.ts` use `buildHandoff`/`renderHandoff`, both untouched) plus a
green full-project typecheck, and the in-test assertion that `buildHandoff` still returns its
pre-existing shape (`token_estimate > 0`, merged constraints, acceptance/scope passed through, summary
still clipped with `…[truncated N chars]`).

## What was implemented (all additive, in `src/plannerWorker/handoff.ts`)

- `MAX_TRANSCRIPT_CHARS = 2_000`, `HandoffAuthority`, `SealedHandoff`, `HandoffAuthorityCheck`.
- `sealHandoff(handoff, transcript?)` — pure/deterministic; digests `objective`, `constraints` (sorted
  copy), `acceptance` (sorted copy), `scope` and the aggregate
  `canonicalHash({ objective, constraints, acceptance, scope })`; comment records that
  `mission_summary`, `decisions`, `architectural_context`, `dependency_results`, `correction`,
  `worker_outcome`, `token_estimate` are NOT authority-bearing (new summary ≠ moved authority).
  Transcript excerpt = first `MAX_TRANSCRIPT_CHARS` of the trimmed string (`""` for a non-string),
  `transcript_truncated` = clipped, `transcript_chars` = trimmed length; the full transcript is never
  retained anywhere in the envelope.
- `verifyHandoffAuthority(sealed, expectedAuthorityHash?)` — recomputes all four field digests plus the
  aggregate from `sealed.handoff`, names every diverged field (`objective`/`constraints`/`acceptance`/
  `scope`, recorded != recomputed), names both hashes on an expected-hash mismatch, and adds
  `expected authority hash missing` when the expected hash is absent/empty/non-string (fails closed).
  Never throws, never mutates (sorted copies, defensive `digests()`).
- `resumeHandoff(env, expectedAuthorityHash?)` — `malformed envelope` unless `{ handoff, authority }` are
  both objects; recomputes from `env.handoff` and rejects an envelope whose recorded `*_sha256` /
  `authority_hash` disagree with the handoff it carries (naming the altered part), then applies
  `verifyHandoffAuthority`. No scores/percentages/confidence anywhere — reasons are factual strings.

Tests cover: edited goal rejected (naming `objective`, via both entry points); same goal with a new
`mission_summary` accepted with unchanged `authority_hash`; edited and dropped `constraints`, changed
`acceptance`, widened `scope.allowed` each rejected naming that field; forged `authority_hash` on an
untouched handoff rejected by `resumeHandoff`; missing/`""`/`42`/`null` expected hash rejected; 5 000-char
(+ 6 000-char tail) transcript bounded with `transcript_truncated: true`, `transcript_chars` equal to the
trimmed length and `renderHandoff(sealed.handoff)` carrying none of it; non-string transcripts yield `""`
without throwing; `null`/`{}`/half envelopes give exactly `["malformed envelope"]`; double seal deep-equal;
`buildHandoff` shape/clip spot-checks.

## Deviations

1. **`canonicalHash` is imported from `src/bootstrap/resultGate.ts`, not `src/bootstrap/taskAuthority.ts`.**
   `taskAuthority.ts` imports `canonicalHash` from `resultGate.ts` and does **not** re-export it, so the
   import the contract names is impossible; `src/bootstrap/**` is DENIED, so adding a re-export was not an
   option. `resultGate.ts` is the identical canonicalizer `deriveTaskAuthority` hashes with ("hashing reuses
   the protocol canonicalizer in resultGate.ts"), so a handoff hash is comparable to a T01 task authority
   hash as required; the reason is stated in the envelope's doc comment. No file under `src/bootstrap/**`
   was edited.
2. **Dense formatting.** To fit the ≤ 100 changed-line cap with the mandated assertion set, the added code
   uses the compact multi-statement style already used by `src/bootstrap/*.ts` rather than the one-statement-
   per-line style of the rest of `handoff.ts`. `npm run lint` (biome) was not among the permitted verify
   commands and was therefore not run; typecheck is clean.
3. **Environment bootstrap:** this worktree had no `node_modules`, so it is a symlink to the primary
   checkout's `node_modules` (the documented approach in `AGENTS.md`, "Symlink `node_modules` into the new
   worktree rather than reinstalling"). It is gitignored (`.gitignore:3`) and absent from the commit.
4. **Type note:** the malformed-envelope branch of `resumeHandoff` returns
   `{ ok: false, reasons: ["malformed envelope"] }` with no `authority`, so `HandoffAuthorityCheck`'s
   failure variant carries `authority` optionally. The spec text for that branch lists only `ok`/`reasons`.
5. `verifyHandoffAuthority` does not itself compare the recorded `authority_hash` against the recomputed
   aggregate (step 3 names only the four diverged fields); envelope-hash integrity is enforced where the
   contract puts it — in `resumeHandoff` — so a rewritten envelope hash is still rejected on resume.

No BLOCKED clause. Nothing pushed (the contract asked only for the commit of the two files).
