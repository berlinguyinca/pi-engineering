# Paste-ready autonomous implementation prompt

You are in the parent directory containing the related Pi engineering repositories.

Implement the specification package `pi-engineering-implementation-spec-2026-09-15.zip`.

1. Locate the ZIP in `~/Downloads`, `/mnt/data`, or the current directory. Unpack it to a temporary directory.
2. Read `MASTER_SPEC.md`, `IMPLEMENTATION_ORDER.md`, every file under `specs/`, and `support/DECISIONS.md`.
3. Discover all relevant repositories below the current directory. At minimum look for Pi, pi-subagents, Pi Web, Pi Forge, Plannotator, AutoSpec, InferWeave-related integrations and existing engineering-harness repositories. Do not assume names/paths if discovery shows different ones.
4. Copy this spec package into the appropriate source-controlled `docs/specs/pi-engineering/` location in the primary implementation repository, preserving the master/sub-spec structure.
5. Before coding, inspect current upstream/local capabilities and produce `docs/specs/pi-engineering/GAP_MATRIX.md` with every requirement classified as EXISTING, PARTIAL, MISSING, SUPERSEDED or NOT-APPLICABLE. In particular inspect pi-subagents, Pi Web, Pi Forge and Plannotator before recreating features.
6. Treat the master spec as normative. Do NOT implement the obsolete shared Blackhole memory server/filesystem design. Blackhole is local; OpenViking is shared.
7. Use subagents aggressively where parallel work is safe: repository reconnaissance, UI/API analysis, memory integration, tests, security review and independent final review. Mutating parallel agents must use isolated worktrees.
8. Implement in dependency order from `IMPLEMENTATION_ORDER.md`. Prefer small coherent commits/changes. Preserve compatibility while migrating.
9. Keep the parent/control Pi session responsive. Use upstream pi-subagents primitives rather than custom process orchestration wherever possible.
10. Pi Web is the primary multi-project UI. Plannotator is the optional plan gate with explicit autonomous bypass. Pi Forge is only integrated where its current implementation provides non-duplicative value.
11. Run formatting, lint/type checks, unit tests and integration tests continuously. Add recovery/failure-injection tests and the 50-worker concurrency/load test specified by the package.
12. For UI work, run browser/E2E tests and perform at least two visual inspection/fix loops at common desktop sizes and a mobile-sized viewport.
13. Run an independent fresh-context code/security review after substantial implementation. Fix findings and rerun validation.
14. Exercise one real end-to-end project flow: plan -> Plannotator or explicit autonomous bypass -> implementation workers -> tests -> independent review -> fixes -> completion -> durable OpenViking memory.
15. Produce `IMPLEMENTATION_REPORT.md` with requirements completed, architecture deviations and reasons, tests/results, load-test results, screenshots/artifacts where relevant, unresolved external blockers, and exact follow-up work.
16. Continue implementing and fixing failures until the acceptance criteria are satisfied. Do not stop after planning, scaffolding, or a partial proof of concept unless an external dependency makes further progress impossible.

Start now by inspecting the repositories and current upstream capabilities, then proceed through implementation.
