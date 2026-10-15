/**
 * Reviewer independence is judged by model FAMILY, not by exact model id: the
 * implementing family never solely approves its own work (spec §2a row 4). An
 * unknown family can never be shown independent, so it counts as the same family.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameFamily as sameFamilyId } from "../../src/capability/modelRecord.ts";
import { assertReviewerDistinct } from "../../src/cav/routing.ts";
import type { WorkerResult } from "../../src/core/types.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

describe("sameFamily over real catalog ids", () => {
  const same: Array<[string, string]> = [
    ["qwen3.8-27b", "qwen3.8-flash-next"],
    ["qwen3.8-27b", "qwen3.8-27b-vision"],
    ["glm-5.3-flash", "glm-5.1"],
    ["claude-opus-4-8", "claude-sonnet-5-5"],
    ["deepseek-v4-flash", "deepseek-v4-pro"],
    // An alias or endpoint prefix must not hide a shared family.
    ["metabolomics/qwen3.8-27b", "qwen3.8-flash-next"],
    ["openrouter/anthropic/claude-sonnet-5-5", "claude-haiku-4-5"],
    ["QWEN3.8-27B", "qwen3.8-flash-next"],
    ["qwen3.8-27b:latest", "qwen3.8-flash-next"],
  ];
  for (const [a, b] of same) {
    it(`${a} and ${b} are one family`, () => {
      assert.equal(sameFamilyId(a, b), true);
      assert.equal(sameFamilyId(b, a), true);
    });
  }

  const different: Array<[string, string]> = [
    ["deepseek-v4-flash", "qwen3.8-27b"],
    ["glm-5.3-flash", "qwen3.8-27b"],
    ["claude-sonnet-5-5", "gpt-5"],
    ["gemini-2.5-pro", "llama-3.3-70b"],
  ];
  for (const [a, b] of different) {
    it(`${a} and ${b} are different families`, () => {
      assert.equal(sameFamilyId(a, b), false);
    });
  }

  it("treats an id with no detectable family as the same family as anything", () => {
    assert.equal(sameFamilyId("", "qwen3.8-27b"), true);
    assert.equal(sameFamilyId("qwen3.8-27b", "-"), true);
    assert.equal(sameFamilyId("", ""), true);
  });
});

describe("assertReviewerDistinct compares families", () => {
  it("rejects two ids of one family", () => {
    assert.equal(assertReviewerDistinct("qwen3.8-27b", "qwen3.8-flash-next"), false);
  });
  it("rejects the identical id", () => {
    assert.equal(assertReviewerDistinct("deepseek-v4-flash", "deepseek-v4-flash"), false);
  });
  it("accepts a different family", () => {
    assert.equal(assertReviewerDistinct("deepseek-v4-flash", "qwen3.8-27b"), true);
  });
  it("never accepts an id whose family is unknown", () => {
    assert.equal(assertReviewerDistinct("qwen3.8-27b", ""), false);
    assert.equal(assertReviewerDistinct("", "qwen3.8-27b"), false);
  });
});

const completed = (summary: string): WorkerRun => ({
  result: {
    status: "completed",
    summary,
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
  } satisfies WorkerResult,
  usage: null,
});

const reviewed = (): WorkerRun => ({
  ...completed("reviewed"),
  structured: { verdict: "approve", findings: [], missingTests: [], specGaps: [], acceptanceResults: [] },
});

function backendsOver(pool: ModelRef[]) {
  const seen: WorkerRequest[] = [];
  const worker: WorkerExecutor = {
    async run(req) {
      seen.push({ ...req });
      return req.role === "reviewer" ? reviewed() : completed("done");
    },
  };
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: "/repo",
    routeModel: async (_role, query) =>
      pool.find((model) => !(query?.exclude ?? []).some((skip) => modelKey(skip) === modelKey(model))),
  });
  return { backends, seen };
}

const signal = () => new AbortController().signal;
const ref = (id: string): ModelRef => ({ provider: "metabolomics", id });

describe("reviewer selection by family", () => {
  it("prefers a different family over a sibling of the implementer", async () => {
    const { backends, seen } = backendsOver([ref("qwen3.8-27b"), ref("qwen3.8-flash-next"), ref("deepseek-v4-flash")]);
    await backends.agent.runAgent({ role: "implementer", objective: "x", missionId: "MSN-1", signal: signal() });
    const outcome = await backends.review.runReview({ objective: "review", missionId: "MSN-1", signal: signal() });
    assert.equal(seen.at(-1)?.modelOverride?.id, "deepseek-v4-flash", "the sibling qwen model was passed over");
    assert.equal(outcome.reviewEvidence?.model, "deepseek-v4-flash");
    assert.equal(outcome.reviewEvidence?.independenceMode, "independent");
  });

  it("records same_model_reduced when only a sibling of the implementer's family is left", async () => {
    const { backends } = backendsOver([ref("qwen3.8-27b"), ref("qwen3.8-flash-next")]);
    await backends.agent.runAgent({ role: "implementer", objective: "x", missionId: "MSN-1", signal: signal() });
    const outcome = await backends.review.runReview({ objective: "review", missionId: "MSN-1", signal: signal() });
    assert.equal(outcome.reviewEvidence?.model, "qwen3.8-flash-next");
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
  });

  it("never records a reviewer whose family is unknown as independent", async () => {
    const { backends } = backendsOver([ref("qwen3.8-27b"), ref("-mystery")]);
    await backends.agent.runAgent({ role: "implementer", objective: "x", missionId: "MSN-1", signal: signal() });
    const outcome = await backends.review.runReview({ objective: "review", missionId: "MSN-1", signal: signal() });
    assert.equal(outcome.reviewEvidence?.model, "-mystery");
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
  });

  it("an unknown-family reviewer is not independent even when no producer is known", async () => {
    const { backends } = backendsOver([ref("-mystery")]);
    const outcome = await backends.review.runReview({ objective: "review", signal: signal() });
    assert.equal(outcome.reviewEvidence?.independenceMode, "same_model_reduced");
  });
});
