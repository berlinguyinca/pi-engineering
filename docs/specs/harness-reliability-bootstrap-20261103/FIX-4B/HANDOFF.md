# HANDOFF FIX-4B — the microtask line ceiling must match the spec, per mode

You are a **single microtask worker** on branch `fix/fix4b-mode-ceiling`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix4b-mode-ceiling-20261104` (base SHA
`5c5d5a5d6ab8681390c8daf35c1daab542f7051d`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Defect (already proved, do not re-derive)

`src/bootstrap/taskManifest.ts` line 5 hard-codes `MICROTASK_CEILING = { maxProductionFiles: 2, maxTestFiles: 2,
maxChangedLines: 100 }`, but the spec (`docs/specs/harness-reliability-bootstrap-20261103/03-TEST-AND-RELEASE-GATES.md`,
rule 3) says: `<=2 production files, <=2 tests, target <=100 changed lines (Herdr UI <=120)`. Seven planned tasks
(`H01`…`H07` in `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`) declare
`maxChangedLines: 120`, so `parseTaskManifest` rejects their manifests with
`limits.maxChangedLines 120 exceeds bootstrap ceiling 100` — they can never be planned, gated or stamped.
`H01` is additionally declared `"mode": "read-only"` while declaring a 120-line budget, and `evaluateDiffScope`
rejects *any* changed path under a read-only manifest, so H01 is unschedulable as declared too.

## Required change (exactly three files)

1. `src/bootstrap/taskManifest.ts`
   - add `"herdr-ui"` to `TASK_MANIFEST_MODES` (keep `read-only` and `isolated-change`),
   - make the line ceiling mode-aware: **100 for `read-only` and `isolated-change`, 120 for `herdr-ui`**, while
     `maxProductionFiles` / `maxTestFiles` stay capped at 2 for every mode. Cite the spec rule in the comment
     (`03-TEST-AND-RELEASE-GATES.md` rule 3). The rejection message must name both value and applicable ceiling,
     e.g. `limits.maxChangedLines 121 exceeds bootstrap ceiling 120 for mode herdr-ui`.
   - everything else stays: pure, no I/O, no `any`, defaults applied, unknown keys dropped, same field set.
2. `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`
   - set `"mode": "herdr-ui"` for `H01`…`H07` only (their `maxChangedLines` stays 120); no other edit in that file.
3. `test/unit/bootstrap-task-manifest.test.ts`
   - `herdr-ui` accepted as a mode; `maxChangedLines: 120` accepted under `herdr-ui` and rejected under
     `isolated-change`; `maxChangedLines: 121` rejected under `herdr-ui`; unknown mode still rejected;
     `maxProductionFiles: 3` and `maxTestFiles: 3` still rejected under `herdr-ui`.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/bootstrap/taskManifest.ts`
- `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`
- `test/unit/bootstrap-task-manifest.test.ts`

Budget: **2 production files, 1 test file, at most 100 changed lines total (added + deleted)**.

Do not touch `src/bootstrap/diffGuard.ts`, `src/bootstrap/resultGate.ts`, `src/bootstrap/handoffWriter.ts`,
`scripts/bootstrap-one.ts`, `templates/handoff.schema.json` or any other test. Existing assertions must stay.

## Acceptance criteria (each proved by output you paste)

1. `parseTaskManifest` with `mode: "herdr-ui"` and `limits {maxProductionFiles:2,maxTestFiles:2,maxChangedLines:120}`
   → `ok: true`, `manifest.mode === "herdr-ui"`.
2. Same but `maxChangedLines: 121` → rejected; the error names the value and the 120 ceiling for the mode.
3. `mode: "isolated-change"` with `maxChangedLines: 120` → rejected against the 100 ceiling.
4. All 51 entries of the updated `tasks.json` parse (command 4 below prints `tasks 51 invalid 0 ,`), with
   `H01`…`H07` reported as `herdr-ui`.
5. `test/unit/bootstrap-task-manifest.test.ts` and `test/unit/bootstrap-*.test.ts` exit 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-task-manifest.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts
node --experimental-strip-types -e 'import {parseTaskManifest} from "./src/bootstrap/taskManifest.ts"; import {readFileSync} from "node:fs"; const t=JSON.parse(readFileSync("docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json","utf8")).tasks; const bad=t.filter(x=>!parseTaskManifest({taskId:x.id,baseSha:"a".repeat(40),repoId:"pi",objective:x.title,allowPaths:["src/**"],denyPaths:["node_modules/**"],commands:[{id:"t",cwd:".",argv:["npm","run","typecheck"]}],limits:{maxProductionFiles:x.maxProductionFiles,maxTestFiles:x.maxTestFiles,maxChangedLines:x.maxChangedLines},parentHandoffHash:null,expectedOutputs:["src/**"],mode:x.mode}).ok); console.log("tasks",t.length,"invalid",bad.length,bad.map(b=>b.id).join(","))'
git diff --numstat HEAD~1 HEAD
```

All must exit 0, the fourth must print `tasks 51 invalid 0 ,`, and the last must list only your three files.
If anything fails, **stop and report the failure verbatim** — no workarounds, no loosened tests, no scope
widening. If the gateway switches your model away from `metabolomics/qwen3.8-flash_next`, say so in your report.

## Commit and report

1. `git add` only your three files; one commit: `fix(bootstrap): mode-aware microtask line ceiling (FIX-4B)`.
2. Write `FIX-4B/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-4B/`:
   what changed, commands with exit codes, numstat totals, commit SHA, risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, `--no-verify`, or any
state mutation outside your worktree.
