# CAV Phase 00 — Root of Trust: Completion Gate Document

Status: **MECHANISM IMPLEMENTED + TESTED** — VERIFIED promotion pending independent review.

## Objective
Build deterministic workflow state, evidence ledger, protected artifacts, hard COMPLETE semantics.

## What was implemented (reconciled with existing architecture)
The repository already contained a generic Engineering Ledger (`src/ledger`), a
RoadmapEngine with derived completion (`src/roadmap`), and a deterministic
`CommandVerifier` (`src/verify`). CAV-00 does **not** duplicate these; it adds a
focused CAV layer that enforces the Root-of-Trust contracts on top of them:

| Step | Deliverable | Files |
|------|-------------|-------|
| CAV-00-01 | Contracts/interfaces (types, protected-path defaults, roles) | `src/cav/types.ts` |
| CAV-00-02 | Minimal mechanism (ledger, guard, step registry, phase gate) | `src/cav/{steps,evidence,guard,completion,index}.ts`, CLI |
| CAV-00-03 | Deterministic tests | `test/unit/cav-{steps,evidence,completion}.test.ts` |
| CAV-00-04 | Failure/sabotage tests | `test/unit/cav-sabotage.test.ts` |
| CAV-00-05 | Gate + documentation (this file) | `scripts/cav-phase-report.ts`, `scripts/cav-record-evidence.ts` |

## Acceptance criteria evidence
1. **Mechanism observable through deterministic test/artifact** — `cav status`/`cav check` CLI and the phase-gate report are deterministic; 21 CAV unit tests pass.
2. **Deliberately failing case fails closed, cannot be VERIFIED** — sabotage suite proves: implementer cannot write VERIFIED; empty-ledger promotion rejected; protected-artifact mutation rejected; false-success exit (code 0 + SPECIFIED) never VERIFIED.
3. **Existing trusted gates still pass** — full unit suite: 1272 pass / 0 fail / 1 pre-existing skip (Postgres-dependent). Typecheck clean. Biome clean.
4. **No protected artifact silently rewritten** — `ProtectedArtifactGuard` rejects mutations to `docs/specs/**`, `tests/cav/golden/**`, `tests/cav/fixtures/**`, `tests/acceptance/contracts/**`, `design/reference/**` by the implementer.
5. **Ledger explains PASS/FAIL/UNKNOWN from evidence** — `cav-phase-report` lists per-step blockers; evidence JSONL carries role, git sha, exit code, gate, command.

## Honest gate status
Phase 00 exit gate is **NOT yet PASS**: every CAV-00 step is recorded `TESTED`
(implementer role) or `SPECIFIED`, and **none is VERIFIED**.

This is not a defect in the implementation — it is the Root of Trust working as
specified. The implementer cannot promote its own work to VERIFIED, and
promotion to VERIFIED is itself role-gated to an independent reviewer. The CAV
roadmap is deliberately ordered so that **phase 10 (Independent Review)**
builds the machinery that can legitimately promote earlier phases to VERIFIED.

Therefore Phase 00's mechanism is complete and evidence-backed, but its
VERIFIED promotion is **BLOCKED on phase 10 (Independent Review)**. Recording
this honestly is the correct behavior; manufacturing a self-VERIFIED would
violate the very contract CAV-00 establishes.

## Verification commands executed
```
npx tsc --noEmit                                   # typecheck PASS
node --test test/unit/cav-*.test.ts                # 21 PASS / 0 FAIL
npx tsx --test $(git ls-files 'test/unit/**/*.test.ts')   # 1272 PASS / 0 FAIL / 1 pre-existing skip
npx biome check src/cav test/unit/cav-*.test.ts    # clean
node --experimental-strip-types scripts/pi-engineering.ts cav status
node --experimental-strip-types scripts/cav-phase-report.ts 00   # exit 1 (gate not PASS — correct)
node --experimental-strip-types scripts/cav-record-evidence.ts CAV-00-0N --gate unit --cmd "node --test test/unit/cav-*.test.ts"
```

## Evidence ledger
`.pi-eng/cav/evidence.jsonl` — append-only JSONL with requirement_id, role,
git sha, exit code, gate, command, environment, timestamps.
