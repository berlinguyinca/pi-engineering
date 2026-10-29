/**
 * Typed handoff kinds and their lifecycle records (spec: typed handoffs).
 *
 * A handoff is the durable record of control passing from one session/generation
 * to the next within a mission. Every handoff has one of the fixed kinds below
 * and moves through the fixed state machine prepared → validated → acknowledged
 * → committed, with `aborted` reachable from any non-committed state. Records are
 * pure data: this module only types and validates them — no I/O, no storage.
 */

/** The complete set of typed handoff kinds (spec: 10 typed handoffs). */
export const HANDOFF_KINDS = [
  "context",
  "delegation",
  "supervisor",
  "review",
  "review_fix",
  "pr",
  "merge",
  "deployment",
  "recovery",
  "phase_transition",
] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** The lifecycle states a handoff record can be in. */
export const HANDOFF_STATES = ["prepared", "validated", "acknowledged", "committed", "aborted"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** A session pointer identifying where control came from / goes to. */
export interface HandoffEndpoint {
  sessionId: string;
  generation: number;
}

/** The durable, typed record of one handoff. */
export interface HandoffRecord {
  id: string;
  kind: HandoffKind;
  state: HandoffState;
  missionId: string;
  predecessor: HandoffEndpoint;
  successor?: HandoffEndpoint;
  /** Git commit SHA of the checkpoint handed over, when one exists. */
  checkpointSha?: string;
  /** ISO timestamp of acknowledgement; required once acknowledged/committed. */
  ackAt?: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp at which the checkpoint passed verification (hashes, commit, required fields). */
  verifiedAt?: string;
  /** ISO timestamp at which the source's lease/process was fenced; only ever set after `verifiedAt`. */
  sourceFencedAt?: string;
}

const CHECKPOINT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

const REQUIRED_ACK_STATES: ReadonlySet<HandoffState> = new Set(["acknowledged", "committed"]);

/** Next allowed states from each state; aborted is reachable from every non-committed state. */
export function nextStates(state: HandoffState): HandoffState[] {
  switch (state) {
    case "prepared":
      return ["validated", "aborted"];
    case "validated":
      return ["acknowledged", "aborted"];
    case "acknowledged":
      return ["committed", "aborted"];
    case "committed":
      return [];
    case "aborted":
      return [];
    default:
      return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isEndpoint(value: unknown): value is HandoffEndpoint {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.sessionId) && Number.isInteger(value.generation) && Number(value.generation) >= 0;
}

/**
 * Validate an unknown value as a `HandoffRecord`. Returns the record when valid,
 * otherwise the list of human-readable errors. Every field is type-checked; kind
 * and state must belong to the fixed tuples; `successor` and `ackAt` are required
 * for acknowledged/committed states; an optional `checkpointSha` must be a
 * 7–64 hex-char SHA.
 */
export function validateHandoffRecord(
  obj: unknown,
): { ok: true; record: HandoffRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(obj)) {
    return { ok: false, errors: ["handoff must be an object"] };
  }

  if (!isNonEmptyString(obj.id)) errors.push("id must be a non-empty string");

  const kind = obj.kind;
  if (!isNonEmptyString(kind)) {
    errors.push("kind must be a non-empty string");
  } else if (!(HANDOFF_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind must be one of ${HANDOFF_KINDS.join(", ")}`);
  }

  const state = obj.state;
  if (!isNonEmptyString(state)) {
    errors.push("state must be a non-empty string");
  } else if (!(HANDOFF_STATES as readonly string[]).includes(state)) {
    errors.push(`state must be one of ${HANDOFF_STATES.join(", ")}`);
  }

  if (!isNonEmptyString(obj.missionId)) errors.push("missionId must be a non-empty string");
  if (!isEndpoint(obj.predecessor)) errors.push("predecessor must be { sessionId: string, generation: number }");

  if (obj.successor !== undefined && !isEndpoint(obj.successor)) {
    errors.push("successor must be { sessionId: string, generation: number }");
  }

  if (obj.checkpointSha !== undefined) {
    if (typeof obj.checkpointSha !== "string" || !CHECKPOINT_SHA_PATTERN.test(obj.checkpointSha)) {
      errors.push("checkpointSha must match /^[0-9a-f]{7,64}$/ when present");
    }
  }

  if (obj.ackAt !== undefined && !isIsoTimestamp(obj.ackAt)) {
    errors.push("ackAt must be an ISO-8601 timestamp when present");
  }

  if (!isIsoTimestamp(obj.createdAt)) errors.push("createdAt must be an ISO-8601 timestamp");
  if (obj.verifiedAt !== undefined && !isIsoTimestamp(obj.verifiedAt)) {
    errors.push("verifiedAt must be an ISO-8601 timestamp when present");
  }
  if (obj.sourceFencedAt !== undefined && !isIsoTimestamp(obj.sourceFencedAt)) {
    errors.push("sourceFencedAt must be an ISO-8601 timestamp when present");
  }
  if (obj.sourceFencedAt !== undefined && obj.verifiedAt === undefined) {
    errors.push("sourceFencedAt requires verifiedAt (verify before revoke)");
  }

  if (typeof state === "string" && REQUIRED_ACK_STATES.has(state as HandoffState)) {
    if (obj.successor === undefined) errors.push(`successor is required for state ${state}`);
    if (obj.ackAt === undefined) errors.push(`ackAt is required for state ${state}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Build a fresh copy containing only the declared HandoffRecord fields so that
  // unknown extra fields are dropped and later mutation of the input cannot
  // affect the returned record.
  const record: HandoffRecord = {
    id: obj.id as string,
    kind: obj.kind as HandoffKind,
    state: obj.state as HandoffState,
    missionId: obj.missionId as string,
    predecessor: obj.predecessor as HandoffEndpoint,
    createdAt: obj.createdAt as string,
  };
  if (obj.successor !== undefined) record.successor = obj.successor as HandoffEndpoint;
  if (obj.checkpointSha !== undefined) record.checkpointSha = obj.checkpointSha as string;
  if (obj.ackAt !== undefined) record.ackAt = obj.ackAt as string;
  if (obj.verifiedAt !== undefined) record.verifiedAt = obj.verifiedAt as string;
  if (obj.sourceFencedAt !== undefined) record.sourceFencedAt = obj.sourceFencedAt as string;
  return { ok: true, record };
}
