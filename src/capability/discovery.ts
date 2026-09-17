/**
 * Model discovery (spec §9).
 *
 * Everything flows through one narrow `ModelSource` interface, so a new provider
 * never requires touching routing code. Sources are: Pi's own ModelRuntime
 * (authoritative when a Pi process exists), the agent `models.json` file
 * (headless + tests), operator-supplied static records, and the optional
 * InferWeave capacity endpoint.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRecord } from "../lifecycle/types.ts";
import { normalizeModelRecord } from "./modelRecord.ts";

export interface DiscoveryContext {
  cwd: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface ModelSource {
  /** Stable identifier recorded on every produced record. */
  readonly name: string;
  discover(ctx: DiscoveryContext): Promise<ModelRecord[]>;
  /** Cheap signature used to detect provider configuration changes. */
  signature?(ctx: DiscoveryContext): Promise<string>;
}

/** Pi's ModelRuntime is the authoritative source inside a Pi process. */
export class PiModelRuntimeSource implements ModelSource {
  readonly name = "pi-model-runtime";

  private readonly runtime: ModelRuntime;
  private readonly includeUnavailable: boolean;

  constructor(runtime: ModelRuntime, includeUnavailable = true) {
    this.runtime = runtime;
    this.includeUnavailable = includeUnavailable;
  }

  async discover(): Promise<ModelRecord[]> {
    const available = new Set(this.runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
    const models = this.includeUnavailable ? this.runtime.getModels() : this.runtime.getAvailableSnapshot();
    const out: ModelRecord[] = [];
    for (const m of models) {
      const provider = String(m.provider);
      const isAvailable = available.has(`${provider}/${m.id}`);
      const authStatus = String(this.runtime.getProviderAuthStatus(provider) ?? "ok");
      const hasAuth = this.runtime.hasConfiguredAuth(provider) ?? true;
      out.push(
        normalizeModelRecord({
          provider,
          id: m.id,
          name: m.name,
          baseUrl: m.baseUrl,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxTokens,
          input: m.input as string[],
          output: ["text"],
          reasoning: m.reasoning,
          streaming: true,
          toolCall: true,
          priceInput: m.cost?.input,
          priceOutput: m.cost?.output,
          enabled: true,
          available: isAvailable,
          healthy: isAvailable || hasAuth,
          healthReason: isAvailable
            ? undefined
            : authStatus && authStatus !== "ok"
              ? `provider auth status: ${authStatus}`
              : "not currently selectable by the provider",
          source: this.name,
        }),
      );
    }
    return out;
  }
}

interface ModelsJsonProvider {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: {
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: string[];
    cost?: { input?: number; output?: number };
    contextWindow?: number;
    maxTokens?: number;
    tags?: string[];
  }[];
}

/**
 * The agent `models.json` file. Reading it directly keeps discovery working in
 * headless processes and makes "add a model to provider configuration" the only
 * step needed for a new model to become routable.
 */
export class AgentModelsFileSource implements ModelSource {
  readonly name = "agent-models-file";

  async discover(ctx: DiscoveryContext): Promise<ModelRecord[]> {
    const path = join(ctx.agentDir, "models.json");
    let parsed: { providers?: Record<string, ModelsJsonProvider> };
    try {
      parsed = JSON.parse(await readFile(path, "utf-8")) as { providers?: Record<string, ModelsJsonProvider> };
    } catch {
      return [];
    }
    const out: ModelRecord[] = [];
    for (const [provider, cfg] of Object.entries(parsed.providers ?? {})) {
      for (const m of cfg.models ?? []) {
        out.push(
          normalizeModelRecord({
            provider,
            id: m.id,
            name: m.name,
            baseUrl: cfg.baseUrl,
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxTokens,
            input: m.input ?? ["text"],
            reasoning: m.reasoning,
            streaming: true,
            toolCall: true,
            priceInput: m.cost?.input,
            priceOutput: m.cost?.output,
            enabled: true,
            // A configured model without a credential is discovered but unhealthy.
            available: true,
            healthy: true,
            source: this.name,
            extraTags: m.tags,
          }),
        );
      }
    }
    return out;
  }

  async signature(ctx: DiscoveryContext): Promise<string> {
    try {
      const s = await stat(join(ctx.agentDir, "models.json"));
      return `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {
      return "absent";
    }
  }
}

export interface StaticModelDefinition {
  provider: string;
  id: string;
  name?: string;
  base_url?: string;
  context_window?: number;
  max_output?: number;
  modalities?: string[];
  reasoning?: boolean;
  enabled?: boolean;
  tags?: string[];
  price_input?: number;
  price_output?: number;
}

/** Operator-declared models (config-supplied), merged with provider-discovered ones. */
export class StaticModelSource implements ModelSource {
  readonly name = "operator-config";

  private readonly defs: StaticModelDefinition[];

  constructor(defs: StaticModelDefinition[]) {
    this.defs = defs;
  }

  async discover(): Promise<ModelRecord[]> {
    return this.defs
      .filter((d) => d?.provider && d?.id)
      .map((d) =>
        normalizeModelRecord({
          provider: d.provider,
          id: d.id,
          name: d.name,
          baseUrl: d.base_url,
          contextWindow: d.context_window,
          maxOutputTokens: d.max_output,
          input: d.modalities ?? ["text"],
          reasoning: d.reasoning,
          enabled: d.enabled ?? true,
          available: d.enabled ?? true,
          source: this.name,
          extraTags: d.tags,
          priceInput: d.price_input,
          priceOutput: d.price_output,
        }),
      );
  }
}

/** Capacity/health payload an InferWeave-style coordinator is expected to expose. */
export interface CapacityPayload {
  nodes?: {
    id?: string;
    provider?: string;
    base_url?: string;
    healthy?: boolean;
    load?: number;
    queued_jobs?: number;
    models?: {
      id: string;
      name?: string;
      capabilities?: string[];
      context_window?: number;
      modalities?: string[];
      healthy?: boolean;
    }[];
  }[];
}

export interface CapacitySourceOptions {
  /** Local path or http(s) URL returning a {@link CapacityPayload}. */
  endpoint: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Optional InferWeave-style capacity source. Core never depends on InferWeave:
 * when the endpoint is absent or fails, discovery simply yields nothing.
 */
export class CapacityEndpointSource implements ModelSource {
  readonly name = "capacity-endpoint";

  private readonly opts: CapacitySourceOptions;

  constructor(opts: CapacitySourceOptions) {
    this.opts = opts;
  }

  async discover(ctx: DiscoveryContext): Promise<ModelRecord[]> {
    const payload = await this.loadPayload(ctx);
    if (!payload) return [];
    const out: ModelRecord[] = [];
    for (const node of payload.nodes ?? []) {
      const provider = node.provider ?? node.id ?? "inferweave";
      for (const m of node.models ?? []) {
        out.push(
          normalizeModelRecord({
            provider,
            id: m.id,
            name: m.name,
            baseUrl: node.base_url,
            contextWindow: m.context_window,
            input: m.modalities ?? ["text"],
            toolCall: true,
            enabled: true,
            available: node.healthy !== false && m.healthy !== false,
            healthy: node.healthy !== false && m.healthy !== false,
            healthReason: node.healthy === false ? "node reported unhealthy" : undefined,
            load: node.load,
            queuedJobs: node.queued_jobs,
            source: this.name,
            extraTags: m.capabilities,
          }),
        );
      }
    }
    return out;
  }

  private async loadPayload(ctx: DiscoveryContext): Promise<CapacityPayload | undefined> {
    const { endpoint, timeoutMs = 3000, headers } = this.opts;
    try {
      if (/^https?:\/\//.test(endpoint)) {
        const res = await fetch(endpoint, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return undefined;
        return (await res.json()) as CapacityPayload;
      }
      const path = endpoint.startsWith("/") ? endpoint : join(ctx.cwd, endpoint);
      return JSON.parse(await readFile(path, "utf-8")) as CapacityPayload;
    } catch {
      return undefined;
    }
  }
}

/** Merge records from several sources; the first source to mention a model wins. */
export function mergeRecords(sources: ModelRecord[][]): ModelRecord[] {
  const merged = new Map<string, ModelRecord>();
  for (const list of sources) {
    for (const rec of list) {
      const key = `${rec.provider}/${rec.id}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, rec);
        continue;
      }
      // Union health/availability signals; keep the richer capability declaration.
      merged.set(key, {
        ...existing,
        available: existing.available || rec.available,
        healthy: existing.healthy && rec.healthy,
        contextWindow: existing.contextWindow ?? rec.contextWindow,
        maxOutput: existing.maxOutput ?? rec.maxOutput,
        priceInputUsdPerMTok: existing.priceInputUsdPerMTok ?? rec.priceInputUsdPerMTok,
        priceOutputUsdPerMTok: existing.priceOutputUsdPerMTok ?? rec.priceOutputUsdPerMTok,
        load: rec.load ?? existing.load,
        queuedJobs: rec.queuedJobs ?? existing.queuedJobs,
        tags: [...new Set([...existing.tags, ...rec.tags])],
        capabilities:
          Object.keys(rec.capabilities.values).length > Object.keys(existing.capabilities.values).length
            ? rec.capabilities
            : existing.capabilities,
      });
    }
  }
  return [...merged.values()];
}
