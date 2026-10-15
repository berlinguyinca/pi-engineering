/**
 * Gate-role model candidates drawn straight from the Pi model registry, for
 * when routing offers none (no repo policy, or every routed candidate was
 * tried or sits on an unreachable provider).
 */

import type { ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import { modelFamily, sameFamily } from "./modelRecord.ts";

/** A model the session registry can serve. */
export interface RegistryModel extends ModelRef {
  contextWindow?: number;
}

/**
 * Order registry models for a gate role: skip excluded models and skipped
 * providers; put the producers' exact models last (they stay a last resort);
 * then models of a different family than every producer first, then larger
 * context windows first, then by name so the order is stable.
 */
export function rankRegistryModels(
  models: readonly RegistryModel[],
  opts: { exclude: readonly ModelRef[]; producers: readonly ModelRef[]; skipProvider: (provider: string) => boolean },
): RegistryModel[] {
  const excluded = new Set(opts.exclude.map(modelKey));
  const producerKeys = new Set(opts.producers.map(modelKey));
  const independent = (model: ModelRef): boolean =>
    modelFamily(model.id) !== undefined && !opts.producers.some((producer) => sameFamily(producer.id, model.id));
  const seen = new Set<string>();
  const pool = models.filter((model) => {
    const key = modelKey(model);
    if (excluded.has(key) || seen.has(key) || opts.skipProvider(model.provider)) return false;
    seen.add(key);
    return true;
  });
  const tier = (model: RegistryModel): number => (producerKeys.has(modelKey(model)) ? 2 : independent(model) ? 0 : 1);
  return pool.sort(
    (a, b) =>
      tier(a) - tier(b) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || modelKey(a).localeCompare(modelKey(b)),
  );
}

/**
 * Keep the models Pi's `enabledModels` patterns allow (case-insensitive globs
 * over `provider/id` or the bare id, an optional `:thinking` suffix ignored).
 * An absent or empty pattern list allows everything.
 */
export function filterEnabledModels<T extends ModelRef>(
  models: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) return [...models];
  const matchers = patterns.map((pattern) => {
    const glob = pattern.replace(/:(off|minimal|low|medium|high|xhigh)$/i, "");
    const source = glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${source}$`, "i");
  });
  return models.filter((model) => matchers.some((re) => re.test(modelKey(model)) || re.test(model.id)));
}
