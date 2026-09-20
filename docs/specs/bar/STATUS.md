# BAR Implementation Status

Generated: 2026-09-20
Branch/commit: `main`

## Honest status

This is a truthful account of the Brownfield Audit & Remediation (BAR) work
state. It does NOT claim full completion. Historical success claims are
untrusted; nothing is marked VERIFIED unless backed by deterministic evidence
and independent review.

## DONE and verified on main

1. **BAR spec pack merged** (`docs/specs/bar/`). Verified identical to the
   archive (141 files: 4 root markdown, 4 contracts, 3 profiles, 130 steps),
   committed on `main` via `816a826`.

2. **Generic BAR engine implemented** (`src/bar/`), reusing the existing CAV /
   Engineering-Ledger architecture rather than building a parallel framework:
   - `types.ts` — the full requirement-state vocabulary (UNKNOWN … DEFERRED),
     candidate classification vocabulary (VERIFIED/FAILED/PARTIAL/MISSING/
     UNKNOWN/BLOCKED/ORPHAN/OBSOLETE), and the four contracts (REQUIREMENT_RECORD,
     AUDIT_REPORT, BASELINE, REPAIR_CAMPAIGN).
   - `store.ts` — append-only JSONL persistent store (resumable + idempotent;
     re-apply updates in place, never duplicates).
   - `discovery.ts` — deterministic repo discovery (specs, source, tests, config,
     historical claims [treated untrusted]).
   - `executor.ts` — deterministic audit pass; reconstructed requirements begin
     UNKNOWN and are NEVER promoted to VERIFIED by the executor; VERIFIED/FAILED
     require explicit independent-verifier classifications.
   - `cluster.ts` — root-cause clustering (shared source / shared blocker) +
     deterministic dependency ordering.
   - `campaign.ts` — bounded repair-campaign generation carrying the contract and
     the hard prohibition on acceptance weakening; settlement gating.
   - `reconcile.ts` — state reconciliation with before/after deltas.
   - `baseline.ts` — immutable before-repair baseline (append-only, audit-id
     addressable, structural `immutable: true`).
   - `report.ts` — audit report honoring the AUDIT_REPORT contract (counts every
     state, explicit percent-verified denominator, untested surfaces, next action).
   - `index.ts` — exports + `barPaths`.

3. **CLI** (`scripts/pi-engineering.ts bar audit|status [--json]`).

4. **Tests** (`test/unit/bar.test.ts`, 12 tests incl. negative/adversarial):
   - store persistence + idempotence/resume, immutable baselines;
   - discovery determinism + node_modules exclusion;
   - **negative**: executor never emits VERIFIED from evidence presence
     (implementer cannot self-promote); reconstructed requirements begin UNKNOWN;
     blockers win;
   - reconcile deltas; clustering; deterministic dependency ordering; campaign
     settlement gating; audit-report state accounting; fingerprint determinism.

## Verification evidence (deterministic, on-disk `main`)

- `npx tsc --noEmit` — exit 0
- `npm test` — **1357 pass / 0 fail / 1 skip** (Postgres, pre-existing)
- `node --test test/unit/bar.test.ts` — 12 pass / 0 fail
- CAV regression gates `test/unit/cav-*.test.ts` — 94 pass / 0 fail
- CAV sabotage suite `test/unit/cav-sabotage*.test.ts` — 8 pass / 0 fail
- `npx biome check src/bar test/unit/bar.test.ts scripts/pi-engineering.ts` — clean
- `node scripts/pi-engineering.ts bar audit` — dogfooded against Pi Engineering
  itself: 200 requirements atomized, **all begin IMPLEMENTED_UNVERIFIED (0/200
  VERIFIED)** — no historical claim trusted, no self-promotion; 26 root-cause
  clusters; 26 bounded repair campaigns generated; immutable baseline persisted.

## Three pipeline-blocking bugs fixed (PRs #26/#27/#28)

The orchestration mission pipeline could not integrate substantive work until:
- Verifier ENOENT on bare binaries (PR #26)
- Worker budget too short (PR #27)
- Broker abort timer out of lockstep with the worker budget (PR #28)

All merged to `main`. Note: the running pi process holds a stale in-memory
runtime, so the `mission` tool in an existing session cannot yet execute BAR
steps to VERIFIED; a fresh process is required.

## What remains (honestly)

- **No BAR step has been promoted to VERIFIED.** The generic engine is TESTED
  (deterministic unit + regression evidence) but VERIFIED requires independent
  cross-model review per step, which the blocked in-session `mission` tool
  prevents and which must be executed step-by-step in a fresh process.
- **Project profiles** (AIMS / InferWeave / WeaveForge) require live external
  consoles / GPU infrastructure and are BLOCKED boundaries, consistent with the
  existing CAV_STATUS honest-boundary findings — they are not claimed.
- **Real-stack CAV execution** over the dogfood audit and the after-campaign
  reconciliation loop are implemented as the engine but not yet run to VERIFIED
  against live surfaces.

## Evidence locations

- `.pi-eng/orchestration.jsonl` — mission/task/execution event log
- `.pi-eng/artifacts/verify/*` — captured verification command output
- `.pi-eng/ledger.jsonl` — engineering ledger
- `.pi-eng/bar/` — BAR audit store (requirements, baselines, campaigns, reports)
- PRs: #26, #27, #28 (pipeline fixes), #29 (status doc) — all MERGED
