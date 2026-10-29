import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import type { MissionLease, RepositoryLease } from "../../src/orchestration/types.ts";
import type { EventStoreBackend, StoredEvent } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { resolveRuntimeBinding } from "../../src/runtime/isolation/RuntimeBinding.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

/** Probe: does this process still hold the runtime's session event writer? */
function sessionWriter(runtime: EngineeringRuntime): () => boolean {
  const eventsDir = runtime.runtimeBinding?.eventsDir;
  if (!eventsDir) throw new Error("runtime has no durable namespace");
  const sessionId = RuntimeSession.current().sessionId;
  return () => SessionEventStore.isOpen(eventsDir, sessionId);
}

function mission(store: MissionStore, missionId: string) {
  return store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "test durable ownership",
    user_request: "test durable ownership",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
}

/**
 * A MissionOwnership that fails its next N renew calls (to simulate a transient
 * lease-renewal blip), then recovers. Used to prove a live dispatch authority
 * survives transient failures instead of latching its heartbeat dead.
 */
class FlakyRenewOwnership extends MissionOwnership {
  private failuresRemaining = 0;
  setFailures(n: number): void {
    this.failuresRemaining = n;
  }
  override async renew(identity: MissionLease): Promise<MissionLease> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("injected transient renewal failure");
    }
    return super.renew(identity);
  }
}

/**
 * Simulates a FENCE_RECONCILE_AND_RESUME recovery re-fencing the repository lease while a live
 * dispatch authority still holds the old identity: the next repository renewal is rejected as a
 * stale fencing identity, and the authority's re-acquisition returns a lease one generation ahead.
 */
class StaleRepositoryOwnership extends MissionOwnership {
  private staleRenew = false;
  private reFenceOnAcquire = false;
  private readonly storeRef: MissionStore;
  constructor(store: MissionStore, options: ConstructorParameters<typeof MissionOwnership>[1]) {
    super(store, options);
    this.storeRef = store;
  }
  armStaleRepository(): void {
    this.staleRenew = true;
    this.reFenceOnAcquire = true;
  }
  override async renewRepository(identity: RepositoryLease): Promise<RepositoryLease> {
    if (this.staleRenew) {
      this.staleRenew = false;
      throw new Error(
        `stale repository fencing identity for ${identity.missionId}: generation=${identity.generation} fencingToken=${identity.fencingToken}`,
      );
    }
    return super.renewRepository(identity);
  }
  override async acquireRepository(identity: MissionLease, repoId: string): Promise<RepositoryLease> {
    if (this.reFenceOnAcquire) {
      this.reFenceOnAcquire = false;
      const current = this.storeRef.getRepositoryLeaseByRepoId(repoId);
      if (current) {
        const reFenced: RepositoryLease = {
          ...current,
          generation: current.generation + 1,
          fencingToken: current.fencingToken + 1,
        };
        this.storeRef.transitionRepositoryLease("acquired", reFenced);
        await this.storeRef.flush();
        return reFenced;
      }
    }
    return super.acquireRepository(identity, repoId);
  }
}

/**
 * Simulates a FENCE_RECONCILE_AND_RESUME recovery re-fencing the MISSION lease while a live
 * dispatch authority still holds the old identity: the next mission renewal is rejected as a
 * stale fencing identity, and the authority's re-acquisition returns a lease one generation ahead.
 */
class StaleMissionOwnership extends MissionOwnership {
  private staleRenew = false;
  private reFenceOnAcquire = false;
  private readonly storeRef: MissionStore;
  constructor(store: MissionStore, options: ConstructorParameters<typeof MissionOwnership>[1]) {
    super(store, options);
    this.storeRef = store;
  }
  armStaleMission(): void {
    this.staleRenew = true;
    this.reFenceOnAcquire = true;
  }
  override async renew(identity: MissionLease): Promise<MissionLease> {
    if (this.staleRenew) {
      this.staleRenew = false;
      throw new Error(
        `stale mission fencing identity for ${identity.missionId}: generation=${identity.generation} fencingToken=${identity.fencingToken}`,
      );
    }
    return super.renew(identity);
  }
  override async acquire(missionId: string, options: { resumptionGeneration?: number } = {}): Promise<MissionLease> {
    if (this.reFenceOnAcquire) {
      this.reFenceOnAcquire = false;
      const current = this.storeRef.getMissionLease(missionId);
      if (current) {
        const reFenced: MissionLease = {
          ...current,
          generation: current.generation + 1,
          fencingToken: current.fencingToken + 1,
        };
        this.storeRef.transitionMissionLease("acquired", reFenced);
        await this.storeRef.flush();
        return { ...reFenced };
      }
    }
    return super.acquire(missionId, options);
  }
}

describe("MissionOwnership", () => {
  it("fails closed when a backend does not explicitly prove writer authority", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const events: StoredEvent[] = [];
    const backend: EventStoreBackend = {
      append: async (event) => {
        events.push(event);
        return event;
      },
      appendConditionally: async (event, condition, onCommit) => {
        if (!condition()) return undefined;
        events.push(event);
        onCommit?.();
        return event;
      },
      appendAll: async (batch) => {
        events.push(...batch);
      },
      all: () => events.slice(),
      get: (eventId) => events.find((event) => event.event_id === eventId),
      count: () => events.length,
    };
    const store = MissionStore.open(backend);
    mission(store, "M-closed");
    await store.flush();

    const ownership = new MissionOwnership(store, { ownerId: "controller" });
    await assert.rejects(() => ownership.acquire("M-closed"), /writer authority/i);
  });

  it("renews a lease without changing its generation or fencing token", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    const ownership = new MissionOwnership(store, {
      ownerId: "controller-a",
      now: () => now,
      leaseMs: 60_000,
    });

    const acquired = await ownership.acquire("M-1");
    now += 30_000;
    const renewed = await ownership.renew(acquired);

    assert.equal(renewed.generation, 1);
    assert.equal(renewed.fencingToken, 1);
    assert.equal(renewed.renewBy, "2026-09-26T10:01:30.000Z");
    assert.deepEqual(store.getMissionLease("M-1"), renewed);
  });

  it("does not let one overlapping same-owner flight release another flight's epoch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-overlap");
    const ownership = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 60_000,
    });

    const first = await ownership.acquire("M-overlap", {
      resumptionGeneration: 0,
    });
    const second = await ownership.acquire("M-overlap", {
      resumptionGeneration: 0,
    });
    assert.equal(first.generation, second.generation);

    await ownership.release(first);

    assert.doesNotThrow(() => ownership.assertAuthoritative(second));
    assert.deepEqual(store.getMissionLease("M-overlap"), second);
    await ownership.release(second);
    assert.equal(store.getMissionLease("M-overlap"), undefined);
  });

  it("reference-counts overlapping same-owner repository authorities by exact lease epoch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-repo-overlap");
    const ownership = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 60_000,
    });
    const missionIdentity = await ownership.acquire("M-repo-overlap", {
      resumptionGeneration: 0,
    });

    const first = await ownership.maintain(missionIdentity, "repo-shared-epoch");
    const second = await ownership.maintain(missionIdentity, "repo-shared-epoch");
    assert.equal(first.repositoryIdentity?.generation, second.repositoryIdentity?.generation);
    assert.equal(first.repositoryIdentity?.fencingToken, second.repositoryIdentity?.fencingToken);

    await first.close();

    assert.doesNotThrow(() => second.assertAuthoritative());
    assert.deepEqual(store.getRepositoryLeaseByRepoId("repo-shared-epoch"), second.repositoryIdentity);
    await second.close();
    assert.equal(store.getRepositoryLeaseByRepoId("repo-shared-epoch"), undefined);
  });

  it("cannot let a stale resumption epoch release the fresh owner's repository lease", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-repo-resume");
    const ownership = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 60_000,
    });
    const staleMission = await ownership.acquire("M-repo-resume", {
      resumptionGeneration: 0,
    });
    const stale = await ownership.maintain(staleMission, "repo-resume");

    store.resumeMission("M-repo-resume", "operator resumed while repository work was active", "operator");
    const currentMission = await ownership.acquire("M-repo-resume", {
      resumptionGeneration: 1,
    });
    const current = await ownership.maintain(currentMission, "repo-resume");

    assert.ok(await stale.close(), "stale close reports authority loss");
    assert.doesNotThrow(() => current.assertAuthoritative());
    assert.deepEqual(store.getRepositoryLeaseByRepoId("repo-resume"), current.repositoryIdentity);
    await current.close();
  });

  it("fences the prior resumption epoch before the same owner acquires the next one", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-resume");
    const ownership = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 60_000,
    });
    const stale = await ownership.acquire("M-resume", {
      resumptionGeneration: 0,
    });

    store.resumeMission("M-resume", "explicit operator resumption", "operator");
    const current = await ownership.acquire("M-resume", {
      resumptionGeneration: 1,
    });

    assert.equal(current.generation, stale.generation + 1);
    assert.equal(current.resumptionGeneration, 1);
    assert.throws(() => ownership.assertAuthoritative(stale), /stale.*resumption|stale.*fencing/i);
    await assert.rejects(() => ownership.release(stale), /stale.*resumption|stale.*fencing/i);
    assert.doesNotThrow(() => ownership.assertAuthoritative(current));
  });

  it("expires an overdue lease and reacquires it with a higher epoch", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    const firstOwner = new MissionOwnership(store, {
      ownerId: "controller-a",
      now: () => now,
      leaseMs: 10_000,
    });
    const first = await firstOwner.acquire("M-1");
    const firstRepository = await firstOwner.acquireRepository(first, "repo-takeover");
    now += 5_000;
    await firstOwner.renewRepository(firstRepository);

    now += 5_001;
    assert.throws(() => firstOwner.assertAuthoritative(first), /expired/i);
    await assert.rejects(() => firstOwner.renew(first), /expired/i);
    const secondOwner = new MissionOwnership(store, {
      ownerId: "controller-b",
      now: () => now,
      leaseMs: 10_000,
    });
    const second = await secondOwner.acquire("M-1");

    assert.equal(second.generation, 2);
    assert.equal(second.fencingToken, 2);
    assert.equal(second.ownerId, "controller-b");
    const repository = await secondOwner.acquireRepository(second, "repo-takeover");
    assert.equal(repository.generation, 2);
    assert.equal(repository.ownerId, "controller-b");
  });

  it("serializes repository mutation authority by repoId across missions", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    mission(store, "M-2");
    const owner = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 60_000,
    });
    const firstMission = await owner.acquire("M-1");
    const secondMission = await owner.acquire("M-2");
    await owner.acquireRepository(firstMission, "repo-shared");

    await assert.rejects(() => owner.acquireRepository(secondMission, "repo-shared"), /repo-shared.*M-1/i);
  });

  it("renews mission and repository authority throughout a long dispatch", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    const owner = new MissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 10,
    });
    const missionIdentity = await owner.acquire("M-1");
    const authority = await owner.maintain(missionIdentity, "repo-long");
    const firstRenewBy = authority.missionIdentity.renewBy;

    const renewalDeadline = Date.now() + 2_000;
    while (authority.missionIdentity.renewBy === firstRenewBy && Date.now() < renewalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    authority.assertAuthoritative();
    assert.notEqual(authority.missionIdentity.renewBy, firstRenewBy);
    assert.equal(store.getRepositoryLeaseByRepoId("repo-long")?.missionId, "M-1");

    await authority.close();
    assert.equal(store.getRepositoryLeaseByRepoId("repo-long"), undefined);
  });

  it("recovers a transient lease renewal failure instead of latching the heartbeat dead", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-lease-transient");
    const owner = new FlakyRenewOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 15,
    });
    const identity = await owner.acquire("M-lease-transient");
    const authority = await owner.maintain(identity, "repo-transient");
    try {
      // Inject a single transient failure on the next heartbeat tick, then let
      // subsequent ticks run. The old code latched `failure` on the first error
      // and every later pulse became a no-op, so one blip lapsed a live
      // controller lease and orphaned a running mission. The fix retries.
      owner.setFailures(1);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
      // Still authoritative: the transient failure was retried and recovered.
      authority.assertAuthoritative();
      assert.match(authority.lastPulseError?.message ?? "", /injected transient renewal failure/);
    } finally {
      await authority.close();
    }
  });

  it("invalidates a dispatch authority only after sustained renewal failures", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-lease-sustained");
    const owner = new FlakyRenewOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 15,
      maxConsecutiveRenewFailures: 2,
    });
    const identity = await owner.acquire("M-lease-sustained");
    const authority = await owner.maintain(identity, "repo-sustained");
    try {
      // A failure that never recovers must still invalidate the authority, but
      // only once consecutive failures reach the configured threshold.
      owner.setFailures(Number.MAX_SAFE_INTEGER);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
      assert.throws(() => authority.assertAuthoritative(), /lease renewal failed 2 times in a row/);
      assert.ok(authority.lastPulseError);
    } finally {
      await authority.close();
    }
  });

  it("survives a sub-threshold run of renewal failures", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-lease-subthreshold");
    const owner = new FlakyRenewOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 15,
      maxConsecutiveRenewFailures: 3,
    });
    const identity = await owner.acquire("M-lease-subthreshold");
    const authority = await owner.maintain(identity, "repo-subthreshold");
    try {
      // Two consecutive failures, then recovery: below the threshold of 3, so
      // the authority must survive.
      owner.setFailures(2);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
      authority.assertAuthoritative();
    } finally {
      await authority.close();
    }
  });

  it("invalidates a re-fenced repository dispatch without adopting the new epoch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-lease-stale-repo");
    const owner = new StaleRepositoryOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 15,
      // Stale epochs invalidate immediately even when transient errors are tolerated.
      maxConsecutiveRenewFailures: 3,
    });
    const identity = await owner.acquire("M-lease-stale-repo");
    const authority = await owner.maintain(identity, "repo-stale");
    const originalGeneration = authority.repositoryIdentity?.generation ?? 0;
    try {
      // A recovery re-fenced the repository lease to a new generation while the
      // authority still held the old identity. Inject the stale epoch on the next
      // renewal; the dispatch must not acquire the replacement lease.
      owner.armStaleRepository();
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
      assert.throws(() => authority.assertAuthoritative(), /stale.*fencing identity/);
      assert.match(authority.lastPulseError?.message ?? "", /stale repository fencing identity/);
      // The dispatch retains its original epoch.
      assert.equal(authority.repositoryIdentity?.generation, originalGeneration);
    } finally {
      await authority.close();
    }
  });

  it("invalidates a re-fenced mission dispatch without adopting the new epoch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-lease-stale-mission");
    const owner = new StaleMissionOwnership(store, {
      ownerId: "controller",
      leaseMs: 5_000,
      heartbeatMs: 15,
      // Stale epochs invalidate immediately even when transient errors are tolerated.
      maxConsecutiveRenewFailures: 3,
    });
    const identity = await owner.acquire("M-lease-stale-mission");
    const authority = await owner.maintain(identity);
    const originalGeneration = authority.missionIdentity?.generation ?? 0;
    try {
      // A recovery re-fenced the MISSION lease to a new generation while the
      // authority still held the old identity. Inject the stale epoch on the next
      // renewal; the dispatch must not acquire the replacement lease.
      owner.armStaleMission();
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
      assert.throws(() => authority.assertAuthoritative(), /stale.*fencing identity/);
      assert.match(authority.lastPulseError?.message ?? "", /stale mission fencing identity/);
      // The dispatch retains its original epoch.
      assert.equal(authority.missionIdentity?.generation, originalGeneration);
    } finally {
      await authority.close();
    }
  });

  it("rejects an old fencing token after takeover and process restart", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const dir = await mkdtemp(join(tmpdir(), "pie-ownership-restart-"));
    const file = join(dir, "events.jsonl");
    let now = Date.parse("2026-09-26T10:00:00.000Z");

    const backend1 = await JsonlEventStore.open(file);
    const store1 = MissionStore.open(backend1);
    mission(store1, "M-1");
    const ownership1 = new MissionOwnership(store1, {
      ownerId: "controller-a",
      now: () => now,
      leaseMs: 10_000,
    });
    const stale = await ownership1.acquire("M-1");
    await store1.flush();
    backend1.close();

    now += 10_001;
    const backend2 = await JsonlEventStore.open(file);
    const store2 = MissionStore.open(backend2);
    const ownership2 = new MissionOwnership(store2, {
      ownerId: "controller-b",
      now: () => now,
      leaseMs: 10_000,
    });
    const current = await ownership2.acquire("M-1");

    assert.equal(current.generation, 2);
    assert.throws(() => ownership2.assertAuthoritative(stale), /stale.*fencing/i);
    assert.doesNotThrow(() => ownership2.assertAuthoritative(current));
    backend2.close();
  });

  it("keeps a shared runtime writer lock until the final runtime closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pie-runtime-ownership-"));
    const workDir = join(root, ".pi-eng");
    const first = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
    });
    const second = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
    });

    const writer = sessionWriter(first);
    await first.close();
    assert.equal(writer(), true, "the shared session writer outlives the first close");
    await second.close();
    assert.equal(writer(), false, "the final close releases the session writer");
  });

  it("accounts for every concurrent open of the single-flight runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pie-runtime-concurrent-ownership-"));
    const workDir = join(root, ".pi-eng");
    const [first, second] = await Promise.all([
      EngineeringRuntime.open({
        cwd: root,
        workDir,
        worker: new FakeWorkerExecutor({}),
      }),
      EngineeringRuntime.open({
        cwd: root,
        workDir,
        worker: new FakeWorkerExecutor({}),
      }),
    ]);
    assert.strictEqual(first, second);

    const writer = sessionWriter(first);
    await first.close();
    assert.equal(writer(), true, "every concurrent open holds a reference");
    await second.close();
    assert.equal(writer(), false);
  });

  it("rolls back the writer reference when runtime initialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pie-runtime-failed-open-"));
    const workDir = join(root, ".pi-eng");
    await assert.rejects(
      () =>
        EngineeringRuntime.open({
          cwd: root,
          workDir,
          worker: new FakeWorkerExecutor({}),
          blackhole: { config: { memoryWorkerConcurrency: 0 } },
        }),
      /memoryWorkerConcurrency/,
    );

    const sessionId = RuntimeSession.current().sessionId;
    const binding = resolveRuntimeBinding({ identity: await resolveWorktreeIdentity(root), workDir, sessionId });
    assert.equal(SessionEventStore.isOpen(binding.eventsDir!, sessionId), false, "no writer reference leaks");
  });

  it("keeps close retryable when flushing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pie-runtime-close-retry-"));
    const workDir = join(root, ".pi-eng");
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
    });
    const store = runtime.missionStore!;
    const originalFlush = store.flush.bind(store);
    let attempts = 0;
    store.flush = async () => {
      attempts++;
      if (attempts === 1) throw new Error("injected close flush failure");
      await originalFlush();
    };

    const writer = sessionWriter(runtime);
    await assert.rejects(() => runtime.close(), /injected close flush failure/);
    assert.strictEqual(runtime.missionStore, store, "failed close must leave the runtime usable");
    assert.equal(writer(), true, "a failed close keeps the session writer");

    await runtime.close();
    assert.equal(writer(), false);
  });

  it("does not let lease release failure mask a completed mission outcome", async () => {
    class FailingReleaseOwnership extends MissionOwnership {
      override async release(): Promise<void> {
        throw new Error("injected lease release failure");
      }
    }
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      planner: async () => [],
      ownership: new FailingReleaseOwnership(store, {
        ownerId: "release-test",
      }),
    });

    const result = await orchestrator.orchestrate("Explain the ownership model", {
      repository: ".",
      baseRef: "",
      mutationRequested: false,
    });

    assert.equal(result.completed, true);
    assert.equal(result.mission.status, "COMPLETE");
    await store.flush();
    const finding = MissionStore.open(backend)
      .listFindings(result.mission.mission_id)
      .find((candidate) => candidate.category === "ownership_release");
    assert.ok(finding, "mission release failure must be durable and operator-visible");
    assert.match(finding.summary, /mission ownership release failed/i);
    assert.match(finding.evidence ?? "", /injected lease release failure/);
    assert.match(finding.evidence ?? "", /fencingToken/);
  });
});
