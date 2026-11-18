/**
 * Host-speed measurement for tests whose premise is an ORDERING property that
 * happens to be timed against a run budget.
 *
 * Why this exists (ci.metabolomics.us pipeline 311, 2026-11-18):
 * `test/unit/orchestration-broker-recovery.test.ts` waits for the broker's
 * checkpoint chain to settle between claims, bounded by a fixed 5s that had to
 * fit inside a fixed 6s execution budget. On the CI host the suite took 1176s
 * where it takes ~220s on an idle one, the sequence of three checkpoint
 * round-trips needed ~4.4s, the wait expired, and an ordering property that has
 * nothing to do with speed went red. A constant cannot survive that spread; a
 * measurement can. So the run budget is derived from how long THIS host takes to
 * do the durable work the property depends on — a real commit, real
 * content-addressed artifact writes, a real durable finding — and a loaded host
 * stretches the window instead of failing the test.
 *
 * This is not a way to make slow code pass. The assertions stay exactly as
 * strict, the budget is capped, and a run that never settles still fails.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

export interface HostScale {
  /** One representative durable round-trip on this host, in ms. */
  unitMs: number;
  /** What was measured, for the failure message. */
  measured: string;
}

/**
 * Time what one checkpoint round-trip actually costs: a real git commit, two
 * artifact writes plus two immutable captures (the broker's evidence copy), and
 * one durable finding write. The finding goes to a throwaway store so the
 * caller's own finding counts are untouched.
 */
export async function measureRoundTripMs(artifacts: ArtifactStore): Promise<HostScale> {
  const repo = await mkdtemp(join(tmpdir(), "pe-host-scale-"));
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const startedAt = Date.now();
  try {
    const git = (args: string[]): unknown =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "--initial-branch=main", "--quiet"]);
    git(["config", "user.email", "scale@test.invalid"]);
    git(["config", "user.name", "scale"]);
    await writeFile(join(repo, "scale.txt"), "one\n");
    git(["add", "scale.txt"]);
    git(["commit", "--quiet", "-m", "scale commit"]);
    const first = await artifacts.put("scale", "checkpoint", "scale body one", "measurement");
    await artifacts.put("scale", "checkpoint", "scale body two", "measurement");
    const body = await artifacts.readContentByUri(first.uri);
    if (body !== undefined) await artifacts.putImmutable("checkpoint", "scale-execution", body, "measurement");
    const mission = store.createMission({
      title: "host scale",
      goal: "host scale",
      user_request: "host scale",
      repository: repo,
      base_ref: "0".repeat(40),
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.addFinding({
      mission_id: mission.mission_id,
      task_id: null,
      severity: "major",
      category: "checkpoint_progress",
      file: null,
      line: null,
      summary: "host scale measurement",
      evidence: "measurement",
      recommended_action: "none",
    });
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    unitMs: Math.max(1, Date.now() - startedAt),
    measured: "git commit + 2 artifact writes + immutable capture + durable finding",
  };
}

/**
 * A run budget with room for the number of durable round-trips the property
 * needs, floored so an idle host pays nothing extra and capped so a wedged host
 * still fails. The default factor (20) is deliberately generous: the measured
 * unit is one commit + a few artifact writes, while one real checkpoint
 * round-trip also takes a git snapshot and a durable checkpoint persist, so the
 * unit under-counts by a few. Three round-trips with that under-count plus the
 * worker's own commit and the final persist is what the window must cover.
 */
export function scaledBudgetMs(unitMs: number, { factor = 20, floorMs = 6_000, capMs = 120_000 } = {}): number {
  return Math.min(capMs, Math.max(floorMs, Math.round(unitMs * factor)));
}
