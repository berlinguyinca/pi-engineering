/**
 * Mission facts for a runtime handover, read from the DURABLE orchestration
 * store (spec §20, §24, §41).
 *
 * Nothing here is carried in memory from one generation to the next. The
 * snapshot only names missions, so the handover can be observed and checked.
 * The new generation rebuilds each mission from the store.
 *
 * The store is the worktree's orchestration namespace under runtime isolation
 * (docs/specs/zero-config-runtime-isolation.md): one append stream per
 * session, merged on read, plus a legacy `.pi-eng/orchestration.jsonl` that
 * has not been imported yet. The read opens no writer, takes no lock and
 * changes nothing; whole lines are complete events and a torn tail is skipped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MissionStore } from "../../orchestration/missionStore.ts";
import type { StoredEvent } from "../../platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../platform/eventstore/jsonl.ts";
import { readMergedEvents } from "../isolation/SessionEventStore.ts";
import { resolveWorktreeIdentity } from "../isolation/WorktreeIdentity.ts";
import { resolveOrchestrationOverride, resolveStateRoot, worktreeRuntimeDir } from "../isolation/stateDir.ts";

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

/** Complete JSONL events of a legacy single-writer file; [] when there is none. */
function readLegacyEvents(file: string): StoredEvent[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: StoredEvent[] = [];
  const lines = raw.split("\n");
  // The last element is either "" (the file ends in a newline) or a torn
  // write. Either way it is not an event.
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as StoredEvent);
    } catch {
      // A corrupt line here is the store's problem to report. The handover
      // only needs whatever missions can be read.
    }
  }
  return events;
}

/**
 * Every durable orchestration event for a working directory (mirrors
 * EngineeringRuntime.open): the worktree namespace's session streams, or the
 * `PI_ENGINEERING_ORCHESTRATION_DIR` override's, plus legacy single-writer
 * files not imported yet. De-duplicated by event id.
 */
export async function readOrchestrationEvents(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredEvent[]> {
  const identity = await resolveWorktreeIdentity(cwd);
  const override = resolveOrchestrationOverride(env);
  const namespaceDir = override ?? worktreeRuntimeDir(resolveStateRoot(env), identity.worktreeId);
  const legacyFiles = [join(identity.worktreeRoot, ".pi-eng", "orchestration.jsonl")];
  if (override) legacyFiles.push(join(override, "orchestration.jsonl"));
  const seen = new Set<string>();
  const events: StoredEvent[] = [];
  for (const event of [...legacyFiles.flatMap(readLegacyEvents), ...readMergedEvents(join(namespaceDir, "events"))]) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    events.push(event);
  }
  return events;
}

/** Mission facts from orchestration events. */
export async function readMissionFacts(events: StoredEvent[]): Promise<MissionHandoverFacts> {
  const facts: MissionHandoverFacts = { active: [], pending: [], inferenceWaits: [], statuses: {} };
  if (events.length === 0) return facts;
  const backend = JsonlEventStore.inMemory();
  await backend.appendAll(events);
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

export async function discoverMissionHandover(cwd: string): Promise<MissionHandoverFacts> {
  return readMissionFacts(await readOrchestrationEvents(cwd));
}
