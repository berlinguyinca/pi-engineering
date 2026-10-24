import { randomUUID } from "node:crypto";
import type { StoredEvent, EventStoreBackend } from "../platform/eventstore/backend.ts";
import { incidentFingerprint, toIncidentEventPayload } from "./fingerprint.ts";
import type { AgentFailureIncident } from "./types.ts";

export type PublishedIncident = ReturnType<typeof toIncidentEventPayload>;
export type IncidentPublish = (event: PublishedIncident) => Promise<void>;
export type IncidentState = "persisted" | "duplicate" | "publish_failed";

export interface IncidentDecision {
  incidentId: string;
  fingerprint: string;
  duplicate: boolean;
  state: IncidentState;
  eventId: string;
  publishAttempted: boolean;
  publishError?: string;
}

export interface IncidentControllerOptions {
  backend: EventStoreBackend;
  publish: IncidentPublish;
  now?: () => Date;
  id?: () => string;
}

function existingByFingerprint(backend: EventStoreBackend, fingerprint: string): StoredEvent | undefined {
  return backend.all().find(
    (event) => event.type === "incident.detected" && event.payload.fingerprint === fingerprint,
  );
}

export class IncidentController {
  private readonly backend: EventStoreBackend;
  private readonly publish: IncidentPublish;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(options: IncidentControllerOptions) {
    this.backend = options.backend;
    this.publish = options.publish;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async recordFailure(incident: AgentFailureIncident): Promise<IncidentDecision> {
    const payload = toIncidentEventPayload(incident);
    const fingerprint = incidentFingerprint(incident);
    const event: StoredEvent = {
      event_id: this.id(),
      timestamp: this.now().toISOString(),
      type: "incident.detected",
      project_id: incident.repo,
      run_id: incident.run_id,
      worker_id: null,
      payload,
    };
    const committed = await this.backend.appendConditionally(
      event,
      () => existingByFingerprint(this.backend, fingerprint) === undefined,
    );
    if (committed === undefined) {
      const existing = existingByFingerprint(this.backend, fingerprint);
      if (!existing) throw new Error(`incident deduplication lost event ${fingerprint}`);
      return {
        incidentId: String(existing.payload.incident_id),
        fingerprint,
        duplicate: true,
        state: "duplicate",
        eventId: existing.event_id,
        publishAttempted: false,
      };
    }

    try {
      await this.publish(payload);
      return {
        incidentId: incident.incident_id,
        fingerprint,
        duplicate: false,
        state: "persisted",
        eventId: committed.event_id,
        publishAttempted: true,
      };
    } catch (error) {
      return {
        incidentId: incident.incident_id,
        fingerprint,
        duplicate: false,
        state: "publish_failed",
        eventId: committed.event_id,
        publishAttempted: true,
        publishError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
