/**
 * `server.live_handoff` — cross-process handoff over the Herdr socket API
 * (spec Unit D1, issue #351; herdr 0.9.1, protocol 22).
 *
 * `server.live_handoff` is a Herdr server RPC that has NO CLI subcommand
 * (the `herdr server` CLI exposes only stop / reload-config / agent-manifests),
 * so the pi side speaks the unix socket directly: newline-delimited JSON
 * requests `{"id", "method", "params"}` answered by a single
 * `{"id", "result"}` or `{"id", "error": {code, message}}` line.
 *
 * The RPC body is fixed by Herdr's schema (`ServerLiveHandoffParams`:
 * `expected_protocol` / `expected_version` / `import_exe` — the live handoff
 * of the server itself under a protocol/version expectation), so a
 * `HandoffArtifact` plus checkpoint refs crosses the process boundary via a
 * durable, validated, size-bounded payload (this module's
 * serialize/deserialize) that the successor process reads back. Availability
 * is gated by the server-declared `capabilities.live_handoff` flag returned by
 * `ping` — never assume the capability without probing.
 *
 * The payload layer is pure (no I/O); the socket layer is the only I/O in
 * this module and its transport is injectable for tests.
 */

import { connect } from "node:net";
import type { HandoffCheckpointRefs } from "../host/handoffCheckpointRefs.ts";
import { HANDOFF_KINDS } from "../host/handoffKinds.ts";
import { HerdrError } from "./HerdrCli.ts";

/** The Herdr socket API method for the live handoff. */
export const LIVE_HANDOFF_METHOD = "server.live_handoff";

/** Payload schema version carried in every serialized payload. */
export const LIVE_HANDOFF_PAYLOAD_VERSION = 1;

/**
 * Size caps a deserialized payload must respect. These MUST stay equal to the
 * clip bounds in plannerWorker/handoff.ts (`MAX_SUMMARY_CHARS` /
 * `MAX_DIFF_CHARS`) — payloads are produced by `buildHandoff`, which clips to
 * exactly these values, so a payload over them is malformed.
 */
export const PAYLOAD_MAX_SUMMARY_CHARS = 1_500;
export const PAYLOAD_MAX_DIFF_CHARS = 24_000;

/** Default per-call socket timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ── RPC params (herdr schema $defs/ServerLiveHandoffParams) ─────────────────

/**
 * Wire params for `server.live_handoff`, exactly as declared in herdr 0.9.1's
 * API schema: every field is nullable; omitted fields are sent as absent.
 */
export interface LiveHandoffParams {
  expected_protocol?: number | null;
  expected_version?: string | null;
  import_exe?: string | null;
}

/**
 * Build the sparse wire params object from typed input: null/undefined fields
 * are omitted (the schema treats absent and null identically, but sparse is
 * the documented request shape).
 */
export function buildLiveHandoffParams(params: LiveHandoffParams = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.expected_protocol !== undefined && params.expected_protocol !== null) {
    out.expected_protocol = params.expected_protocol;
  }
  if (params.expected_version !== undefined && params.expected_version !== null) {
    out.expected_version = params.expected_version;
  }
  if (params.import_exe !== undefined && params.import_exe !== null) {
    out.import_exe = params.import_exe;
  }
  return out;
}

/**
 * Validate an unknown value as `ServerLiveHandoffParams`. Returns the typed
 * params when valid, otherwise the field-level errors.
 */
export function validateLiveHandoffParams(
  value: unknown,
): { ok: true; params: LiveHandoffParams } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["params must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  const params: LiveHandoffParams = {};
  for (const key of Object.keys(obj)) {
    if (key !== "expected_protocol" && key !== "expected_version" && key !== "import_exe") {
      errors.push(`unknown param ${key}`);
    }
  }
  if (obj.expected_protocol !== undefined && obj.expected_protocol !== null) {
    if (
      typeof obj.expected_protocol !== "number" ||
      !Number.isInteger(obj.expected_protocol) ||
      obj.expected_protocol < 0
    ) {
      errors.push("expected_protocol must be a non-negative integer");
    } else {
      params.expected_protocol = obj.expected_protocol;
    }
  }
  if (obj.expected_version !== undefined && obj.expected_version !== null) {
    if (typeof obj.expected_version !== "string" || obj.expected_version.length === 0) {
      errors.push("expected_version must be a non-empty string");
    } else {
      params.expected_version = obj.expected_version;
    }
  }
  if (obj.import_exe !== undefined && obj.import_exe !== null) {
    if (typeof obj.import_exe !== "string" || obj.import_exe.length === 0) {
      errors.push("import_exe must be a non-empty string");
    } else {
      params.import_exe = obj.import_exe;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params };
}

// ── socket transport (NDJSON over the herdr unix socket) ────────────────────

/** Options for talking to the Herdr socket directly. */
export interface HerdrSocketOptions {
  /** Path of the herdr unix socket (default ~/.config/herdr/herdr.sock when absent). */
  socketPath?: string;
  /** Per-call timeout. Default 30s. */
  timeoutMs?: number;
  /**
   * Injectable transport for tests: receives the single request line and
   * returns the single response line. When absent, the real unix socket is
   * used.
   */
  send?: (requestLine: string) => Promise<string> | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function herdrErrorFrom(response: Record<string, unknown>): HerdrError {
  const error = isRecord(response.error) ? response.error : {};
  const code = typeof error.code === "string" && error.code.length > 0 ? error.code : "herdr_error";
  const message = typeof error.message === "string" ? error.message : JSON.stringify(response);
  return new HerdrError(code, message);
}

/**
 * Call one Herdr socket API method with NDJSON framing. Resolves with the
 * `result` payload; throws a normalized `HerdrError` for server error
 * envelopes, malformed responses, timeouts, and connect failures.
 */
export async function callHerdrSocket(
  opts: HerdrSocketOptions,
  method: string,
  params: Record<string, unknown>,
  requestId: string,
): Promise<unknown> {
  const line = JSON.stringify({ id: requestId, method, params });
  const responseLine = opts.send ? await opts.send(line) : await sendOverSocket(opts, line);
  const response = JSON.parse(responseLine) as Record<string, unknown>;
  if (!isRecord(response)) {
    throw new HerdrError("malformed_response", "herdr socket response is not a JSON object");
  }
  if (response.error !== undefined) {
    throw herdrErrorFrom(response);
  }
  if (response.result === undefined) {
    throw new HerdrError("malformed_response", "herdr socket response carries neither result nor error");
  }
  return response.result;
}

function sendOverSocket(opts: HerdrSocketOptions, line: string): Promise<string> {
  const socketPath = opts.socketPath ?? "~/.config/herdr/herdr.sock";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new HerdrError("live_handoff_timeout", `herdr socket call timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once("error", (err) => fail(new HerdrError("socket_connect_failed", err.message)));
    socket.once("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return; // wait for the full response line
      settled = true;
      clearTimeout(timer);
      socket.destroy(); // one-shot RPC: done reading, drop the connection
      resolve(buffer.slice(0, newline));
    });
    socket.write(`${line}\n`);
  });
}

/**
 * Invoke `server.live_handoff`. The Herdr server hot-swaps under the given
 * protocol/version expectation; the result payload is server-defined.
 */
export function callHerdrLiveHandoff(opts: HerdrSocketOptions, params: LiveHandoffParams = {}): Promise<unknown> {
  return callHerdrSocket(opts, LIVE_HANDOFF_METHOD, buildLiveHandoffParams(params), "pi-eng:live-handoff");
}

/** The outcome of probing the server for the live-handoff capability. */
export interface LiveHandoffCapability {
  /** Whether the socket answered at all. */
  reachable: boolean;
  /** The server-declared `capabilities.live_handoff` flag. */
  liveHandoff: boolean;
  version?: string;
  protocol?: number;
}

/**
 * Probe the server with `ping` and read back the declared capabilities.
 * Connect failures resolve to `{reachable: false, liveHandoff: false}` (the
 * probe is for discovery, not control flow); server error envelopes throw.
 */
export async function probeLiveHandoffCapability(opts: HerdrSocketOptions): Promise<LiveHandoffCapability> {
  let result: unknown;
  try {
    result = await callHerdrSocket(opts, "ping", {}, "pi-eng:ping");
  } catch (err) {
    if (err instanceof HerdrError && (err.code === "socket_connect_failed" || err.code === "live_handoff_timeout")) {
      return { reachable: false, liveHandoff: false };
    }
    throw err;
  }
  const pong = isRecord(result) ? result : {};
  const capabilities = isRecord(pong.capabilities) ? pong.capabilities : {};
  return {
    reachable: true,
    liveHandoff: typeof capabilities.live_handoff === "boolean" ? capabilities.live_handoff : false,
    ...(typeof pong.version === "string" ? { version: pong.version } : {}),
    ...(typeof pong.protocol === "number" ? { protocol: pong.protocol } : {}),
  };
}

// ── payload: HandoffArtifact + checkpoint refs across the process boundary ──

/**
 * A serialized live-handoff payload: the bounded `HandoffArtifact` (the ONLY
 * thing that crosses the boundary, per spec §3/§18) plus the immutable
 * checkpoint reference set when one exists. The artifact is generic so the
 * producer side can pass a typed `HandoffArtifact` and the consumer side a
 * structural view; deserialization validates the shape either way.
 */
export interface LiveHandoffPayload<TArtifact extends object = Record<string, unknown>> {
  payloadVersion: number;
  artifact: TArtifact;
  checkpointRefs?: HandoffCheckpointRefs;
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ARTIFACT_SHA_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Serialize a payload to its durable JSON form. The artifact is taken as-is
 * (producers are `buildHandoff`, which already clips to the payload caps);
 * `checkpointRefs` is omitted when absent.
 */
export function serializeLiveHandoffPayload<TArtifact extends object>(input: {
  artifact: TArtifact;
  checkpointRefs?: HandoffCheckpointRefs;
}): string {
  const payload: LiveHandoffPayload<TArtifact> = {
    payloadVersion: LIVE_HANDOFF_PAYLOAD_VERSION,
    artifact: input.artifact,
  };
  if (input.checkpointRefs !== undefined) {
    payload.checkpointRefs = input.checkpointRefs;
  }
  return JSON.stringify(payload);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function checkStringField(errors: string[], artifact: Record<string, unknown>, field: string): void {
  if (typeof artifact[field] !== "string" || (artifact[field] as string).length === 0) {
    errors.push(`artifact.${field} must be a non-empty string`);
  }
}

function checkStringArray(errors: string[], artifact: Record<string, unknown>, field: string): void {
  if (!isStringArray(artifact[field])) {
    errors.push(`artifact.${field} must be an array of strings`);
  }
}

function checkBoundedString(errors: string[], value: unknown, field: string, max: number): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`artifact.${field} must be a non-empty string`);
  } else if (value.length > max) {
    errors.push(`artifact.${field} exceeds ${max} chars (${value.length})`);
  }
}

/**
 * Validate and decode a serialized payload. Collects ALL errors in a fixed
 * order; on success returns a fresh copy (the input string is untouched and
 * later mutation of the returned object cannot affect any stored reference).
 * Structural: it checks the HandoffArtifact shape and the payload caps
 * without importing planner types (layering: runtime is below plannerWorker).
 */
export function deserializeLiveHandoffPayload<TArtifact extends object = Record<string, unknown>>(
  json: string,
): { ok: true; payload: LiveHandoffPayload<TArtifact> } | { ok: false; errors: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, errors: ["payload is not valid JSON"] };
  }
  if (!isRecord(obj)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  const errors: string[] = [];

  if (obj.payloadVersion !== LIVE_HANDOFF_PAYLOAD_VERSION) {
    errors.push(`payloadVersion must be ${LIVE_HANDOFF_PAYLOAD_VERSION}`);
  }

  const artifact = obj.artifact;
  if (!isRecord(artifact)) {
    errors.push("artifact must be an object");
  } else {
    const kind = artifact.kind;
    if (typeof kind !== "string" || !(HANDOFF_KINDS as readonly string[]).includes(kind)) {
      errors.push(`artifact.kind must be one of ${HANDOFF_KINDS.join(", ")}`);
    }
    checkStringField(errors, artifact, "mission_id");
    checkStringField(errors, artifact, "task_id");
    checkStringField(errors, artifact, "from_role");
    checkStringField(errors, artifact, "to_role");
    checkBoundedString(errors, artifact.mission_summary, "mission_summary", PAYLOAD_MAX_SUMMARY_CHARS);
    checkStringField(errors, artifact, "objective");
    for (const field of [
      "architectural_context",
      "relevant_files",
      "decisions",
      "constraints",
      "acceptance",
      "verification",
    ]) {
      checkStringArray(errors, artifact, field);
    }
    if (!isRecord(artifact.scope)) {
      errors.push("artifact.scope must be an object");
    }
    if (!Array.isArray(artifact.dependency_results)) {
      errors.push("artifact.dependency_results must be an array");
    }
    if (typeof artifact.token_estimate !== "number" || !Number.isFinite(artifact.token_estimate)) {
      errors.push("artifact.token_estimate must be a finite number");
    }
    if (artifact.worker_outcome !== undefined) {
      const outcome = artifact.worker_outcome;
      if (!isRecord(outcome)) {
        errors.push("artifact.worker_outcome must be an object");
      } else {
        checkBoundedString(errors, outcome.summary, "worker_outcome.summary", PAYLOAD_MAX_SUMMARY_CHARS);
        if (!isStringArray(outcome.changed_files)) {
          errors.push("artifact.worker_outcome.changed_files must be an array of strings");
        }
        checkBoundedString(errors, outcome.diff, "worker_outcome.diff", PAYLOAD_MAX_DIFF_CHARS);
        if (!isStringArray(outcome.verification)) {
          errors.push("artifact.worker_outcome.verification must be an array of strings");
        }
      }
    }
  }

  if (obj.checkpointRefs !== undefined) {
    const refs = obj.checkpointRefs;
    if (!isRecord(refs)) {
      errors.push("checkpointRefs must be an object");
    } else {
      if (typeof refs.checkpointSha !== "string" || !FULL_SHA_PATTERN.test(refs.checkpointSha)) {
        errors.push("checkpointRefs.checkpointSha must be a 40-hex commit sha");
      }
      if (typeof refs.sourceSha !== "string" || !FULL_SHA_PATTERN.test(refs.sourceSha)) {
        errors.push("checkpointRefs.sourceSha must be a 40-hex commit sha");
      }
      if (!Array.isArray(refs.artifacts)) {
        errors.push("checkpointRefs.artifacts must be an array");
      } else {
        refs.artifacts.forEach((entry, i) => {
          if (!isRecord(entry)) {
            errors.push(`checkpointRefs.artifacts[${i}] must be an object`);
            return;
          }
          if (typeof entry.ref !== "string" || !entry.ref.startsWith("artifact://")) {
            errors.push(`checkpointRefs.artifacts[${i}].ref must start with artifact://`);
          }
          if (typeof entry.sha256 !== "string" || !ARTIFACT_SHA_PATTERN.test(entry.sha256)) {
            errors.push(`checkpointRefs.artifacts[${i}].sha256 must be a 64-hex sha256`);
          }
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const payload: LiveHandoffPayload<TArtifact> = {
    payloadVersion: obj.payloadVersion as number,
    artifact: JSON.parse(JSON.stringify(artifact)) as TArtifact,
  };
  if (obj.checkpointRefs !== undefined) {
    payload.checkpointRefs = JSON.parse(JSON.stringify(obj.checkpointRefs)) as HandoffCheckpointRefs;
  }
  return { ok: true, payload };
}
