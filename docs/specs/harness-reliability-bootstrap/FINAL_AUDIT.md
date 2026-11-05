# FINAL AUDIT — harness-reliability bootstrap (V06)

Base `d44672d4` (branch tip `harness-reliability-bootstrap-20261103`), pi `main` = `b923cd33` (untouched), herdr `main` = `591264f9bd4fc2fc07d88d94febde4cd0e919448`.
Manifest: 51 tasks (`manifests/tasks.json`), modes read-only 5 / isolated-change 39 / herdr-ui 7, ceilings 100×44 + 120×7, repos pi 44 / herdr 7.
Records on disk: 104 `*.handoff.json` (63 under `*/out*/`, 41 unit-root copies) over **52** unit dirs (43 manifest units + 9 `FIX-*`); 52 canonical (latest generation).

## 1. Per-family roll-up (evidence read from the conductor checkout `docs/specs/harness-reliability-bootstrap-20261103/`, read-only)

| family | units | records (out*/ , canonical) | mode declared → enforced | diff lines base..result vs ceiling | command exit codes | logs/ | lineage |
|---|---|---|---|---|---|---|---|
| B | 6 | 0 , 0 | read-only/isolated-change → none enforced | n/a | n/a | B00 16 files, no record | B05 result `36cab891` → E01 base ✓ (no record) |
| E | 7 | 16 , 7 | E01 read-only, E02–E07 isolated-change → **E01,E02 fixtures/manifest.json missing (mode not machine-enforced)** | 98–100 ≤100 ✓ | all 0 | 5–10/unit, all resolve | E01→E02 ✓; E02→E03 ✗ (see FIX insert); E03→E07 ✓ |
| D | 8 | 16 , 8 | isolated-change → isolated-change ✓ | 93–100 ≤100 ✓ | all 0 | 5–8/unit ✓ | D01→D08 ✓ (8/8 pairs) |
| T | 9 | 18 , 9 | isolated-change → isolated-change ✓ | 96–100 ≤100 ✓ | all 0 | 4–11/unit ✓ | T01→T09 ✓ (8/8 pairs) |
| R | 8 | 17 , 8 | **R01 task read-only → fixture isolated-change (wrote a file)**; rest isolated-change ✓ | 73–100 ≤100 ✓ | all 0 | 2–7/unit ✓ | R01→R08 ✓ (7/7); R08 restamped |
| H | 7 | 8 , 7 | **H01 task read-only → fixture herdr-ui (wrote a file)**; **H03 task md isolated-change vs manifest+fixture herdr-ui** | 86–118 ≤120 ✓ | all 0 | 1–3/unit ✓ | H01→H07 ✓ (6/6); H07→V01 restamped cross-repo |
| V | 5 (+V06 this unit) | 14 , 5 | **V05 task read-only → fixture isolated-change (wrote a file)** | 92–99 ≤100 ✓ | all 0 | 3–5/unit ✓ | V01→V05 ✓ (4/4); V05 nextBaseSha = `d44672d4` |
| FIX | 9 | 15 , 8 (FIX-3 has HANDOFF.md+logs, no record) | not in manifest → fixture isolated-change (self-declared) | 30–96 ≤100 ✓, but FIX-4A/FIX-4B touch 3 files | 0 except **FIX-1 one cmd=5, FIX-2 two cmds=5** inside PASS records | 4–11/unit ✓ | FIX-1→FIX-2 ✓; **FIX-2→FIX-3B `e77904e7`→`24f42fba` ✗**; FIX-3B→FIX-3C→FIX-4A **`3881178f`→`74b54eb1` ✗**; FIX-4A→FIX-5 ✓ |
| F,M,L,O,S,P,Q,X | 0 | 0 , 0 | not in manifest; no such directories exist | n/a | n/a | none | n/a |

Lineage overall: **42/43** adjacent manifest pairs have `parent.nextBaseSha == child.baseSha`; the one break (E02→E03) is bridged only by the conductor-inserted FIX-1…FIX-5 chain. All declared `baseSha`/`resultSha` resolve as commits in the repo named by the record (`git cat-file -e`, 52/52), including H01 `b5e6903c`/`debcfeef` in herdr (the scan's "commit-MISSING" is a false positive of its repo-selection heuristic: `git -C herdr cat-file -e debcfeef^{commit}` succeeds; `debcfeef` is an ancestor of herdr `main`).

## 2. Missing / unverifiable artifacts

* **No handoff record for B00–B05.** B00 carries only `B00/logs/` (16 files: `01-git-status`, `02-git-rev-parse`, `03-npm-typecheck`, `04-npm-test`, `05`–`09` probes; no `.handoff.json`, no `TASK_REPORT.md`). B01–B05 have no unit directory at all. Mitigating evidence, re-run by this audit at `d44672d4`: `node --test … test/unit/bootstrap-{task-manifest,path-policy,diff-guard,result-gate,one}.test.ts` → `tests 39 / pass 39 / fail 0`, exit 0.
* **`docs/specs/harness-reliability-bootstrap-20261103/06-ACCEPTANCE-TESTS.md` does not exist** (no `*ACCEPTANCE*` file in the package). Acceptance verdicts below are taken from `03-TEST-AND-RELEASE-GATES.md` (7 microtask gates, 7 phase gates, promotion policy).
* **`AUDIT/integrity-scan-20261108.txt` does not exist**; the file present is `AUDIT/integrity-scan-20261104.txt` (`records_scanned=94 unresolvable_shas=1`, and it lists V03,V04,V05,V06 as record-less — contradicting `AUDIT/task-ledger-status.txt`, which lists 43 PASS + 8 record-less). Both `AUDIT/` files are **untracked** at `d44672d4`.
* **Schema check — the schema exists and was used.** `docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json` is tracked at `d44672d4` (2327 bytes, 15 `required`, `additionalProperties:false`) — `git cat-file -e d44672d4:…templates/handoff.schema.json` succeeds; the earlier "schema does not exist" instruction was wrong. Both scopes were computed by machine, independently, with the same canonicalizer:

| scope | glob | records | field + `additionalProperties` conformance | `handoffHash` recomputation |
|---|---|---|---|---|
| narrow (this audit, first pass) | `*/out*/<UNIT>.handoff.json` only (`out`, `out2`, `out-corrected`, `out-final`, `out-negctl`) | 63 | **63/63**, 0 missing, 0 extra | **63/63** match |
| full (deduplicated by `realpath`) | every `*/out*/*.handoff.json` (63) **plus** every top-level `<UNIT>/<UNIT>.handoff.json` (41) | 104 | **104/104** | **104/104** match |

  Canonical form in both: `sha256:` + SHA-256 of `json.dumps(record_without_handoffHash, sort_keys=True, separators=(',',':'), ensure_ascii=False)`; 0 failures. The 41 top-level copies are separate regular files (0 symlinks): byte-identical to their `out/` twin for most units, **stale for T09, H07, R08** (`cmp` differs) — duplicate copies that can drift from the canonical generation.
* **Evidence not preserved in git.** Of 696 files in the 52 unit dirs, **172** are byte-identical at the same path in `d44672d4` and **524 are not in git**; only **9/52** canonical records are committed (H01–H07, `R08/out-corrected`, FIX-3C), so **43 canonical records and 35 units' raw logs exist in one working tree only**.
* **`BASELINE-unit-suite-at-c349613b.txt` was never committed** — it is untracked in the conductor checkout *and absent from `d44672d4`* (`git ls-tree -r d44672d4` has no such path), so "committed at d44672d4" is false. Content verified: 3550 lines, `grep -c '^✔'` = **2180**, `grep -c '^✖'` = **150**, raw reporter output (no command/exit header).
* **`npm test` has never been green in this bootstrap.** B00 `logs/04-npm-test.log`: `cmd: npm test … exit=1`. Tip run started by this audit at `d44672d4` was still running at write time and had already emitted 40 `^✖` lines / 168 `^✔`. Every unit was verified by the targeted commands its record declares; the suite is **not** green.
* **F02 placeholder**: no `F02` path exists in `d44672d4`, in the conductor working tree, or in its history (`git log --oneline d44672d4 -- '*F02*'` empty). The claimed removal is unverifiable — no before/after artifact.
* **R06 / H02 path rewrite**: not reproducible at record level — `changedFiles` equals `fixtures/manifest.json:allowPaths` exactly for both. No before/after path-diff artifact exists, so the claim is recorded as unverifiable.
* V06 (this unit) had no record at scan time, as expected; V05 has since concluded (`V05/out-final`: status PASS, `nextBaseSha=d44672d4`).

## 3. Deviations ledger

| deviation | evidence |
|---|---|
| Mode: plan declared read-only, delta required creating a file | R01 (`31-R01.md` read-only → `docs/…/RETRY_OWNERS.md`, fixture `isolated-change`); H01 (`39-H01.md` read-only → `HERDR_SURFACES.md`, fixture `herdr-ui`); V05 (`50-V05.md` read-only → `ROLLOUT.md`, fixture `isolated-change`). **H03 is not this deviation**: `41-H03.md` says isolated-change; its inconsistency is task-md vs manifest/fixture `herdr-ui`. 3 of the 4 expected cases confirmed. |
| Mode not enforced at all | E01, E02 have no `fixtures/manifest.json`, so no allowPaths/mode was machine-checked. |
| Re-stamped records (3 generations) | `out/` → `out-corrected/` (R08, H07, V01, V02–V05) → `out-final/` (V02–V05). Deltas are `nextBaseSha` + notes + `handoffHash` only: V01 `67a27366`→`ff2a8a6b`; V02 `9531f8b1`→`8c064b37`. Cause: the evidence commit is created after the record, so the child base is nameable only afterwards. |
| Supersede vs overwrite | No committed `out/` record was ever modified in place — `git log --name-status` shows `A` only for V01–V05 `out/*.handoff.json`, `R08/out-corrected`, `H07/out-corrected`; older generations kept side by side. Exception: `V01–V05/fixtures/handoff-record.json` are **modified in place** (uncommitted `M` in the conductor checkout). |
| Delegated approval | 63/63 records carry `operatorApproval.approved=true`, `approvedBy="operator (blanket instruction 2026-11-04: continue automatically; no per-task review)"`. Approval authority is **delegated to the conductor process**, not signed; per `02-HANDOFF-PROTOCOL.md` the hash detects accidental modification and is **not cryptographic authorization**. |
| Extra units outside the manifest | 9 `FIX-*` units (15 record files) executed between manifest units; 2 lineage gaps (FIX-2→FIX-3B, FIX-3C→FIX-4A) land on conductor commits `24f42fba`, `74b54eb1`. |
| Cross-repo repo id | FIX-5 record declares `repo=berlinguyinca/pi-engineering-runtime`; all other pi records declare `berlinguyinca/pi-engineering`. |

## 4. Verdict per acceptance criterion (`03-TEST-AND-RELEASE-GATES.md`; `06-ACCEPTANCE-TESTS.md` absent)

| # | criterion | verdict | evidence |
|---|---|---|---|
| G1 | authority hash + predecessor approved + clean base | met with recorded exception | 42/43 pairs continuous; FIX gaps `24f42fba`, `74b54eb1` |
| G2 | exact candidate allowlist, zero unauthorized mods | met with recorded exception | record `changedFiles` == fixture `allowPaths`; E01/E02 unchecked (no fixture); mode labels deviate (R01,H01,V05) |
| G3 | ≤2 prod + ≤2 tests, ≤100 (herdr 120) lines | met with recorded exception | measured 73–100 / 86–118; FIX-4A, FIX-4B = 3 files each, no manifest ceiling defined |
| G4 | declared tests executed with recorded exit code + logs; `git diff --check` clean | met with recorded exception | exit codes 0 in 50/52 canonical records (FIX-1, FIX-2 record exit 5 reproductions); `evidence` paths resolve 52/52; this unit's `git diff --check d44672d4..HEAD` exit 0 |
| G5 | no background tests/processes left unknown | not met | no artifact records background-process teardown for any unit |
| G6 | no model self-approval; human gate before next task | not met | 63/63 `approved=true` written by the conductor under blanket delegation; no independent validator or signature artifact |
| G7 | never edit main; isolated worktree + verified commit | met | all base/result SHAs resolve on `feat/*`, `fix/*` or evidence commits; pi `main` `b923cd33` ≠ lineage tip `d44672d4`; herdr lineage is an ancestor of herdr `main` |
| P1–P6 | phase gates after B05/E07/D08/T09/R08/H07 | met with recorded exception | asserted only in unit records/logs; B05 gate has no record (B00–B05 record-less); D/T/R/E logs untracked |
| P7 | gate after V06: final source-and-runtime audit | met with recorded exception | this file; runtime/deployment state explicitly **not verified** |
| S1 | promotion: start shadow-only, flags OFF by default | met with recorded exception | `ROLLOUT.md` (V05) declares flags; no runtime proof attached |
| S2 | "later full `npm test` once safe" | not met | suite never green: B00 exit=1; baseline 150 `✖` / 2180 `✔`; tip run non-green at write time |
| E1 | "all task records pass schema checks" | met (schema) / not met (coverage) | 63/63 narrow-scope and 104/104 full-scope field+hash conformance; but 8 plan tasks (B00–B05 + none for V06 at scan) have **no record at all**, so the record set is incomplete |
| E2 | "all records pass reproducibility checks" | not met | 43/52 canonical records and 524/696 evidence files are untracked; cannot be reproduced from git |
| E3 | "all records pass lineage checks" | met with recorded exception | 52/52 declared SHAs resolve; 2 FIX gaps + 1 manifest gap explained by restamps |
| E4 | built ≠ tested ≠ deployed ≠ unverified stated | met | this section 2/4: nothing deployed; runtime, herdr 36/36 diagnostics run and quantization benchmark validity **not re-verified here** (no committed log) |

Verdict: **bootstrap complete with recorded exceptions**; blocking items for release review = G5, G6, S2, E2, and B00–B05 record absence.
