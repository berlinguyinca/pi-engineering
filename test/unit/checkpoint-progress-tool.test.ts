import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCheckpointProgressTool } from "../../src/workers/checkpointProgressTool.ts";

type ToolParams = {
  claims: Array<{
    deliverable: string;
    candidate_sha: string;
    evidence_paths: string[];
    artifact_refs?: string[];
  }>;
};

async function run(
  tool: ReturnType<typeof createCheckpointProgressTool>,
  params: ToolParams,
): Promise<{ text: string; claims: unknown[] }> {
  const result = (await tool.execute("tc-1", params, {} as never, {} as never, {} as never)) as {
    content: Array<{ type: string; text?: string }>;
    details: { claims: unknown[] };
  };
  return {
    text: (result.content.find((c) => c.type === "text")?.text ?? "").trim(),
    claims: result.details.claims,
  };
}

describe("checkpoint_progress tool feedback", () => {
  it("records claims for declared deliverables", async () => {
    const tool = createCheckpointProgressTool(["deliverable-a", "deliverable-b"]);
    const res = await run(tool, {
      claims: [
        { deliverable: "deliverable-a", candidate_sha: "abc123", evidence_paths: ["src/a.ts"] },
        { deliverable: "deliverable-b", candidate_sha: "abc123", evidence_paths: ["src/b.ts"] },
      ],
    });
    assert.match(res.text, /^Recorded 2 checkpoint progress claim/);
    assert.equal(res.claims.length, 2);
    assert.ok(!/REJECTED/i.test(res.text), "no rejection feedback for valid labels");
  });

  it("rejects undeclared deliverable labels and returns the exact declared list", async () => {
    const tool = createCheckpointProgressTool(["Merge worker/repair branches into the base checkout."]);
    const res = await run(tool, {
      claims: [{ deliverable: "repair", candidate_sha: "abc123", evidence_paths: ["src/a.ts"] }],
    });
    assert.match(res.text, /REJECTED 1 claim/);
    assert.match(res.text, /"repair" is not a declared deliverable/);
    assert.ok(
      res.text.includes('"Merge worker/repair branches into the base checkout."'),
      "the exact declared deliverable must be returned so the worker can re-claim",
    );
    assert.equal(res.claims.length, 0, "rejected claims must not be forwarded to broker settlement");
  });

  it("records the valid subset and rejects the rest in mixed claims", async () => {
    const tool = createCheckpointProgressTool(["deliverable-a"]);
    const res = await run(tool, {
      claims: [
        { deliverable: "deliverable-a", candidate_sha: "abc123", evidence_paths: ["src/a.ts"] },
        { deliverable: "the fix", candidate_sha: "abc123", evidence_paths: ["src/b.ts"] },
      ],
    });
    assert.equal(res.claims.length, 1);
    assert.match(res.text, /REJECTED 1 claim/);
    assert.match(res.text, /"the fix" is not a declared deliverable/);
    assert.match(res.text, /"deliverable-a"/);
  });
});
