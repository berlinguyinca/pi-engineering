/**
 * Durable Mission / Task / Execution store (spec 00 §3, spec 02 persistence).
 *
 * Event-sourced over the shared `EventStoreBackend` contract: every mutation
 * appends an event and the store replays the stream to rebuild an in-memory
 * materialized view on open. Mission/task/execution state therefore survives
 * process restart and is reconstructable/auditable from events — execution
 * state lives in the authoritative event store, not only in semantic memory.
 *
 * Reuses the existing durable backends (`JsonlEventStore`, ledger adapter).
 */

import type { EventStoreBackend } from "../platform/eventstore/backend.ts";
import { MissionStoreLifecycle } from "./missionStoreLifecycle.ts";
import { fromStored } from "./missionStoreTypes.ts";

export type {
  CanonicalLifecycle,
  GateEvidencePublication,
  LateExecutionEvidence,
  MissionCompletionOptions,
  MissionCreateInput,
  MissionPersistenceDiagnostic,
  MissionRevisionFence,
  MissionTransitionOptions,
  MissionUpdatePatch,
  OrchestrationEvent,
  OrchestrationEventType,
  RepositoryWait,
  TaskCreateInput,
  DagProjection,
} from "./missionStoreTypes.ts";
export { HandoffRecordError } from "./missionStoreTypes.ts";

export class MissionStore extends MissionStoreLifecycle {
  private constructor(backend: EventStoreBackend) {
    super(backend);
  }

  /** Open a store over a backend, replaying existing events. */
  static open(backend: EventStoreBackend): MissionStore {
    const store = new MissionStore(backend);
    for (const e of backend.all()) store.apply(fromStored(e));
    return store;
  }
}
