# Pi Engineering / Herdr — Harness Reliability Bootstrap v1.2

**Generated:** 2026-11-03. **Repositories inspected:** `berlinguyinca/pi-engineering`, `berlinguyinca/herdr-engineering`. **Scope:** 51 independent, dependency-ordered microtasks, conservative bootstrap execution, handoff verification, read-only diagnostics, goal-drift instrumentation, scoped recovery, Herdr dashboards, and controlled benchmarks.

## Why this package exists
The current harness can wander, produce unrelated modifications, repeat failed calls, and occasionally fail to return structured results. The implementation mechanism must not rely on the self-repair and orchestration features being fixed. The first six tasks build an **independent, static, single-task workflow** and do not launch models until its verification logic has been validated.

## Start here
1. Read `00-OPERATOR-START.md`, `01-ARCHITECTURE-AND-AUDIT.md`, `02-HANDOFF-PROTOCOL.md`, `03-TEST-AND-RELEASE-GATES.md`, `04-QUANTIZATION-BENCHMARK.md` and `05-IMPLEMENTATION-SECURITY.md`.
2. Verify exact local repository paths, branches, git status and installed extension revision. Stop if dirty or if the package is stale.
3. Run **B00 only** with the starter prompt. Nothing else begins automatically.
4. Record an independent approval of each task; pass one handoff to the next task. When switching repos, validate and record the target repo SHA independently.
5. Do not feed the whole ZIP and all tasks to Qwen Flash for implementation. Coordinator reads index; worker sees only one task + immediately previous approved handoff + limited relevant source.

## Non-negotiable
- One worker, one tiny objective, one commit candidate, no automatic retries or replans during bootstrap.
- Target <=100 changed lines and <=2 production files + <=2 tests; tasks exceeding budget must BLOCK and be split by a human into a versioned task extension.
- Existing code takes precedence: discover and reuse APS, `IncidentController`, `SessionEventStore`, `RetryTrace`, planner contracts, completion gates, and Herdr UI components.
- Never infer code is deployed from GitHub config or comments. Verify installed revision and runtime model identity.
- No model-required dependency for guardrails, logging or recovery. Quantized models are optional analyzers/implementers.
- The task authority hash survives every restart/handoff; no summary changes permission boundaries.
- Errors and diagnostics stay local by default; redact secrets and minimize captured data.
- Rollout remains shadow/read-only until all explicit gates are met. No self-editing live harness.

## Important nuance
Paths in tasks are **candidate file targets grounded in observed repository structure or intentionally proposed new files**. They must be independently confirmed at each base SHA. A task must BLOCK, not guess, when a path or integration seam is wrong. Test files named in tasks are *proposed*: tests can be created at those exact paths only if compatible with repo conventions. A terminal stage may require a human-approved amendment when additional integration points are discovered.

## Contents
- `tasks/01-B00.md` through `tasks/51-V06.md`: individual complete microtask contracts.
- `manifests/tasks.json`: machine-readable DAG and scope metadata.
- `templates/handoff.schema.json`: mandatory evidence/approval record.
- `templates/task-execution-prompt.md`: task-specific worker prompt.
- `06-ONE-SHOT-LOCAL-START-PROMPT.md`: operator's first copy/paste prompt.
