/**
 * Stateful role resolution for one mission: the gateway catalogue, the models
 * found unavailable during the mission, and candidates the gateway suggested.
 */

import type { ModelProfile } from "./compatibility.ts";
import type { CatalogModel } from "./gateway.ts";
import type { ModelRef } from "./planner.ts";
import { DEFAULT_ROLE_CONFIG, type ResolvedRole, type RoleConfig, resolveRole } from "./roles.ts";
import type { PlannerWorkerRole } from "./types.ts";

export interface RoleResolverOptions {
  provider: string;
  config?: Readonly<Record<PlannerWorkerRole, RoleConfig>>;
  catalog?: CatalogModel[];
  loadCatalog?: () => Promise<CatalogModel[]>;
  fallback?: (role: PlannerWorkerRole, exclude: readonly string[]) => Promise<ModelRef | undefined>;
}

export class RoleResolver {
  private models: CatalogModel[];
  private readonly excluded = new Set<string>();
  readonly config: Readonly<Record<PlannerWorkerRole, RoleConfig>>;
  private readonly opts: RoleResolverOptions;

  constructor(opts: RoleResolverOptions) {
    this.opts = opts;
    this.config = opts.config ?? DEFAULT_ROLE_CONFIG;
    this.models = opts.catalog ?? [];
  }

  async refresh(): Promise<void> {
    if (!this.opts.loadCatalog) return;
    const next = await this.opts.loadCatalog().catch(() => [] as CatalogModel[]);
    if (next.length > 0) this.models = next;
  }

  catalog(): CatalogModel[] {
    return [...this.models];
  }

  /** A model the gateway reported unavailable is skipped for the rest of the mission. */
  exclude(modelId: string): void {
    this.excluded.add(modelId);
  }

  excludedModels(): string[] {
    return [...this.excluded];
  }

  /** Merge gateway-suggested candidates (availability error metadata). */
  mergeCandidates(candidates: CatalogModel[]): void {
    for (const c of candidates) if (!this.models.some((m) => m.id === c.id)) this.models.push(c);
  }

  resolve(role: PlannerWorkerRole, avoid: readonly string[] = []): Promise<ResolvedRole | null> {
    return resolveRole(role, {
      catalog: this.models,
      config: this.config,
      provider: this.opts.provider,
      avoid,
      exclude: [...this.excluded],
      ...(this.opts.fallback ? { fallback: this.opts.fallback } : {}),
    });
  }

  profileOf(r: ResolvedRole): ModelProfile {
    const e = r.entry;
    const backing = r.backing ? this.models.find((m) => m.id === r.backing) : undefined;
    const window = r.contextWindow ?? backing?.contextWindow;
    return {
      id: r.model.id,
      ...(window !== undefined ? { contextWindow: window } : {}),
      modalities: e?.modalities ?? [],
      ...(e?.tools !== undefined ? { tools: e.tools } : {}),
      ...(e?.structuredOutput !== undefined ? { structuredOutput: e.structuredOutput } : {}),
      capabilities: e?.capabilities ?? [],
    };
  }

  /** Other concrete catalogue models that could serve `role` (compatibility alternatives). */
  alternatives(role: PlannerWorkerRole, besides: string): ModelProfile[] {
    const cap = this.config[role].capability;
    return this.models
      .filter((m) => !m.alias && m.id !== besides && !this.excluded.has(m.id) && m.capabilities.includes(cap))
      .map((m) => ({
        id: m.id,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        modalities: m.modalities,
        ...(m.tools !== undefined ? { tools: m.tools } : {}),
        ...(m.structuredOutput !== undefined ? { structuredOutput: m.structuredOutput } : {}),
        capabilities: m.capabilities,
      }));
  }
}
