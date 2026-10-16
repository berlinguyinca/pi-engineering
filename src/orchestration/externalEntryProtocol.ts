/**
 * Hand-written validation of an autospec shared-protocol envelope
 * (`autospec.protocol.<entity>.v<N>`). Mirrors the envelope schema in
 * test/fixtures/autospec-protocol/schemas/autospec-protocol-envelope.v1.schema.json
 * using the keyword subset documented in test/fixtures/autospec-protocol/schemas/,
 * so a Rust reader and a TypeScript reader behave identically.
 *
 * This module validates only the envelope fields (schema, protocol_version,
 * idempotency_key, mission_id, sequence, required_extensions, extensions). It
 * does not validate per-entity payload fields, nor does it enforce stream
 * invariants (sequence gaps, idempotency reuse) — those live in the consumer.
 */

/** The only protocol major version this reader understands. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * The envelope every autospec shared-protocol message carries. Entity schemas
 * reuse these field definitions; see autospec-protocol-envelope.v1.schema.json.
 */
export interface Envelope {
  /** Entity schema identifier, of the form autospec.protocol.<entity>.v<N>. */
  schema: string;
  /** Protocol major version this message was produced under. */
  protocol_version: number;
  /** Producer-chosen key, unique within one mission_id. */
  idempotency_key: string;
  /** Identifier of the mission whose ordered stream this message belongs to. */
  mission_id: string;
  /** Monotonic position in the mission stream, starting at 1. */
  sequence: number;
  /** Extension keys the reader must understand; empty array means none. */
  required_extensions: string[];
  /** Optional extension data; keys not in required_extensions are ignored. */
  extensions?: Record<string, unknown>;
}

export type EnvelopeValidationResult =
  | { ok: true; envelope: Envelope }
  | {
      ok: false;
      code: "PROTOCOL_VERSION_UNSUPPORTED" | "SCHEMA_VIOLATION" | "MISSING_FIELD" | "INVALID_FIELD";
      message: string;
    };

const ENVELOPE_FIELDS = [
  "schema",
  "protocol_version",
  "idempotency_key",
  "mission_id",
  "sequence",
  "required_extensions",
] as const;

/** Structural form of an entity schema identifier, e.g. autospec.protocol.event.v1. */
const SCHEMA_FORM = /^autospec\.protocol\.[a-z-]+\.v1$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an external autospec-protocol envelope. Fails closed:
 * - non-object input is rejected as INVALID_FIELD;
 * - an unsupported protocol_version is rejected before any field checks;
 * - any required envelope field that is absent yields MISSING_FIELD;
 * - an entity schema identifier that is not of the form
 *   autospec.protocol.<entity>.v<N> yields SCHEMA_VIOLATION;
 * - a present field with an invalid type or value yields INVALID_FIELD.
 */
export function validateEnvelope(obj: unknown): EnvelopeValidationResult {
  if (!isRecord(obj)) {
    return { ok: false, code: "INVALID_FIELD", message: "envelope must be an object" };
  }

  const { protocol_version, schema, idempotency_key, mission_id, sequence, required_extensions } = obj;

  // Version negotiation fails closed before any other envelope check. A missing
  // protocol_version is a MISSING_FIELD; a present but non-integer value is an
  // INVALID_FIELD; an integer other than 1 is PROTOCOL_VERSION_UNSUPPORTED.
  if (protocol_version === undefined) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: 'required envelope field "protocol_version" is missing',
    };
  }
  if (typeof protocol_version !== "number" || !Number.isInteger(protocol_version)) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      message: `protocol_version must be an integer, got ${String(protocol_version)}`,
    };
  }
  if (protocol_version !== SUPPORTED_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      message: `protocol_version ${String(protocol_version)} is not supported (only ${SUPPORTED_PROTOCOL_VERSION})`,
    };
  }

  // Every required envelope field must be present.
  for (const field of ENVELOPE_FIELDS) {
    if (obj[field] === undefined) {
      return { ok: false, code: "MISSING_FIELD", message: `required envelope field "${field}" is missing` };
    }
  }

  if (typeof schema !== "string" || !SCHEMA_FORM.test(schema)) {
    return {
      ok: false,
      code: "SCHEMA_VIOLATION",
      message: `schema must be of the form autospec.protocol.<entity>.v<N>, got ${JSON.stringify(schema)}`,
    };
  }

  if (typeof idempotency_key !== "string" || idempotency_key.length === 0) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      message: "idempotency_key must be a non-empty string",
    };
  }

  if (typeof mission_id !== "string" || mission_id.length === 0) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      message: "mission_id must be a non-empty string",
    };
  }

  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      message: "sequence must be an integer greater than or equal to 1",
    };
  }

  if (!Array.isArray(required_extensions)) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      message: "required_extensions must be an array of strings",
    };
  }
  for (const item of required_extensions) {
    if (typeof item !== "string") {
      return {
        ok: false,
        code: "INVALID_FIELD",
        message: "required_extensions must contain only strings",
      };
    }
  }

  const envelope: Envelope = {
    schema,
    protocol_version: protocol_version as number,
    idempotency_key,
    mission_id,
    sequence: sequence as number,
    required_extensions: required_extensions as string[],
  };
  if (obj.extensions !== undefined) {
    if (!isRecord(obj.extensions)) {
      return { ok: false, code: "INVALID_FIELD", message: "extensions must be an object" };
    }
    envelope.extensions = obj.extensions as Record<string, unknown>;
  }

  return { ok: true, envelope };
}
