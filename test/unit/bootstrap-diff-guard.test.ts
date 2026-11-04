import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDiffScope } from "../../src/bootstrap/diffGuard.ts";
import { parseTaskManifest } from "../../src/bootstrap/taskManifest.ts";

const manifest = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseTaskManifest({ taskId: "B03", baseSha: "a".repeat(40), repoId: "pi", objective: "validate diff scope", allowPaths: ["src/bootstrap/**", "test/unit/**"], denyPaths: ["src/bootstrap/generated/**"], commands: [{ argv: ["npm", "run", "typecheck"], cwd: "." }], limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 }, parentHandoffHash: null, expectedOutputs: [], mode: "isolated-change", ...overrides });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("fixture must parse");
  return parsed.manifest;
};
const labels = (report: ReturnType<typeof evaluateDiffScope>): string[] => report.violations.map((v) => `${v.kind}:${v.path ?? "-"}`);

test("unexpected, denied, generated, binary and budget breaches are reported deterministically", () => {
  const meta = { porcelain: " M src/other/file.ts\n M src/bootstrap/pathPolicy.ts\n?? src/bootstrap/generated/out.min.js\nR  old/name.ts -> new/name.ts\n!! ignored.txt\n", numstat: "3\t1\tsrc/bootstrap/pathPolicy.ts\n-\t-\tsrc/assets/logo.png\n" };
  const snapshot = JSON.parse(JSON.stringify(meta));
  const report = evaluateDiffScope(manifest(), meta);
  assert.deepEqual(meta, snapshot, "metadata is consumed read-only");
  assert.deepEqual(report.changedPaths, ["new/name.ts", "old/name.ts", "src/assets/logo.png", "src/bootstrap/generated/out.min.js", "src/bootstrap/pathPolicy.ts", "src/other/file.ts"]);
  assert.deepEqual([report.added, report.deleted, report.productionFiles, report.testFiles], [3, 1, 6, 0]);
  assert.deepEqual(labels(report), ["binary-change:src/assets/logo.png", "denied-path:src/bootstrap/generated/out.min.js", "generated-file:src/bootstrap/generated/out.min.js", "production-file-budget:-", "unexpected-path:new/name.ts", "unexpected-path:old/name.ts", "unexpected-path:src/assets/logo.png", "unexpected-path:src/other/file.ts"]);
});

test("a clean worktree still scopes the commit under review (FIX-1)", () => {
  const meta = { porcelain: "", numstat: "4\t0\ttest/unit/x.test.ts\n" };
  const snapshot = JSON.parse(JSON.stringify(meta));
  const report = evaluateDiffScope(manifest({ allowPaths: ["src/bootstrap/**"], denyPaths: ["test/**"] }), meta);
  assert.deepEqual(meta, snapshot, "metadata is consumed read-only");
  assert.deepEqual([report.ok, report.changedPaths, report.productionFiles, report.testFiles], [false, ["test/unit/x.test.ts"], 0, 1]);
  assert.deepEqual(labels(report), ["denied-path:test/unit/x.test.ts"]);
  // A committed path that is neither allowed nor denied is as unexpected as an unstaged one.
  assert.deepEqual(labels(evaluateDiffScope(manifest(), { porcelain: "", numstat: "2\t0\tsrc/other/file.ts\n" })), ["unexpected-path:src/other/file.ts"]);
  // Generated-file and read-only checks see committed paths too.
  assert.deepEqual(labels(evaluateDiffScope(manifest(), { porcelain: "", numstat: "9\t0\tsrc/bootstrap/generated/bundle.min.js\n" })), ["denied-path:src/bootstrap/generated/bundle.min.js", "generated-file:src/bootstrap/generated/bundle.min.js"]);
  assert.deepEqual(labels(evaluateDiffScope(manifest({ mode: "read-only" }), { porcelain: "", numstat: "1\t0\tsrc/bootstrap/diffGuard.ts\n" })), ["read-only-mode:-"]);
});

test("file budgets count committed paths, not just dirty ones (FIX-1)", () => {
  const committed = evaluateDiffScope(manifest({ allowPaths: ["src/**"] }), { porcelain: "", numstat: "1\t0\tsrc/c.ts\n1\t0\tsrc/a.ts\n1\t0\tsrc/b.ts\n" });
  assert.deepEqual(committed.changedPaths, ["src/a.ts", "src/b.ts", "src/c.ts"], "union paths stay sorted even when numstat is not");
  assert.deepEqual([committed.ok, committed.productionFiles, committed.testFiles], [false, 3, 0]);
  assert.deepEqual(labels(committed), ["production-file-budget:-"]);
  const tests = evaluateDiffScope(manifest(), { porcelain: "", numstat: "1\t0\ttest/unit/a.test.ts\n1\t0\ttest/unit/b.test.ts\n" });
  assert.deepEqual([tests.ok, tests.productionFiles, tests.testFiles], [false, 0, 2]);
  assert.deepEqual(labels(tests), ["test-file-budget:-"]);
});

test("a path in both porcelain and numstat is scoped once (FIX-1)", () => {
  const report = evaluateDiffScope(manifest({ limits: { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 100 } }), { porcelain: " M src/bootstrap/diffGuard.ts\n", numstat: "10\t2\tsrc/bootstrap/diffGuard.ts\n1\t0\tsrc/bootstrap/pathPolicy.ts\n" });
  assert.deepEqual(report.changedPaths, ["src/bootstrap/diffGuard.ts", "src/bootstrap/pathPolicy.ts"]);
  assert.deepEqual([report.ok, report.added + report.deleted, report.productionFiles, report.testFiles, report.violations.length], [true, 13, 2, 0, 0]);
});

test("a diff inside limits passes; oversize, symlink and read-only breaches do not", () => {
  const clean = evaluateDiffScope(manifest(), { porcelain: " M src/bootstrap/diffGuard.ts\n M test/unit/bootstrap-diff-guard.test.ts\n", numstat: "60\t4\tsrc/bootstrap/diffGuard.ts\n30\t0\ttest/unit/bootstrap-diff-guard.test.ts\n" });
  assert.deepEqual([clean.ok, clean.added + clean.deleted, clean.productionFiles, clean.testFiles, clean.violations.length], [true, 94, 1, 1, 0]);
  assert.deepEqual(labels(evaluateDiffScope(manifest(), { porcelain: " M src/bootstrap/diffGuard.ts\n", numstat: "140\t0\tsrc/bootstrap/diffGuard.ts\n" })).includes("changed-line-budget:-"), true);
  const symlinked = evaluateDiffScope(manifest(), { porcelain: " M link/file.ts\n", numstat: "" }, ["link"]);
  assert.match(symlinked.violations[0]?.detail ?? "", /symlink/u);
  assert.deepEqual(labels(evaluateDiffScope(manifest({ mode: "read-only" }), { porcelain: " M src/bootstrap/diffGuard.ts\n", numstat: "1\t0\tsrc/bootstrap/diffGuard.ts\n" })), ["read-only-mode:-"]);
});
