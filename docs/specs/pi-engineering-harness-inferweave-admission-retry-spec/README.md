# Pi Engineering Harness — InferWeave Admission Retry Spec

This specification defines resilient, server-directed retry behavior for InferWeave admission-control responses in the Pi Engineering Harness.

Read in this order:

1. `00-overview.md`
2. `01-admission-error-contract.md`
3. `02-retry-state-machine.md`
4. `03-configuration.md`
5. `04-ui-telemetry.md`
6. `05-tests-and-rollout.md`
7. `06-implementation-checklist.md`

Primary objective: convert retryable InferWeave admission failures such as `queue_timeout` and `caller_concurrency` from terminal Pi errors into bounded, abortable, observable wait/retry states.
