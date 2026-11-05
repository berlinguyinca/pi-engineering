import { modelFamily, sameFamily } from "./modelRecord.ts";

/** One measured run of the quantization-benchmark protocol (docs/specs/harness-reliability-bootstrap-20261103/04-QUANTIZATION-BENCHMARK.md).
 * Names follow ExecutionProvenance (src/uieng/schemas.ts): selected_model -> modelId, quantization -> quantMethod, timings_ms -> latencyMs. */
export interface QuantRunRecord { // every provenance field is required: a missing value is a gap, never a default
  modelId: string; // model id; the comparison is only ever drawn within one modelFamily()
  weightsHash: string; // exact weights/version hash; the literal "unknown" is a provenance gap in comparisons
  quantMethod: "q8" | "q6" | "q4" | "fp16" | "bf16" | "unknown";
  kvCache: "fp16" | "q8" | "q4" | "unknown"; // KV-cache dtype, never conflated with weight quantization
  contextTokens: number; // effective context bucket (~8k/32k/64k/100k), not a requested limit
  promptSha256: string; // sha256:<64 hex> over the frozen prompt
  sampling: { seed?: number; temperature: number };
  outcome: "completed" | "refused" | "error" | "timeout"; // completion outcome, never an HTTP status
  latencyMs: number;
  harness: "minimal" | "full"; // minimal single-task Pi versus the full harness
  baseSha: string; // clean base tree each run was isolated against
}

const UNIONS = { quantMethod: ["q8", "q6", "q4", "fp16", "bf16", "unknown"], kvCache: ["fp16", "q8", "q4", "unknown"], outcome: ["completed", "refused", "error", "timeout"], harness: ["minimal", "full"] };
const TOLERANCE = 1e-9; // a decoding difference below this is not a different controlled condition

/** Ordered, human-readable problems for a candidate run record; never throws. [] means provenance is complete. */
export function validateRunRecord(input: unknown): string[] {
  const r = (input ?? {}) as Record<string, unknown>; const problems: string[] = [];
  const text = (key: string) => { if (typeof r[key] !== "string" || (r[key] as string).trim() === "") problems.push(`${key}: required non-empty string`); };
  const count = (key: string) => { const v = r[key]; if (typeof v !== "number" || !Number.isInteger(v) || v < 0) problems.push(`${key}: required integer >= 0`); };
  const oneOf = (key: string, allowed: string[]) => { if (typeof r[key] !== "string" || !allowed.includes(r[key])) problems.push(`${key}: must be one of ${allowed.join("|")}`); };
  text("modelId"); text("weightsHash"); text("baseSha"); text("promptSha256");
  count("contextTokens"); count("latencyMs");
  for (const [key, allowed] of Object.entries(UNIONS)) oneOf(key, allowed); // insertion order = stable problem order
  if (typeof r.promptSha256 === "string" && !/^sha256:[0-9a-f]{64}$/.test(r.promptSha256)) problems.push("promptSha256: expected sha256:<64 hex>");
  const s = (r.sampling ?? {}) as Record<string, unknown>;
  if (typeof s.temperature !== "number" || !(s.temperature >= 0 && s.temperature <= 2)) problems.push("sampling.temperature: required number within 0..2");
  if (s.seed !== undefined && (typeof s.seed !== "number" || !Number.isInteger(s.seed))) problems.push("sampling.seed: integer when present");
  return problems;
}

/** The gate: comparable only when the same base family and every controlled variable are proven equal. */
export function compareRuns(left: unknown, right: unknown): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const [side, rec] of [["left", left], ["right", right]] as const) for (const p of validateRunRecord(rec)) reasons.push(`${side}.${p}`);
  if (reasons.length > 0) return { comparable: false, reasons }; // an unprovable record is never comparable
  const a = left as QuantRunRecord; const b = right as QuantRunRecord; const [familyA, familyB] = [modelFamily(a.modelId), modelFamily(b.modelId)];
  for (const [side, rec] of [["left", a], ["right", b]] as const) {
    if (rec.weightsHash === "unknown") reasons.push(`${side}.weightsHash is unknown: exact weights hash required`);
    if (modelFamily(rec.modelId) === undefined) reasons.push(`${side}.modelId family cannot be established: not comparable`);
  }
  if (familyA !== undefined && familyB !== undefined && !sameFamily(a.modelId, b.modelId)) reasons.push(`model family differs: ${familyA} vs ${familyB}`);
  if (a.quantMethod !== b.quantMethod) reasons.push(`quantMethod differs: ${a.quantMethod} vs ${b.quantMethod}`);
  if (a.kvCache !== b.kvCache) reasons.push(`kvCache differs: ${a.kvCache} vs ${b.kvCache}`);
  if (a.baseSha !== b.baseSha) reasons.push(`baseSha differs: ${a.baseSha} vs ${b.baseSha}`);
  if (a.contextTokens !== b.contextTokens) reasons.push(`contextTokens differ: ${a.contextTokens} vs ${b.contextTokens}`);
  if (a.promptSha256 !== b.promptSha256) reasons.push(`promptSha256 differs: ${a.promptSha256} vs ${b.promptSha256}`);
  if (a.sampling.seed !== b.sampling.seed) reasons.push(`sampling.seed differs: ${a.sampling.seed} vs ${b.sampling.seed}`);
  if (Math.abs(a.sampling.temperature - b.sampling.temperature) > TOLERANCE) reasons.push(`sampling.temperature differs: ${a.sampling.temperature} vs ${b.sampling.temperature}`);
  return { comparable: reasons.length === 0, reasons };
}
