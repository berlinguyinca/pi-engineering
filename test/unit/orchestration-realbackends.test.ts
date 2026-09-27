import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { normalizeFindings, realBackends } from "../../src/orchestration/realBackends.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

function capturingWorker(seen: WorkerRequest[]): WorkerExecutor {
  return {
    async run(req: WorkerRequest) {
      seen.push(req);
      return {
        result: {
          status: "completed",
          summary: "ok",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1, model: "m" },
        toolCalls: 0,
      } as never;
    },
  };
}

describe("realBackends capability routing", () => {
  it("does not start or publish activity for a pre-aborted worker", async () => {
    let runs = 0;
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    const worker: WorkerExecutor = {
      async run(req) {
        runs++;
        return capturingWorker([]).run(req);
      },
    };
    const backends = realBackends({ worker, verifier: {} as never, artifacts: {} as never, git: null, cwd: "/repo" });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      backends.agent.runAgent({
        role: "implementer",
        objective: "x",
        signal: abort.signal,
        onActivity: (e) => activity.push(e),
      }),
      /aborted/i,
    );
    assert.equal(runs, 0);
    assert.deepEqual(activity, []);
  });

  it("suppresses late completion and activity after abort", async () => {
    let finish!: () => void;
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    const worker: WorkerExecutor = {
      async run(req) {
        await new Promise<void>((resolve) => {
          finish = resolve;
          started();
        });
        req.onActivity?.({ kind: "state", phase: "completed", summary: "late", meaningfulProgress: true });
        return capturingWorker([]).run(req);
      },
    };
    const backends = realBackends({ worker, verifier: {} as never, artifacts: {} as never, git: null, cwd: "/repo" });
    const abort = new AbortController();
    const pending = backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      signal: abort.signal,
      onActivity: (event) => activity.push(event),
    });
    await workerStarted;
    abort.abort();
    finish();
    await pending;
    assert.deepEqual(activity, []);
  });

  it("forwards worker activity and suppresses updates after the worker settles", async () => {
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    let finish!: () => void;
    const worker: WorkerExecutor = {
      async run(req) {
        req.onActivity?.({ kind: "tool", phase: "started", summary: "Running tool: bash", meaningfulProgress: false });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return capturingWorker([]).run(req);
      },
    };
    const backends = realBackends({
      worker,
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
    });
    const pending = backends.agent.runAgent({
      role: "implementer",
      objective: "do work",
      signal: new AbortController().signal,
      onActivity: (event) => activity.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    finish();
    await pending;
    assert.deepEqual(activity.at(-1), {
      kind: "state",
      phase: "completed",
      summary: "Worker session completed",
      meaningfulProgress: true,
    });
    assert.equal(activity.filter((event) => event.kind === "tool").length, 1);
  });

  it("places the implementer worker on the model routeModel returns", async () => {
    const seen: WorkerRequest[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async (role) => (role === "implementer" ? { provider: "metabolomics", id: "qwen-27b" } : undefined),
    });
    const out = await backends.agent.runAgent({
      role: "implementer",
      objective: "do work",
      signal: new AbortController().signal,
    });
    assert.equal(out.exitStatus, "succeeded");
    assert.deepEqual(seen[0]?.modelOverride, { provider: "metabolomics", id: "qwen-27b" });
  });

  it("leaves modelOverride unset when routeModel returns undefined", async () => {
    const seen: WorkerRequest[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async () => undefined,
    });
    await backends.agent.runAgent({ role: "implementer", objective: "x", signal: new AbortController().signal });
    assert.equal(seen[0]?.modelOverride, undefined);
  });

  it("routes the reviewer too", async () => {
    const seen: WorkerRequest[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async (role) => (role === "reviewer" ? { provider: "metabolomics", id: "qwen-vision" } : undefined),
    });
    await backends.review.runReview({ objective: "review", signal: new AbortController().signal });
    assert.deepEqual(seen[0]?.modelOverride, { provider: "metabolomics", id: "qwen-vision" });
  });

  it("warns while explicitly routing review to the current model when no distinct reviewer exists", async () => {
    const seen: WorkerRequest[] = [];
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async () => ({
        provider: "local",
        id: "local",
        warning: "No distinct reviewer model is available; reviewing with local/local in a fresh session.",
      }),
    });

    await backends.review.runReview({
      objective: "review",
      signal: new AbortController().signal,
      onActivity: (event) => activity.push(event),
    });

    assert.deepEqual(seen[0]?.modelOverride, { provider: "local", id: "local" });
    assert.ok(activity.some((event) => event.summary.includes("No distinct reviewer model")));
  });

  it("falls back to the current model when reviewer routing finds no distinct model", async () => {
    const seen: WorkerRequest[] = [];
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async () => undefined,
      reviewFallbackModel: { provider: "local", id: "local" },
    } as never);

    await backends.review.runReview({
      objective: "review",
      signal: new AbortController().signal,
      onActivity: (event) => activity.push(event),
    });

    assert.deepEqual(seen[0]?.modelOverride, { provider: "local", id: "local" });
    assert.ok(activity.some((event) => /reduced independence/i.test(event.summary)));
  });

  it("warns about reduced independence even when a custom worker's current model identity is unknown", async () => {
    const seen: WorkerRequest[] = [];
    const activity: import("../../src/workers/WorkerExecutor.ts").WorkerActivity[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      routeModel: async () => undefined,
    });

    await backends.review.runReview({
      objective: "review",
      signal: new AbortController().signal,
      onActivity: (event) => activity.push(event),
    });

    assert.equal(seen[0]?.modelOverride, undefined);
    assert.ok(activity.some((event) => /current worker model.*reduced independence/i.test(event.summary)));
  });

  it("gives the reviewer the same wall-clock budget as implementation workers", async () => {
    // Without an explicit budget the executor's 5-minute default aborted
    // reviewers mid-analysis.
    const seen: WorkerRequest[] = [];
    const backends = realBackends({
      worker: capturingWorker(seen),
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
    });
    await backends.review.runReview({ objective: "review", signal: new AbortController().signal });
    assert.equal(seen[0]?.timeoutMs, workerTimeoutMs());
  });

  it("fails closed for incomplete review payloads and invented model provenance", async () => {
    const worker: WorkerExecutor = {
      async run() {
        return {
          result: { status: "completed", summary: "ok", details: {} },
          structured: { verdict: "approve", findings: [] },
          usage: { model: "unknown" },
        } as never;
      },
    };
    const backends = realBackends({ worker, verifier: {} as never, artifacts: {} as never, git: null, cwd: "/repo" });
    const outcome = await backends.review.runReview({
      objective: "review",
      acceptanceCriteria: [{ acceptanceId: "AC-1", criterion: "works" }],
      signal: new AbortController().signal,
    });
    assert.equal(outcome.reviewEvidence?.outputValid, false);
    assert.equal(outcome.reviewEvidence?.model, "");
    assert.equal(outcome.reviewEvidence?.provider, "");
  });

  it("fails closed when any raw review finding is malformed instead of silently discarding it", async () => {
    const worker: WorkerExecutor = {
      async run() {
        return {
          result: { status: "completed", summary: "ok", details: {} },
          structured: {
            verdict: "approve",
            findings: [{ severity: "critical" }],
            missingTests: [],
            specGaps: [],
            acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "claimed pass" }],
          },
          usage: { model: "reviewer" },
        } as never;
      },
    };
    const backends = realBackends({
      worker,
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      reviewFallbackModel: { provider: "test", id: "reviewer" },
    });
    const outcome = await backends.review.runReview({
      objective: "review",
      acceptanceCriteria: [{ acceptanceId: "AC-1", criterion: "works" }],
      signal: new AbortController().signal,
    });
    assert.equal(outcome.reviewEvidence?.outputValid, false);
    assert.equal(outcome.reviewEvidence?.verdict, "approve");
  });

  it("turns blocking missing tests and spec gaps into blocking review findings", async () => {
    const worker: WorkerExecutor = {
      async run() {
        return {
          result: { status: "completed", summary: "ok", details: {} },
          structured: {
            verdict: "request_changes",
            findings: [],
            missingTests: [{ severity: "high", description: "no regression test" }],
            specGaps: [
              { severity: "critical", requirement: "must preserve data", status: "missing", detail: "not met" },
            ],
            acceptanceResults: [{ acceptanceId: "AC-1", status: "failed", detail: "gap remains" }],
          },
          usage: { model: "reviewer" },
        } as never;
      },
    };
    const backends = realBackends({
      worker,
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: "/repo",
      reviewFallbackModel: { provider: "test", id: "reviewer" },
    });
    const outcome = await backends.review.runReview({
      objective: "review",
      acceptanceCriteria: [{ acceptanceId: "AC-1", criterion: "works" }],
      signal: new AbortController().signal,
    });
    assert.equal(outcome.reviewEvidence?.outputValid, true);
    assert.equal(outcome.reviewEvidence?.findings.filter((finding) => finding.severity === "blocking").length, 2);
  });
});

describe("normalizeFindings (spec 07 — reviewer finding normalization)", () => {
  it("passes through structured objects, mapping summary/message/text/title", () => {
    const out = normalizeFindings([
      { severity: "blocking", summary: "crashes on empty input", file: "a.ts", line: 3 },
      { severity: "minor", message: "nit: naming" },
      { severity: "major", text: "unused import" },
      { severity: "warning", title: "title-based finding" },
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], {
      severity: "blocking",
      summary: "crashes on empty input",
      message: "crashes on empty input",
      file: "a.ts",
      line: 3,
    });
    assert.equal(out[1]!.severity, "minor");
    assert.equal(out[2]!.summary, "unused import");
    assert.equal(out[3]!.summary, "title-based finding");
  });

  it("treats plain strings as findings with no severity", () => {
    const out = normalizeFindings(["boom", "second issue"]);
    assert.deepEqual(out, [
      { summary: "boom", message: "boom" },
      { summary: "second issue", message: "second issue" },
    ]);
  });

  it("parses a JSON string (object or array)", () => {
    const arr = normalizeFindings('[{"severity":"blocking","summary":"a"},{"severity":"minor","summary":"b"}]');
    assert.equal(arr.length, 2);
    assert.equal(arr[0]!.severity, "blocking");
    const obj = normalizeFindings('{"severity":"major","summary":"single"}');
    assert.equal(obj.length, 1);
    assert.equal(obj[0]!.severity, "major");
  });

  it("treats a non-JSON string as a single finding", () => {
    const out = normalizeFindings("this is a problem");
    assert.deepEqual(out, [{ summary: "this is a problem", message: "this is a problem" }]);
  });

  it("returns [] for null, empty, or malformed input", () => {
    assert.deepEqual(normalizeFindings(null), []);
    assert.deepEqual(normalizeFindings(undefined), []);
    assert.deepEqual(normalizeFindings(""), []);
    assert.deepEqual(normalizeFindings("[not json"), [{ summary: "[not json", message: "[not json" }]);
    assert.deepEqual(normalizeFindings(42), []);
    assert.deepEqual(normalizeFindings([{ noSummaryField: true }]), []);
  });
});

describe("realBackends integration: recovered handoffs", () => {
  const passingVerifier = {
    detect: async () => ({ name: "none", stages: [] }),
    run: async () => ({ passed: true, stages: [], evidence: [], failedStage: null, noTargets: false }),
  };
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  /** A branch off HEAD with one commit writing `file`; returns that commit. */
  function branchWith(root: string, branch: string, file: string, content: string): string {
    sh(root, "checkout", "-q", "-b", branch);
    writeFileSync(join(root, file), content);
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", `${branch}: ${file}`);
    const sha = sh(root, "rev-parse", "HEAD");
    sh(root, "checkout", "-q", "-");
    return sha;
  }

  it("merges a recovered handoff's exact ref, and a conflict on it does not fail clean work", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      branchWith(fx.root, "clean", "src/add.js", "export const add = (a, b) => a + b;\n");
      // Recovered branch: a conflicting worker commit ...
      const conflictRef = branchWith(fx.root, "rec-conflict", "src/add.js", "export const add = () => 0;\n");
      // ... and a non-conflicting one whose branch tip ALSO carries a harvest
      // auto-commit of half-done work that must not be merged.
      const goodRef = branchWith(fx.root, "rec-good", "src/extra.js", "export const extra = 1;\n");
      sh(fx.root, "checkout", "-q", "rec-good");
      writeFileSync(join(fx.root, "src", "half.js"), "half-done\n");
      sh(fx.root, "add", "-A");
      sh(fx.root, "commit", "-q", "-m", "pi-eng: harvest");
      sh(fx.root, "checkout", "-q", "-");

      const backends = realBackends({
        worker: capturingWorker([]),
        verifier: passingVerifier as never,
        artifacts: {} as never,
        git,
        cwd: fx.root,
      });
      const wt = (branch: string) => ({ path: fx.root, branch });
      const out = await backends.integration.runIntegration({
        objective: "merge",
        signal: new AbortController().signal,
        handoffs: [
          { worktree: wt("clean"), summary: "s", artifacts: [] },
          { worktree: wt("rec-conflict"), summary: "s", artifacts: [], ref: conflictRef, recovered: true },
          { worktree: wt("rec-good"), summary: "s", artifacts: [], ref: goodRef, recovered: true },
        ],
      });
      assert.equal(out.exitStatus, "succeeded", out.summary);
      assert.match(out.summary, /recovered/);
      assert.match(out.summary, /rec-conflict/);
      assert.equal(readFileSync(join(fx.root, "src", "add.js"), "utf8"), "export const add = (a, b) => a + b;\n");
      assert.ok(existsSync(join(fx.root, "src", "extra.js")), "the recovered worker commit is merged");
      assert.ok(!existsSync(join(fx.root, "src", "half.js")), "the harvest commit on the branch tip is not");
    } finally {
      await fx.cleanup();
    }
  });

  it("stops integration between branch merges when canceled", async () => {
    const controller = new AbortController();
    const merged: string[] = [];
    let verificationRuns = 0;
    const git = {
      async mergeBranch(branch: string) {
        merged.push(branch);
        controller.abort();
        return { merged: true };
      },
    };
    const verifier = {
      detect: async () => ({ name: "none", stages: [] }),
      run: async () => {
        verificationRuns++;
        return { passed: true, stages: [], evidence: [], failedStage: null, noTargets: false };
      },
    };
    const backends = realBackends({
      worker: capturingWorker([]),
      verifier: verifier as never,
      artifacts: {} as never,
      git: git as never,
      cwd: "/repo",
    });

    await assert.rejects(
      backends.integration.runIntegration({
        objective: "merge",
        signal: controller.signal,
        handoffs: [
          { worktree: { path: "/one", branch: "one" }, summary: "one", artifacts: [] },
          { worktree: { path: "/two", branch: "two" }, summary: "two", artifacts: [] },
        ],
      }),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "AbortError");
        return true;
      },
    );
    assert.deepEqual(merged, ["one"]);
    assert.equal(verificationRuns, 0, "post-merge verification must not start after cancellation");
  });
});

describe("realBackends deterministic cancellation", () => {
  for (const kind of ["validation", "process"] as const) {
    it(`forwards cancellation to the ${kind} verifier`, async () => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      let verifierStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        verifierStarted = resolve;
      });
      const verifier = {
        detect: async () => ({ name: "test", stages: [] }),
        run: async (_cwd: string, _profile: unknown, _artifacts: unknown, opts?: { signal?: AbortSignal }) => {
          receivedSignal = opts?.signal;
          verifierStarted();
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
          });
          throw new Error("unreachable");
        },
      };
      const backends = realBackends({
        worker: capturingWorker([]),
        verifier: verifier as never,
        artifacts: {} as never,
        git: null,
        cwd: "/repo",
      });

      const pending =
        kind === "validation"
          ? backends.validation.runValidation({ objective: "check", signal: controller.signal })
          : backends.process.runProcess({ objective: "check", signal: controller.signal });
      await started;
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(receivedSignal, controller.signal);
    });
  }
});
