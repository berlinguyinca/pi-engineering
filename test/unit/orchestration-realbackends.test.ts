import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { normalizeFindings, realBackends } from "../../src/orchestration/realBackends.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

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
