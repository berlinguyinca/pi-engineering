# HANDOFF D04 — classify recovery outcome accurately (planned task, ordinal 17)

You are a **single microtask worker** on branch `feat/d04-recovery-outcome`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-d04-recovery-outcome-20261104` (base SHA
`23e2d90501dab6271482d0420f9268e8e244092e`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

**The gateway cuts long turns.** Three turns: production → test → verify+commit. **Line budget spans both
files**: production ≤ 55 lines, test ≤ 45 lines (total ≤ 100 added+deleted, gate-enforced; D03 landed at exactly
100, so do not assume slack).

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `D04`)

> "Classify recovery outcome accurately" — "Compute recovered, unresolved, suppressed, and unknown **from durable
> evidence**; **never infer success from HTTP 200 alone**."
> Evidence required: "**False recovery claims rejected with missing completion evidence.**" `dependsOn: [D03]`.

## Read first (modify none of them)

- `src/incidents/errorAggregate.ts` (D03) — its `AggregateRow.resolution?: "recovered" | "unresolved"` is the
  **caller-supplied placeholder** you now feed: keep it a pure classifier that returns a richer outcome plus the
  reason and the missing evidence, so D03's caller can pass `resolution` derived from you.
- `src/incidents/errorReader.ts` (D01) — the read-only side that supplies durable events: **you do not read
  files**; your caller hands you evidence records.
- `src/incidents/errorEvent.ts` (E02 `timestamp`, `layer`, `code`), `src/runtime/isolation/SessionErrorWriter.ts`
  (E05: recording is itself durable evidence that a failure happened), `src/inference/retryTrace.ts` (E07:
  `recordRetryTrace` proves attempts were acted on; the trace is a separate durable record).

## Required change (two files)

1. `src/incidents/recoveryOutcome.ts` — a **pure** classifier (no I/O, no clock, no env):
   - `export type RecoveryOutcome = "recovered" | "unresolved" | "suppressed" | "unknown";`
   - `export interface RecoveryEvidence { failureRecorded: boolean; failureAt?: string;
     completion?: { kind: string; at: string; eventId: string } | null; retryTraced?: boolean;
     httpStatus?: number | null; suppression?: { at: string; eventId: string } | null;
     claimedOutcome?: RecoveryOutcome | null }` (names may differ; the shape must be caller-supplied and total);
   - `export function classifyRecoveryOutcome(evidence: RecoveryEvidence):
     { outcome: RecoveryOutcome; reason: string; missing: string[] }`;
   - **allowlist of durable completion kinds** (`COMPLETION_KINDS`, e.g. `verification.passed`, `unit.passed`,
     `typecheck.passed`, `task.completed`) — an unknown kind is not completion; document it in one comment;
   - rules, in this order, each with a stable `reason` code:
     1. `suppressed` only with a suppression record (`suppression.eventId` present);
     2. `recovered` **only if** `failureRecorded`, a completion in the allowlist exists, and
        `completion.at > failureAt` strictly (equal timestamps are not "after"); `retryTraced` alone is not
        recovery; `httpStatus === 200` (or 2xx) **never** yields `recovered` and must never be cited as the
        reason;
     3. `unresolved` when the failure is recorded and there is no completion/suppression evidence at all;
     4. `unknown` when the evidence is internally inconsistent or a **claimed** `recovered` cannot be
        substantiated — and then `missing` must name exactly the evidence needed
        (e.g. `["completion:allowlisted-kind-after-failureAt"]`, plus `failureAt` if absent, plus
        `suppression:eventId` if the suppression record is half-filled);
   - if `claimedOutcome === "recovered"` and the rules don't support it, the returned outcome must be the
     substantiated one and `missing` must be non-empty — that is the "false recovery claim rejected" behaviour;
   - total on garbage input (`null`, `{}`, non-string `at`): never throw, return `unknown` + `missing`.
2. `test/unit/recovery-outcome.test.ts` (≤45 lines, dense style):
   - **evidence criterion**: a caller claiming `recovered` with `httpStatus: 200` and no completion record → not
     recovered, `missing` names the missing completion evidence (and repeats for a completion record whose kind is
     not in the allowlist);
   - `recovered` requires an allowlisted completion strictly after `failureAt` (equal timestamps rejected, a
     completion *before* the failure rejected), with and without `retryTraced`;
   - `suppressed` only with a complete suppression record; a half-filled one → `unknown` + `missing`;
   - `unresolved` for a recorded failure with nothing else; 2xx statuses do not change it;
   - total: `null`, `{}`, `failureAt: "not-a-date"`, `completion: { kind: 5 }` all return `unknown` (or the
     documented outcome) and never throw; and no output ever cites `httpStatus` in `reason`.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/recoveryOutcome.ts`
- `test/unit/recovery-outcome.test.ts`

Never touch `errorAggregate.ts`, `errorReader.ts`, `errorFingerprint.ts`, `errorEvent.ts`, `errorNormalize.ts`,
`errorSanitize.ts`, `src/inference/**`, `src/runtime/**`, `src/bootstrap/**`, `scripts/**`, `package.json`,
`test/support/**` or any other test. No `node:fs`, no clock, no env reads in the production file.

## Acceptance criteria (each proved by output you paste)

1. Evidence criterion: false `recovered` claims rejected, with `missing` naming the absent completion evidence.
2. HTTP 2xx never produces `recovered`, and never appears in `reason` (assert over a set of statuses).
3. Allowlist + strict `completion.at > failureAt` semantics (equal and earlier rejected).
4. `suppressed` / `unresolved` / `unknown` behave as documented; malformed input never throws.
5. `npm run typecheck` and the two `verify` commands exit 0, and
   `test/unit/error-aggregate.test.ts test/unit/error-fingerprint.test.ts` still exit 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/recovery-outcome.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-aggregate.test.ts test/unit/error-fingerprint.test.ts
grep -nE "Date\\.now|node:fs|process\\.env|Math\\.random|httpStatus" src/incidents/recoveryOutcome.ts | grep -v "interface\|httpStatus?" ; echo "grep_done=$?"
git diff --numstat 23e2d90501dab6271482d0420f9268e8e244092e HEAD
```

The grep line may only show `httpStatus` uses inside the rules that reject them (never as a recovery reason); the
numstat must list only your two files with total ≤ 100. If anything else fails, **stop and report the failure
verbatim** — no workarounds, no scope widening.

## Commit and report

1. `git add` only your files; commit: `feat(incidents): classify recovery outcome from durable evidence (D04)`.
2. Write `D04/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/D04/`:
   the rule table (rule → outcome → reason code → required evidence), the allowlist and why unknown kinds are not
   completion, how D03's `resolution` should be derived from your outcome, commands with exit codes, numstat
   totals, commit SHA, risks (what could still look recovered but isn't), disagreements.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, treating 2xx as
success, reading files or the clock inside the classifier, relaxing the strict-after rule to make an equivalence
test pass, `--no-verify`, or any state mutation outside your worktree.
