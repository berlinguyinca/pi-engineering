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
  try {
    ownerId = str(body, "ownerId", true)!;
    if (sub === "submit") {
      idempotencyKey = str(body, "idempotencyKey", true)!;
      str(body, "title", true);
      str(body, "goal", true);
      str(body, "repository", true);
      str(body, "baseRef", true);
      const risk = str(body, "riskProfile", false);
      if (risk !== undefined && !RISK.includes(risk as RiskProfile)) throw new RequestError("riskProfile is not valid");
    } else {
      missionId = str(body, "missionId", true)!;
      const token = body.fencingToken;
      if (typeof token !== "number" || !Number.isInteger(token) || token < 0) {
        throw new RequestError("fencingToken must be a non-negative integer");
      }
      fencingToken = token;
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
      const id = externalMissionId(idempotencyKey);
      const ownership = new MissionOwnership(store, {
        ownerId,
        leaseMs: typeof body.leaseMs === "number" && body.leaseMs > 0 ? body.leaseMs : DEFAULT_LEASE_MS,
      });
      let mission = store.getMission(id);
      let created = false;
      if (!mission) {
        mission = store.createMission({
          mission_id: id,
          title: str(body, "title", true)!,
          goal: str(body, "goal", true)!,
          user_request: str(body, "userRequest", false) ?? str(body, "goal", true)!,
          repository: str(body, "repository", true)!,
          base_ref: str(body, "baseRef", true)!,
          constraints: Array.isArray(body.constraints)
            ? body.constraints.filter((c): c is string => typeof c === "string")
            : [],
          risk_profile: (str(body, "riskProfile", false) as RiskProfile | undefined) ?? "medium",
          workflow_class: (str(body, "workflowClass", false) as WorkflowClass | undefined) ?? "engineering",
        });
        created = true;
      }
      let lease = store.getLatestMissionLease(id);
      if (lease && lease.ownerId !== ownerId) {
        reply({ result: "conflict", missionId: id, reason: "the idempotencyKey belongs to another owner" });
        return 1;
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
