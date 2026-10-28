/**
 * (#427) Durable mission lookup behind the live store.
 *
 * A session's in-memory store can lose track of a mission it once ran (a
 * hot-reload, a runtime restart, or another session's live custody) while the
 * durable event streams in the orchestration namespace still replay it
 * perfectly. Before this module the mission tool answered such lookups with
 * `Unknown mission` — operator-visible amnesia that orphaned resumable work
 * (observed 2026-10-25: a mission created in the SAME session reported
 * Unknown while its events replayed to BLOCKED).
 *
 * The fallback replays the namespace's merged events exactly like the
 * handover reader (`readOrchestrationEvents`) and answers from that
 * projection. The replay is cached briefly per (cwd, state-dir, override)
 * because a cold replay of a busy namespace is expensive; a stale cache
 * degrades to the same answer the live store would give for a recently-moved
 * mission, never to corruption.
 */

import { MissionStore } from "../../orchestration/missionStore.ts";
import type { Mission } from "../../orchestration/types.ts";
import { JsonlEventStore } from "../../platform/eventstore/jsonl.ts";
import { readOrchestrationEvents } from "./missionHandover.ts";

const CACHE_TTL_MS = 30_000;

interface ReplayEntry {
  atMs: number;
  store: MissionStore;
}

const replays = new Map<string, Promise<ReplayEntry>>();

async function replayStore(cwd: string, env: NodeJS.ProcessEnv): Promise<ReplayEntry> {
  const events = await readOrchestrationEvents(cwd, env);
  const backend = JsonlEventStore.inMemory();
  await backend.appendAll(events);
  return { atMs: Date.now(), store: MissionStore.open(backend) };
}

/** The mission as the DURABLE event log knows it, or undefined when it truly
 * does not exist there. The store returned alongside is the replay projection
 * (report lines about it are durable-view as well). */
export async function lookupMissionDurable(
  cwd: string,
  missionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ mission: Mission; store: MissionStore } | undefined> {
  const key = JSON.stringify([cwd, env.PI_ENGINEERING_STATE_DIR ?? "", env.PI_ENGINEERING_ORCHESTRATION_DIR ?? ""]);
  let entry: ReplayEntry | undefined;
  const cached = replays.get(key);
  if (cached) {
    try {
      const e = await cached;
      if (Date.now() - e.atMs <= CACHE_TTL_MS) entry = e;
    } catch {
      if (replays.get(key) === cached) replays.delete(key);
    }
  }
  if (!entry) {
    const fresh = replayStore(cwd, env);
    replays.set(key, fresh);
    try {
      entry = await fresh;
    } catch (error) {
      if (replays.get(key) === fresh) replays.delete(key);
      throw error;
    }
  }
  const mission = entry.store.getMission(missionId);
  return mission ? { mission, store: entry.store } : undefined;
}
