import assert from "node:assert/strict";
import { test } from "node:test";
import { type GitPrimitives, MergeQueue } from "../../src/merge/MergeQueue.ts";

function git(over: Partial<GitPrimitives> = {}): GitPrimitives {
  return {
    currentBranch: async () => "main",
    branchExists: async () => true,
    rebaseOnto: async () => ({ ok: true }),
    mergeBranch: async () => ({ merged: true, conflict: false, reason: null }),
    headCommit: async () => "abc123",
    runIntegrationGate: async () => true,
    ...over,
  };
}

test("merge: promotes clean candidate through candidate->integration->main", async () => {
  const calls: string[] = [];
  const g = git({
    rebaseOnto: async () => {
      calls.push("rebase");
      return { ok: true };
    },
    runIntegrationGate: async () => {
      calls.push("gate");
      return true;
    },
    mergeBranch: async () => {
      calls.push("merge");
      return { merged: true, conflict: false, reason: null };
    },
  });
  const q = new MergeQueue({ git: g });
  const res = await q.promote("pi-eng-cand");
  assert.equal(res.ok, true);
  assert.equal(res.level, "main");
  assert.deepEqual(calls, ["rebase", "gate", "merge"]);
});

test("merge: rejects when the candidate branch does not exist", async () => {
  const q = new MergeQueue({ git: git({ branchExists: async () => false }) });
  const res = await q.promote("nope");
  assert.equal(res.ok, false);
  assert.equal(res.level, "candidate");
});

test("merge: rejects on rebase conflict", async () => {
  const q = new MergeQueue({ git: git({ rebaseOnto: async () => ({ ok: false, conflict: "src/x.ts" }) }) });
  const res = await q.promote("pi-eng-cand");
  assert.equal(res.ok, false);
  assert.equal(res.level, "integration");
  assert.match(res.reason ?? "", /conflict/);
});

test("merge: rejects when the integration gate fails", async () => {
  const q = new MergeQueue({ git: git({ runIntegrationGate: async () => false }) });
  const res = await q.promote("pi-eng-cand");
  assert.equal(res.ok, false);
  assert.equal(res.level, "integration");
});

test("merge: rejects on merge conflict", async () => {
  const q = new MergeQueue({
    git: git({ mergeBranch: async () => ({ merged: false, conflict: true, reason: "merge conflict" }) }),
  });
  const res = await q.promote("pi-eng-cand");
  assert.equal(res.ok, false);
  assert.equal(res.level, "main");
});

test("merge: serializes concurrent promotions (no index race)", async () => {
  const order: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const g = git({
    mergeBranch: async (b) => {
      order.push(`start:${b}`);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      order.push(`end:${b}`);
      return { merged: true, conflict: false, reason: null };
    },
  });
  const q = new MergeQueue({ git: g });
  const results = await Promise.all([q.promote("cand-1"), q.promote("cand-2"), q.promote("cand-3")]);
  assert.equal(peak, 1, "promotions must not overlap");
  assert.equal(results.filter((r) => r.ok).length, 3);
});

test("merge: gate can be disabled", async () => {
  let gateCalled = false;
  const q = new MergeQueue({
    git: git({
      runIntegrationGate: async () => {
        gateCalled = true;
        return true;
      },
    }),
    requireGate: false,
  });
  const res = await q.promote("cand");
  assert.equal(res.ok, true);
  assert.equal(gateCalled, false);
});
