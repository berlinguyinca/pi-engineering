# Implementation Order
0. Repository/upstream reconciliation and gap matrix.
1. Shared domain contracts: project/run/task/worker/event IDs and schemas.
2. Durable EventStore + compatibility adapter for current execution.
3. pi-subagents adoption; responsive parent; worktree isolation.
4. OpenViking mandatory shared memory + Blackhole-local enforcement.
5. Dynamic model/context discovery + InferWeave queue/backpressure integration.
6. Scheduler/concurrency/backpressure and worker recovery.
7. Plannotator modes and persisted approval state.
8. Pi Web multi-project control plane and live worker controls.
9. Permissions/sandbox/Docker hardening + MCP registry.
10. AutoSpec/CI/review integration.
12. Remote worker contract.
13. Prompt/event research telemetry and observability.
14. Failure injection, 50-worker load, E2E, independent review, migration cleanup.
