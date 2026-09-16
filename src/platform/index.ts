/**
 * Pi Engineering Platform — control-plane facade.
 *
 * Wires the pi-engineering-owned control-plane pieces into one object:
 *   ProjectRegistry (workspace/project/repository) +
 *   WorkGraph (run/task/worker lifecycle) +
 *   Plannotator (plan gate) +
 *   McpRegistry (scoped tools) +
 *   RemoteWorkerClient (outbound workers) +
 *   ControlPlane (operator adapter for Pi Web).
 *
 * All state flows through one EventStore backend so the whole control plane is
 * reconstructable from events.
 */

import type { EventStore } from "../ledger/EventStore.ts";
import { ControlPlane } from "./ControlPlane.ts";
import { McpRegistry } from "./McpRegistry.ts";
import { PlannotatorAdapter } from "./Plannotator.ts";
import { ProjectRegistry } from "./ProjectRegistry.ts";
import { RemoteWorkerClient } from "./RemoteWorker.ts";
import { WorkGraph } from "./WorkGraph.ts";
import { LedgerEventStoreBackend } from "./eventstore/adapters.ts";
import type { EventStoreBackend } from "./eventstore/backend.ts";
import { JsonlEventStore } from "./eventstore/jsonl.ts";

export * from "./types.ts";
export * from "./eventstore/backend.ts";
export * from "./eventstore/jsonl.ts";
export * from "./eventstore/adapters.ts";
export * from "./ProjectRegistry.ts";
export * from "./WorkGraph.ts";
export * from "./Plannotator.ts";
export * from "./McpRegistry.ts";
export * from "./RemoteWorker.ts";
export * from "./ControlPlane.ts";

export interface PlatformOptions {
  /** Backend for platform events. Defaults to in-memory. */
  store?: EventStoreBackend;
  /** Reuse the existing single-project ledger EventStore via the compat adapter. */
  ledgerStore?: EventStore;
  workspaceName?: string;
  plannotator?: ConstructorParameters<typeof PlannotatorAdapter>[0];
  mcpPolicy?: (ctx: { projectId: string; role: string; tool: string }) => boolean;
}

export class Platform {
  readonly store: EventStoreBackend;
  readonly registry: ProjectRegistry;
  readonly graph: WorkGraph;
  readonly plannotator: PlannotatorAdapter;
  readonly mcp: McpRegistry;
  readonly remote: RemoteWorkerClient;
  readonly controlPlane: ControlPlane;

  constructor(opts: PlatformOptions = {}) {
    this.store =
      opts.store ?? (opts.ledgerStore ? new LedgerEventStoreBackend(opts.ledgerStore) : JsonlEventStore.inMemory());
    this.registry = ProjectRegistry.create(this.store, opts.workspaceName ?? "default");
    this.graph = WorkGraph.create(this.store);
    this.plannotator = new PlannotatorAdapter(opts.plannotator);
    this.mcp = new McpRegistry({ policy: opts.mcpPolicy });
    this.remote = new RemoteWorkerClient({ graph: this.graph });
    this.controlPlane = new ControlPlane({
      registry: this.registry,
      graph: this.graph,
      store: this.store,
    });
  }
}
