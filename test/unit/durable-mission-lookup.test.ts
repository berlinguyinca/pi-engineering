/**
 * #427 — the durable mission lookup behind the live store: a mission written
 * to ANOTHER session's stream must be findable by replay (the "Unknown
 * mission" amnesia fix), and a truly unknown id must still be Unknown.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { lookupMissionDurable } from "../../src/runtime/host/durableMissionLookup.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";
import { resolveStateRoot, worktreeRuntimeDir } from "../../src/runtime/isolation/stateDir.ts";

describe("#427 durable mission lookup", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "durable-lookup-"));
    repo = join(root, "repo");
    env = { PI_ENGINEERING_STATE_DIR: join(root, "state") };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("finds a mission that lives only in another session's durable stream", async () => {
    const identity = await resolveWorktreeIdentity(repo);
    const eventsDir = join(worktreeRuntimeDir(resolveStateRoot(env), identity.worktreeId), "events");
    const backend = SessionEventStore.open({ eventsDir, sessionId: "sess-A", worktreeId: identity.worktreeId });
    const store = MissionStore.open(backend);
    store.createMission({
      mission_id: "MSN-other-session",
      title: "t",
      goal: "g",
      user_request: "u",
      repository: repo,
      base_ref: "main",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    await store.flush();
    backend.close();

    const found = await lookupMissionDurable(repo, "MSN-other-session", env);
    assert.ok(found, "the durable replay must surface the other session's mission");
    assert.equal(found.mission.mission_id, "MSN-other-session");

    // The truly unknown stays unknown.
    assert.equal(await lookupMissionDurable(repo, "MSN-nope", env), undefined);
  });
});
