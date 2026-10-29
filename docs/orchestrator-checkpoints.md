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
