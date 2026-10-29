/**
 * Builds the Orchestrator's `phaseHandoff` option from the real model registry and the GLOBAL engineering.yaml
 * `context_thresholds:` block (context/thresholds.ts). Without this the phase-boundary handoff, the live
 * context-threshold trigger and the quota handoff are all off (orchestrator.ts only enables them when `phaseHandoff` is
 * passed). Best effort: an unreadable registry yields a resolver that knows no windows, which means "no signal, no
 * control effect", never a guess.
 */
import type { ContextThresholds } from "../context/thresholds.ts";
import { loadContextThresholdConfig, resolveContextThresholds } from "../context/thresholds.ts";
import type { OrchestratorOptions } from "../orchestration/orchestrator.ts";

export interface RegistryModel {
  provider: string;
  id: string;
  contextWindow?: number;
}

export async function buildContinuityConfig(input: {
  agentDir: string;
  models: () => Promise<readonly RegistryModel[]>;
  isModelUnavailable?: (model: { provider: string; id: string }) => boolean;
  log?: (line: string) => void;
}): Promise<NonNullable<OrchestratorOptions["phaseHandoff"]>> {
  const { config, notes } = await loadContextThresholdConfig(input.agentDir);
  for (const note of notes) input.log?.(`[context-thresholds] ${note}`);
  let registry: readonly RegistryModel[] = [];
  try {
    // Startup must not wait on a slow registry: no answer in time means no windows (no signal), not a guess.
    registry = await Promise.race([
      input.models(),
      new Promise<readonly RegistryModel[]>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), 5_000);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    input.log?.(`[context-thresholds] model registry unreadable (${error instanceof Error ? error.message : error})`);
  }
  const windows = new Map<string, number>();
  const providers = new Map<string, string>();
  for (const m of registry) {
    for (const key of [m.id, `${m.provider}/${m.id}`]) {
      if (typeof m.contextWindow === "number" && m.contextWindow > 0) windows.set(key, m.contextWindow);
      providers.set(key, m.provider);
    }
  }
  const thresholdsForModel = (model: string | null): ContextThresholds =>
    resolveContextThresholds(config, {
      ...(model ? { model, ...(providers.get(model) ? { runtime: providers.get(model) as string } : {}) } : {}),
    });
  return {
    contextWindowForModel: (model) => windows.get(model) ?? null,
    // The phase boundary hands off at the global `soft` level.
    threshold: thresholdsForModel(null).soft,
    thresholdsForModel,
    quotaCatalogue: () =>
      registry.map((m) => ({
        id: m.id,
        eligible: input.isModelUnavailable?.({ provider: m.provider, id: m.id }) !== true,
      })),
  };
}
