/**
 * Runtime validator for the slice of the AutoSpec shared protocol that DAG
 * ingestion uses: `autospec.protocol.mission.v1` and `autospec.protocol.task.v1`.
 *
 * The schemas live in the optional AutoSpec repo and are not available at
 * runtime, so this is a hand-written mirror of the fields used (copied from
 * schemas/autospec-protocol-{mission,task}.v1.schema.json; see
 * test/fixtures/autospec-dag/README.md for the source sha). The envelope part is
 * delegated to the existing reader (externalEntryProtocol.ts) so both readers
 * share one set of error codes with the Rust side.
 *
 * Fails closed: unknown top-level or nested keys (schemas are
 * additionalProperties:false), wrong types and unknown enum values are errors.
 * Pure: no I/O.
 */

import { type Envelope, validateEnvelope } from "../../orchestration/externalEntryProtocol.ts";

export type ProtocolErrorCode =
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "SCHEMA_VIOLATION"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "UNKNOWN_REQUIRED_FIELD"
  | "UNKNOWN_FIELD";

export class ProtocolRejection extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const MISSION_STATES = [
  "CREATED",
  "PLANNED",
  "READY",
  "RUNNING",
  "VALIDATING",
  "REVIEWING",
  "REPAIRING",
  "MERGE_QUEUED",
  "MERGING",
  "MERGED",
  "FINALIZING",
  "ARCHIVED",
  "BLOCKED",
  "PAUSED",
  "FAILED",
  "CANCELLED",
  "RECOVERING",
  "RETAINED_FOR_DIAGNOSTICS",
] as const;

export const TASK_STATES = [
  "DEFINED",
  "BLOCKED",
  "READY",
  "LEASED",
  "RUNNING",
  "AWAITING_TEST",
  "AWAITING_REVIEW",
  "CHANGES_REQUESTED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "SUPERSEDED",
  "VERIFIED",
] as const;

export interface SurfaceRef {
  path: string;
  symbols?: string[];
}

export interface ProtocolMission extends Envelope {
  state: (typeof MISSION_STATES)[number];
  authority: "pi-engineering";
  generation: number;
}

export interface ProtocolTask extends Envelope {
  task_id: string;
  depends_on: string[];
  state: (typeof TASK_STATES)[number];
  executor: "pi-local" | "autospec-managed";
  affected_surfaces: SurfaceRef[];
  exclusivity?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function envelope(raw: unknown, schema: string): Envelope & Record<string, unknown> {
  const env = validateEnvelope(raw);
  if (!env.ok) throw new ProtocolRejection(env.code, env.message);
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== schema) {
    throw new ProtocolRejection("SCHEMA_VIOLATION", `expected schema ${schema}, got ${String(rec.schema)}`);
  }
  return { ...env.envelope, ...rec } as Envelope & Record<string, unknown>;
}

function onlyKeys(rec: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) throw new ProtocolRejection("UNKNOWN_FIELD", `${where}: unknown field "${k}"`);
  }
}

const ENVELOPE_KEYS = [
  "schema",
  "protocol_version",
  "idempotency_key",
  "mission_id",
  "sequence",
  "required_extensions",
  "extensions",
] as const;

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new ProtocolRejection("INVALID_FIELD", `${where} must be a string`);
  return v;
};

export function parseMission(raw: unknown): ProtocolMission {
  const rec = envelope(raw, "autospec.protocol.mission.v1");
  onlyKeys(rec, [...ENVELOPE_KEYS, "state", "authority", "generation", "last_transition"], "mission");
  for (const f of ["state", "authority", "generation", "last_transition"]) {
    if (rec[f] === undefined) throw new ProtocolRejection("MISSING_FIELD", `mission: "${f}" is missing`);
  }
  if (!(MISSION_STATES as readonly string[]).includes(str(rec.state, "mission.state"))) {
    throw new ProtocolRejection("INVALID_FIELD", `mission.state "${String(rec.state)}" is not a known state`);
  }
  if (rec.authority !== "pi-engineering") {
    throw new ProtocolRejection("INVALID_FIELD", 'mission.authority must be "pi-engineering"');
  }
  if (typeof rec.generation !== "number" || !Number.isInteger(rec.generation) || rec.generation < 1) {
    throw new ProtocolRejection("INVALID_FIELD", "mission.generation must be an integer >= 1");
  }
  if (!isRecord(rec.last_transition)) {
    throw new ProtocolRejection("INVALID_FIELD", "mission.last_transition must be an object");
  }
  for (const f of ["to", "reason", "at", "owner"]) {
    if (rec.last_transition[f] === undefined) {
      throw new ProtocolRejection("MISSING_FIELD", `mission.last_transition: "${f}" is missing`);
    }
  }
  return rec as unknown as ProtocolMission;
}

export function parseTask(raw: unknown): ProtocolTask {
  const rec = envelope(raw, "autospec.protocol.task.v1");
  onlyKeys(
    rec,
    [...ENVELOPE_KEYS, "task_id", "depends_on", "state", "executor", "affected_surfaces", "exclusivity"],
    "task",
  );
  for (const f of ["task_id", "depends_on", "state", "executor", "affected_surfaces"]) {
    if (rec[f] === undefined) throw new ProtocolRejection("MISSING_FIELD", `task: "${f}" is missing`);
  }
  const id = str(rec.task_id, "task.task_id");
  if (!id) throw new ProtocolRejection("INVALID_FIELD", "task.task_id must be non-empty");
  if (!Array.isArray(rec.depends_on) || rec.depends_on.some((d) => typeof d !== "string" || !d)) {
    throw new ProtocolRejection("INVALID_FIELD", `task ${id}: depends_on must be an array of non-empty strings`);
  }
  if (!(TASK_STATES as readonly string[]).includes(str(rec.state, "task.state"))) {
    throw new ProtocolRejection("INVALID_FIELD", `task ${id}: state "${String(rec.state)}" is not a known state`);
  }
  if (rec.executor !== "pi-local" && rec.executor !== "autospec-managed") {
    throw new ProtocolRejection("INVALID_FIELD", `task ${id}: executor must be pi-local or autospec-managed`);
  }
  if (!Array.isArray(rec.affected_surfaces)) {
    throw new ProtocolRejection("INVALID_FIELD", `task ${id}: affected_surfaces must be an array`);
  }
  for (const s of rec.affected_surfaces) {
    if (!isRecord(s))
      throw new ProtocolRejection("INVALID_FIELD", `task ${id}: affected_surfaces item must be an object`);
    onlyKeys(s, ["path", "symbols"], `task ${id} surface`);
    if (typeof s.path !== "string") throw new ProtocolRejection("MISSING_FIELD", `task ${id}: surface.path is missing`);
    if (s.symbols !== undefined && (!Array.isArray(s.symbols) || s.symbols.some((x) => typeof x !== "string"))) {
      throw new ProtocolRejection("INVALID_FIELD", `task ${id}: surface.symbols must be an array of strings`);
    }
  }
  if (rec.exclusivity !== undefined && typeof rec.exclusivity !== "string") {
    throw new ProtocolRejection("INVALID_FIELD", `task ${id}: exclusivity must be a string`);
  }
  return rec as unknown as ProtocolTask;
}
