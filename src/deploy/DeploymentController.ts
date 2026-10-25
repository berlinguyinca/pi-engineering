import { randomUUID } from "node:crypto";
import type { EventStoreBackend, StoredEvent } from "../platform/eventstore/backend.ts";

export interface DeploymentArtifact {
  version: string;
  commit: string;
  location: string;
}

export interface DeploymentAdapter {
  promote(next: DeploymentArtifact, rollback: DeploymentArtifact): Promise<void>;
  health(next: DeploymentArtifact): Promise<{ healthy: boolean; summary: string }>;
  rollback(previous: DeploymentArtifact): Promise<void>;
}

export type DeploymentResult =
  | { status: "verified"; version: string; commit: string }
  | { status: "rolled_back"; version: string; commit: string; reason: string }
  | { status: "rollback_failed"; version: string; commit: string; reason: string };

export interface DeploymentControllerOptions {
  events: EventStoreBackend;
  adapter: DeploymentAdapter;
  now?: () => string;
  id?: () => string;
}

export class DeploymentController {
  private readonly events: EventStoreBackend;
  private readonly adapter: DeploymentAdapter;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(options: DeploymentControllerOptions) {
    this.events = options.events;
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
  }

  async deploy(next: DeploymentArtifact, rollback: DeploymentArtifact | null): Promise<DeploymentResult> {
    if (!rollback) throw new Error("deployment requires a rollback target");
    if (!next.version || !next.commit || !next.location) throw new Error("deployment artifact identity is incomplete");
    if (next.version === rollback.version || next.commit === rollback.commit) {
      throw new Error("deployment artifact must differ from rollback target");
    }
    await this.append("deployment.started", next, { rollback_version: rollback.version });
    await this.adapter.promote(next, rollback);
    const health = await this.adapter.health(next);
    if (health.healthy) {
      await this.append("deployment.verified", next, { summary: health.summary, rollback_version: rollback.version });
      return { status: "verified", version: next.version, commit: next.commit };
    }
    try {
      await this.adapter.rollback(rollback);
      await this.append("deployment.rolled_back", next, {
        reason: health.summary,
        rollback_version: rollback.version,
      });
      return { status: "rolled_back", version: next.version, commit: next.commit, reason: health.summary };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.append("deployment.rollback_failed", next, {
        reason,
        health_summary: health.summary,
        rollback_version: rollback.version,
      });
      return { status: "rollback_failed", version: next.version, commit: next.commit, reason };
    }
  }

  private async append(type: string, artifact: DeploymentArtifact, detail: Record<string, unknown>): Promise<StoredEvent> {
    return this.events.append({
      event_id: this.id(),
      timestamp: this.now(),
      type,
      project_id: null,
      run_id: null,
      worker_id: null,
      payload: { version: artifact.version, commit: artifact.commit, location: artifact.location, ...detail },
    });
  }
}
