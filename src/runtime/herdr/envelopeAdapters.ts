/**
 * Pure adapters: existing Pi event shapes -> {@link EnvelopeDraft}.
 *
 * These do not touch the stores that produce the events; they only map at the
 * contract edge. Rules shared by all adapters:
 *  - lineage / scope ids are copied ONLY from explicit typed fields or explicit
 *    payload keys (`mission_id`, `task_id`, `agent_id`, `causation_id`, ...);
 *    nothing is parsed out of free text and nothing is guessed;
 *  - a client-side actor is never put in the trusted `actor` slot (the server
 *    owns it); it is preserved in the payload as `claimed_actor`;
 *  - visibility is left unset so buildEnvelope applies the `private` default.
 */

import { createHash } from "node:crypto";

import type { LedgerEvent } from "../../core/types.ts";
import type { TelemetryEvent } from "../../lifecycle/telemetry.ts";
import type { PlatformEvent } from "../../platform/types.ts";
import type { InspectorEvent } from "./InspectorFeed.ts";
import { type EnvelopeDraft, type EnvelopeIds, sanitizeEvidenceRefs } from "./envelope.ts";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Deterministic id for events that carry none: same content => same id. */
export function deterministicEventId(prefix: string, parts: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

/**
 * Explicit string-valued scope ids from a payload; nothing else is consulted.
 *
 * Only the fixed whitelist below is ever copied, and only from typed payload
 * keys (never parsed out of text). These values are emitter CLAIMS: the server
 * must validate them against the principal's grants before trusting scope.
 */
export function scopeIdsFromPayload(payload: Record<string, unknown>): EnvelopeIds {
  const out: EnvelopeIds = {};
  for (const key of ["org_id", "project_id", "room_id", "workspace_id", "mission_id", "task_id", "agent_id"] as const) {
    const v = str(payload[key]);
    if (v) out[key] = v;
  }
  return out;
}

function lineageFromPayload(payload: Record<string, unknown>): Pick<EnvelopeDraft, "correlation_id" | "causation_id"> {
  const out: Pick<EnvelopeDraft, "correlation_id" | "causation_id"> = {};
  const correlation = str(payload.correlation_id);
  const causation = str(payload.causation_id);
  if (correlation) out.correlation_id = correlation;
  if (causation) out.causation_id = causation;
  return out;
}

export function ledgerEventToDraft(event: LedgerEvent): EnvelopeDraft {
  const payload = { ...event.payload, claimed_actor: event.actor, work_item_id: event.work_item_id };
  return {
    event_id: event.event_id,
    occurred_at: event.timestamp,
    entity_type: "ledger",
    entity_id: event.work_item_id ?? event.event_id,
    event_type: event.type,
    payload,
    ...scopeIdsFromPayload(event.payload),
    ...lineageFromPayload(event.payload),
    evidence_refs: sanitizeEvidenceRefs(event.payload.evidence_refs),
  };
}

export function platformEventToDraft(event: PlatformEvent): EnvelopeDraft {
  const payload = {
    ...event.payload,
    claimed_actor: { type: event.actor },
    run_id: event.run_id,
    worker_id: event.worker_id,
  };
  const draft: EnvelopeDraft = {
    event_id: event.event_id,
    occurred_at: event.timestamp,
    entity_type: "platform",
    entity_id: event.run_id ?? event.worker_id ?? event.project_id ?? event.event_id,
    event_type: event.type,
    payload,
    ...scopeIdsFromPayload(event.payload),
    ...lineageFromPayload(event.payload),
    evidence_refs: sanitizeEvidenceRefs(event.payload.evidence_refs),
  };
  // Typed top-level fields win over anything in the payload.
  if (event.project_id) draft.project_id = event.project_id;
  if (event.worker_id) draft.agent_id = event.worker_id;
  return draft;
}

export function telemetryEventToDraft(event: TelemetryEvent, eventId?: string): EnvelopeDraft {
  const payload: Record<string, unknown> = { ...event.attributes };
  if (event.runId) payload.run_id = event.runId;
  if (event.sessionKey) payload.session_key = event.sessionKey;
  const draft: EnvelopeDraft = {
    event_id: eventId ?? deterministicEventId("tel", event),
    ...(eventId ? {} : { event_id_derived: true }),
    occurred_at: event.at,
    entity_type: "lifecycle",
    entity_id: event.runId ?? event.sessionKey ?? event.name,
    event_type: event.name,
    payload,
    ...scopeIdsFromPayload(payload),
    ...lineageFromPayload(payload),
  };
  if (event.correlation) draft.correlation_id = event.correlation;
  return draft;
}

export interface InspectorDraftContext {
  /** The `session` entity id the feed reports under. */
  sessionId: string;
  /** Mission from an explicit association; never inferred. */
  missionId?: string;
  /** Timestamp used when the event has no `ts`. */
  now?: () => Date;
}

export function inspectorEventToDraft(event: InspectorEvent, ctx: InspectorDraftContext): EnvelopeDraft {
  // `parent_agent_id` is explicit lineage DATA about agents, not an event id, so
  // it stays in the payload; causation_id is only set when the event names one.
  const payload: Record<string, unknown> = { ...event };
  const draft: EnvelopeDraft = {
    event_id: str(event.event_id) ?? deterministicEventId("insp", [ctx.sessionId, event]),
    ...(str(event.event_id) ? {} : { event_id_derived: true }),
    occurred_at: str(event.ts) ?? (ctx.now ?? (() => new Date()))(),
    entity_type: "inspector",
    entity_id: ctx.sessionId,
    event_type: `inspector.${event.kind}`,
    payload,
    ...lineageFromPayload(payload),
  };
  const agent = str(event.agent_id);
  if (agent) draft.agent_id = agent;
  if (ctx.missionId) draft.mission_id = ctx.missionId;
  // Sensitive inspector data must not be widened by default.
  draft.visibility_scope = "private";
  return draft;
}
