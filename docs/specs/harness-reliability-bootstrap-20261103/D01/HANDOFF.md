# HANDOFF D01 — read-only merged host error reader (planned task, ordinal 14)

You are a **single microtask worker** on branch `feat/d01-error-reader`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-d01-error-reader-20261104` (base SHA
`8f33cfbb6cd0ce4f4a3b5f24e02965a1776cd447`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

**The gateway in this environment is flaky and cuts long turns.** Work in small steps: write the production file
first and stop; then the test; then verify+commit. If a turn dies with
`Error: Dispatch to the selected node failed`, say so and continue where you stopped.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `D01`)

> "Read-only merged host error reader" — "Build index by reading existing SessionEventStore events across **one
> verified local namespace**; do not assume arbitrary session directories or introduce external service."
> Evidence required: "**Time/host/session filters do not open writers or corrupt records.**"
> `dependsOn: [E07]`, `maxChangedLines: 100`.

## Read first (modify none of them)

- `src/runtime/isolation/SessionEventStore.ts` — note the **read-only surface**: `listStreamFiles(eventsDir)` and
  `readMergedEvents(eventsDir)` are module functions; the `SessionEventStore` class is a *writer* (it takes
  `sessionId`/`worktreeId`, creates `<sessionId>.jsonl`, holds a writer generation/lock, `writerAuthority`…).
- `src/runtime/isolation/jsonlFiles.ts` — `toStoredEvent`, torn-tail/corrupt-line accounting.
- `src/runtime/isolation/RuntimeRegistry.ts` / `stateDir.ts` — how a **real** namespace (events dir) is located,
  so the reader takes a verified namespace path instead of guessing directories.
- `src/incidents/errorEvent.ts` (E02 `parseErrorOccurrence`), `src/runtime/isolation/SessionErrorWriter.ts`
  (E05: `ERROR_OCCURRENCE_EVENT_TYPE`, payload = occurrence + fingerprint).

## Required change (two files)

1. `src/incidents/errorReader.ts` — a **strictly read-only** index over one namespace:
   - export something like `readHostErrorOccurrences(namespaceDir: string, filter?: ErrorIndexFilter): ErrorIndex`
     where `ErrorIndexFilter = { since?: string; until?: string; host?: string; sessionId?: string; limit?: number }`
     (ISO-8601 bounds compared on the occurrence `timestamp`);
   - read **only** through `listStreamFiles` + `readMergedEvents` (or `jsonlFiles` readers) — **never**
     instantiate `SessionEventStore`, never open a stream for writing, never create a directory, lock, recovery
     file or side index;
   - select only E05 occurrence events (`ERROR_OCCURRENCE_EVENT_TYPE`) whose payload passes
     `parseErrorOccurrence`; anything else (foreign types, corrupt lines, torn tail, payload that fails E02) is
     **skipped and counted**, never repaired or rewritten;
   - return `{ occurrences, scannedStreams, scannedEvents, skipped: { foreignType, corrupt, unparsable },
      truncated }` (names may differ, but the counts must be reported) with a documented default `limit` and
      deterministic ordering (timestamp then event_id);
   - filter *before* materializing beyond `limit` where practical, and never let a filter widen the scan to
     another namespace: reject obviously wrong input (missing dir → typed empty result or documented throw,
     never a recursive walk of the filesystem root).
2. `test/unit/error-reader.test.ts` — build a real namespace with the existing writer + `mkdtempSync` fixtures
   (write some occurrences through E05's writer, plus a foreign event and one corrupt line appended directly),
   then:
   - **the evidence test**: run every filter combination (since/until/host/session/limit) and assert the
     namespace is **untouched** — same file names (no new `<id>.jsonl`, no lock, no `recovery/`), same bytes
     (sha256 of each stream file before and after), same mtimes if you can hold them stable;
   - filters do what they say: time window excludes out-of-range occurrences; host filter uses the occurrence's
     own `host`; session filter only ever returns that session's occurrences; `limit` truncates and reports
     `truncated: true`;
   - robustness: corrupt line and foreign event types are skipped with correct counts; a stream that is empty or
     missing yields an empty index; a nonexistent namespace dir yields the documented empty/refused result
     without creating anything;
   - ordering is deterministic across two runs.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/errorReader.ts`
- `test/unit/error-reader.test.ts`

Budget: **at most 100 changed lines total (added + deleted)** measured across the whole `base..HEAD` range — a
two-commit unit must still land ≤100 combined, so keep it tight.

Never touch `SessionEventStore.ts`, `jsonlFiles.ts`, `RuntimeRegistry.ts`, `stateDir.ts`, `src/incidents/**`
(other than creating `errorReader.ts`), `src/bootstrap/**`, `scripts/**`, `package.json`, `test/support/**` or
any other test. No external services, no network, no new storage.

## Acceptance criteria (each proved by output you paste)

1. Evidence criterion: byte-identical + name-identical namespace after all filtered reads (no writer opened).
2. Filters behave (time / host / session / limit+truncated).
3. Foreign types, corrupt lines, unparsable payloads skipped **and counted**; ordering deterministic.
4. Read-only guarantees hold for a nonexistent/empty namespace (nothing created).
5. `npm run typecheck` and the two `verify` commands exit 0, and
   `node --test --import ./test/support/isolatedState.ts test/unit/session-error-writer.test.ts test/unit/error-sanitize.test.ts`
   still exits 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/error-reader.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/session-error-writer.test.ts test/unit/error-sanitize.test.ts
git diff --numstat 8f33cfbb6cd0ce4f4a3b5f24e02965a1776cd447 HEAD
```

All must exit 0; the last must list only your two files with **total ≤ 100** (the deterministic gate enforces
that number, so do not exceed it). If anything fails, **stop and report the failure verbatim** — no workarounds,
no loosened assertions, no scope widening.

## Commit and report

1. `git add` only your files; commit message: `feat(incidents): read-only merged host error reader (D01)`.
2. Write `D01/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/D01/`:
   exported API, the read-only guarantees and how the test proves them, counts semantics, commands with exit
   codes, numstat totals, commit SHA, risks, disagreements.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, opening any stream for
writing during a read, `--no-verify`, or any state mutation outside your worktree.
