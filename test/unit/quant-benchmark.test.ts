import assert from "node:assert";
import { test } from "node:test";
import { compareRuns, validateRunRecord, type QuantRunRecord } from "../../src/capability/quantBenchmark.ts";

const hex = (c: string) => `sha256:${c.repeat(64)}`;
const base: QuantRunRecord = { modelId: "qwen3.8-27b", weightsHash: hex("b"), quantMethod: "q8", kvCache: "fp16", contextTokens: 8192, promptSha256: hex("a"), sampling: { seed: 7, temperature: 0.2 }, outcome: "completed", latencyMs: 1200, harness: "minimal", baseSha: "aaaa111" };
// [rejection class, patch to the left record, exact reason, whether the patched record is still schema-valid].
const REJECTIONS: [string, Partial<QuantRunRecord>, string, boolean][] = [
  ["missing quantMethod", { quantMethod: undefined }, "quantMethod: must be one of q8|q6|q4|fp16|bf16|unknown", false],
  ["missing weightsHash", { weightsHash: "  " }, "weightsHash: required non-empty string", false],
  ["malformed promptSha256", { promptSha256: "sha256:deadbeef" }, "promptSha256: expected sha256:<64 hex>", false],
  ["weightsHash unknown", { weightsHash: "unknown" }, "left.weightsHash is unknown: exact weights hash required", true],
  ["different family", { modelId: "gpt-5-codex" }, "model family differs: gpt-5 vs qwen", true],
  ["unknown family", { modelId: "mystery/" }, "left.modelId family cannot be established: not comparable", true],
  ["different baseSha", { baseSha: "bbbb222" }, "baseSha differs: bbbb222 vs aaaa111", true],
  ["different context bucket", { contextTokens: 32768 }, "contextTokens differ: 32768 vs 8192", true],
  ["different prompt hash", { promptSha256: hex("c") }, `promptSha256 differs: ${hex("c")} vs ${hex("a")}`, true],
  ["different quantMethod", { quantMethod: "q4" }, "quantMethod differs: q4 vs q8", true],
  ["different kvCache", { kvCache: "q4" }, "kvCache differs: q4 vs fp16", true],
  ["different temperature", { sampling: { seed: 7, temperature: 0.9 } }, "sampling.temperature differs: 0.9 vs 0.2", true],
];

test("validateRunRecord is clean for the good record and names each broken one", () => {
  assert.deepEqual(validateRunRecord(base), []);
  for (const [name, patch, reason, valid] of REJECTIONS) {
    assert.equal(validateRunRecord({ ...base, ...patch }).length === 0, valid, name);
    assert.deepEqual(compareRuns({ ...base, ...patch }, base), { comparable: false, reasons: valid ? [reason] : [`left.${reason}`] }, name);
  }
});

test("a fully specified same-family same-quant pair is comparable", () => {
  assert.deepEqual(compareRuns(base, { ...base }), { comparable: true, reasons: [] });
  assert.deepEqual(compareRuns({ ...base, sampling: { seed: 7, temperature: 0.2 + 1e-12 } }, base), { comparable: true, reasons: [] });
});
test("reasons name every failed check, in a stable order across calls", () => {
  const left = { ...base, modelId: "gpt-5-codex", quantMethod: "q4", kvCache: "q4", contextTokens: 32768, baseSha: "bbbb222", promptSha256: hex("c"), sampling: { seed: 1, temperature: 1.5 } };
  const first = compareRuns(left, base);
  assert.equal(first.comparable, false);
  assert.equal(first.reasons.length, 8);
  assert.deepEqual(first.reasons, compareRuns(left, base).reasons);
  assert.ok(first.reasons.indexOf("model family differs: gpt-5 vs qwen") < first.reasons.indexOf("quantMethod differs: q4 vs q8"));
});
