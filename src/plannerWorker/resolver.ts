/**
 * Stateful role resolution for one mission: the gateway catalogue, the models
 * found unavailable during the mission, and candidates the gateway suggested.
 */

import type { ModelProfile } from "./compatibility.ts";
import type { CatalogModel } from "./gateway.ts";
import type { ModelRef } from "./planner.ts";
import {
  DEFAULT_ROLE_CONFIG,
  type ResolvedRole,
  type RoleConfig,
  resolveRole,
  servedIdentity,
  usable,
} from "./roles.ts";
import type { PlannerWorkerRole } from "./types.ts";

export interface RoleResolverOptions {
  provider: string;
  config?: Readonly<Record<PlannerWorkerRole, RoleConfig>>;
  catalog?: CatalogModel[];
  loadCatalog?: () => Promise<CatalogModel[]>;
  fallback?: (role: PlannerWorkerRole, exclude: readonly string[]) => Promise<ModelRef | undefined>;
  /**
   * The operator's explicit model choice (Pi `/model`), read at every
   * resolution so a switch lands at the next dispatch, replan or review.
   */
  operatorPin?: () => ModelRef | null | undefined;
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

  /** A model reported ready again (route events) is eligible again. */
  include(modelId: string): void {
    this.excluded.delete(modelId);
  }

  excludedModels(): string[] {
    return [...this.excluded];
  }

  /** Merge gateway-suggested candidates (availability error metadata). */
  mergeCandidates(candidates: CatalogModel[]): void {
    for (const c of candidates) if (!this.models.some((m) => m.id === c.id)) this.models.push(c);
  }

  async resolve(role: PlannerWorkerRole, avoid: readonly string[] = []): Promise<ResolvedRole | null> {
    const pin = this.opts.operatorPin?.();
    if (!pin || this.excluded.has(pin.id)) return this.resolveUnpinned(role, avoid);
    const pinName = `${pin.provider}/${pin.id}`;
    const cfg = this.config[role];
    const entry = this.models.find((m) => m.id === pin.id);
    // Hard checks only: what the catalogue says the pinned model cannot do.
    const refusal = !entry
      ? null
      : !usable(entry)
        ? `state ${entry.state}`
        : cfg.min_context !== undefined && entry.contextWindow !== undefined && entry.contextWindow < cfg.min_context
          ? `context ${entry.contextWindow} < required ${cfg.min_context}`
          : cfg.tools === true && entry.tools === false
            ? "no tool calling"
            : null;
    if (refusal) {
      const routed = await this.resolveUnpinned(role, avoid);
      return (
        routed && { ...routed, notes: [`operator pin ${pinName} cannot serve ${role} (${refusal})`, ...routed.notes] }
      );
    }
    if (avoid.includes(pin.id)) {
      // Separation of duties: keep the roles apart when another capable model exists.
      const routed = await this.resolveUnpinned(role, avoid);
      if (routed && servedIdentity(routed) !== pin.id) {
        return {
          ...routed,
          notes: [
            `operator pin ${pinName} also serves a role ${role} must differ from; using ${routed.model.id}`,
            ...routed.notes,
          ],
        };
      }
      return this.pinned(role, pin, entry, [
        `only the operator-pinned model ${pinName} can serve ${role}; it also serves a role ${role} must differ from`,
      ]);
    }
    return this.pinned(role, pin, entry, [`operator pin ${pinName}`]);
  }

  private pinned(
    role: PlannerWorkerRole,
    pin: ModelRef,
    entry: CatalogModel | undefined,
    notes: string[],
  ): ResolvedRole {
    return {
      role,
      model: { provider: pin.provider, id: pin.id },
      via: "operator_pin",
      ...(entry?.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry ? { entry } : {}),
      notes,
    };
  }

  private resolveUnpinned(role: PlannerWorkerRole, avoid: readonly string[]): Promise<ResolvedRole | null> {
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
  alternatives(role: PlannerWorkerRole, besides: string, avoid: readonly string[] = []): ModelProfile[] {
    const cap = this.config[role].capability;
    return this.models
      .filter(
        (m) =>
          !m.alias &&
          m.id !== besides &&
          !avoid.includes(m.id) &&
          !this.excluded.has(m.id) &&
          m.capabilities.includes(cap),
      )
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
