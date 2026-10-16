import assert from "node:assert/strict";
import { test } from "node:test";
import { capContextPackage, estimateTokensDefault, type PackageFile } from "../../src/context/packageBudget.ts";

function file(path: string, content: string, required?: boolean): PackageFile {
  return { path, content, ...(required === undefined ? {} : { required }) };
}

test("context-package-budget: default estimator is ceil(length / 4)", () => {
  assert.equal(estimateTokensDefault("abcdefgh"), 2);
  assert.equal(estimateTokensDefault("abcde"), 2);
  assert.equal(estimateTokensDefault("a"), 1);
  assert.equal(estimateTokensDefault(""), 0);
});

test("context-package-budget: all files fit when total is within budget", () => {
  const files = [
    file("a.ts", "aaaa"), // 1 token
    file("b.ts", "bbbbbbbb"), // 2 tokens
    file("c.ts", "cccc"), // 1 token
  ];
  const result = capContextPackage(files, 10);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["a.ts", "b.ts", "c.ts"],
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.tokens, 4);
});

test("context-package-budget: optional files are dropped in order when over budget", () => {
  const files = [
    file("a.ts", "aaaa"), // 1 token, kept
    file("b.ts", "bbbbbbbb"), // 2 tokens, kept (1+2 <= 4)
    file("c.ts", "cccccccc"), // 2 tokens, would be 3+2=5 > 4, dropped
    file("d.ts", "dddd"), // 1 token, 3+1=4 <= 4, kept
    file("e.ts", "eeeeeeee"), // 2 tokens, would be 4+2=6 > 4, dropped
  ];
  const result = capContextPackage(files, 4);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["a.ts", "b.ts", "d.ts"],
  );
  assert.deepEqual(result.dropped, ["c.ts", "e.ts"]);
  assert.equal(result.tokens, 4);
});

test("context-package-budget: required files are kept even when over budget", () => {
  const files = [
    file("required.ts", "rrrrrrrrrrrrrrrrrrrr", true), // 5 tokens, required
    file("optional.ts", "oooo"), // 1 token
  ];
  const result = capContextPackage(files, 2);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["required.ts"],
  );
  assert.deepEqual(result.dropped, ["optional.ts"]);
  // Tokens are reported honestly even though required files exceed the budget.
  assert.equal(result.tokens, 5);
});

test("context-package-budget: required files kept even when the budget is zero", () => {
  const files = [file("must.ts", "mmmm", true), file("maybe.ts", "mmmm")];
  const result = capContextPackage(files, 0);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["must.ts"],
  );
  assert.deepEqual(result.dropped, ["maybe.ts"]);
  assert.equal(result.tokens, 1);
});

test("context-package-budget: required files are kept even when budget is negative", () => {
  const files = [file("must.ts", "mmmm", true)];
  const result = capContextPackage(files, -5);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["must.ts"],
  );
  assert.equal(result.tokens, 1);
});

test("context-package-budget: empty input yields empty result", () => {
  const result = capContextPackage([], 100);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.tokens, 0);
});

test("context-package-budget: required files preserve original order and come before optionals", () => {
  const files = [file("opt1.ts", "o"), file("req1.ts", "r", true), file("opt2.ts", "o"), file("req2.ts", "r", true)];
  const result = capContextPackage(files, 100);
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["req1.ts", "req2.ts", "opt1.ts", "opt2.ts"],
  );
});

test("context-package-budget: custom estimator is honored", () => {
  const files = [file("a.ts", "xx"), file("b.ts", "xx")];
  // Each file costs 10 tokens under the custom estimator.
  const result = capContextPackage(files, 15, (s) => (s.length === 0 ? 0 : 10));
  assert.deepEqual(
    result.kept.map((f) => f.path),
    ["a.ts"],
  );
  assert.deepEqual(result.dropped, ["b.ts"]);
  assert.equal(result.tokens, 10);
});
