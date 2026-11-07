# HANDOFF FIX-5 — a parent handoff is only a valid base if its status is an accepted result

You are a **single microtask worker** on branch `fix/fix5-parent-status`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix5-parent-status-20261104` (base SHA
`7f983ee05c0d6feb1ee725984070aef31bdcf92c`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Defect (already proved, do not re-derive)

`validateParentHandoff` in `scripts/bootstrap-one.ts` verifies the parent's `nextTaskId`, `nextBaseSha` and
canonical hash, but **never looks at `parent.status`**. `templates/handoff.schema.json` allows
`status: "BLOCKED"`, so a handoff that records a *failed/blocked* unit — or one with a fabricated status —
currently satisfies the chain and the child is stamped on top of it. `parentAcceptance()` compounds this: it
prints `parent=<taskId> accepted <hash>…` from a successful `JSON.parse` alone, so the log claims acceptance
even when the gate later rejects the stamp for another reason.

## Required change (exactly two files)

1. `scripts/bootstrap-one.ts`
   - in `validateParentHandoff`, add a blocker when the parent's `status` is not `PASS` and not
     `ALREADY_SATISFIED`, worded as
     `parent handoff <taskId> reports status <status>; only PASS or ALREADY_SATISFIED may be a base`,
     and a blocker when the field is absent (`… reports status undefined; …` is acceptable);
   - keep the existing blockers (unreadable, wrong `nextTaskId`, wrong `nextBaseSha`, hash mismatch) and their
     order; keep the printed acceptance line **unchanged in wording** (`parent=<taskId> accepted <hash>…`) so
     existing assertions hold — it must now only ever be printed when the status is accepted;
   - no other behaviour change: exit-code map (0/2/3/4/5/64/66), FIX-3C schema gate, FIX-4A authority check,
     gate call, no model call, read-only apart from writing the handoff file.
2. `test/unit/bootstrap-one.test.ts`
   - a parent with `status: "BLOCKED"` → `REJECT gate:` with the status blocker, exit 5, nothing written;
   - a parent with no `status` key → rejected the same way;
   - a parent with `status: "ALREADY_SATISFIED"` → accepted, file written, `parent=<taskId> accepted` printed;
   - existing fixtures that use `status: "PASS"` keep passing **unmodified**.

## Files you may change (nothing else — the merge is rejected otherwise)

- `scripts/bootstrap-one.ts`
- `test/unit/bootstrap-one.test.ts`

Budget: **1 production file, 1 test file, at most 70 changed lines total (added + deleted)**.

Do not touch `src/bootstrap/**`, `templates/**`, `docs/**`, `package.json`, or any other test. Existing
assertions may only be extended, never weakened, skipped or deleted. Use `mkdtempSync(join(tmpdir(), …))` for
temporary output, clean up, and **do not create or remove git worktrees**.

## Acceptance criteria (each proved by output you paste)

1. Parent `status: "BLOCKED"` (everything else valid, hash recomputed over the mutated parent so the hash
   itself matches) → `REJECT gate: parent handoff … reports status BLOCKED; only PASS or ALREADY_SATISFIED may
   be a base`, exit 5, no `<taskId>.handoff.json` written.
2. Parent without a `status` key → rejected; the run does not throw.
3. Parent `status: "ALREADY_SATISFIED"` → `parent=<taskId> accepted <hash>…` printed, exit 0, file written.
4. `test/unit/bootstrap-one.test.ts` and `test/unit/bootstrap-*.test.ts` exit 0 with every pre-existing test
   still present (`git diff` on that file must show additions only).

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your two files, total ≤ 70 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened tests, no scope widening. If the gateway switches
your model away from `metabolomics/qwen3.8-flash_next`, say so in your report.

## Commit and report

1. `git add` only your two files; one commit: `fix(bootstrap): require an accepted parent status (FIX-5)`.
2. Write `FIX-5/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-5/`:
   what changed, commands with exit codes, numstat totals, commit SHA, risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing `src/bootstrap/**` or the schema template,
`--no-verify`, or any state mutation outside your worktree.
