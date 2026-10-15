/**
 * Nightly real-mission dogfood record (issue #226).
 *
 * Summarises one mission from the durable event stream with the same extraction
 * `pi-engineering missions why --json` uses (`explainMission` -> typed per-task
 * usage), and assembles the `dogfood_mission` roadmap evidence document that
 * `scripts/dogfood-real-mission.ts` writes and `roadmap check` reads.
 */
import type { MissionStore } from "./missionStore.ts";
import { explainMission } from "./missionWhy.ts";

export interface DogfoodMissionSummary {
  goal: string;
  missionId: string;
  status: string;
  candidateSha: string | null;
  wallMs: number;
  /** Agent executions (one worker model session each). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

export interface DogfoodMissionRecord {
  kind: "dogfood_mission";
  /** Main SHA the run was pinned to. */
  sha: string;
  missions: DogfoodMissionSummary[];
  ranAt: string;
}

export function summariseMission(
  store: MissionStore,
  missionId: string,
  meta: { goal: string; wallMs: number; fallbackCandidateSha?: string | null },
): DogfoodMissionSummary {
  const mission = store.getMission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  const why = explainMission(store, missionId);
  let inputTokens = 0;
  let outputTokens = 0;
  const models = new Map<string, number>();
  for (const u of why.usage) {
    inputTokens += u.promptTokens;
    outputTokens += u.completionTokens;
    if (u.model) models.set(u.model, (models.get(u.model) ?? 0) + u.promptTokens + u.completionTokens);
  }
  const calls = store.listExecutions(missionId).filter((e) => e.backend === "agent").length;
  const candidate = store
    .listCandidates(missionId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .at(-1);
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    goal: meta.goal,
    missionId,
    status: mission.status,
    candidateSha: candidate?.identity.candidateSha ?? meta.fallbackCandidateSha ?? null,
    wallMs: meta.wallMs,
    calls,
    inputTokens,
    outputTokens,
    model,
  };
}

export function buildDogfoodRecord(sha: string, missions: DogfoodMissionSummary[], ranAt: Date): DogfoodMissionRecord {
  return { kind: "dogfood_mission", sha, missions, ranAt: ranAt.toISOString() };
}

/** True only when there is at least one mission and every one reached COMPLETE. */
export function allComplete(record: DogfoodMissionRecord): boolean {
  return record.missions.length > 0 && record.missions.every((m) => m.status === "COMPLETE");
}
