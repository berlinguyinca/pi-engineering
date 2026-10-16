/**
 * Issue #260: TestQuarantine is reached by the verifier and the merge-queue
 * gate. Real child processes stall under shortened watchdog thresholds, a real
 * persisted quarantine records them, and a blocked outcome is never a pass:
 * not from CommandVerifier.run, not from a mission through the real
 * EngineeringRuntime, not at the MergeQueue gate over a real git repository.
 *
 * Honest limit: MergeQueue is not constructed on a production path yet (#153
 * routes promotion through it), so its refusal is proven against the queue
 * itself, fed by the real verifier, not through a runtime caller.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { type GateVerdict, type GitPrimitives, MergeQueue } from "../../src/merge/MergeQueue.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier, type VerificationProfile } from "../../src/verify/Verifier.ts";
import { type FailureBaseline, hashProfile } from "../../src/verify/failureBaseline.ts";
import { type QuarantineEvidence, TestQuarantine } from "../../src/verify/testQuarantine.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const run = promisify(execFile);

/** A test stage that sleeps silently, under shortened watchdog thresholds. */
const STALLING: VerificationProfile = {
  name: "stalling",
  stages: [
    {
      name: "test",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 120000)"],
      required: true,
      timeoutMs: 900_000,
      watchdog: { warnMs: 100, investigateMs: 200, stallMs: 500, sampleMs: 50 },
    },
  ],
};

const PASSING: VerificationProfile = {
  name: "passing",
  stages: [
    {
      name: "test",
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      required: true,
      timeoutMs: 900_000,
    },
  ],
};

async function scratchDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-eng-quarantine-${label}-`));
}

/** Two identical stalls of `stage:test`, as the stalling stage above produces them. */
async function quarantineTestStage(quarantine: TestQuarantine): Promise<void> {
  const evidence: QuarantineEvidence = {
    pgid: 1,
    capturedAt: new Date().toISOString(),
    processes: [{ pid: 10, ppid: 1, state: "S", started: "now", command: "node -e setTimeout" }],
    lastLines: [],
    lastProgressKind: null,
  };
  assert.equal(await quarantine.recordStall("stage:test", evidence, "artifact:first"), false);
  assert.equal(await quarantine.recordStall("stage:test", evidence, "artifact:second"), true);
}

describe("CommandVerifier.run (issue #260)", () => {
  it("1 real stall leaves the outcome unblocked; 2 identical stalls make the third run blocked, not passed", async () => {
    const dir = await scratchDir("verifier");
    try {
      const quarantine = new TestQuarantine(join(dir, "state"));
      const verifier = new CommandVerifier({ quarantine });
      const store = await ArtifactStore.create(join(dir, "artifacts"));

      const first = await verifier.run(dir, STALLING, store);
      assert.equal(first.stages[0]?.summary.stalled, "stalled", "the silent stage was ended by the progress watchdog");
      assert.equal(first.passed, false);
      assert.equal(first.status, undefined, "one stall does not block");
      assert.equal(await quarantine.isQuarantined("stage:test"), false);

      const second = await verifier.run(dir, STALLING, store);
      assert.equal(await quarantine.isQuarantined("stage:test"), true, "the second identical stall quarantines");
      assert.equal(second.status, "blocked");

      const third = await verifier.run(dir, STALLING, store);
      assert.equal(third.status, "blocked");
      assert.equal(third.passed, false);
      assert.deepEqual(third.quarantined, ["stage:test"]);
      assert.match((third.warnings ?? []).join("\n"), /blocked: depends on quarantined test: stage:test/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a quarantined stage that passes this time is still blocked: quarantine is never a false green", async () => {
    const dir = await scratchDir("verifier-pass");
    try {
      const quarantine = new TestQuarantine(join(dir, "state"));
      await quarantineTestStage(quarantine);
      const store = await ArtifactStore.create(join(dir, "artifacts"));
      const outcome = await new CommandVerifier({ quarantine }).run(dir, PASSING, store);
      assert.equal(outcome.stages[0]?.passed, true, "the stage itself passed");
      assert.equal(outcome.passed, false);
      assert.equal(outcome.status, "blocked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a run without a quarantine is unchanged", async () => {
    const dir = await scratchDir("verifier-none");
    try {
      const store = await ArtifactStore.create(join(dir, "artifacts"));
      const outcome = await new CommandVerifier().run(dir, PASSING, store);
      assert.equal(outcome.passed, true);
      assert.equal(outcome.status, undefined);
      assert.equal(outcome.stages[0]?.summary.tests, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a mission through the real EngineeringRuntime (issue #260)", () => {
  const worker: WorkerExecutor = {
    async run(req) {
      if (req.role === "implementer") {
        await mkdir(`${req.cwd}/src`, { recursive: true });
        await writeFile(`${req.cwd}/src/change.ts`, "export const n = 1;\n", "utf8");
      }
      const reviewed = req.resultTool === "review_result";
      return {
        result: {
          status: "completed",
          summary: `${req.role} done`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1, model: "fake" },
        toolCalls: 1,
        structured: reviewed
          ? {
              verdict: "approve",
              findings: [],
              missingTests: [],
              specGaps: [],
              acceptanceResults: [...req.task.matchAll(/Acceptance criterion ([^:]+):/g)].map((m) => ({
                acceptanceId: m[1]!,
                status: "passed" as const,
                detail: "checked",
              })),
              summary: "approved",
            }
          : undefined,
      };
    },
  };

  async function greenFixture() {
    const fx = await makeFixtureRepo();
    await writeFile(join(fx.root, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
    await run("git", ["-C", fx.root, "add", "-A"]);
    await run("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
    return fx;
  }

  async function mission(root: string, seed?: (q: TestQuarantine) => Promise<void>) {
    const rt = await EngineeringRuntime.open({
      cwd: root,
      worker,
      verifier: new CommandVerifier(),
      roleRouter: { route: async () => ({ provider: "fake", id: "fake-reviewer" }) },
    });
    try {
      if (seed) await seed(rt.testQuarantine);
      return await rt.orchestrator!.orchestrate("Add a change", {
        repository: rt.cwd,
        baseRef: await rt.git!.headCommit(),
        mutationRequested: true,
      });
    } finally {
      await rt.close();
    }
  }

  it("completes when nothing is quarantined and does NOT complete when the test stage is quarantined", async () => {
    const control = await greenFixture();
    const blocked = await greenFixture();
    try {
      const ok = await mission(control.root);
      assert.equal(ok.completed, true, ok.failureReason ?? undefined);

      const result = await mission(blocked.root, quarantineTestStage);
      assert.equal(result.completed, false, "a quarantined test stage must not read as green");
    } finally {
      await control.cleanup();
      await blocked.cleanup();
    }
  });
});

describe("the engineer() verify path (issue #260)", () => {
  const stable = {
    claims: [],
    details: {},
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
  };
  async function engineer(root: string, seed?: (q: TestQuarantine) => Promise<void>) {
    const worker = new FakeWorkerExecutor({
      scout: () => ({ status: "completed", summary: "Change src/add.js.", ...stable }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
        return { status: "completed", summary: "Implemented add.", ...stable };
      },
      reviewer: () => ({ status: "completed", summary: "clean", ...stable, details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: root, worker, verifier: new CommandVerifier() });
    try {
      if (seed) await seed(rt.testQuarantine);
      return await rt.engineer("Implement add(a, b) to return the sum of a and b");
    } finally {
      await rt.close();
    }
  }

  it("promotes when nothing is quarantined and never promotes a candidate whose test stage is quarantined", async () => {
    const control = await makeFixtureRepo();
    const quarantined = await makeFixtureRepo();
    try {
      assert.equal((await engineer(control.root)).outcome, "promoted");
      const report = await engineer(quarantined.root, quarantineTestStage);
      assert.notEqual(report.outcome, "promoted");
      assert.equal(report.verification?.passed, false);
    } finally {
      await control.cleanup();
      await quarantined.cleanup();
    }
  });
});

describe("MergeQueue gate (issue #260)", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-mergeq-quarantine-"));
    const g = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout.trim();
    await run("git", ["init", "-q", "-b", "main", root]);
    await g("config", "user.email", "t@example.com");
    await g("config", "user.name", "T");
    await writeFile(join(root, "base.txt"), "base\n");
    await g("add", "-A");
    await g("commit", "-q", "-m", "base");
    const commit = async (branch: string, file: string, create = false) => {
      await g("checkout", "-q", ...(create ? ["-b", branch] : [branch]));
      await writeFile(join(root, file), `${file}\n`);
      await g("add", "-A");
      await g("commit", "-q", "-m", file);
      const sha = await g("rev-parse", "HEAD");
      await g("checkout", "-q", "main");
      return sha;
    };
    const merges: string[] = [];
    const prims = (over: Partial<GitPrimitives>): GitPrimitives => ({
      currentBranch: async () => g("rev-parse", "--abbrev-ref", "HEAD"),
      branchExists: async (name) =>
        g("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).then(
          () => true,
          () => false,
        ),
      resolveRef: async (ref) => g("rev-parse", ref),
      rebaseOnto: async (branch, onto) => {
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
      mergeBranch: async (branch, target, expectedHeadSha) => {
        merges.push(branch);
        await g("checkout", "-q", target ?? "main");
        await g("merge", "--no-ff", "-q", "-m", `merge ${branch}`, expectedHeadSha ?? branch);
        return { merged: true, conflict: false, reason: null };
      },
      headCommit: async (ref) => g("rev-parse", ref ?? "HEAD"),
      ...over,
    });
    return { root, g, commit, prims, merges, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  /** A real verification of the branch tip with the given quarantine; the stage itself always passes. */
  const verifyWith = (quarantine: TestQuarantine, dir: string) => async () => {
    const store = await ArtifactStore.create(join(dir, "gate-artifacts"));
    return new CommandVerifier({ quarantine }).run(dir, PASSING, store);
  };

  const emptyBaseline = (sha: string): FailureBaseline => ({
    baseSha: sha,
    profileHash: hashProfile(PASSING),
    failures: [],
    flaky: [],
    capturedAt: new Date().toISOString(),
  });

  async function enqueueMoved(f: Awaited<ReturnType<typeof fixture>>, over: Partial<GitPrimitives>) {
    const reviewed = await f.commit("feat/a", "a.txt", true);
    const base = await f.g("rev-parse", "main");
    await f.commit("main", "moved.txt"); // the target tip moved after review: the gate must rerun
    await f.g("checkout", "-q", "main");
    return new MergeQueue({ git: f.prims(over) }).enqueue({
      branch: "feat/a",
      target: "main",
      reviewedHeadSha: reviewed,
      boundBaseSha: base,
    });
  }

  it("a blocked verification refuses the merge; the same flow merges when nothing is quarantined", async () => {
    const f = await fixture();
    const dir = await scratchDir("gate");
    try {
      const quarantine = new TestQuarantine(join(dir, "state"));
      await quarantineTestStage(quarantine);
      const refused = await enqueueMoved(f, {
        baselineAt: async (_t, sha) => emptyBaseline(sha),
        verifyBranch: verifyWith(quarantine, dir),
      });
      assert.equal(refused.ok, false);
      assert.match(refused.reason ?? "", /blocked by quarantined test\(s\): stage:test/);
      assert.deepEqual(f.merges, [], "mergeBranch was never called");
    } finally {
      await f.cleanup();
      await rm(dir, { recursive: true, force: true });
    }

    const g = await fixture();
    const dir2 = await scratchDir("gate-control");
    try {
      const open = new TestQuarantine(join(dir2, "state"));
      const merged = await enqueueMoved(g, {
        baselineAt: async (_t, sha) => emptyBaseline(sha),
        verifyBranch: verifyWith(open, dir2),
      });
      assert.equal(merged.ok, true, merged.reason);
      assert.deepEqual(g.merges, ["feat/a"]);
    } finally {
      await g.cleanup();
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("a blocked verdict from a boolean-style integration gate refuses enqueue and promote", async () => {
    const f = await fixture();
    try {
      const blocked: GateVerdict = { passed: false, status: "blocked", quarantined: ["stage:test"] };
      const enqueued = await enqueueMoved(f, { runIntegrationGate: async () => blocked });
      assert.equal(enqueued.ok, false);
      assert.match(enqueued.reason ?? "", /blocked by quarantined test\(s\): stage:test/);

      // Even a verdict that claims `passed` is refused when it is marked blocked.
      const lying = await new MergeQueue({
        git: f.prims({
          runIntegrationGate: async () => ({ passed: true, status: "blocked", quarantined: ["stage:test"] }),
        }),
      }).promote("feat/a");
      assert.equal(lying.ok, false);
      assert.match(lying.reason ?? "", /blocked by quarantined test/);
      assert.deepEqual(f.merges, []);
    } finally {
      await f.cleanup();
    }
  });
});
