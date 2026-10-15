/**
 * Issue #150: a per-target, SHA-fenced merge queue. An entry is bound to the
 * head SHA that was reviewed and the base SHA it was validated against; a moved
 * head or target tip means rebase, gate rerun and a fresh baseline before the
 * merge. Required checks block when failing or pending.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  type ChecksResult,
  type GitPrimitives,
  MergeQueue,
  type QueueEntry,
  type QueueState,
} from "../../src/merge/MergeQueue.ts";
import type { VerifyOutcome } from "../../src/verify/Verifier.ts";
import type { FailureBaseline } from "../../src/verify/failureBaseline.ts";

const run = promisify(execFile);

/** A real fixture repo with `main` and helpers to commit on branches. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-mergeq-"));
  const g = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout.trim();
  await run("git", ["init", "-q", "-b", "main", root]);
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "T");
  await writeFile(join(root, "base.txt"), "base\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "base");
  const commitOn = async (branch: string, file: string, text: string, create = false) => {
    await g("checkout", "-q", ...(create ? ["-b", branch] : [branch]));
    await writeFile(join(root, file), text);
    await g("add", "-A");
    await g("commit", "-q", "-m", `${file}: ${text.trim()}`);
    const sha = await g("rev-parse", "HEAD");
    await g("checkout", "-q", "main");
    return sha;
  };
  /** GitPrimitives over the real repo; every call is recorded. */
  const calls: string[] = [];
  const prims = (over: Partial<GitPrimitives> = {}): GitPrimitives => ({
    currentBranch: async () => g("rev-parse", "--abbrev-ref", "HEAD"),
    branchExists: async (name) =>
      g("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).then(
        () => true,
        () => false,
      ),
    resolveRef: async (ref) => g("rev-parse", ref),
    rebaseOnto: async (branch, onto) => {
      calls.push(`rebase:${branch}`);
      await g("checkout", "-q", branch);
      try {
        await g("rebase", onto);
        return { ok: true };
      } catch (error) {
        await g("rebase", "--abort").catch(() => {});
        return { ok: false, conflict: String(error) };
      } finally {
        await g("checkout", "-q", "main");
      }
    },
    mergeBranch: async (branch, target) => {
      calls.push(`merge:${branch}`);
      await g("checkout", "-q", target ?? "main");
      try {
        await g("merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch);
        return { merged: true, conflict: false, reason: null };
      } catch (error) {
        await g("merge", "--abort").catch(() => {});
        return { merged: false, conflict: true, reason: String(error) };
      }
    },
    headCommit: async (ref) => g("rev-parse", ref ?? "HEAD"),
    runIntegrationGate: async (branch) => {
      calls.push(`gate:${branch}`);
      return true;
    },
    ...over,
  });
  return { root, g, commitOn, prims, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a head that moved after review makes enqueue rebase and rerun the gate before merging", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.commitOn("feat/a", "a.txt", "one\n", true);
    const base = await f.g("rev-parse", "main");
    await f.commitOn("feat/a", "a2.txt", "pushed after review\n"); // the head moved
    const states: string[] = [];
    const q = new MergeQueue({ git: f.prims(), onState: (_e, s) => states.push(s) });
    const res = await q.enqueue({ branch: "feat/a", target: "main", reviewedHeadSha: reviewed, boundBaseSha: base });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(f.calls, ["rebase:feat/a", "gate:feat/a", "merge:feat/a"]);
    assert.deepEqual(states, ["MERGE_QUEUED", "MERGING", "MERGED"]);
  } finally {
    await f.cleanup();
  }
});

test("a moved target tip makes enqueue rebase onto it and rerun the gate with a fresh baseline", async () => {
  const f = await fixture();
  try {
    const head = await f.commitOn("feat/b", "b.txt", "b\n", true);
    const staleBase = await f.g("rev-parse", "main");
    await f.commitOn("main", "other.txt", "landed meanwhile\n");
    const newTip = await f.g("rev-parse", "main");
    const seen: Array<{ kind: string; sha: string }> = [];
    const baseline = (sha: string): FailureBaseline => ({
      baseSha: sha,
      profileHash: "p",
      failures: [],
      flaky: [],
      capturedAt: new Date().toISOString(),
    });
    const green = { passed: true, stages: [], evidence: [], failedStage: null, noTargets: false } as VerifyOutcome;
    const q = new MergeQueue({
      git: f.prims({
        baselineAt: async (_target, sha) => {
          seen.push({ kind: "baseline", sha });
          return baseline(sha);
        },
        verifyBranch: async (_branch, sha) => {
          seen.push({ kind: "verify", sha });
          return green;
        },
      }),
    });
    const res = await q.enqueue({ branch: "feat/b", target: "main", reviewedHeadSha: head, boundBaseSha: staleBase });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(seen, [
      { kind: "baseline", sha: newTip },
      { kind: "verify", sha: newTip },
    ]);
    assert.ok(f.calls.includes("rebase:feat/b"));
  } finally {
    await f.cleanup();
  }
});

test("an unmoved entry merges without a rebase or a gate rerun", async () => {
  const f = await fixture();
  try {
    const head = await f.commitOn("feat/c", "c.txt", "c\n", true);
    const base = await f.g("rev-parse", "main");
    const res = await new MergeQueue({ git: f.prims() }).enqueue({
      branch: "feat/c",
      target: "main",
      reviewedHeadSha: head,
      boundBaseSha: base,
    });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(f.calls, ["merge:feat/c"]);
  } finally {
    await f.cleanup();
  }
});

test("a baseline that finds an introduced failure blocks the merge", async () => {
  const f = await fixture();
  try {
    const head = await f.commitOn("feat/d", "d.txt", "d\n", true);
    const staleBase = await f.g("rev-parse", "main");
    await f.commitOn("main", "other.txt", "x\n");
    const red = {
      passed: false,
      stages: [
        {
          stage: { name: "test", command: "npm", args: [], required: true },
          exitCode: 1,
          passed: false,
          summary: {},
          artifactUri: "a",
          failingTests: ["brand new failure"],
        },
      ],
      evidence: [],
      failedStage: "test",
      noTargets: false,
    } as unknown as VerifyOutcome;
    const q = new MergeQueue({
      git: f.prims({
        baselineAt: async (_t, sha) => ({
          baseSha: sha,
          profileHash: "p",
          failures: [],
          flaky: [],
          capturedAt: "now",
        }),
        verifyBranch: async () => red,
      }),
    });
    const res = await q.enqueue({ branch: "feat/d", target: "main", reviewedHeadSha: head, boundBaseSha: staleBase });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /introduced/);
    assert.ok(!f.calls.some((c) => c.startsWith("merge:")));
  } finally {
    await f.cleanup();
  }
});

test("a rebase conflict rejects the entry", async () => {
  const f = await fixture();
  try {
    const head = await f.commitOn("feat/e", "same.txt", "mine\n", true);
    const staleBase = await f.g("rev-parse", "main");
    await f.commitOn("main", "same.txt", "theirs\n");
    const res = await new MergeQueue({ git: f.prims() }).enqueue({
      branch: "feat/e",
      target: "main",
      reviewedHeadSha: head,
      boundBaseSha: staleBase,
    });
    assert.equal(res.ok, false);
    assert.equal(res.level, "integration");
    assert.match(res.reason ?? "", /rebase conflict/);
  } finally {
    await f.cleanup();
  }
});

for (const [checks, blocks] of [
  ["pending", true],
  ["fail", true],
  ["pass", false],
  ["none", false],
] as Array<[ChecksResult, boolean]>) {
  test(`requiredChecks returning ${checks} ${blocks ? "blocks" : "does not block"} the merge`, async () => {
    const f = await fixture();
    try {
      const head = await f.commitOn("feat/f", "f.txt", "f\n", true);
      const base = await f.g("rev-parse", "main");
      const asked: string[] = [];
      const res = await new MergeQueue({
        git: f.prims({
          requiredChecks: async (sha) => {
            asked.push(sha);
            return checks;
          },
        }),
      }).enqueue({ branch: "feat/f", target: "main", reviewedHeadSha: head, boundBaseSha: base });
      assert.deepEqual(asked, [head], "checks are asked about the exact head being merged");
      assert.equal(res.ok, !blocks, res.reason);
      if (blocks)
        assert.match(res.reason ?? "", new RegExp(`required checks ${checks === "fail" ? "failed" : "pending"}`));
      assert.equal(
        f.calls.some((c) => c.startsWith("merge:")),
        !blocks,
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("two entries for one target merge sequentially and the second is revalidated onto the first", async () => {
  const f = await fixture();
  try {
    const h1 = await f.commitOn("feat/g1", "g1.txt", "1\n", true);
    const h2 = await f.commitOn("feat/g2", "g2.txt", "2\n", true);
    const base = await f.g("rev-parse", "main");
    const q = new MergeQueue({ git: f.prims() });
    const [r1, r2] = await Promise.all([
      q.enqueue({ branch: "feat/g1", target: "main", reviewedHeadSha: h1, boundBaseSha: base }),
      q.enqueue({ branch: "feat/g2", target: "main", reviewedHeadSha: h2, boundBaseSha: base }),
    ]);
    assert.equal(r1.ok, true, r1.reason);
    assert.equal(r2.ok, true, r2.reason);
    assert.deepEqual(f.calls, ["merge:feat/g1", "rebase:feat/g2", "gate:feat/g2", "merge:feat/g2"]);
  } finally {
    await f.cleanup();
  }
});

test("entries for 2 targets run concurrently while one target stays serial", async () => {
  let inFlight = 0;
  let peak = 0;
  const perTarget = new Map<string, number>();
  let peakSameTarget = 0;
  const git: GitPrimitives = {
    currentBranch: async () => "main",
    branchExists: async () => true,
    resolveRef: async () => "sha",
    rebaseOnto: async () => ({ ok: true }),
    headCommit: async () => "sha",
    mergeBranch: async (_b, target) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const t = target ?? "main";
      perTarget.set(t, (perTarget.get(t) ?? 0) + 1);
      peakSameTarget = Math.max(peakSameTarget, perTarget.get(t) ?? 0);
      await new Promise((r) => setTimeout(r, 30));
      perTarget.set(t, (perTarget.get(t) ?? 1) - 1);
      inFlight--;
      return { merged: true, conflict: false, reason: null };
    },
  };
  const q = new MergeQueue({ git });
  const entry = (branch: string, target: string): QueueEntry => ({
    branch,
    target,
    reviewedHeadSha: "sha",
    boundBaseSha: "sha",
  });
  const results = await Promise.all([
    q.enqueue(entry("a1", "main")),
    q.enqueue(entry("a2", "main")),
    q.enqueue(entry("b1", "release")),
    q.enqueue(entry("b2", "release")),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(peak, 2, "the two targets overlap");
  assert.equal(peakSameTarget, 1, "one target never has two merges in flight");
});

test("enqueue and promote share one chain per target", async () => {
  const order: string[] = [];
  const git: GitPrimitives = {
    currentBranch: async () => "main",
    branchExists: async () => true,
    resolveRef: async () => "sha",
    rebaseOnto: async () => ({ ok: true }),
    headCommit: async () => "sha",
    runIntegrationGate: async () => true,
    mergeBranch: async (b) => {
      order.push(`start:${b}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${b}`);
      return { merged: true, conflict: false, reason: null };
    },
  };
  const q = new MergeQueue({ git });
  await Promise.all([
    q.promote("legacy"),
    q.enqueue({ branch: "fenced", target: "main", reviewedHeadSha: "sha", boundBaseSha: "sha" }),
  ]);
  assert.deepEqual(order, ["start:legacy", "end:legacy", "start:fenced", "end:fenced"]);
});

test("enqueue refuses when the primitives cannot resolve refs", async () => {
  const git: GitPrimitives = {
    currentBranch: async () => "main",
    branchExists: async () => true,
    rebaseOnto: async () => ({ ok: true }),
    mergeBranch: async () => ({ merged: true, conflict: false, reason: null }),
    headCommit: async () => "sha",
  };
  const res = await new MergeQueue({ git }).enqueue({
    branch: "x",
    target: "main",
    reviewedHeadSha: "a",
    boundBaseSha: "b",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /resolve/);
});

test("a branch that keeps moving is rejected after the revalidation limit", async () => {
  let n = 0;
  const git: GitPrimitives = {
    currentBranch: async () => "main",
    branchExists: async () => true,
    // Every read of the branch sees a new head: someone keeps pushing.
    resolveRef: async (ref) => (ref === "main" ? "tip" : `head-${n++}`),
    rebaseOnto: async () => ({ ok: true }),
    mergeBranch: async () => ({ merged: true, conflict: false, reason: null }),
    headCommit: async () => "sha",
    runIntegrationGate: async () => true,
  };
  const res = await new MergeQueue({ git, maxRevalidations: 2 }).enqueue({
    branch: "moving",
    target: "main",
    reviewedHeadSha: "head-0",
    boundBaseSha: "tip",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /kept moving/);
});

test("a missing branch is rejected at the candidate level", async () => {
  const git: GitPrimitives = {
    currentBranch: async () => "main",
    branchExists: async () => false,
    resolveRef: async () => "sha",
    rebaseOnto: async () => ({ ok: true }),
    mergeBranch: async () => ({ merged: true, conflict: false, reason: null }),
    headCommit: async () => "sha",
  };
  const states: QueueState[] = [];
  const res = await new MergeQueue({ git, onState: (_e, s) => states.push(s) }).enqueue({
    branch: "gone",
    target: "main",
    reviewedHeadSha: "a",
    boundBaseSha: "b",
  });
  assert.equal(res.ok, false);
  assert.equal(res.level, "candidate");
  assert.deepEqual(states, ["MERGE_QUEUED"]);
});
