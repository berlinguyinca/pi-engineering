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
  assert.deepEqual(report.changedPaths, ["new/name.ts", "old/name.ts", "src/bootstrap/generated/out.min.js", "src/bootstrap/pathPolicy.ts", "src/other/file.ts"]);
  assert.deepEqual([report.added, report.deleted, report.productionFiles, report.testFiles], [3, 1, 5, 0]);
  assert.deepEqual(labels(report), ["binary-change:src/assets/logo.png", "denied-path:src/bootstrap/generated/out.min.js", "generated-file:src/bootstrap/generated/out.min.js", "production-file-budget:-", "unexpected-path:new/name.ts", "unexpected-path:old/name.ts", "unexpected-path:src/other/file.ts"]);
});

test("a diff inside limits passes; oversize, symlink and read-only breaches do not", () => {
  const clean = evaluateDiffScope(manifest(), { porcelain: " M src/bootstrap/diffGuard.ts\n M test/unit/bootstrap-diff-guard.test.ts\n", numstat: "60\t4\tsrc/bootstrap/diffGuard.ts\n30\t0\ttest/unit/bootstrap-diff-guard.test.ts\n" });
  assert.deepEqual([clean.ok, clean.added + clean.deleted, clean.productionFiles, clean.testFiles, clean.violations.length], [true, 94, 1, 1, 0]);
  assert.deepEqual(labels(evaluateDiffScope(manifest(), { porcelain: " M src/bootstrap/diffGuard.ts\n", numstat: "140\t0\tsrc/bootstrap/diffGuard.ts\n" })).includes("changed-line-budget:-"), true);
  const symlinked = evaluateDiffScope(manifest(), { porcelain: " M link/file.ts\n", numstat: "" }, ["link"]);
  assert.match(symlinked.violations[0]?.detail ?? "", /symlink/u);
  assert.deepEqual(labels(evaluateDiffScope(manifest({ mode: "read-only" }), { porcelain: " M src/bootstrap/diffGuard.ts\n", numstat: "1\t0\tsrc/bootstrap/diffGuard.ts\n" })), ["read-only-mode:-"]);
});
