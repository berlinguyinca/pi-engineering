import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INTEGRATION_DOMAIN,
  InMemoryLaneCoordinator,
  LaneBlockedError,
  type LaneConfig,
  laneDomainsOf,
  laneKeyFor,
  resolveLaneConfig,
} from "../../src/orchestration/lanes.ts";

describe("resolveLaneConfig", () => {
  it("keeps defaults when no env vars are set", () => {
    assert.deepEqual(resolveLaneConfig({}), { backend: "auto", leaseMs: 300_000, maxRepoWriters: 4 });
  });

  it("resolves all three operator-configured values", () => {
    const cfg = resolveLaneConfig({
      PI_ENGINEERING_MAX_REPO_WRITERS: "9",
      PI_ENGINEERING_LANE_LEASE_MS: "60000",
      PI_ENGINEERING_LANE_BACKEND: "git",
    });
    assert.deepEqual(cfg, { backend: "git", leaseMs: 60_000, maxRepoWriters: 9 });
  });

  it("falls back per key on invalid values", () => {
    const cfg = resolveLaneConfig({
      PI_ENGINEERING_MAX_REPO_WRITERS: "abc",
      PI_ENGINEERING_LANE_LEASE_MS: "0",
      PI_ENGINEERING_LANE_BACKEND: "nonsense",
    });
    assert.deepEqual(cfg, { backend: "auto", leaseMs: 300_000, maxRepoWriters: 4 });
  });

  it("treats negative numbers as invalid for lease and writer keys", () => {
    const cfg = resolveLaneConfig({
      PI_ENGINEERING_MAX_REPO_WRITERS: "-3",
      PI_ENGINEERING_LANE_LEASE_MS: "-1",
    });
    assert.equal(cfg.maxRepoWriters, 4);
    assert.equal(cfg.leaseMs, 300_000);
  });
});

describe("lane key and domain helpers", () => {
  it("derives a stable digest lane ref per repo", () => {
    const key = laneKeyFor("repo-a");
    assert.match(key, /^refs\/lanes\/[0-9a-f]{64}$/);
    assert.equal(key, laneKeyFor("repo-a"));
    assert.notEqual(key, laneKeyFor("repo-b"));
  });

  it("maps integration tasks to the reserved domain and normalizes agent domains", () => {
    assert.deepEqual(laneDomainsOf({ kind: "integration", write_domains: [] }), [INTEGRATION_DOMAIN]);
    assert.deepEqual(laneDomainsOf({ kind: "agent", write_domains: ["src/a/**"] }), ["src/a"]);
  });

  it("treats a mutating task with no write domains as whole-repo (Review Focus 4)", () => {
    assert.deepEqual(laneDomainsOf({ kind: "agent", write_domains: [] }), ["**"]);
  });
});

function coordinatorAt(overrides: Partial<LaneConfig> = {}) {
  let current = 1_000;
  const cfg: LaneConfig = { backend: "memory", leaseMs: 100, maxRepoWriters: 4, ...overrides };
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    lanes: new InMemoryLaneCoordinator({ config: cfg, now: () => current }),
  };
}

const base = { repoId: "repo:/x", ownerId: "hostA/owner1", missionId: "MSN-1", taskId: "TSK-1" };

describe("InMemoryLaneCoordinator", () => {
  it("grants disjoint domains on the same repo", async () => {
    const { lanes } = coordinatorAt();
    const a = await lanes.acquire({ ...base, domains: ["src/a"] });
    assert.equal(a.renewBy, 1_100);
    const b = await lanes.acquire({ ...base, ownerId: "hostB/owner2", taskId: "TSK-2", domains: ["src/b"] });
    assert.equal(b.taskId, "TSK-2");
    assert.equal((await lanes.listClaims("repo:/x")).length, 2);
  });

  it("rejects an overlapping domain naming the blocking claim", async () => {
    const { lanes } = coordinatorAt();
    await lanes.acquire({ ...base, domains: ["src/a"] });
    await assert.rejects(
      lanes.acquire({
        ...base,
        ownerId: "hostB/o2",
        taskId: "TSK-2",
        missionId: "MSN-2",
        domains: ["src/a/nested/**"],
      }),
      (error: unknown) => {
        assert.ok(error instanceof LaneBlockedError);
        assert.equal(error.blockingClaims.length, 1);
        assert.equal(error.blockingClaims[0]?.ownerId, "hostA/owner1");
        return true;
      },
    );
  });

  it("serializes prefix overlaps in both directions", async () => {
    const { lanes } = coordinatorAt();
    await lanes.acquire({ ...base, domains: ["src"] });
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-2", domains: ["src/orchestration"] }), LaneBlockedError);
    const { lanes: lanes2 } = coordinatorAt();
    await lanes2.acquire({ ...base, domains: ["src/orchestration"] });
    await assert.rejects(lanes2.acquire({ ...base, taskId: "TSK-2", domains: ["src"] }), LaneBlockedError);
  });

  it("makes the whole-repo domain overlap everything, both directions", async () => {
    const { lanes } = coordinatorAt();
    await lanes.acquire({ ...base, domains: ["**"] });
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-2", domains: ["docs"] }), LaneBlockedError);
    const { lanes: lanes2 } = coordinatorAt();
    await lanes2.acquire({ ...base, domains: ["docs"] });
    await assert.rejects(lanes2.acquire({ ...base, taskId: "TSK-2", domains: ["**"] }), LaneBlockedError);
  });

  it("keeps a claim live at exactly renewBy and allows takeover one ms past, fencing +1", async () => {
    const { now, advance, lanes } = coordinatorAt({ leaseMs: 100 });
    const first = await lanes.acquire({ ...base, domains: ["src/a"] });
    assert.equal(first.renewBy, 1_100);
    // now === renewBy: still live (Review Focus 3).
    advance(100);
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-2", domains: ["src/a"] }), LaneBlockedError);
    // one ms past expiry: take over, old entry gone, fence = old + 1.
    advance(1);
    const taken = await lanes.acquire({
      ...base,
      ownerId: "hostB/o2",
      missionId: "MSN-2",
      taskId: "TSK-2",
      domains: ["src/a"],
    });
    assert.equal(taken.fence, first.fence + 1);
    const claims = await lanes.listClaims("repo:/x");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.taskId, "TSK-2");
  });

  it("enforces the per-repo writer cap and treats 0 as unlimited", async () => {
    const { lanes } = coordinatorAt({ maxRepoWriters: 2 });
    await lanes.acquire({ ...base, domains: ["a"] });
    await lanes.acquire({ ...base, taskId: "TSK-2", domains: ["b"] });
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-3", domains: ["c"] }), LaneBlockedError);
    const { lanes: open } = coordinatorAt({ maxRepoWriters: 0 });
    for (let i = 0; i < 5; i++) {
      await open.acquire({ ...base, taskId: `TSK-${i}`, domains: [`d${i}`] });
    }
    assert.equal((await open.listClaims("repo:/x")).length, 5);
  });

  it("lets the integration lane overlap only other integrations, even against a wildcard claim", async () => {
    const { lanes } = coordinatorAt();
    const integration = await lanes.acquire({ ...base, domains: [INTEGRATION_DOMAIN] });
    // A worker may run while an integrator holds its lane (spec 4.4) —
    // including a whole-repo worker: integration never overlaps a work domain.
    await lanes.acquire({ ...base, taskId: "TSK-2", domains: ["**"] });
    // …but a second integration must wait (blocked only by the first).
    await assert.rejects(
      lanes.acquire({ ...base, taskId: "TSK-3", domains: [INTEGRATION_DOMAIN] }),
      (error: unknown) => {
        assert.ok(error instanceof LaneBlockedError);
        assert.deepEqual(
          error.blockingClaims.map((claim) => claim.taskId),
          ["TSK-1"],
        );
        return true;
      },
    );
    assert.ok(integration.fence >= 1);
  });

  it("does not count integration claims against the writer cap", async () => {
    const { lanes } = coordinatorAt({ maxRepoWriters: 1 });
    await lanes.acquire({ ...base, domains: [INTEGRATION_DOMAIN] });
    await lanes.acquire({ ...base, taskId: "TSK-2", domains: ["src/a"] });
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-3", domains: ["src/b"] }), LaneBlockedError);
  });

  it("re-acquires for the same taskId without self-deadlock or cap double-count (Review Focus 2)", async () => {
    const { lanes } = coordinatorAt({ maxRepoWriters: 1 });
    const first = await lanes.acquire({ ...base, domains: ["src/a"] });
    // Same domain: refresh re-fences max+1 over the prior claim.
    const same = await lanes.acquire({ ...base, domains: ["src/a"] });
    assert.equal(same.fence, first.fence + 1);
    // Overlapping-but-different domain: still succeeds, one claim set held.
    const again = await lanes.acquire({ ...base, domains: ["src/a/deep/**"] });
    assert.equal(again.taskId, "TSK-1");
    assert.equal((await lanes.listClaims("repo:/x")).length, 1);
    // A different task still must wait.
    await assert.rejects(lanes.acquire({ ...base, taskId: "TSK-2", domains: ["src/a"] }), LaneBlockedError);
  });

  it("renews a held lease and returns null once released or taken over (Review Focus 1)", async () => {
    const { now, advance, lanes } = coordinatorAt({ leaseMs: 100 });
    const lease = await lanes.acquire({ ...base, domains: ["src/a"] });
    advance(50);
    const renewed = await lanes.renew(lease);
    assert.ok(renewed);
    assert.equal(renewed.renewBy, now() + 100);
    await lanes.release(lease);
    assert.equal(await lanes.renew(lease), null);
    // Takeover: renewing the dead lease must not resurrect it or clobber the new claim.
    const other = await lanes.acquire({ ...base, ownerId: "hostB/o2", taskId: "TSK-2", domains: ["src/a"] });
    const zombie = await lanes.renew(lease);
    assert.equal(zombie, null);
    const claims = await lanes.listClaims("repo:/x");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.taskId, other.taskId);
  });

  it("releases idempotently", async () => {
    const { lanes } = coordinatorAt();
    const lease = await lanes.acquire({ ...base, domains: ["src/a"] });
    await lanes.release(lease);
    await lanes.release(lease);
    assert.equal((await lanes.listClaims("repo:/x")).length, 0);
  });

  it("lists only live claims", async () => {
    const { advance, lanes } = coordinatorAt({ leaseMs: 100 });
    await lanes.acquire({ ...base, domains: ["src/a"] });
    advance(101);
    assert.deepEqual(await lanes.listClaims("repo:/x"), []);
  });
});
