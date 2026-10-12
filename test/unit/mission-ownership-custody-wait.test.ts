/**
 * Repository/mission custody contention is queueing, not failure.
 *
 * Regression (2026-10-10): a mission resume died with
 * `repository repo-… is in the custody of another live session (session f4c3cd60
 * (pid 2893918))` — an idle pi process from three days earlier. One failed
 * claim failed the operation, so on a machine with dozens of concurrent pi
 * sessions ordinary contention became a mission-blocking error and the operator
 * had to guess who held the repository. Custody is now waited out and, when the
 * wait is exhausted, the error names the holder and says what to do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { CustodyClaim, MissionCustody } from "../../src/runtime/isolation/MissionCustody.ts";

class ContendedCustody implements MissionCustody {
  claims = 0;
  /** Claim number at which the other session has released (Infinity = never). */
  private readonly freeAfter: number;
  private readonly holder: string;
  constructor(freeAfter: number, holder = "session-f4c3cd60 (pid 2893918)") {
    this.freeAfter = freeAfter;
    this.holder = holder;
  }
  async claim(): Promise<CustodyClaim> {
    this.claims++;
    return this.claims > this.freeAfter ? { ok: true, reclaimed: false } : { ok: false, holder: this.holder };
  }
  holds(): boolean {
    return true;
  }
  async release(): Promise<void> {}
  async releaseAll(): Promise<void> {}
  retainForReload(): void {}
}

/** A clock whose sleeps advance it, so waits are exercised without real time. */
function clock() {
  let at = 1_700_000_000_000;
  return {
    now: () => at,
    elapsed: () => at - 1_700_000_000_000,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

function harness(freeAfter: number, custodyWaitMs = 30_000, missionId = "MSN-contended") {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "test custody contention",
    user_request: "test custody contention",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  const clk = clock();
  const custody = new ContendedCustody(freeAfter);
  const ownership = new MissionOwnership(store, {
    ownerId: "mission-doctor-test",
    custody,
    now: clk.now,
    sleep: clk.sleep,
    custodyWaitMs,
    custodyPollMs: 5_000,
  });
  return { store, custody, clk, ownership, missionId };
}

describe("custody contention waits instead of failing", () => {
  it("takes the mission once the other session releases", async () => {
    const h = harness(3);
    const lease = await h.ownership.acquire(h.missionId, { resumptionGeneration: 0 });
    assert.equal(lease.missionId, h.missionId);
    assert.ok(h.custody.claims >= 4, `expected repeated claims, got ${h.custody.claims}`);
    assert.ok(h.clk.elapsed() > 0, "the wait must actually have been taken, not skipped");
  });

  it("reports the holder and the remedy when the wait is exhausted", async () => {
    const h = harness(Number.MAX_SAFE_INTEGER, 10_000, "MSN-stuck");
    await assert.rejects(
      () => h.ownership.acquire(h.missionId, { resumptionGeneration: 0 }),
      (error: Error) => {
        assert.match(error.message, /MSN-stuck is in the custody of another live session/);
        assert.match(error.message, /session-f4c3cd60 \(pid 2893918\)/);
        assert.match(error.message, /Waited \d+s for it to release/);
        assert.match(error.message, /Close that session/);
        return true;
      },
    );
    assert.ok(h.clk.elapsed() <= 10_000, "the wait is bounded by the configured window");
  });

  it("waits for repository custody the same way", async () => {
    const h = harness(2, 30_000, "MSN-repo");
    const missionLease = await h.ownership.acquire(h.missionId, { resumptionGeneration: 0 });
    const repoLease = await h.ownership.acquireRepository(missionLease, "repo-0123456789abcdef");
    assert.equal(repoLease.repoId, "repo-0123456789abcdef");
  });
});
