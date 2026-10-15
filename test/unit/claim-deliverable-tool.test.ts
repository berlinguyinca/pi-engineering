import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClaimDeliverableTool } from "../../src/workers/claimDeliverableTool.ts";

async function run(deliverables: string[], names: string[]) {
  const tool = createClaimDeliverableTool(deliverables);
  const result = (await tool.execute("tc", { deliverables: names }, undefined, undefined, {} as never)) as {
    content: Array<{ text?: string }>;
    details: { claims: Array<{ deliverable: string; tipBound?: boolean; candidateSha: string }> };
  };
  return { text: result.content[0]?.text ?? "", claims: result.details.claims };
}

describe("claim_deliverable", () => {
  it("matches ignoring case and whitespace and returns the declared string, tip-bound with no sha", async () => {
    const res = await run(["Add Parser", "docs"], ["  add   parser "]);
    assert.deepEqual(res.claims, [
      { deliverable: "Add Parser", candidateSha: "", evidencePaths: [], artifactRefs: [], tipBound: true },
    ]);
  });

  it("lists the declared deliverables for an unknown name and records nothing for it", async () => {
    const res = await run(["Add Parser"], ["parser tests"]);
    assert.equal(res.claims.length, 0);
    assert.match(res.text, /NOT declared: "parser tests"/);
    assert.match(res.text, /"Add Parser"/);
  });

  it("offers the declared list in its description", () => {
    assert.match(createClaimDeliverableTool(["alpha", "beta"]).description, /"alpha", "beta"/);
  });
});
