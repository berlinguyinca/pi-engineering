/**
 * Crash recovery (spec §17, §18, acceptance case 4): a session killed with
 * SIGKILL is detected on the next start, its ownership reclaimed, and its
 * mission adopted at once — no manual cleanup, no waiting for lease expiry.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeGitRepo, makeStateDir, startChild } from "../support/childSessions.ts";

describe("crash recovery across real processes", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("SIGKILLed custodian: the replacement reconciles it, reclaims its leases and adopts its mission immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-crash-"));
    const stateDir = await makeStateDir("crash-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "repo"));

    const holder = startChild("hold", repo, stateDir);
    const held = await holder.report;
    assert.equal(held.ok, true, held.error);
    assert.ok(
      held.heldLeases?.some((lease) => lease.endsWith(`#mission:${held.missionId}`)),
      "holder has custody",
    );

    // While the holder lives, another session must not take its mission.
    const blocked = startChild("adopt", repo, stateDir, { env: { PI_TEST_ADOPT_MISSION: held.missionId! } });
    const blockedReport = await blocked.report.catch((error: Error) => ({ ok: false, error: error.message }) as const);
    assert.equal(blockedReport.ok, false, "a live custodian's mission is not adopted");
    assert.match(String(blockedReport.error), /custody of another live session/);

    holder.child.kill("SIGKILL");
    await holder.exited;

    const replacement = startChild("adopt", repo, stateDir, { env: { PI_TEST_ADOPT_MISSION: held.missionId! } });
    const adopted = await replacement.report;
    assert.equal(adopted.ok, true, adopted.error);
    assert.ok(
      adopted.reconciliation?.orphanedSessions.some((session) => session.sessionId === held.sessionId),
      "the killed session is detected and marked orphaned at startup",
    );
    // The dead holder's lease was generation 1; the takeover (possibly after the
    // replacement's own startup supervision) is a newer generation, and it did
    // not wait out the dead owner's lease.
    assert.ok((adopted.adoptedGeneration ?? 0) >= 2, "the mission lease moved to a new generation without waiting");
    assert.equal(adopted.health, "healthy");
    await replacement.exited;
  });
});
