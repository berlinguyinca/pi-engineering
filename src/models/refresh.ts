/**
 * The `/refresh-models` operation.
 *
 * Fetch what the gateway serves, reconcile it with `models.json`, and report
 * exactly what changed. Kept out of the extension entry point so the whole
 * operation is testable without a session — the lesson of a scoping fix that
 * shipped unapplied because the only code path exercising it was untested
 * wiring.
 */

import { type CatalogPlan, type ConfiguredModel, describeCatalogPlan, planCatalogUpdate } from "./catalogPlan.ts";
import { DEFAULT_GATEWAY_BASE_URL, type GatewayModelEntry, fetchGatewayModels } from "./gatewayCatalog.ts";
import {
  type ModelsConfig,
  providerBaseUrl,
  providerModels,
  readModelsConfig,
  withProviderModels,
  writeModelsConfig,
} from "./modelsConfig.ts";

export interface RefreshOptions {
  modelsPath: string;
  providerId: string;
  /** Overrides the configured base URL. */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  /** Report what would change without touching the file. */
  dryRun?: boolean;
  /** Remove configured models the gateway no longer lists. Off by default. */
  pruneMissing?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RefreshResult {
  plan: CatalogPlan;
  gateway: GatewayModelEntry[];
  baseUrl: string;
  /** Written only when the plan was dirty and this was not a dry run. */
  backupPath?: string;
  written: boolean;
  /** Rendered report, ready to show. */
  lines: string[];
}

export interface ProviderRefreshAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

export interface RefreshConfiguredProvidersOptions
  extends Pick<RefreshOptions, "modelsPath" | "dryRun" | "pruneMissing" | "signal" | "fetchImpl" | "now"> {
  providerIds: string[];
  authForProvider?: (providerId: string) => ProviderRefreshAuth | Promise<ProviderRefreshAuth>;
}

export interface ConfiguredProviderRefreshResult {
  results: Array<{ providerId: string; result: RefreshResult }>;
  failures: Array<{ providerId: string; error: Error }>;
  /** One restore point for the complete successful batch. */
  backupPath?: string;
  written: boolean;
  lines: string[];
}

async function planProviderRefresh(config: ModelsConfig, opts: RefreshOptions): Promise<RefreshResult> {
  const existing: ConfiguredModel[] = providerModels(config, opts.providerId);
  const baseUrl = opts.baseUrl ?? providerBaseUrl(config, opts.providerId) ?? DEFAULT_GATEWAY_BASE_URL;

  const gateway = await fetchGatewayModels({
    baseUrl,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const plan = planCatalogUpdate(existing, gateway, opts.pruneMissing ? { pruneMissing: true } : {});
  const lines = [`${opts.providerId} — ${gateway.length} model(s) on ${baseUrl}`, ...describeCatalogPlan(plan)];
  return { plan, gateway, baseUrl, written: false, lines };
}

/**
 * Refresh one provider's models from its gateway.
 *
 * Reads the config BEFORE fetching so a malformed `models.json` fails before
 * any network call, and writes only when something actually changed — a refresh
 * that rewrites an identical file still churns a backup and a mtime for nothing.
 */
export async function refreshProviderModels(opts: RefreshOptions): Promise<RefreshResult> {
  const config: ModelsConfig = readModelsConfig(opts.modelsPath);
  const result = await planProviderRefresh(config, opts);

  if (!result.plan.dirty || opts.dryRun) {
    if (result.plan.dirty && opts.dryRun) result.lines.push("Dry run — nothing written.");
    return result;
  }

  const write = writeModelsConfig(
    opts.modelsPath,
    withProviderModels(config, opts.providerId, result.plan.next),
    (opts.now ?? (() => new Date()))(),
  );
  result.lines.push(`Wrote ${opts.modelsPath}`);
  if (write.backupPath) result.lines.push(`Previous version kept at ${write.backupPath}`);
  result.lines.push("Restart Pi or run /reload for the new models to take effect.");

  return {
    ...result,
    written: true,
    ...(write.backupPath ? { backupPath: write.backupPath } : {}),
  };
}

/** Refresh configured providers independently so one bad host cannot block the rest. */
export async function refreshConfiguredProviders(
  opts: RefreshConfiguredProvidersOptions,
): Promise<ConfiguredProviderRefreshResult> {
  // Parse once before entering the per-provider recovery loop. A malformed
  // source file is not a provider failure and must never be replaced.
  let nextConfig = readModelsConfig(opts.modelsPath);
  const results: ConfiguredProviderRefreshResult["results"] = [];
  const failures: ConfiguredProviderRefreshResult["failures"] = [];
  const lines: string[] = [];

  for (const providerId of opts.providerIds) {
    try {
      const auth = (await opts.authForProvider?.(providerId)) ?? {};
      const result = await planProviderRefresh(nextConfig, {
        modelsPath: opts.modelsPath,
        providerId,
        ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.pruneMissing ? { pruneMissing: true } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (result.plan.dirty && opts.dryRun) result.lines.push("Dry run — nothing written.");
      if (result.plan.dirty && !opts.dryRun) {
        nextConfig = withProviderModels(nextConfig, providerId, result.plan.next);
      }
      results.push({ providerId, result });
      lines.push(...result.lines);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failures.push({ providerId, error });
      lines.push(`${providerId} — skipped: ${error.message}. Existing configuration kept.`);
    }
  }

  const dirty = results.some(({ result }) => result.plan.dirty);
  if (!dirty || opts.dryRun) return { results, failures, written: false, lines };

  const write = writeModelsConfig(opts.modelsPath, nextConfig, (opts.now ?? (() => new Date()))());
  const commonLines = [`Wrote ${opts.modelsPath}`];
  if (write.backupPath) commonLines.push(`Previous version kept at ${write.backupPath}`);
  commonLines.push("Restart Pi or run /reload for the new models to take effect.");
  lines.push(...commonLines);

  for (const entry of results) {
    if (!entry.result.plan.dirty) continue;
    entry.result = {
      ...entry.result,
      written: true,
      ...(write.backupPath ? { backupPath: write.backupPath } : {}),
    };
  }

  return {
    results,
    failures,
    ...(write.backupPath ? { backupPath: write.backupPath } : {}),
    written: true,
    lines,
  };
}
