# HANDOFF D02 — stable cross-session error fingerprint (planned task, ordinal 15)

You are a **single microtask worker** on branch `feat/d02-error-fingerprint`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-d02-error-fingerprint-20261104` (base SHA
`a3f9b8820a389bc94920c4b5461c39cc68f3bc88`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

**The gateway cuts long turns.** Work in three small turns: production file → test file → verify+commit. Stop
after each; if a turn dies with `Error: Dispatch to the selected node failed`, continue where you stopped.
**Line budget is measured across both files**: keep production ≤ 55 lines and the test ≤ 45 (total ≤ 100
added+deleted, gate-enforced).

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `D02`)

> "Stable cross-session error fingerprint" — "Normalize volatile ids, timestamps, addresses and worktree
> prefixes while retaining root-cause discriminators; **must not collapse 404 vs 429**."
> Evidence required: "Equivalent errors correlate; distinct causes remain separate." `dependsOn: [D01]`.

## Read first (modify none of them)

- `src/incidents/errorEvent.ts` (E02 `ErrorOccurrence` fields), `src/incidents/errorNormalize.ts` (E03 codes —
  note codes already carry the status, e.g. `gateway.429.rate_limited`), `src/incidents/errorSanitize.ts` (E04
  already folds paths/prompts, so what you receive is post-sanitization text with markers like `<path>`,
  `<redacted-prompt len=… sha256=…>`, `[env:NAME]`, `[REDACTED]`), `src/runtime/isolation/SessionErrorWriter.ts`
  (E05 attaches `incidentFingerprint`).
- `src/incidents/fingerprint.ts` — the **existing incident-level** fingerprint style to follow: fixed sorted
  keys, `JSON.stringify`, `fnv1a64` (exported from `src/aps/fingerprint.ts:158`), and a private `stripWorktree`
  you cannot import (write your own path/worktree folding).
- `src/incidents/errorReader.ts` (D01) — the read side that will group by your key later (D03).

## Required change (two files)

1. `src/incidents/errorFingerprint.ts` — export e.g. `errorFingerprint(occurrence: ErrorOccurrence): string`
   (plus the normalizer, e.g. `fingerprintInput(occurrence)` returning the discriminator object, so the test can
   assert *what* is compared):
   - **drop volatile fields**: `timestamp`, `host`, `sessionId`, `runId`, `taskId`, `runtime`, model/quantization
     when they are not the cause (document the rule), `correlationIds`, `artifactRefs` paths, sequence numbers;
   - **normalize within the retained text**: uuids / hex ids (`[0-9a-f]{8,}`) → `<id>`, durations (`123ms`,
     `2.5s`) → `<dur>`, byte/line counts → `<n>`, absolute paths and any worktree prefix → `<path>`,
     `http(s)://host:port/...` → `<url>` keeping only the path-less host kind or dropping entirely (document),
     E04 markers (`<redacted-prompt len=N sha256=…>`) → `<prompt>` so a re-serialized record cannot change the
     key, IPv4/IPv6 `host:port` → `<addr>`;
   - **retain discriminators**: `layer`, dotted `code` (this is what keeps 404 apart from 429 — never strip
     digits from codes), normalized `summary` skeleton (after the normalizations above), `severity`? only if you
     can show it does not split equivalent errors (otherwise drop it and say why), tool name when present in the
     code/summary;
   - deterministic output: fixed sorted keys, no `Date.now()`, no randomness, no locale-dependent casing —
     return a stable hex digest (prefer `fnv1a64` for consistency with the existing incident fingerprint, or
     sha256 truncated to ≥12 hex chars; document the collision posture in one comment);
   - pure and total: malformed input (`null`, `{}`, non-string fields) yields a documented result (throw a typed
     error or return a documented fallback key) and never leaks raw text into the key.
2. `test/unit/error-fingerprint.test.ts` (≤45 lines, dense style):
   - **equivalence**: two occurrences from different sessions/hosts/runs/timestamps, with different uuids,
     durations, byte counts, worktree-prefixed paths and different `<redacted-prompt len=… sha256=…>` digests,
     same root cause → **same** fingerprint (this is "equivalent errors correlate");
   - **separation, 404 vs 429**: otherwise identical occurrences with codes `gateway.404.not_found` vs
     `gateway.429.rate_limited` → different fingerprints; plus separation for different `layer`, different tool,
     different root-cause noun (e.g. "connection reset" vs "connection timeout"), and different exception class;
   - determinism/idempotence: same input twice → identical; a second run in the same process → identical; no
     fingerprint contains raw digits from volatile fields (assert the digest shape);
   - malformed input behaves as documented;
   - one assertion that the key is **not** the payload digest (changing only `sessionId` must not change it).

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/errorFingerprint.ts`
- `test/unit/error-fingerprint.test.ts`

Never touch `src/incidents/fingerprint.ts`, `src/aps/fingerprint.ts`, `errorEvent.ts`, `errorNormalize.ts`,
`errorSanitize.ts`, `errorReader.ts`, `src/runtime/**`, `src/bootstrap/**`, `scripts/**`, `package.json`,
`test/support/**` or any other test.

## Acceptance criteria (each proved by output you paste)

1. Equivalent-but-volatile-differing occurrences correlate (one fingerprint).
2. 404 vs 429 (and layer/tool/root-cause variants) stay separate.
3. Deterministic across repeated calls; digest shape stable; volatile digits never leak into the key.
4. Malformed input behaves as documented (no throw unless documented and asserted).
5. `npm run typecheck` and the two `verify` commands exit 0, and `test/unit/error-reader.test.ts
   test/unit/incidents-fingerprint.test.ts` still exit 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/error-fingerprint.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-reader.test.ts test/unit/incidents-fingerprint.test.ts
git diff --numstat a3f9b8820a389bc94920c4b5461c39cc68f3bc88 HEAD
```

All must exit 0; the last must list only your two files with total ≤ 100. If anything fails, **stop and report
the failure verbatim** — no workarounds, no scope widening.

## Commit and report

1. `git add` only your files; commit: `feat(incidents): stable cross-session error fingerprint (D02)`.
2. Write `D02/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/D02/`:
   the drop/retain rules as a table, normalization regexes, digest choice + collision posture, commands with exit
   codes, numstat totals, commit SHA, risks (what would falsely merge or falsely split), disagreements.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, weakening the 404/429
separation to make equivalence tests pass, `--no-verify`, or any state mutation outside your worktree.
