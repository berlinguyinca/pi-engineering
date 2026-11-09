# HANDOFF E05 — record normalized error occurrences per session (planned task, ordinal 11)

You are a **single microtask worker** on branch `feat/e05-session-error-writer`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e05-session-error-writer-20261104` (base SHA
`c349613b59ab6a0a9666633df68002394767cfa6`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `E05`)

> "Record normalized error occurrences per session" — "Adapter emitting E02 records to the EXISTING per-session
> event writer. Separate event occurrences from deduplicated incidents; no new database."
> Evidence required: "Two concurrent sessions remain isolated; append survives reopen." `dependsOn: [E04]`.

## Existing pieces you must reuse (read them first, modify none of them)

- `src/platform/eventstore/backend.ts` — the `StoredEvent` contract:
  `{ event_id, timestamp, type, project_id, run_id, worker_id, payload }`.
- `src/runtime/isolation/SessionEventStore.ts` — the **existing per-session writer** (`SessionEventStore`,
  `SessionEventStoreOptions {eventsDir, sessionId, worktreeId, recoveryDir?, writerAuthority?}`,
  `append`, `appendAll`, `all`, `refresh`, `diagnostics`, `drain`, `close`; one `<sessionId>.jsonl` stream per
  session, envelope fields `session_id`/`worktree_id`/`sequence` are added and stripped by the store).
- `src/incidents/errorEvent.ts` (E02 `ErrorOccurrence` + `parseErrorOccurrence`),
  `src/incidents/errorSanitize.ts` (E04 `sanitizeForPersistence`), `src/incidents/errorNormalize.ts` (E03).
- `src/incidents/fingerprint.ts` (`incidentFingerprint`, `toIncidentEventPayload`) and
  `src/incidents/IncidentController.ts` — **incidents** (deduplicated) already live there; your adapter must not
  duplicate or replace that role.

## Required change (two files)

1. `src/runtime/isolation/SessionErrorWriter.ts` — a thin adapter over `SessionEventStore`:
   - export `ERROR_OCCURRENCE_EVENT_TYPE` (a distinct event `type`, e.g. `"error.occurrence"`) so occurrences
     are separable from incident events on read, and a class or factory (e.g.
     `createSessionErrorWriter(store, scope?)` / `SessionErrorWriter`) with at least
     `record(occurrence: ErrorOccurrence): Promise<StoredEvent>` and `recordMany(...)`, plus
     `listOccurrences(): ErrorOccurrence[]` that reads back through the store and returns only
     `ERROR_OCCURRENCE_EVENT_TYPE` events whose payload still passes `parseErrorOccurrence`;
   - **sanitize before persisting**: run every occurrence through E04's `sanitizeForPersistence` (never write an
     unsanitized payload); if sanitization refuses the input, do not write and surface a typed failure (return
     `null`/throw a documented error — pick one and test it);
   - map scope honestly: `project_id`/`run_id`/`worker_id` from the writer's scope or the occurrence's
     correlation ids — never invent a session id; `event_id` must be stable/deterministic per occurrence
     (derived from the sanitized payload, e.g. a digest) so a retried write is idempotent against the store's
     own dedup (`appendConditionally` exists — prefer it, otherwise explain in a comment why plain `append` is
     safe);
   - attach `incidentFingerprint(...)` (from `src/incidents/fingerprint.ts`) into the payload so the incident
     layer can deduplicate later — the writer records **occurrences**, it does not decide incident identity;
   - **no new storage**: no new file format, no sqlite, no side index; only `SessionEventStore`.
2. `test/unit/session-error-writer.test.ts` — use `mkdtempSync(join(tmpdir(), …))` and clean up:
   - two writers over **two different `sessionId`s in the same `eventsDir`**, appending concurrently
     (`Promise.all`): each stream contains only its own occurrences, and `readMergedEvents` shows both;
   - **reopen durability**: append, `drain()` + `close()`, construct a fresh store over the same `eventsDir`, and
     see the occurrence via `listOccurrences()` with identical payload;
   - a secret-bearing occurrence is written **sanitized** (assert the secret string is absent from the raw
     `.jsonl` bytes on disk);
   - reading occurrences ignores foreign event types (append a `"incident.raised"`-style event through the raw
     store and assert `listOccurrences()` skips it);
   - the same occurrence recorded twice does not duplicate (idempotent `event_id` + store dedup) — or, if you
     use plain `append`, assert the documented duplicate behaviour explicitly.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/runtime/isolation/SessionErrorWriter.ts`
- `test/unit/session-error-writer.test.ts`

Budget: **2 production files, 2 test files, at most 100 changed lines total (added + deleted)** — this is an
adapter, not a subsystem; if it needs more than ~100 lines, stop and report rather than widening.

Never touch `SessionEventStore.ts`, `jsonlFiles.ts`, `sqlite.ts`, `platform/eventstore/**`, `src/incidents/**`,
`src/bootstrap/**`, `scripts/**`, `package.json`, `test/support/**` or any other test.

## Acceptance criteria (each proved by output you paste)

1. Session isolation: after concurrent appends, `<sessionA>.jsonl` contains only A's `event_id`s and
   `<sessionB>.jsonl` only B's.
2. Reopen: after close + reopen, the occurrence is read back with deep-equal payload.
3. No raw secret on disk (byte-level check of the stream file).
4. Occurrence/incident separation: only `ERROR_OCCURRENCE_EVENT_TYPE` events are returned by
   `listOccurrences()`; the payload carries the incident fingerprint.
5. Idempotent or documented-duplicate behaviour for a repeated record, proved by an assertion.
6. `npm run typecheck` and the two `verify` commands exit 0, and
   `node --test --import ./test/support/isolatedState.ts test/unit/runtime-isolation-registry.test.ts test/unit/error-sanitize.test.ts`
   still exits 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/session-error-writer.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/runtime-isolation-registry.test.ts test/unit/error-sanitize.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your two files, total ≤ 100 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened assertions, no scope widening. If the gateway
switches your model away from `metabolomics/qwen3.8-flash_next` or drops your turn, say so in your report.

## Commit and report

1. `git add` only your files; one commit: `feat(runtime): record error occurrences per session (E05)`.
2. Write `E05/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E05/`:
   exported API, mapping rules, dedup/idempotency choice, commands with exit codes, numstat totals, commit SHA,
   risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, adding a database or
new persistence format, `--no-verify`, or any state mutation outside your worktree.
