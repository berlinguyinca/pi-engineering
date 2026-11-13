# WORKER_REPORT — R01 retry ownership catalog (read-only)

Base `3bb21ab2e4b4434f01f01d93770ff4a131f176e9`; commit `9e508548` on `feat/r01-retry-owners`
(`docs(recovery): retry ownership catalog by failure class (R01)`). Mode: read-only — one new
documentation file, zero source changes.

## Verify

`git diff --numstat 3bb21ab2e4b4434f01f01d93770ff4a131f176e9 HEAD`:

```
85	0	docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md
```

Exactly one file, one path, no deletions.

`git diff --check` (the only verify command): **exit code 0**, no output.

Document length: **85 lines** (limit 100).

Citation self-check: every `path:line` in the document (77 references, 71 unique) was re-resolved
against the working tree — each resolves to exactly one file and to a non-empty line. No constant
name or value was written without opening its declaration line; Pi-internal-only claims about the
external `pi-ai`/`pi-coding-agent` retry wrapper are marked as read-from-comment, and tool-error
retry inside Pi's own loop is stated as `unknown`.

## Files opened to establish citations

- `docs/specs/harness-reliability-bootstrap-20261103/R01/HANDOFF.md` (contract)
- `src/resilience/classify.ts`, `src/resilience/config.ts`, `src/resilience/MissionSupervisor.ts`
- `src/guard/transient.ts`
- `src/gateway/signals.ts`, `src/gateway/config.ts`, `src/gateway/streamRetry.ts`,
  `src/gateway/fallbackLifecycle.ts`, `src/gateway/afterOutputRetry.ts`
- `src/inference/failureClassifier.ts`, `src/inference/recovery.ts`, `src/inference/retryDelay.ts`,
  `src/inference/retryPolicy.ts`, `src/inference/resilienceConfig.ts`,
  `src/inference/admissionConfig.ts`, `src/inference/admissionTransport.ts`,
  `src/inference/resilientStream.ts`, `src/inference/streamResume.ts`
- `src/workers/PiWorkerExecutor.ts`
- `src/orchestration/scheduler.ts`, `src/orchestration/missionStore.ts`, `src/orchestration/recovery.ts`
- `src/plannerWorker/executor.ts`, `src/plannerWorker/convergence.ts`, `src/plannerWorker/types.ts`,
  `src/plannerWorker/planner.ts`, `src/plannerWorker/gateway.ts`
- `src/aps/escalation.ts`, `src/lifecycle/roleRunner.ts`, `src/lifecycle/policy.ts`
- `src/verify/Verifier.ts`, `src/verify/targetedRetry.ts`
- `src/models/health.ts`, `src/models/refresh.ts`
- `src/runtime/EngineeringRuntime.ts`, `src/runtime/host/sourceWatch.ts`,
  `src/runtime/herdr/ControlPlaneIngest.ts`, `src/runtime/herdr/graphClient.ts`,
  `src/runtime/herdr/SteeringReceiver.ts`, `src/runtime/herdr/roomClient.ts`
- `src/github/reconcile.ts`, `src/github/quorum.ts`, `src/github/client.ts`
- `docs/specs/harness-reliability-bootstrap/ERROR_SOURCES.md` (sibling-document precedent)

Regions were read with bounded `sed -n`/`read` slices and `grep -n`; the citation self-check above
confirms each cited line's content, so grep-only files still have their cited line verified.

## Findings (summary)

- Seven failure classes catalogued, each with a current owner, a literal/config limit, the decider,
  and one proposed owner.
- Six unresolved conflicts recorded: 429 has four decision points across three scopes; 5xx is
  retried at two layers of one worker attempt; `gateway/signals.ts` and `guard/transient.ts` disagree
  on 503 scope; 404's retry count is decided twice; zero-tool `worker_result` retries never consume
  `max_attempts`; `400` and tool errors have **no** retry owner today (stated as such, not invented).
