/**
 * Mission facts for a runtime handover, read from the DURABLE orchestration
 * store (spec §20, §24, §41).
 *
 * Nothing here is carried in memory from one generation to the next. The
 * snapshot only names missions, so the handover can be observed and checked.
 * The new generation rebuilds each mission from the store.
 *
 * The read uses no lock and changes nothing. The store is append-only JSONL:
 * whole lines are complete events, and a torn tail is skipped.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MissionStore } from "../../orchestration/missionStore.ts";
import { JsonlEventStore } from "../../platform/eventstore/jsonl.ts";

/** Parked on inference capacity: a handover must leave these parked, never failed. */
export const INFERENCE_WAIT_STATES = new Set([
  "WAITING_FOR_LLM",
  "WAITING_FOR_CAPACITY",
  "WAITING_FOR_GATEWAY",
  "WAITING_FOR_MODEL",
  "PAUSED_INFRASTRUCTURE",
]);

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELED"]);
const PENDING = new Set(["CLASSIFYING", "PLANNING", "READY", "QUEUED"]);

export interface MissionHandoverFacts {
  active: string[];
  pending: string[];
  inferenceWaits: string[];
  statuses: Record<string, string>;
}

/** Where the orchestration store lives for a working directory (mirrors EngineeringRuntime). */
export function orchestrationFile(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_ENGINEERING_ORCHESTRATION_DIR;
  const dir = override && override.trim() !== "" ? resolve(override) : join(cwd, ".pi-eng");
  return join(dir, "orchestration.jsonl");
}

/** Read mission facts from an orchestration JSONL file; empty when there is none. */
export async function readMissionFacts(file: string): Promise<MissionHandoverFacts> {
  const facts: MissionHandoverFacts = { active: [], pending: [], inferenceWaits: [], statuses: {} };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return facts;
  }
  const events: unknown[] = [];
  const lines = raw.split("\n");
  // The last element is either "" (the file ends in a newline) or a torn
  // write. Either way it is not an event.
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A corrupt line here is the store's problem to report. The handover
      // only needs whatever missions can be read.
    }
  }
  const backend = JsonlEventStore.inMemory();
  await backend.appendAll(events as never);
  const store = MissionStore.open(backend);
  for (const mission of store.listMissions()) {
    facts.statuses[mission.mission_id] = mission.status;
    if (TERMINAL.has(mission.status)) continue;
    if (INFERENCE_WAIT_STATES.has(mission.status)) facts.inferenceWaits.push(mission.mission_id);
    if (PENDING.has(mission.status)) facts.pending.push(mission.mission_id);
    else facts.active.push(mission.mission_id);
  }
  return facts;
}

export function discoverMissionHandover(cwd: string): Promise<MissionHandoverFacts> {
  return readMissionFacts(orchestrationFile(cwd));
}
