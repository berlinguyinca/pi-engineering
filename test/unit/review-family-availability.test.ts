/**
 * Issue #153: the runtime's "was a different-family reviewer available" answer
 * draws on the reviewer picker's pool, so a model outside the operator's
 * enabled scope never blocks a single-family session's promotion.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { differentFamilyReviewerAvailable } from "../../src/capability/registryCandidates.ts";

const qwen = { provider: "local", id: "qwen3-32b", toolCall: true, contextWindow: 262_144 };
const qwenSmall = { provider: "local", id: "qwen3-8b", toolCall: true, contextWindow: 262_144 };
const claude = { provider: "anthropic", id: "claude-sonnet-4-5", toolCall: true, contextWindow: 262_144 };

describe("differentFamilyReviewerAvailable (issue #153)", () => {
  it("does not count an incompatible different-family model as an independent reviewer", () => {
    assert.equal(
      differentFamilyReviewerAvailable(
        [
          { ...qwen, toolCall: true, contextWindow: 262_144 },
          { ...claude, toolCall: true, contextWindow: 32_768, input: ["text"] },
        ],
        qwen.id,
      ),
      false,
    );
  });

  it("is false when every live model shares the reviewer's family", () => {
    assert.equal(differentFamilyReviewerAvailable([qwen, qwenSmall], qwen.id), false);
  });

  it("is true when a live model of another family exists", () => {
    assert.equal(differentFamilyReviewerAvailable([qwen, claude], qwen.id), true);
  });

  it("ignores a different-family model outside the enabled scope", () => {
    assert.equal(
      differentFamilyReviewerAvailable([qwen, qwenSmall, claude], qwen.id, { enabledPatterns: ["local/*"] }),
      false,
    );
  });

  it("ignores a different-family model recorded unavailable", () => {
    const isUnavailable = (model: { provider: string; id: string }) => model.id === claude.id;
    assert.equal(differentFamilyReviewerAvailable([qwen, claude], qwen.id, { isUnavailable }), false);
  });

  it("falls back to every live model when nothing enabled is live, like the reviewer picker", () => {
    assert.equal(differentFamilyReviewerAvailable([qwen, claude], qwen.id, { enabledPatterns: ["openai/*"] }), true);
  });
});
