import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdapterRegistry,
  type AutoSpecAdapter,
  type AutoSpecHandle,
  type AutoSpecObservation,
  type AutoSpecOwner,
  type AutoSpecRunState,
  type AutoSpecSubmission,
  StaleFencingTokenError,
  isStaleAutoSpecOwner,
} from "../../src/adapters/Adapters.ts";

/** An in-process AutoSpec that applies the contract's fencing rule. */
function fakeAutoSpec(): AutoSpecAdapter & { runs: number } {
  const runs = new Map<string, { owner: AutoSpecOwner; state: AutoSpecRunState; sequence: number; at?: string }>();
  const byKey = new Map<string, AutoSpecHandle>();
  const fake = {
    name: "autospec" as const,
    runs: 0,
    async submit(sub: AutoSpecSubmission): Promise<AutoSpecHandle> {
      const seen = byKey.get(`${sub.missionId}:${sub.idempotencyKey}`);
      if (seen) return seen;
      const holder = [...runs.entries()].find(([id]) => id.startsWith(`${sub.missionId}/`))?.[1].owner;
      if (holder && isStaleAutoSpecOwner(holder, sub.owner)) {
        return { externalId: "", accepted: false, reason: "stale-fencing-token" };
      }
      const externalId = `${sub.missionId}/${sub.taskId}/${++fake.runs}`;
      runs.set(externalId, { owner: sub.owner, state: "running", sequence: 1, at: "2026-10-15T00:00:00Z" });
      const handle = { externalId, accepted: true };
      byKey.set(`${sub.missionId}:${sub.idempotencyKey}`, handle);
      return handle;
    },
    async observe(externalId: string, owner: AutoSpecOwner): Promise<AutoSpecObservation> {
      const run = runs.get(externalId);
      if (!run) throw new Error(`unknown run ${externalId}`);
      if (isStaleAutoSpecOwner(run.owner, owner)) throw new StaleFencingTokenError(externalId, owner, run.owner);
      run.owner = owner;
      return { state: run.state, lastProgressAt: run.at, sequence: run.sequence };
    },
    async cancel(externalId: string, owner: AutoSpecOwner) {
      const run = runs.get(externalId);
      if (!run || isStaleAutoSpecOwner(run.owner, owner)) return { cancelled: false, stale: true };
      run.owner = owner;
      run.state = "cancelled";
      run.sequence++;
      return { cancelled: true, stale: false };
    },
  };
  return fake;
}

const owner1: AutoSpecOwner = { ownerId: "pi-a", fencingToken: 3 };
const submission = (over: Partial<AutoSpecSubmission> = {}): AutoSpecSubmission => ({
  missionId: "MSN-1",
  taskId: "T1",
  request: "implement isEven",
  baseSha: "abc123",
  owner: owner1,
  idempotencyKey: "k1",
  ...over,
});

test("autospec adapter: the registry is empty by default (core standalone)", () => {
  assert.equal(new AdapterRegistry().hasAdapters, false);
  assert.equal(new AdapterRegistry().autospecAdapter, null);
});

test("autospec adapter: submit, observe and cancel go through an installed adapter", async () => {
  const reg = new AdapterRegistry({ autospec: fakeAutoSpec() });
  assert.equal(reg.hasAdapters, true);
  const adapter = reg.autospecAdapter!;
  const handle = await adapter.submit(submission());
  assert.equal(handle.accepted, true);
  const seen = await adapter.observe(handle.externalId, owner1);
  assert.equal(seen.state, "running");
  assert.equal(seen.sequence, 1);
  const cancel = await adapter.cancel(handle.externalId, owner1, "operator stop");
  assert.deepEqual(cancel, { cancelled: true, stale: false });
  assert.equal((await adapter.observe(handle.externalId, owner1)).state, "cancelled");
});

test("autospec adapter: submitting the same idempotency key twice returns one run", async () => {
  const adapter = fakeAutoSpec();
  const a = await adapter.submit(submission());
  const b = await adapter.submit(submission());
  assert.equal(a.externalId, b.externalId);
  assert.equal(adapter.runs, 1);
});

test("autospec adapter: a stale fencing token cannot submit, observe or cancel", async () => {
  const adapter = fakeAutoSpec();
  const handle = await adapter.submit(submission());
  const newer: AutoSpecOwner = { ownerId: "pi-b", fencingToken: 4 };
  // A new owner takes over the run with a higher token.
  assert.equal((await adapter.cancel(handle.externalId, newer, "takeover")).cancelled, true);
  // The previous owner is now behind.
  await assert.rejects(adapter.observe(handle.externalId, owner1), StaleFencingTokenError);
  assert.deepEqual(await adapter.cancel(handle.externalId, owner1, "late"), { cancelled: false, stale: true });
  const late = await adapter.submit(submission({ idempotencyKey: "k2", owner: owner1 }));
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "stale-fencing-token");
});

test("autospec adapter: the fencing rule", () => {
  const holder: AutoSpecOwner = { ownerId: "pi-a", fencingToken: 5 };
  assert.equal(isStaleAutoSpecOwner(holder, { ownerId: "pi-a", fencingToken: 5 }), false);
  assert.equal(isStaleAutoSpecOwner(holder, { ownerId: "pi-b", fencingToken: 6 }), false);
  assert.equal(isStaleAutoSpecOwner(holder, { ownerId: "pi-a", fencingToken: 4 }), true);
  assert.equal(isStaleAutoSpecOwner(holder, { ownerId: "pi-b", fencingToken: 5 }), true);
});
