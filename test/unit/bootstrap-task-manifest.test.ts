import assert from "node:assert/strict"; import { test } from "node:test";
import { DEFAULT_LIMITS, TASK_MANIFEST_FIELDS, type TaskManifest, parseTaskManifest } from "../../src/bootstrap/taskManifest.ts";
const HASH = `sha256:${"a".repeat(64)}`;
const VALID: Record<string, unknown> = JSON.parse(`{"taskId":"B01","baseSha":"c2b75dc93885d246d712d656f72de1764cf198e0","repoId":"berlinguyinca/pi-engineering","objective":"Define static microtask manifest schema","allowPaths":["src/bootstrap/taskManifest.ts"],"denyPaths":["package.json"],"commands":[{"argv":["npm","run","typecheck"],"cwd":"."}],"limits":{"maxProductionFiles":1,"maxTestFiles":1,"maxChangedLines":100},"parentHandoffHash":"${HASH}","expectedOutputs":["src/bootstrap/taskManifest.ts"],"mode":"isolated-change"}`);
const reject = (input: unknown): string[] => { const result = parseTaskManifest(input); assert.equal(result.ok, false, "expected rejection"); return (result as { ok: false; errors: string[] }).errors; };
const accept = (input: unknown): TaskManifest => { const result = parseTaskManifest(input); assert.equal(result.ok, true, JSON.stringify((result as { errors?: string[] }).errors)); return (result as { ok: true; manifest: TaskManifest }).manifest; };
test("B01: valid JSON fixture is accepted and every schema field is populated", () => {
  const manifest = accept(VALID);
  assert.deepEqual(Object.keys(manifest).sort(), [...TASK_MANIFEST_FIELDS].sort());
  assert.equal(manifest.parentHandoffHash, HASH); assert.deepEqual(manifest.commands, [{ argv: ["npm", "run", "typecheck"], cwd: "." }]);
});
test("B01: defaults apply when the optional fields (limits, denyPaths, expectedOutputs) are absent", () => {
  const optional = { ...VALID }; for (const field of ["limits", "denyPaths", "expectedOutputs"]) delete optional[field];
  const [limits, denyPaths, expectedOutputs] = [accept(optional).limits, accept(optional).denyPaths, accept(optional).expectedOutputs];
  assert.deepEqual([limits, denyPaths, expectedOutputs], [DEFAULT_LIMITS, [], []]);
});
test("B01: invalid fixtures are rejected with deterministic, sorted, deduplicated errors", () => {
  const cases: Array<[unknown, string]> = [
    [{ ...VALID, scope: "src" }, "unknown field: scope"], [{ ...VALID, parentHandoffHash: undefined }, "parentHandoffHash: missing"],
    [[VALID], "manifest: expected a JSON object"], ["nope", "manifest: expected a JSON object"],
    [{ ...VALID, baseSha: "not-a-sha" }, "baseSha: expected 7-64 hex characters"],
    [{ ...VALID, allowPaths: [] }, "allowPaths: scope must name at least one path"],
    [{ ...VALID, commands: [{ argv: [], cwd: "" }] }, "commands[0].argv: expected a non-empty argv array"],
    [{ ...VALID, limits: { ...DEFAULT_LIMITS, maxTestFiles: 3 } }, "limits.maxTestFiles: 3 exceeds bootstrap ceiling 2"],
    [{ ...VALID, limits: { ...DEFAULT_LIMITS, maxDocs: 1 } }, "unknown field: limits.maxDocs"],
    [{ ...VALID, parentHandoffHash: "sha256:deadbeef" }, "parentHandoffHash: expected null or sha256:<64 hex>"],
    [{ ...VALID, mode: "yolo" }, "mode: expected one of read-only, isolated-change, herdr-ui"],
  ];
  for (const [fixture, expected] of cases) assert.ok(reject(fixture).includes(expected), `expected a rejection containing "${expected}"`);
  assert.deepEqual(reject({ ...VALID, zzzUnknown: 1, aaaUnknown: 2 }), ["unknown field: aaaUnknown", "unknown field: zzzUnknown"]);
});
// FIX-4B: the line ceiling is mode-aware (03-TEST-AND-RELEASE-GATES.md rule 3); the 2-file caps are not.
test("FIX-4B: herdr-ui is accepted as a mode with a 120-line ceiling", () => {
  const ui = { ...VALID, mode: "herdr-ui", limits: { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 120 } };
  assert.equal(accept(ui).mode, "herdr-ui");
  assert.ok(reject({ ...ui, limits: { ...ui.limits, maxChangedLines: 121 } }).includes("limits.maxChangedLines: 121 exceeds bootstrap ceiling 120 for mode herdr-ui"));
});
test("FIX-4B: 120 changed lines is rejected against the 100 ceiling for every non-herdr-ui mode", () => {
  for (const mode of ["isolated-change", "read-only"]) assert.ok(reject({ ...VALID, mode, limits: { ...DEFAULT_LIMITS, maxChangedLines: 120 } }).includes(`limits.maxChangedLines: 120 exceeds bootstrap ceiling 100 for mode ${mode}`), mode);
});
test("FIX-4B: an unknown mode is still rejected and herdr-ui keeps the 2-file caps", () => {
  const uiLimits = { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 120 };
  assert.ok(reject({ ...VALID, mode: "herdr" }).includes("mode: expected one of read-only, isolated-change, herdr-ui"));
  assert.ok(reject({ ...VALID, mode: "herdr-ui", limits: { ...uiLimits, maxProductionFiles: 3 } }).includes("limits.maxProductionFiles: 3 exceeds bootstrap ceiling 2"));
  assert.ok(reject({ ...VALID, mode: "herdr-ui", limits: { ...uiLimits, maxTestFiles: 3 } }).includes("limits.maxTestFiles: 3 exceeds bootstrap ceiling 2"));
});
