import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessComplexity, classifyWork } from "../../src/lifecycle/classification.ts";

const f = (path: string) => ({ path, added: false, deleted: false });

describe("assessComplexity", () => {
  it("is deterministic and bounded to 0..100", () => {
    const input = { request: "migrate the database schema and rotate credentials", files: [f("db/migrations/1.sql")] };
    const a = assessComplexity(input);
    const b = assessComplexity(input);
    assert.deepEqual(a, b);
    assert.ok(a.score >= 0 && a.score <= 100);
    const huge = assessComplexity({
      request: "delete the production database and drop table users",
      files: Array.from({ length: 40 }, (_, i) => ({
        path: `infra/db/auth/m${i}.sql`,
        added: false,
        deleted: i === 0,
      })),
      commands: ["terraform destroy"],
      changedLines: 9000,
      mutates: true,
      taskCount: 12,
    });
    assert.ok(huge.score <= 100);
    assert.equal(huge.riskClass, "critical");
  });

  it("a docs-only edit is trivial and low risk", () => {
    const r = assessComplexity({ request: "fix a typo in the readme", files: [f("README.md")], mutates: true });
    assert.equal(r.riskClass, "low");
    assert.ok(r.score < 30, `score ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("risk class low")));
  });

  it("database/auth work is high risk and outscores a docs edit", () => {
    const docs = assessComplexity({ files: [f("README.md")], mutates: true });
    const auth = assessComplexity({
      request: "change login token handling",
      files: [f("src/auth/session.ts")],
      mutates: true,
    });
    assert.ok(["high", "critical"].includes(auth.riskClass));
    assert.ok(auth.score > docs.score);
  });

  it("mutating work is never classed as chat", () => {
    const r = assessComplexity({ request: "add a feature", files: [], mutates: true });
    assert.ok(!r.classification.categories.includes("chat"));
    assert.ok(r.reasons.some((x) => x.includes("never classed as chat")));
  });

  it("leaves classifyWork unchanged", () => {
    const c = classifyWork({ request: "fix a typo in the readme", files: [f("README.md")] });
    assert.equal(c.risk, "LOW");
    assert.ok(c.categories.includes("docs"));
  });
});
