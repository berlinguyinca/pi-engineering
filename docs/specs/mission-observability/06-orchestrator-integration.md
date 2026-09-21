# 06 — Orchestrator Integration

## Mission Controller

Mission Controller remains the authority for:

- mission lifecycle,
- DAG,
- worker assignment,
- state,
- completion validation.

Add an observability projector/service beside it rather than coupling UI rendering into orchestration logic.

## Worker contract

Every worker must emit:

1. heartbeat,
2. current observable activity,
3. meaningful progress events,
4. task completion/failure,
5. waiting reason when applicable.

## Subagents and subprocesses

All Pi subagents and subprocesses associated with a mission must register under the mission ID and task ID.

A subprocess must not become invisible merely because it was spawned by another worker.

## AutoSpec

AutoSpec-generated execution tasks must map into Mission DAG nodes.

Expose:
- issue/spec identifier,
- dependencies,
- implementation status,
- validation status.

## Review workflow

Review is mandatory where Pi-Engineering policy already requires it.

Expose:
- review start,
- reviewer worker,
- review findings,
- severity,
- required repairs,
- re-review,
- final status.

## InferWeave integration

Where model/runtime requests route through InferWeave, surface useful waiting/runtime metadata when available:

```text
requested capability
selected model
provider/runtime
queue/admission state
elapsed wait
worker/host
tokens/sec if available
```

Do not make mission health depend on InferWeave-specific telemetry being present.

## Slurm

For Pi work launched under Slurm:

- retain mission ID across job submission,
- expose Slurm job/node identity when available,
- keep worker heartbeat/activity mapped to the parent mission,
- represent scheduler wait explicitly,
- avoid incorrectly marking queued jobs as stalled.

## Repository state

Mission observability should track, where available:

- repo,
- branch,
- worktree,
- changed files,
- commits,
- integration status.

## Crash recovery

On orchestrator restart:

1. reload active missions,
2. reconstruct projection,
3. reconcile registered workers/processes,
4. mark stale leases,
5. resume or recover tasks according to existing mission rules,
6. continue user-visible status without resetting progress to zero.
