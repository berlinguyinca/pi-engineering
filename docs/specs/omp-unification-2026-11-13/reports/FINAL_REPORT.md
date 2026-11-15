# OMP unification: final report (2026-11-13 program)

Legacy remains the default path. Everything OMP-backed is behind `PI_ENGINEERING_OMP_WORKER=1` plus `PI_ENGINEERING_OMP_ADAPTER=1`. Legacy needs no bun, no omp and one model. Rollback: `rollback-guide.md`. Items not executed are marked UNVERIFIED.

## Phases

| Phase | Branch | PR | Merge SHA | Result |
| --- | --- | --- | --- | --- |
| 1 audit, parity matrix, baseline | `docs/omp-unification-phase1-audit` | #690 | 2cb95221 | Docs. Baseline: unit 6898/6903, integration 1197/1198 (1 known flake), platform 120/120. Verdicts: ledger, custody, leases/fencing, worktree guards, verify, tournament RETAIN |
| 2 adapter spike | `feat/omp-adapter-spike` | #692 | 783058de | `src/omp` negotiation, version pin (omp 18.20.0), typed fallback. Real omp 11/11; CI (no omp) 8 pass, 3 skip |
| coverage gate | `ci/coverage-gate` | #691 | 24a66588 | `test:coverage`, floors 85/83/83 |
| golden gate | `test/phase3-legacy-golden` | #693 | 1294390c | Legacy goldens, byte-for-byte; `PARITY_PATH=<name>` runs the same scenarios through another path |
| skills | `feat/omp-skills-adoption` | #694 | c8c4c6ba | PE-owned `pe-operator` skill pack, locked; compression and tool-prompt experiments (DEFER); no runtime path imports it |
| 3 `/engineer` slice | `feat/omp-engineer-slice` | #695 | pending | `OmpWorkerExecutor`, flag-gated selection, context firewall overlay, fallback to legacy before the prompt |
| 4 worker/session/tool integration | `feat/omp-worker-integration` | #696 | pending | All worker roles; PE tools as host tools; process-per-run; 27/27 goldens under `PARITY_PATH=omp` |
| 5 parity suite | `test/omp-parity-suite` | #697 | pending | verify, tournament, recovery (SIGKILL, no orphans), Hindsight, context ratchet, firewall leak scan |
| 6 Herdr bridge | `feat/omp-herdr-bridge` | PR pending | pending | omp frames mapped to the existing `onActivity` seam; footer text identical to legacy golden |
| 7 final | `docs/omp-unification-final` | PR pending | pending | Redundancy audit (nothing deleted), context trim, rollback guide, this report |

## Changed files (summary)

- `src/omp/*` (12 files, about 1350 lines): all new. Existing code touched: the hook in `EngineeringRuntime.open`, `acceptsCustomTools` wiring in the executor chain, three `export` keywords, `src/workers/reviewVerdict.ts`. No ledger, custody, lease, fencing or schema change.
- `test/`: new unit, integration and support files (`ompOffline`, `scriptedModelServer`, `fakeOmpRpc.mjs`, `parityRecoveryChild`), legacy goldens, omp frame fixtures.
- `skill-packs/pe-operator/`, `src/skillpack`, `src/promptcompress` (skills branch only).

## Phase 7 work

1. Redundancy audit. Checked every export of `src/omp/*` for importers (`git grep -w`), `src/omp/index.ts` (imported by `omp-adapter` unit and integration tests), both frame fixtures (referenced by 4 and 1 tests), and `test/support` helpers. Findings: no unreachable file; no helper function name is duplicated across `src/omp` and the omp test support; the 12 exports with no importer outside their own file are used inside it (each has at least one in-file use) and are public typing surface. `fakeModelServer.ts` predates this program and serves a different flow (context-handoff smoke), so it is not a duplicate of `scriptedModelServer.ts`. Phase 2 spike code was promoted into `src/omp` (no separate spike scripts remain). Legacy worker code is required for the offline default. **Deleted: nothing.**
2. Context regression. Per-tool dump of the implementer's first request (chars): omp built-ins `bash` 2136 vs legacy 543, `read` 1853 vs 684, `edit` 2226 vs 1179; PE host tools add only about 70 chars each. omp has no tool-description override. Settings in the existing `--config` overlay do change the text: `edit.mode: replace` (edit 2226 to 1550, read 1853 to 1743), `async.enabled: false` and `bash.autoBackground.enabled: false` (bash 2136 to 1695; bash then runs in the foreground, as legacy's does). Implementer first request 3978 to 3671 approx tokens (+34% to +23.5% over legacy 2972). Scout (2617) and reviewer (2794) unchanged. Ratchet tightened: implementer ratio 0.40 to 0.28, ceiling 4200 to 3800. Parity gates stayed byte-identical (27/27 legacy, 27/27 `PARITY_PATH=omp`, no golden edited). Not done, because it needs upstream or a behavior change: replacing omp `bash`/`read`/`edit` with host-side PE tools under `pe_*` names would reach near parity, but moves bash out of omp's process group and changes the tool names models see. Remaining gap is omp's own tool prose plus about 230 chars of user message and 350 chars of system text.
   `edit.mode` only changes omp's own `edit` tool. When PE supplies `pe_edit` (isolated worktrees, tolerant file tools) it replaces omp's `edit`, so there the setting mainly changes the read/hashline guidance in omp's `read`; the measured implementer flow used omp's own `edit`.
   Silent-bash risk, found in review and fixed in a follow-up commit: with auto-background off, a silent foreground omp bash longer than the inactivity window (300 s default or `req.timeoutMs`) would have killed the run. Legacy `PiWorkerExecutor` re-arms its inactivity guard on session events only, so it has the same window, but legacy bash is bounded by its own wrapper. The omp executor now suspends the guard while an omp `bash` `tool_execution` is in flight, capped by `bashMaxMs` (default 1 h), and a hang with no tool in flight still times out (unit tests with `fakeOmpRpc` modes `silent-bash` and `silent-bash-hang`).
   Risk: the trimmed overlay was verified with a scripted model, not a real model. Whether foreground bash or replace-mode edit changes real model behavior is UNVERIFIED.

## Tests and metrics

| Check | Result |
| --- | --- |
| typecheck / biome | exit 0 / exit 0 |
| all `omp-*.test.ts` together, real omp | 121 pass, 0 fail, 0 skip |
| legacy golden gate (no OMP_BIN) | 27/27 |
| `PARITY_PATH=omp` gate (real omp) | 27/27 |
| `npm run test:coverage` (no OMP_BIN) | exit 0; 6984 tests, 6979 pass, 0 fail, 5 skipped; lines 85.66, branches 83.33, functions 83.45 (floors 85/83/83) |
| golden gate wall time | legacy 23.5 s, omp 82 s (process start per worker run, 1-2 s each) |
| processes | legacy 0 child processes; omp 2 at runtime open (negotiation), then 1 per worker run, none left after run, abort, timeout or SIGKILL of PE |
| first-request context (approx tokens) | scout 2311 vs 2617 (+13%), implementer 2972 vs 3671 (+24%), reviewer 2485 vs 2794 (+12%) |

## Retained, upstreamed, deleted

- Retained (no OMP equivalent proven): ledger, custody, leases and fencing, worktree guards, verify, tournament, review, legacy worker executor and its fallback role. omp ratchet, cleanse and reviewer were read from source and are not equivalent.
- Upstream-owned and used as-is: skill discovery, precedence, registry and lockfile (skills branch).
- Deleted: none.

## Outstanding risks and open user decisions

- CI never runs real-omp tests: `OMP_BIN` is not provisioned in Woodpecker. All real-omp evidence above is local-only.
- Flaky on the shared CI host: hostile-concurrency and load-sensitive lock and race tests (baseline flake `mission-reliability-foundation` index.lock; `runtime-host-auto-reload` seen failing in Phase 2). Not caused by this program, not fixed.
- Legacy tournament tie-break is nondeterministic (found in Phase 5, unchanged).
- Full mission DAG on real omp: UNVERIFIED. omp `agent.db` contents: UNVERIFIED. TUI pixel screenshots and a live Herdr room: UNVERIFIED. Model-driven prompt compression and tool-description ablation: UNVERIFIED (no local model).
- omp bash has no budget notice or stall quarantine; omp receives the full parent environment plus `HOME` (legacy strips session variables).
- DECIDED and implemented (opt-in, default off): worker sessions may get version-pinned, digest-verified skill packs when `PI_ENGINEERING_WORKER_SKILLS=1` and the operator's own `engineering.yaml` allowlists them per role with a pinned manifest sha256 (repo-supplied allowlists and packs are ignored); fail closed with a visible diagnostic. See skills-adoption-decisions.md, "Worker skill packs (opt-in)".
- Decision: always pass an `autolearn.enabled: false` overlay to the operator session, and suppress foreign skill dirs there? (Workers already get the overlay.)
- Upstream issue to file: OMP loads a skillshare store entry by comparing only the `.skillshare-integrity` marker; unpacked files are not re-hashed (a tampered `SKILL.md` still loads).
- Decision: whether to provision omp in CI so the real-omp tests run.
