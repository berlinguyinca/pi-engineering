/**
 * Normalized model capability records (spec §9, §10).
 *
 * Capability provenance is never conflated: a provider declaration, a curated
 * naming heuristic, and an observed measurement are recorded with distinct
 * sources and carry different authority in routing (declared > curated >
 * inferred > observed).
 */

import type { ModelRecord } from "../lifecycle/types.ts";

/** Capability names used by role requirements. */
export const CAPABILITIES = [
  "vision",
  "reasoning",
  "long_context",
  "tool_calling",
  "structured_output",
  "streaming",
  "parallel_tools",
  "fast",
  "low_cost",
  "high_quality",
  "code_strong",
  "local",
  "privacy_sensitive",
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Providers whose endpoint is a local process rather than a remote API. */
export function isLocalEndpoint(baseUrl: string | undefined, provider: string): boolean {
  if (!baseUrl) return /^(lmstudio|ollama|llama-cpp|vllm|localgpt|qwen-local|gpu-node)/.test(provider);
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

const FAMILY_PATTERNS: [RegExp, string][] = [
  [/^gpt-5/, "gpt-5"],
  [/^gpt-4/, "gpt-4"],
  [/^o[134]/, "openai-reasoning"],
  [/claude.*(opus|sonnet|haiku)/, "claude"],
  [/^deepseek/, "deepseek"],
  [/^qwen/, "qwen"],
  [/^gemini/, "gemini"],
  [/^llama/, "llama"],
  [/^(mistral|pixtral|devstral)/, "mistral"],
  [/^command/, "cohere"],
  [/^grok/, "grok"],
];

export function detectFamily(id: string): string | undefined {
  const lower = id.toLowerCase();
  for (const [re, family] of FAMILY_PATTERNS) {
    if (re.test(lower)) return family;
  }
  const head = lower.split(/[-/:]/)[0];
  return head || undefined;
}

/** Curated traits derived from naming + pricing conventions. Explicitly tagged `curated`. */
export function curatedTags(rec: {
  id: string;
  name?: string;
  contextWindow?: number;
  priceInputUsdPerMTok?: number;
  priceOutputUsdPerMTok?: number;
  modalities?: string[];
  local?: boolean;
}): string[] {
  const hay = `${rec.id} ${rec.name ?? ""}`.toLowerCase();
  const tags: string[] = [];
  if (/vision|vl\b|-vl\b|omni|image|multimodal|flash-next/.test(hay) || rec.modalities?.includes("image")) {
    tags.push("vision_ui");
  }
  if (/flash|mini|haiku|lite|turbo|small|fast|nanofast/.test(hay)) tags.push("fast", "low_cost");
  if (/opus|ultra|max|pro|-4\.(6|7|8)|thinking|reasoner/.test(hay)) tags.push("high_quality", "reasoning_heavy");
  if ((rec.contextWindow ?? 0) >= 200_000) tags.push("long_context");
  if (rec.local) tags.push("local_hosted");
  const inPrice = rec.priceInputUsdPerMTok;
  const outPrice = rec.priceOutputUsdPerMTok;
  if (typeof inPrice === "number" && typeof outPrice === "number") {
    if (inPrice === 0 && outPrice === 0) tags.push("free", "low_cost");
    else if (outPrice >= 30) tags.push("expensive", "high_quality");
    else if (outPrice <= 2) tags.push("low_cost");
  }
  return [...new Set(tags)];
}

export interface NormalizeInput {
  provider: string;
  id: string;
  name?: string;
  family?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: string[];
  output?: string[];
  reasoning?: boolean;
  streaming?: boolean;
  toolCall?: boolean;
  priceInput?: number;
  priceOutput?: number;
  enabled?: boolean;
  available?: boolean;
  healthy?: boolean;
  healthReason?: string;
  source: string;
  extraTags?: string[];
  load?: number;
  queuedJobs?: number;
}

/** Build a ModelRecord with provenance-tagged capabilities. */
export function normalizeModelRecord(input: NormalizeInput): ModelRecord {
  const modalities = [
    ...new Set([
      ...(input.input ?? []).map((m) => m.toLowerCase()),
      ...(input.output ?? []).map((m) => m.toLowerCase()),
    ]),
  ];
  const local = isLocalEndpoint(input.baseUrl, input.provider);
  const declared: Record<string, boolean> = {};
  if (modalities.includes("image")) declared.vision = true;
  if (input.reasoning) declared.reasoning = true;
  if (input.toolCall) declared.tool_calling = true;
  if (input.streaming !== false) declared.streaming = true;
  if ((input.contextWindow ?? 0) >= 200_000) declared.long_context = true;
  if (local) declared.local = true;

  const base = {
    provider: input.provider,
    id: input.id,
    name: input.name,
    family: input.family ?? detectFamily(input.id),
    endpoint: input.baseUrl,
    contextWindow: input.contextWindow,
    maxOutput: input.maxOutputTokens,
    modalities,
    reasoning: input.reasoning ?? false,
    parallelToolCalls: false,
    streaming: input.streaming ?? true,
    local,
    priceInputUsdPerMTok: input.priceInput,
    priceOutputUsdPerMTok: input.priceOutput,
    enabled: input.enabled ?? true,
    healthy: input.healthy ?? true,
    healthReason: input.healthReason,
    available: input.available ?? true,
    load: input.load,
    queuedJobs: input.queuedJobs,
    source: input.source,
    discoveredAt: new Date().toISOString(),
    penalty: 0,
  };

  const tags = [...curatedTags(base), ...(input.extraTags ?? [])];
  const capabilities: ModelRecord["capabilities"] = { values: declared, source: "declared" };

  // Curated traits are additive but never override a declared value.
  for (const tag of tags) {
    if (tag === "vision_ui" && capabilities.values.vision === undefined) capabilities.values.vision = true;
    if (tag === "reasoning_heavy" && capabilities.values.reasoning === undefined) capabilities.values.reasoning = true;
    if (tag === "long_context" && capabilities.values.long_context === undefined)
      capabilities.values.long_context = true;
    if (tag === "fast") capabilities.values.fast = true;
    if (tag === "low_cost" || tag === "free") capabilities.values.low_cost = true;
    if (tag === "high_cost" || tag === "expensive") capabilities.values.low_cost = false;
    if (tag === "high_quality") capabilities.values.high_quality = true;
  }
  if (capabilities.values.vision === undefined) capabilities.values.vision = false;
  if (modalities.length > 0 && !modalities.includes("image") && !tags.includes("vision_ui")) {
    capabilities.values.vision = false;
  }

  return { ...base, tags: [...new Set(tags)], capabilities };
}

/** Read a capability with declared-or-curated semantics. Unknown capabilities are false. */
export function hasCapability(rec: ModelRecord, capability: string): boolean {
  if (capability === "any") return true;
  const v = rec.capabilities.values[capability];
  if (v !== undefined) return v;
  return rec.tags.includes(capability);
}
