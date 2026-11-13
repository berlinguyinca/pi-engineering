# HANDOFF D03 — aggregate occurrences into issue clusters (planned task, ordinal 16)

You are a **single microtask worker** on branch `feat/d03-error-aggregate`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-d03-error-aggregate-20261104` (base SHA
`d4c056848107cfa3bddff4311c11e9017f6e8430`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

**The gateway cuts long turns.** Three turns: production → test → verify+commit. **Line budget spans both
files**: production ≤ 55 lines, test ≤ 45 lines (total ≤ 100 added+deleted, gate-enforced).

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `D03`)

> "Aggregate occurrences into issue clusters" — "Pure grouping with first/last seen, count, sessions, hosts,
> affected model/config and recovered/unresolved counts. **Keep source event IDs.**"
> Evidence required: "**Stable ordering and correct counts with duplicate retry traces.**" `dependsOn: [D02]`.

## Read first (modify none of them)

- `src/incidents/errorFingerprint.ts` (D02 `errorFingerprint`, `fingerprintInput`, `INVALID_FINGERPRINT`) — your
  grouping key; **reuse it, do not invent another key**.
- `src/incidents/errorReader.ts` (D01 `IndexedErrorOccurrence { eventId, stream, occurrence }`) — the natural
  input shape.
- `src/incidents/errorEvent.ts` (E02 fields incl. `host`, `sessionId`, `model`, `quantization`, `layer`, `code`,
  `timestamp`).
- `src/inference/retryTrace.ts` (E07 `failureIdentity`, optional `failure_id`) — the mechanism that makes one
  upstream failure observable through two paths (session event + retry trace), which is exactly the duplicate you
  must not double-count.

## Required change (two files)

1. `src/incidents/errorAggregate.ts` — a **pure** (no I/O, no `Date.now()`, no input mutation) grouping function:
   - input `AggregateRow = { eventId: string; occurrence: ErrorOccurrence; resolution?: "recovered" | "unresolved"; failureIdentity?: string }`
     (accept D01's `IndexedErrorOccurrence` too — structurally it satisfies this shape);
   - `aggregateErrorOccurrences(rows: AggregateRow[], opts?: { maxEventIds?: number; limit?: number }): {
      clusters: ErrorCluster[]; truncated: boolean; duplicateEvents: number; rejected: number }`;
   - `ErrorCluster` must carry: `fingerprint`, `count`, `firstSeen`, `lastSeen`, sorted-unique `sessions`,
     `hosts`, `models`, `quantizations`, `layers`, `codes`, `recovered`, `unresolved`, `eventIds` (sorted, capped
     by `maxEventIds`, default documented) and `eventIdsTruncated`;
   - **dedupe rules**: the same `eventId` twice contributes once; two rows sharing the same
     `failureIdentity` (E07) but different `eventId` count **once** toward `count` while **both** event ids are
     kept in `eventIds` and `duplicateEvents` is incremented — that is the retry-trace duplicate case; a row
     whose occurrence D02 refuses (`INVALID_FINGERPRINT`) is counted in `rejected` and forms no cluster;
   - `resolution` defaults to `"unresolved"` (D04 will supply real classification later — say so in a comment),
     and `recovered + unresolved === count`;
   - **stable ordering**: sort by `lastSeen` desc, then `count` desc, then `fingerprint` asc, so any input
     permutation yields the identical output order; `limit` truncates the cluster list and sets `truncated`.
2. `test/unit/error-aggregate.test.ts` (≤45 lines, dense style):
   - **duplicate retry traces** (the evidence test): build rows where one failure identity appears as both a
     session occurrence and a retry-trace occurrence (different `eventId`s), plus the same `eventId` twice —
     assert `count`, `duplicateEvents`, `eventIds` (both ids kept, sorted), and that ordering is unchanged when
     the input array is shuffled (use a deterministic shuffle, not `Math.random()`);
   - first/last seen pick the min/max `timestamp` of the *deduped* occurrences; sessions/hosts/models/
     quantizations/layers/codes are sorted unique sets;
   - recovered/unresolved counts with a mixed `resolution` map, default unresolved, and the sum equals `count`;
   - purity: the input array and rows are deep-equal before and after the call;
   - `maxEventIds` caps `eventIds` and sets `eventIdsTruncated`; `limit` sets `truncated`;
   - a malformed occurrence (D02 refuses it) is counted in `rejected` and creates no cluster.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/errorAggregate.ts`
- `test/unit/error-aggregate.test.ts`

Never touch `errorFingerprint.ts`, `errorReader.ts`, `errorEvent.ts`, `errorNormalize.ts`, `errorSanitize.ts`,
`src/inference/**`, `src/runtime/**`, `src/bootstrap/**`, `scripts/**`, `package.json`, `test/support/**` or any
other test. No I/O at all in the production file (no `node:fs`, no env reads, no clocks).

## Acceptance criteria (each proved by output you paste)

1. Evidence criterion: correct counts + identical cluster order with duplicate retry traces and shuffled input.
2. first/last seen, sorted-unique dimension sets, and source event ids are kept (with cap + truncated flag).
3. recovered + unresolved === count, default unresolved.
4. Purity: input deep-equal after the call; no module-level state; no `Date.now()` in the file
   (`grep -nE "Date\\.now|node:fs|process\\.env|Math\\.random" src/incidents/errorAggregate.ts` prints nothing).
5. `npm run typecheck` and the two `verify` commands exit 0, and
   `test/unit/error-fingerprint.test.ts test/unit/error-reader.test.ts` still exit 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/error-aggregate.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-fingerprint.test.ts test/unit/error-reader.test.ts
grep -nE "Date\\.now|node:fs|process\\.env|Math\\.random" src/incidents/errorAggregate.ts; echo "purity_grep=$?"
git diff --numstat d4c056848107cfa3bddff4311c11e9017f6e8430 HEAD
```

The grep must print nothing (exit 1 is the expected outcome for that line); the numstat must list only your two
files with total ≤ 100. If anything else fails, **stop and report the failure verbatim** — no workarounds, no
scope widening.

## Commit and report

1. `git add` only your files; commit: `feat(incidents): aggregate error occurrences into stable issue clusters (D03)`.
2. Write `D03/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/D03/`:
   the dedupe rules and why retry-trace duplicates must not inflate `count`, ordering rule, caps, the placeholder
   `resolution` contract for D04, commands with exit codes, numstat totals, commit SHA, risks, disagreements.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, reading files or the
clock inside the aggregate, inflating counts to make a test easier, `--no-verify`, or any state mutation outside
your worktree.
