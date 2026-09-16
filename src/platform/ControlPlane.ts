/**
 * Control-plane adapter — the pi-engineering side of the Pi Web integration
 * (spec 02/08).
 *
 * Pi Web is an EXTERNAL operator UI. This module is the normalized adapter that
 * exposes projects, runs, workers, events, tests, reviews, routing/memory status
 * and interventions as a single JSON contract that an existing Pi Web
 * deployment (or any operator client) consumes. It does NOT build a Pi Web
 * frontend/backend. It reads from the pi-engineering-owned state: the
 * ProjectRegistry, WorkGraph and the shared EventStore backend.
 *
 * If a UI feature is absent upstream, that is documented as a Pi Web gap — not
 * re-implemented here.
 */

import type { ProjectRegistry } from "./ProjectRegistry.ts";
import type { WorkGraph } from "./WorkGraph.ts";
import type { EventStoreBackend } from "./eventstore/backend.ts";
import type { ApprovalRecord } from "./types.ts";

export interface ControlPlaneSnapshot {
  generatedAt: string;
  workspace: { id: string; name: string };
  projects: Array<{
    id: string;
    name: string;
    canonicalRemote: string | null;
    riskClass: string;
    multiRepo: boolean;
    repositories: Array<{ id: string; root: string; remote: string | null; worktrees: string[] }>;
  }>;
  runs: Array<{
    id: string;
    projectId: string;
    workItemId: string | null;
    goal: string;
    status: string;
    parentRunId: string | null;
    startedAt: string;
    finishedAt: string | null;
    approval: ApprovalRecord | null;
  }>;
  workers: Array<{
    id: string;
    runId: string | null;
    projectId: string;
    role: string;
    status: string;
    model: string | null;
    worktree: string | null;
    location: { host: string; remote: boolean };
    heartbeatAt: string | null;
    generation: number;
  }>;
  /** Normalized event feed (bounded) for the operator client. */
  events: Array<{
    eventId: string;
    type: string;
    projectId: string | null;
    runId: string | null;
    workerId: string | null;
    timestamp: string;
    payload: Record<string, unknown>;
  }>;
  /** High-level health rollup (no chain-of-thought; only observable state). */
  health: {
    projects: number;
    activeRuns: number;
    activeWorkers: number;
    staleWorkers: number;
    memory: { openviking: boolean; blackhole: boolean };
  };
}

export interface ControlPlaneInputs {
  registry: ProjectRegistry;
  graph: WorkGraph;
  store: EventStoreBackend;
  /** Optional external status flags reported by the adapter. */
  memoryStatus?: { openviking: boolean; blackhole: boolean };
}

/** Bounds for the normalized event feed exposed to the operator client. */
const MAX_EVENTS = 500;
const STALE_HEARTBEAT_MS = 30_000;

export class ControlPlane {
  private readonly registry: ProjectRegistry;
  private readonly graph: WorkGraph;
  private readonly store: EventStoreBackend;
  private readonly memoryStatus: { openviking: boolean; blackhole: boolean };

  constructor(inputs: ControlPlaneInputs) {
    this.registry = inputs.registry;
    this.graph = inputs.graph;
    this.store = inputs.store;
    this.memoryStatus = inputs.memoryStatus ?? { openviking: true, blackhole: true };
  }

  snapshot(): ControlPlaneSnapshot {
    const events = this.store
      .all()
      .slice(-MAX_EVENTS)
      .map((e) => ({
        eventId: e.event_id,
        type: e.type,
        projectId: e.project_id,
        runId: e.run_id,
        workerId: e.worker_id,
        timestamp: e.timestamp,
        payload: e.payload,
      }));

    const activeRuns = this.graph.listRuns().filter((r) => !["COMPLETED", "FAILED", "CANCELLED"].includes(r.status));
    const activeWorkers = this.graph
      .listWorkers()
      .filter((w) => ["IDLE", "BOOTSTRAPPING", "RUNNING", "WAITING", "RECOVERING"].includes(w.status));
    const stale = this.graph.staleWorkers(STALE_HEARTBEAT_MS);

    return {
      generatedAt: new Date().toISOString(),
      workspace: this.registry.getWorkspace(),
      projects: this.registry.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        canonicalRemote: p.canonicalRemote,
        riskClass: p.riskClass,
        multiRepo: p.multiRepo,
        repositories: this.registry
          .listRepositories(p.id)
          .map((r) => ({ id: r.id, root: r.root, remote: r.remote, worktrees: r.worktreeRoots })),
      })),
      runs: this.graph.listRuns().map((r) => ({
        id: r.id,
        projectId: r.projectId,
        workItemId: r.workItemId,
        goal: r.goal,
        status: r.status,
        parentRunId: r.parentRunId,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        approval: r.approval,
      })),
      workers: this.graph.listWorkers().map((w) => ({
        id: w.id,
        runId: w.runId,
        projectId: w.projectId,
        role: w.role,
        status: w.status,
        model: w.model,
        worktree: w.worktree,
        location: w.location,
        heartbeatAt: w.heartbeat_at,
        generation: w.generation,
      })),
      events,
      health: {
        projects: this.registry.listProjects().length,
        activeRuns: activeRuns.length,
        activeWorkers: activeWorkers.length,
        staleWorkers: stale.length,
        memory: { ...this.memoryStatus },
      },
    };
  }
}
