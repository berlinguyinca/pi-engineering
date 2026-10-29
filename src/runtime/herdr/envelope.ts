/**
 * Event envelope v2 — the single canonical wire envelope Pi emits to the Herdr
 * control plane (contract: herdr `docs/contracts/event-envelope-v2.md`).
 *
 * This is a CONSOLIDATION at the contract edge: the ledger, platform, lifecycle
 * telemetry and inspector stores keep their own shapes; the adapters in
 * `envelopeAdapters.ts` map them onto the one envelope built here.
 *
 * Emitter rules enforced here:
 *  - schema_version is 2;
 *  - event_id is stable (the caller supplies it, or it is generated once and
 *    then persisted by the outbox, so a retry reuses it);
 *  - source_sequence is assigned by the caller at emit time (see
 *    SourceSequence) and persisted with the event;
 *  - `actor` and `received_at` are SERVER-owned and never emitted;
 *  - visibility_scope defaults to the narrowest value, `private`;
 *  - lineage (correlation_id / causation_id) is copied only from explicit data.
 */

import { randomUUID } from "node:crypto";

export const ENVELOPE_SCHEMA_VERSION = 2 as const;

export type VisibilityScope = "private" | "mission" | "room" | "org";
export const VISIBILITY_SCOPES: readonly VisibilityScope[] = ["private", "mission", "room", "org"];

/** Existing v1 `source` rule: identifies the sequence domain. */
export const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface EvidenceRef {
  kind: string;
  uri: string;
  /** Binds the evidence to exact content. */
  digest?: string;
  /** Binds the evidence to an exact commit / plan revision. */
  revision?: string;
}

/** Optional scope ids. Never inferred from chat text; only copied from typed fields. */
export interface EnvelopeIds {
  org_id?: string;
  project_id?: string;
  room_id?: string;
  workspace_id?: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  /** The agent INSTANCE (a Pi process / worker); not the pane-link `instance_id`. */
  agent_instance_id?: string;
}

/** Everything an emitter knows about an event before it is stamped with a sequence. */
export interface EnvelopeDraft extends EnvelopeIds {
  /** Stable id. Omit to have one generated (then persisted by the outbox for retries). */
  event_id?: string;
  occurred_at: string | Date;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
  /** event_id of the event that caused this one; explicit only. */
  causation_id?: string;
  visibility_scope?: VisibilityScope;
  evidence_refs?: EvidenceRef[];
  /**
   * True when `event_id` was derived from content by an adapter. The emitter then
   * appends a per-occurrence nonce so identical events stay distinct. Never sent.
   */
  event_id_derived?: boolean;
}

/** The wire envelope. Note the deliberate absence of `actor` and `received_at`. */
export interface EnvelopeV2 extends EnvelopeIds {
  schema_version: 2;
  event_id: string;
  source: string;
  source_sequence: number;
  occurred_at: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
  causation_id?: string;
  visibility_scope: VisibilityScope;
  evidence_refs: EvidenceRef[];
}

export interface BuildEnvelopeOptions {
  source: string;
  /** Allocated by SourceSequence at emit time. */
  sourceSequence: number;
  /** Fallback event id factory (tests). */
  newEventId?: () => string;
}

const ID_KEYS = [
  "org_id",
  "project_id",
  "room_id",
  "workspace_id",
  "mission_id",
  "task_id",
  "agent_id",
  "agent_instance_id",
] as const;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** RFC 3339 UTC, millisecond precision. Throws on an unparseable timestamp. */
export function toRfc3339Utc(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`envelope: invalid occurred_at ${String(value)}`);
  return d.toISOString();
}

/** Keep only well-formed evidence refs; anything else is dropped, never repaired. */
export function sanitizeEvidenceRefs(refs: unknown): EvidenceRef[] {
  if (!Array.isArray(refs)) return [];
  const out: EvidenceRef[] = [];
  for (const r of refs) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = nonEmpty(o.kind);
    const uri = nonEmpty(o.uri);
    if (!kind || !uri) continue;
    const ref: EvidenceRef = { kind, uri };
    const digest = nonEmpty(o.digest);
    const revision = nonEmpty(o.revision);
    if (digest) ref.digest = digest;
    if (revision) ref.revision = revision;
    out.push(ref);
  }
  return out;
}

/** Unknown / missing scope fails closed to `private`. */
export function normalizeVisibility(scope: unknown): VisibilityScope {
  return VISIBILITY_SCOPES.includes(scope as VisibilityScope) ? (scope as VisibilityScope) : "private";
}

/** Throws TypeError on an invalid source / sequence / timestamp. Pure otherwise. */
export function buildEnvelope(draft: EnvelopeDraft, opts: BuildEnvelopeOptions): EnvelopeV2 {
  if (!SOURCE_PATTERN.test(opts.source)) throw new TypeError(`envelope: invalid source "${opts.source}"`);
  if (!Number.isSafeInteger(opts.sourceSequence) || opts.sourceSequence < 0) {
    throw new TypeError(`envelope: invalid source_sequence ${opts.sourceSequence}`);
  }
  const env: EnvelopeV2 = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    event_id: nonEmpty(draft.event_id) ?? (opts.newEventId ?? randomUUID)(),
    source: opts.source,
    source_sequence: opts.sourceSequence,
    occurred_at: toRfc3339Utc(draft.occurred_at),
    entity_type: draft.entity_type,
    entity_id: draft.entity_id,
    event_type: draft.event_type,
    payload: draft.payload,
    visibility_scope: normalizeVisibility(draft.visibility_scope),
    evidence_refs: sanitizeEvidenceRefs(draft.evidence_refs),
  };
  for (const key of ID_KEYS) {
    const v = nonEmpty(draft[key]);
    if (v) env[key] = v;
  }
  const correlation = nonEmpty(draft.correlation_id);
  if (correlation) env.correlation_id = correlation;
  const causation = nonEmpty(draft.causation_id);
  if (causation) env.causation_id = causation;
  return env;
}
