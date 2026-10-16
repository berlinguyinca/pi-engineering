/**
 * `pi-engineering mission submit|observe|cancel`: a JSON entry point for an
 * external system (AutoSpec) to hand Pi a mission and watch or stop it.
 *
 *   pi-engineering mission submit  --store <dir>   < {ownerId, idempotencyKey, title, goal, repository, baseRef, ...}
 *   pi-engineering mission observe --store <dir>   < {missionId, ownerId, fencingToken}
 *   pi-engineering mission cancel  --store <dir>   < {missionId, ownerId, fencingToken, reason?}
 *
 * Pi stays the mission's owner: submit creates the mission in CREATED (status
 * `NEW`) and acquires its lease for `ownerId`, returning the lease's fencing
 * token. Every later call must present that owner and token. The token must
 * match the store's latest lease epoch exactly: a lower one is a superseded
 * owner, a higher one was never issued, and neither may read or change the
 * mission (`stale`, exit 1, nothing written).
 *
 * Off unless `PI_AUTOSPEC_ENABLED` is on (exit 2), and never from inside a
 * mission worker (`assertRootMissionAllowed`). Replies are one JSON object on
 * stdout. Exit codes: 0 ok, 1 stale/conflict/not found, 2 disabled or invalid
 * request, 3 the store could not be opened.
 *
 * The store is a JSONL event store opened under its single-writer lock, as
 * `missions cancel` does, so it refuses to run beside a live writer.
 */

import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { type Envelope, validateEnvelope } from "./externalEntryProtocol.ts";
import { cancelStaleMission, transitionMissionToCanceled } from "./missionCancel.ts";
import { assertRootMissionAllowed, readAutospecFlags } from "./missionMode.ts";
import { buildMissionSnapshot } from "./missionSnapshot.ts";
import { MissionStore } from "./missionStore.ts";
import { MissionOwnership } from "./ownership.ts";
import type { Mission, RiskProfile, WorkflowClass } from "./types.ts";

export interface ExternalEntryIo {
  write?: (text: string) => void;
  error?: (text: string) => void;
}

const USAGE = "usage: pi-engineering mission submit|observe|cancel --store <dir>   (JSON request on stdin)\n";
/** Long enough that an external owner's lease outlives the gaps between its calls. */
const DEFAULT_LEASE_MS = 24 * 60 * 60_000;
const RISK: readonly RiskProfile[] = ["low", "medium", "high", "critical"];

class RequestError extends Error {}

function str(body: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new RequestError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new RequestError(`${key} must be ${required ? "a non-empty " : "a "}string`);
  }
  return value;
}

function parseBody(stdin: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(stdin);
  } catch {
    throw new RequestError("the request on stdin is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RequestError("the request must be a JSON object");
  return body as Record<string, unknown>;
}

/** The same key always names the same mission, across processes and restarts. */
export function externalMissionId(idempotencyKey: string): string {
  return `MSN-ext-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}

/**
 * Mission identifiers carried by an autospec-protocol envelope: an optional
 * single-letter prefix followed by letters, digits, dots, underscores and
 * dashes, at most 64 characters long. Anything else is rejected as
 * INVALID_FIELD before the store is touched.
 */
const ENVELOPE_MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Sentinel embedded in a protocol-created mission's constraints to persist the envelope idempotency_key. */
const IDEMPOTENCY_SENTINEL_PREFIX = "__pi_idempotency_key:";

function idempotencySentinel(key: string): string {
  return `${IDEMPOTENCY_SENTINEL_PREFIX}${key}`;
}

/** The stored envelope idempotency_key embedded in constraints, or undefined if none. */
function storedIdempotencyKey(constraints: string[]): string | undefined {
  for (const c of constraints) {
    if (c.startsWith(IDEMPOTENCY_SENTINEL_PREFIX)) return c.slice(IDEMPOTENCY_SENTINEL_PREFIX.length);
  }
  return undefined;
}

/**
 * The Pi submit fields a protocol-mode submit carries under `extensions.pi`.
 * The mission id and idempotency key come from the envelope itself.
 */
interface ProtocolSubmitParams {
  ownerId: string;
  idempotencyKey: string;
  missionId: string;
  title: string;
  goal: string;
  userRequest?: string;
  repository: string;
  baseRef: string;
  constraints: string[];
  riskProfile?: RiskProfile;
  workflowClass?: WorkflowClass;
  leaseMs?: number;
}

/**
 * Read the Pi submit fields out of an already-validated autospec-protocol
 * envelope. The mission id and idempotency key are taken from the envelope;
 * the rest live under `extensions.pi`. Invalid field values raise RequestError.
 */
function parseProtocolSubmit(envelope: Envelope): ProtocolSubmitParams {
  const pi = envelope.extensions?.pi;
  if (!pi || typeof pi !== "object" || Array.isArray(pi))
    throw new RequestError("extensions.pi must be an object for a protocol submit");
  const fields = pi as Record<string, unknown>;
  const risk = str(fields, "riskProfile", false);
  if (risk !== undefined && !RISK.includes(risk as RiskProfile)) throw new RequestError("riskProfile is not valid");
  return {
    ownerId: str(fields, "ownerId", true)!,
    idempotencyKey: envelope.idempotency_key,
    missionId: envelope.mission_id,
    title: str(fields, "title", true)!,
    goal: str(fields, "goal", true)!,
    userRequest: str(fields, "userRequest", false),
    repository: str(fields, "repository", true)!,
    baseRef: str(fields, "baseRef", true)!,
    constraints: Array.isArray(fields.constraints)
      ? fields.constraints.filter((c): c is string => typeof c === "string")
      : [],
    riskProfile: risk as RiskProfile | undefined,
    workflowClass: str(fields, "workflowClass", false) as WorkflowClass | undefined,
    leaseMs: typeof fields.leaseMs === "number" && fields.leaseMs > 0 ? fields.leaseMs : undefined,
  };
}

function storeFlag(args: string[]): string {
  const index = args.indexOf("--store");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new RequestError("--store <dir> is required");
  return resolve(value);
}

function lifecycleOf(store: MissionStore, mission: Mission) {
  return store.getCanonicalLifecycle(mission.mission_id);
}

export async function runExternalEntry(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
  io: ExternalEntryIo = {},
): Promise<number> {
  const out = io.write ?? ((text: string) => process.stdout.write(text));
  const err = io.error ?? ((text: string) => process.stderr.write(text));
  const reply = (value: unknown): void => out(`${JSON.stringify(value)}\n`);
  const sub = argv[0];

  if (!readAutospecFlags(env).enabled) {
    err("pi-engineering mission is off: set PI_AUTOSPEC_ENABLED=1 to use the external entry point\n");
    return 2;
  }
  if (sub !== "submit" && sub !== "observe" && sub !== "cancel") {
    err(`unknown subcommand\n${USAGE}`);
    return 2;
  }

  let dir: string;
  let body: Record<string, unknown>;
  try {
    assertRootMissionAllowed(env);
    dir = storeFlag(argv.slice(1));
    body = parseBody(stdin);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const file = join(dir, "orchestration.jsonl");

  // Validate the request before touching the store.
  let ownerId: string;
  let idempotencyKey = "";
  let missionId = "";
  let fencingToken = 0;
  let protocolSubmit: ProtocolSubmitParams | undefined;
  try {
    const isProtocolSubmit =
      sub === "submit" && typeof body.schema === "string" && body.schema.startsWith("autospec.protocol.");
    if (isProtocolSubmit) {
      const result = validateEnvelope(body);
      if (!result.ok) {
        reply({ result: "protocol_error", code: result.code, message: result.message });
        return 2;
      }
      if (!ENVELOPE_MISSION_ID_RE.test(String(result.envelope.mission_id))) {
        reply({
          result: "protocol_error",
          code: "INVALID_FIELD",
          message: `mission_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, got ${JSON.stringify(result.envelope.mission_id)}`,
        });
        return 2;
      }
      protocolSubmit = parseProtocolSubmit(result.envelope);
      ownerId = protocolSubmit.ownerId;
      idempotencyKey = protocolSubmit.idempotencyKey;
      missionId = protocolSubmit.missionId;
    } else {
      ownerId = str(body, "ownerId", true)!;
      if (sub === "submit") {
        idempotencyKey = str(body, "idempotencyKey", true)!;
        str(body, "title", true);
        str(body, "goal", true);
        str(body, "repository", true);
        str(body, "baseRef", true);
        const risk = str(body, "riskProfile", false);
        if (risk !== undefined && !RISK.includes(risk as RiskProfile))
          throw new RequestError("riskProfile is not valid");
      } else {
        missionId = str(body, "missionId", true)!;
        const token = body.fencingToken;
        if (typeof token !== "number" || !Number.isInteger(token) || token < 0) {
          throw new RequestError("fencingToken must be a non-negative integer");
        }
        fencingToken = token;
      }
    }
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  let backend: JsonlEventStore;
  try {
    if (sub === "submit") await mkdir(dir, { recursive: true });
    else if (!(await stat(file)).isFile()) throw new Error(`${file} is not a store file`);
    backend = await JsonlEventStore.open(file);
  } catch (error) {
    err(`cannot open the store in ${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }

  try {
    const store = MissionStore.open(backend);
    if (sub === "submit") {
      const id = protocolSubmit ? protocolSubmit.missionId : externalMissionId(idempotencyKey);
      const ownership = new MissionOwnership(store, {
        ownerId,
        leaseMs: protocolSubmit
          ? (protocolSubmit.leaseMs ?? DEFAULT_LEASE_MS)
          : typeof body.leaseMs === "number" && body.leaseMs > 0
            ? body.leaseMs
            : DEFAULT_LEASE_MS,
      });
      let mission = store.getMission(id);
      let created = false;
      if (!mission) {
        mission = store.createMission({
          mission_id: id,
          title: protocolSubmit ? protocolSubmit.title : str(body, "title", true)!,
          goal: protocolSubmit ? protocolSubmit.goal : str(body, "goal", true)!,
          user_request: protocolSubmit
            ? (protocolSubmit.userRequest ?? protocolSubmit.goal)
            : (str(body, "userRequest", false) ?? str(body, "goal", true)!),
          repository: protocolSubmit ? protocolSubmit.repository : str(body, "repository", true)!,
          base_ref: protocolSubmit ? protocolSubmit.baseRef : str(body, "baseRef", true)!,
          constraints: protocolSubmit
            ? [...protocolSubmit.constraints, idempotencySentinel(protocolSubmit.idempotencyKey)]
            : Array.isArray(body.constraints)
              ? body.constraints.filter((c): c is string => typeof c === "string")
              : [],
          risk_profile: protocolSubmit
            ? (protocolSubmit.riskProfile ?? "medium")
            : ((str(body, "riskProfile", false) as RiskProfile | undefined) ?? "medium"),
          workflow_class: protocolSubmit
            ? (protocolSubmit.workflowClass ?? "engineering")
            : ((str(body, "workflowClass", false) as WorkflowClass | undefined) ?? "engineering"),
        });
        created = true;
      } else if (protocolSubmit) {
        // A protocol resubmit must present the same idempotency_key the mission
        // was created with; a different key is an idempotency conflict and must
        // not touch the existing mission or its lease.
        const storedKey = storedIdempotencyKey(mission.constraints);
        if (storedKey !== undefined && storedKey !== protocolSubmit.idempotencyKey) {
          reply({
            result: "protocol_error",
            code: "IDEMPOTENCY_CONFLICT",
            message: "idempotency_key does not match the existing mission",
          });
          return 2;
        }
      }
      let lease = store.getLatestMissionLease(id);
      if (lease && lease.ownerId !== ownerId) {
        reply({ result: "conflict", missionId: id, reason: "the idempotencyKey belongs to another owner" });
        return 1;
      }
      if (protocolSubmit) {
        // Only acquire (or re-confirm) the lease when this submission created
        // the mission or its idempotency_key matches the envelope's key.
        const storedKey = storedIdempotencyKey(mission.constraints);
        if (!created && storedKey !== protocolSubmit.idempotencyKey) {
          reply({
            result: "protocol_error",
            code: "IDEMPOTENCY_CONFLICT",
            message: "idempotency_key does not match the existing mission",
          });
          return 2;
        }
      }
      // A crash between createMission and acquire leaves a mission with no lease.
      if (!lease) lease = await ownership.acquire(id);
      await store.flush();
      reply({
        result: created ? "created" : "existing",
        missionId: id,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        status: mission.status,
        canonicalState: lifecycleOf(store, mission)?.canonicalState,
      });
      return 0;
    }

    const mission = store.getMission(missionId);
    if (!mission) {
      reply({ result: "not_found", missionId });
      return 1;
    }
    const lease = store.getLatestMissionLease(missionId);
    if (!lease || lease.ownerId !== ownerId || lease.fencingToken !== fencingToken) {
      reply({ result: "stale", missionId });
      return 1;
    }

    if (sub === "observe") {
      reply({
        result: "ok",
        mission: buildMissionSnapshot(
          mission,
          store.listTasks(missionId),
          store.listFindings(missionId),
          null,
          null,
          null,
          { executions: store.listExecutions(missionId), classifications: store.listFailureClassifications(missionId) },
          lifecycleOf(store, mission),
        ),
      });
      return 0;
    }

    // cancel. A mission still in NEW has no cancel edge in the lifecycle, so it
    // passes through CLASSIFYING (recorded) on its way to CANCELED.
    if (mission.status === "NEW") store.transitionMission(missionId, "CLASSIFYING", `external:${ownerId}`);
    // The caller IS the controller (identity checked above), so the live-lease
    // refusal meant for other operators does not apply.
    let status = mission.status;
    if (status !== "CANCELED") {
      status = cancelStaleMission(store, missionId, { now: Number.MAX_SAFE_INTEGER }).status;
    }
    await store.flush();
    reply({ result: "cancelled", missionId, status, reason: str(body, "reason", false) ?? null });
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  } finally {
    backend.close();
  }
}
