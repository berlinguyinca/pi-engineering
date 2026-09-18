# BAR Implementation Status

Generated: 2026-09-18
Branch/commit: `main` @ `7b37af0`

## Honest status

This is a truthful account of the Brownfield Audit & Remediation (BAR) work
state. It does NOT claim completion. Historical success claims are untrusted;
nothing below is marked VERIFIED unless backed by deterministic evidence.

### DONE and verified on main

1. **BAR spec pack merged** (`docs/specs/bar/`).
   The archive `pi-engineering-brownfield-audit-remediation-specs-2026-09-18.zip`
   was unpacked and `docs/specs/bar/` merged into the repo. Verified identical to
   the archive (141 files: 4 root markdown, 4 contracts, 3 profiles, 130 steps),
   committed on `main` via `816a826` ("promote pi-eng-orch-TSK-kGDa0w").
   - `npx tsc --noEmit` exit 0
   - `npm test` 1345 pass / 0 fail / 1 skip (Postgres, pre-existing)

2. **Three pipeline-blocking bugs found, fixed, and merged** that prevented the
   orchestration mission pipeline from integrating ANY substantive work:

   - **Verifier ENOENT** (`src/verify/Verifier.ts`) — `execFile("tsc", ...)` with
     bare binary names failed with ENOENT when `node_modules/.bin` was not on
     PATH (runtime launched via `node`, not `npm`), so every integration /
     validation gate spuriously FAILED with empty output even when work landed.
     Fix: prepend the nearest `node_modules/.bin` to the child PATH + regression
     test. **PR #26**, merged `9c47075`.
   - **Worker budget too short** (`src/orchestration/realBackends.ts`) — fresh
     workers were killed at the 10-minute boundary before committing real work.
     Fix: default 30 min, override `PI_ENGINEERING_WORKER_TIMEOUT_MS`.
     **PR #27**, merged `b88de87`.
   - **Broker abort timer out of lockstep** (`src/orchestration/broker.ts`) — the
     timer that actually ABORTS an execution was still hardcoded to 10 minutes,
     so the broker killed workers even after PR #27 raised the worker budget.
     Fix: centralize `workerTimeoutMs()` (30 min default) used for BOTH the
     broker abort timer and the worker budget + regression test.
     **PR #28**, merged `7b37af0`.

   On-disk state at `7b37af0` is green: `tsc` exit 0; `npm test` 1345 pass /
   0 fail / 1 skip; verifier + orchestration unit tests pass.

### BLOCKED: executing BAR steps 000–129 through the mission pipeline

The mission tool (`mission`) runs the orchestration pipeline **in-process** via a
runtime cached per repository root in the running pi extension process
(`extensions/index.ts` `runtimes` map, reloaded only when the blackhole memory
identity changes). The runtime was constructed at session start, **before** the
three fixes above were merged.

Empirically confirmed: a mission (`MSN-Rp1ORh`) started at 18:14Z — after
PR #26 (17:25Z) and PR #27 (18:13Z) had already merged — still used the old
10-minute broker abort timer (exact 10-minute execution intervals) and produced
empty ENOENT typecheck output. The running process holds the OLD in-memory code;
the merged fixes take effect only in a fresh pi process.

Because of this, every `mission` delegation in this session deterministically
fails its integration/validation/review gates regardless of correctness, so no
BAR step can be promoted to VERIFIED through the pipeline in this session.

### What this means for BAR step status

- Step 0 prerequisite (spec merge): **DONE** (verified, on main).
- BAR-000 … BAR-129: **UNKNOWN / NOT VERIFIED**. Not implemented. No step has
  been executed, tested, or reviewed. Nothing is claimed as COMPLETE.
- Next action: start a fresh pi process (which will load the merged fixes), then
  execute the numbered steps in order, each gated to VERIFIED with deterministic
  positive + negative evidence and independent review.

## Evidence locations

- `.pi-eng/orchestration.jsonl` — mission/task/execution event log
- `.pi-eng/artifacts/verify/*` — captured verification command output
- `.pi-eng/ledger.jsonl` — engineering ledger (findings w1Re7U, 5QGIFD)
- PRs: #26, #27, #28 (all MERGED)
