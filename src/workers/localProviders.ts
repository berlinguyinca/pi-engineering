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
 *
 * "Mirrors" is the whole responsibility of this file, and it used to be a
 * partial mirror: the extension holds a model that cannot emit OpenAI
 * `tool_calls` out of the lane, and this loader had no `tools` field at all, so
 * a fresh-context worker registered that model happily and stalled mid-task on
 * its first tool call -- a worker failure the operator could not reproduce
 * interactively, on the same machine, against the same node. It also capped
 * every model at 8192 completion tokens where the extension allows 32768, so
 * the same model silently truncated for a worker and not for a human.
 *
 * What is deliberately still different, and why:
 *
 * - No live `/models` discovery. Workers start offline and cheap; the node file
 *   is maintained by `metabolomics-sync`, which writes the advertised (floored)
 *   window in. Discovery here would add a network round trip to every
 *   fresh-context worker for data the file already carries.
 * - `reasoning` stays opt-in per model (`m.reasoning ?? false`). The extension
 *   advertises `reasoning: true` for everything, so an interactive session
 *   thinks where a worker does not. That is a cost decision made once,
 *   deliberately, for every autonomous worker on the fleet; flipping it here
 *   would turn thinking on for all of them. Set `"reasoning": true` on the
 *   model in the node file to opt that model in for workers too.
 */
const COMPAT = {
  thinkingFormat: "qwen-chat-template",
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const;

/**
 * Per-node overrides accepted in the nodes file.
 *
 * `Partial<typeof COMPAT>` rather than a loose record: the compat fields are
 * literal unions on pi's model type, and widening them to `string` here is what
 * makes a typo in a config file compile quietly and fail at request time.
 */
type CompatOverrides = Partial<typeof COMPAT>;

interface NodeSpec {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  /** Send OpenAI `reasoning_effort` to this node. Off unless the node says so:
   *  a plain llama.cpp router ignores it, a gateway honours it. */
  supportsReasoningEffort?: boolean;
  /** Completion budget for models on this node that do not state their own. */
  maxTokens?: number;
  /** Per-node COMPAT override, merged over the shared defaults. */
  compat?: CompatOverrides;
  models?: Array<{
    id: string;
    contextWindow?: number;
    vision?: boolean;
    reasoning?: boolean;
    name?: string;
    maxTokens?: number;
    /** false = probed and found unable to emit OpenAI tool_calls.
     *  `metabolomics-sync` writes this from its probe (or the operator pin). */
    tools?: boolean;
  }>;
}

interface NodesFile {
  nodes?: NodeSpec[];
}

/**
 * Completion budget when neither the model nor the node states one.
 *
 * 32768, not the 8192 this file used to hardcode: the interactive extension
 * already allows 32768 for the same model on the same node, so a worker that
 * capped lower truncated long patches and tool-heavy answers with no error --
 * the truncation looked like a model that gave up. Divergence between two
 * readers of one config file is the bug; the number itself is the symptom.
 */
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Capability verdicts written by `metabolomics-sync` -- the same files the
 * interactive extension reads, so a worker and an interactive session never
 * disagree about whether a model can call tools.
 *
 * `capabilities.json` is the operator pin and MUST be read last: it beats a
 * probe on purpose, because the probe forces `tool_choice: "required"`, which
 * is the one path a gateway whose tool parser handles only the default path
 * will fail -- reporting "no tools" about a model that works.
 */
export function capabilityDir(): string {
  const fromEnv = process.env.LLM_METABOLOMICS_STATE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "llm-metabolomics");
}

export async function readCapabilityVerdicts(dir: string = capabilityDir()): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const file of ["capability-cache.json", "capabilities.json"]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, file), "utf-8"));
    } catch {
      // Absent or unreadable: that model is simply unjudged.
      continue;
    }
    const models = (parsed as { models?: Record<string, unknown> })?.models ?? {};
    for (const [id, rec] of Object.entries(models)) {
      const verdict = (rec as { tools?: unknown })?.tools;
      if (typeof verdict === "boolean") out[id] = verdict;
    }
  }
  return out;
}

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

/** A model plus the verdict on whether it can call tools at all. */
export type UsableModel = NonNullable<NodeSpec["models"]>[number];

/**
 * Partition a node's models into those a worker may be pointed at and those it
 * must not.
 *
 * A model that cannot emit `tool_calls` is worse than slow here: pi sends tools
 * with every prompt, so the model answers with raw tool markup in `content`, no
 * tool ever runs, and the worker reports a plausible-looking result computed
 * from nothing. Silence is the failure mode, so the model is held out and the
 * reason is printed once, the same way the interactive extension does it.
 *
 * Precedence, first match wins: an explicit `tools` on the model in the node
 * file, then the verdict files, then unknown (kept -- an unjudged model is not
 * a broken one, and benching on a missing verdict has already retired a working
 * model once).
 */
export function partitionByToolSupport(
  models: UsableModel[],
  verdicts: Record<string, boolean>,
): { kept: UsableModel[]; heldOut: string[] } {
  const kept: UsableModel[] = [];
  const heldOut: string[] = [];
  for (const model of models) {
    const verdict = model.tools === undefined ? verdicts[model.id] : model.tools;
    if (verdict === false) heldOut.push(model.id);
    else kept.push(model);
  }
  return { kept, heldOut };
}

/** Register local nodes onto a ModelRuntime. Returns registered provider ids. */
export async function registerLocalProviders(
  modelRuntime: ModelRuntime,
  opts?: { verdicts?: Record<string, boolean>; allowNoTools?: boolean },
): Promise<string[]> {
  const specs = await readNodeSpecs();
  const verdicts = opts?.verdicts ?? (await readCapabilityVerdicts());
  const allowNoTools = opts?.allowNoTools === true || process.env.QWEN_ALLOW_NO_TOOLS === "1";
  const registered: string[] = [];
  for (const node of specs) {
    if (!node.provider || !node.baseUrl) continue;
    const declared = node.models ?? [];
    const { kept, heldOut } = partitionByToolSupport(declared, verdicts);
    if (heldOut.length && !allowNoTools) {
      console.warn(
        `localProviders: holding ${node.provider}/${heldOut.join(", ")} out of the lane (no OpenAI tool_calls); set QWEN_ALLOW_NO_TOOLS=1 to register anyway`,
      );
    }
    const usable = allowNoTools ? declared : kept;
    if (usable.length === 0) continue; // nothing this worker can safely be pointed at
    const compat = {
      ...COMPAT,
      supportsReasoningEffort: node.supportsReasoningEffort === true,
      ...(node.compat ?? {}),
    };
    const config = {
      name: node.provider,
      baseUrl: node.baseUrl,
      ...(node.apiKey ? { apiKey: node.apiKey } : {}),
      api: "openai-completions",
      models: usable.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: "openai-completions",
        reasoning: m.reasoning ?? false,
        input: m.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow ?? node.contextWindow ?? 131072,
        maxTokens: m.maxTokens ?? node.maxTokens ?? DEFAULT_MAX_TOKENS,
        compat,
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
