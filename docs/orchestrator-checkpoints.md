# Orchestrator phase checkpoints (`TCP-orch-*`)

A `phase_transition` handoff names a checkpoint written by the orchestrating session itself at the phase boundary
(`CheckpointManager.persistPhaseBoundary`). It is stored as an ordinary `task.checkpointed` journal event with
`checkpointId` `TCP-orch-<mission>-<n>`, `executionId` `ORCH-<mission>` and `scope: "orchestrator"`, anchored on the
mission's most recent task.

- Current binaries hide it from every worker-level read (`MissionStore.listTaskCheckpoints`); only
  `listOrchestratorCheckpoints` and the handoff driver see it.
- **Older binaries replaying a journal that contains these events do not know `scope`.** They will load the entry as
  a normal task checkpoint of the anchor task, so recovery or handoff code there may treat it as that task's newest
  checkpoint (its `executionId` has no execution, its `sessionId` is the orchestrator's). Do not run an older binary
  against a journal written by this one if phase handoffs are enabled; roll forward instead.
- `phase_transition` records written before this change have no orchestrator checkpoint; the driver aborts them once
  with a reported reason.
- Quota switching (`quota_fallbacks` in `engineering.yaml`) adds `task.model_switched` events and `fromModel`,
  `toModel`, `blockedReason`, `fromPhase`, `toPhase` on handoff records; older binaries ignore these.

## Context-pressure handoffs keep the model

A worker whose context crosses the `preferred` (at a safe point) or `emergency` level hands off to a NEW session instead
of compacting. The successor runs on the same model the predecessor was serving; no configuration is needed and
`quota_fallbacks` is not involved.

- The record (`cause: context_pressure`) carries `fromModel` and a `toModel` equal to the routable `provider/id`. After the
  checkpoint is verified and before the writer is fenced, the task is pinned to that model through the same durable
  switch a quota fallback uses (`task.model_switched`, `execution_requirements.model`), so the scheduler's retry starts
  there from the verified checkpoint. The pin is a preference, not a requirement: if an operator pin or a failover routes the successor to another model,
  that session still takes over and acknowledges (unlike a quota fallback, which only an execution on the fallback does).
- A model that cannot be pinned (marked unavailable by the runtime, absent from a readable registry, serving model
  unknown, or a bare id with an unreadable registry) is never guessed. The record has no `toModel`, the report says
  `successor not pinned to <model> (<reason>); it routes normally`, and the successor is routed as any retry.
- Precedence is unchanged: an operator pin for the mission still outranks the task's model, and a failed pinned model
  fails over (the pin applies only to the first placement).
- Like a quota switch, the successor is the task's next attempt: with no attempt left the record is aborted, the source
  keeps running and is not fenced (`no retry budget left ... successor [on <model>] not started`). This holds whether or not the model could be pinned.
- The task keeps that model in its execution requirements; if the model fails, the failover attempt is routed normally.

## Enabling quota fallbacks (operator checklist)

Quota switching is off until the operator lists fallbacks in the GLOBAL `engineering.yaml`
(`<pi agent dir>/engineering.yaml`, default `~/.pi/agent/engineering.yaml`; it is not read from the repo's
`.pi/engineering.yaml`). A commented, tested example block is at the end of `.pi/engineering.yaml`: copy it to the
global file and uncomment it.

```yaml
quota_fallbacks:
  roles:
    implementer: [provider/model-b, provider/model-c]   # order = preference
  default: [provider/model-z]                           # roles without their own list
```

Check before relying on it:

1. **Registry ids.** Every id must be in the model registry as `provider/id` or the plain id. Startup validates this
   when the registry can be read.
2. **Same provider family per role.** The successor continues the predecessor's verified checkpoint on a different
   model; a close relative loses the least.
3. **Retry budget.** The successor runs as the task's next attempt, so the planned task needs `max_attempts >= 2`
   (planner default: 3). With `max_attempts: 1` the handoff aborts with "no retry budget left", the source is not
   fenced and keeps running. `max_attempts` is set per task by the planner, not in `engineering.yaml`, so it cannot be
   validated at config time.
4. **No fallback means blocked.** An empty or missing list leaves the handoff blocked with
   `no quota_fallbacks configured for role <role>`; the chain also ends, blocked, with `fallback list exhausted` once
   every listed model has run out for the task.

Validation is fail-closed. These are errors: a block that is not a mapping, unknown keys (only `roles` and `default`
exist), a role value that is not a list, non-string or empty entries, duplicate ids in one list, ids missing from the
registry, and a list holding only the role's own pinned model (`routing.roles.<role>.model`). On any error the whole
block is ignored (no switching) and startup logs `[quota-fallbacks] ERROR ...`. Warnings (logged, not fatal): registry
unreadable so ids are unchecked, an empty list, a block that lists nothing, a list that also names the role's pinned
model. `pi-engineering doctor` reports the same shape, duplicate and pin checks (status FAIL, exit 2, on errors);
registry ids are only verified at startup.
