import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Standalone provider discovery for the worker runtime.
 *
 * The SDK's `ModelRuntime` does not run the user's interactive extensions, so
 * custom providers registered there (e.g. `qwen-turing.ts`) are unknown to it.
 * This loader reads the standard local node configuration file
 * (`~/.pi/agent/qwen-nodes.json` or `$QWEN_NODES_FILE`) and registers the same
 * providers directly, so fresh-context workers work without a hosted control
 * plane (INV-013). This mirrors what the interactive extension does.
 */
interface NodeSpec {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  models?: Array<{
    id: string;
    contextWindow?: number;
    vision?: boolean;
    reasoning?: boolean;
    name?: string;
  }>;
}

interface NodesFile {
  nodes?: NodeSpec[];
}

const COMPAT = {
  thinkingFormat: "qwen-chat-template",
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const;

export function nodesFilePath(): string {
  const env = process.env.QWEN_NODES_FILE?.trim();
  if (env) return env;
  return join(homedir(), ".pi", "agent", "qwen-nodes.json");
}

export async function readNodeSpecs(): Promise<NodeSpec[]> {
  try {
    const raw = await readFile(nodesFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as NodesFile | NodeSpec[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.nodes ?? [];
  } catch {
    return [];
  }
}

/** Register local nodes onto a ModelRuntime. Returns registered provider ids. */
export async function registerLocalProviders(modelRuntime: ModelRuntime): Promise<string[]> {
  const specs = await readNodeSpecs();
  const registered: string[] = [];
  for (const node of specs) {
    if (!node.provider || !node.baseUrl) continue;
    const config = {
      name: node.provider,
      baseUrl: node.baseUrl,
      ...(node.apiKey ? { apiKey: node.apiKey } : {}),
      api: "openai-completions",
      models: (node.models ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: "openai-completions",
        reasoning: m.reasoning ?? false,
        input: m.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow ?? node.contextWindow ?? 131072,
        maxTokens: 8192,
        compat: COMPAT,
      })),
    };
    if (config.models && config.models.length > 0) {
      try {
        modelRuntime.registerProvider(node.provider, config);
        registered.push(node.provider);
      } catch {
        // Provider may already exist; skip.
      }
    }
  }
  return registered;
}
