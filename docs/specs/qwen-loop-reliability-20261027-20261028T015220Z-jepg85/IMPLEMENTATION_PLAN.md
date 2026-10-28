# Implementation plan: smallest safe increments

## P0: Baseline and reproduce
- Inspect canonical repos, current branches/worktrees and active deployments.
- Run existing unit/integration tests without changing active GPU allocation.
- Capture/redact 2–5 real loop traces if available, plus legitimate long outputs.
- Identify actual reasoning and text event shapes, token counts, guard config and signal path.
- Document baseline in `docs/specs/<this-spec>/AUDIT_RESULTS.md` with code links and evidence.

## P1: Stream protection
- Test-first change to `guardFeedFor` and existing GenerationGuard for reasoning channel and channel-specific no-progress/repetition detection.
- Ensure streaming delta/snapshot accounting is monotonic and exact per unique event; include restart/segment boundaries.
- Preserve role exemptions and avoid false positives on code generation.
- Add configuration/feature flags and logging; verify abort signal propagation and runtime acknowledgment.

## P2: Recovery and APS integration
- Reuse existing controller; connect stage-specific prompts and bounded recovery to verified checkpoint resume.
- Propagate same loop fingerprint, avoid duplicate attempts, guard side effects.
- Maintain separation of inference transport retries and model-degeneration retries.
- Compare worker, interactive and reviewer paths.

## P3: Experiment-driven optimizer
- Implement minimal versioned recipe records in existing configuration/storage model.
- Build replay adapter using existing benchmark harness, not a parallel benchmark system.
- Seed with real loop traces and healthy control cases; run paired, parameter-isolated trials.
- Only promote statistically meaningful no-regression recipes (thresholds to be decided from baseline); include manual override/rollback.

## P4: Dashboard and operations
- Extend existing inspector/telemetry event types, filtering, overlays and summaries.
- Document runbook for diagnosing 32K loops and inspection of inference cancellation.
- Add canary rollout by model/profile, monitor false aborts/recovery, then wider enablement.

## Gates after EVERY phase
- Formatting/lint/typecheck; relevant existing and new tests; no skip/disable of unrelated tests.
- Idempotence and cancellation stress tests; compatibility with Qwen Flash/27B and at least one non-Qwen model.
- Change manifest detailing reused modules, touched paths and explicitly avoided duplicate code.
- Record verified results, unresolved blockers and next safe step. Stop on uncertain side effects.
