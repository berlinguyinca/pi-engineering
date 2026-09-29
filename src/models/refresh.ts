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
  /** Generate a tiny completion with every advertised model and keep only successful ones. */
  probeModels?: boolean;
  /** Deadline for one inference probe. */
  probeTimeoutMs?: number;
  /** Maximum inference probes in flight at once. */
  probeConcurrency?: number;
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
  extends Pick<
    RefreshOptions,
    | "modelsPath"
    | "dryRun"
    | "pruneMissing"
    | "probeModels"
    | "probeTimeoutMs"
    | "probeConcurrency"
    | "signal"
    | "fetchImpl"
    | "now"
  > {
  providerIds: string[];
  authForProvider?: (providerId: string) => ProviderRefreshAuth | Promise<ProviderRefreshAuth>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
// Backends commonly expose several model aliases through one GPU worker. Probe
// sequentially by default so refresh itself does not manufacture a capacity
// failure and hide an otherwise healthy model. Callers may opt into bounded
// parallelism when their gateway is known to have independent capacity.
const DEFAULT_PROBE_CONCURRENCY = 1;

type ProbeResult =
  | { verdict: "working" }
  | { verdict: "unavailable"; reason: string }
  | { verdict: "systemic"; reason: string };

function requestHeaders(opts: Pick<RefreshOptions, "apiKey" | "headers">): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    const existing = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (existing) delete headers[existing];
    if (value !== null) headers[name] = value;
  }
  return headers;
}

function visibleCompletion(payload: unknown): boolean {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim().length > 0;
}

function errorCode(payload: unknown): string {
  const error = (payload as { error?: { code?: unknown; reason?: unknown; type?: unknown } })?.error;
  for (const value of [error?.code, error?.reason, error?.type]) {
    if (typeof value === "string" && value.length > 0) return value.toLowerCase();
  }
  return "";
}

function supportsThinkingOff(providerId: string, api: string, baseUrl: string): boolean {
  if (api !== "openai-completions") return false;
  const configuredList = (value: string | undefined, fallback: string[]): string[] =>
    (value === undefined ? fallback : value.split(",")).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const providers = configuredList(process.env.PI_THINKING_OFF_PROVIDERS, ["metabolomics"]);
  if (providers.includes(providerId.toLowerCase())) return true;
  const hosts = configuredList(process.env.PI_THINKING_OFF_GATEWAYS, ["llm.metabolomics.us"]);
  try {
    return hosts.includes(new URL(baseUrl).host.toLowerCase());
  } catch {
    return false;
  }
}

async function probeGatewayModel(
  model: GatewayModelEntry,
  baseUrl: string,
  opts: RefreshOptions,
  disableThinking: boolean,
): Promise<ProbeResult> {
  opts.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: requestHeaders(opts),
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
        ...(disableThinking ? { reasoning_effort: "none" } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      return visibleCompletion(payload)
        ? { verdict: "working" }
        : { verdict: "unavailable", reason: "returned no visible completion" };
    }
    const code = errorCode(payload);
    if (response.status === 404 || /model_not_found|capacity_unavailable|no_context_capacity/.test(code)) {
      return { verdict: "unavailable", reason: code || `HTTP ${response.status}` };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return { verdict: "systemic", reason: `HTTP ${response.status}${code ? ` ${code}` : ""}` };
    }
    return { verdict: "systemic", reason: `HTTP ${response.status}${code ? ` ${code}` : ""}` };
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (timedOut || controller.signal.aborted) return { verdict: "unavailable", reason: "probe timed out" };
    return { verdict: "systemic", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function verifiedGatewayModels(
  gateway: GatewayModelEntry[],
  baseUrl: string,
  opts: RefreshOptions,
  disableThinking: boolean,
): Promise<{ working: GatewayModelEntry[]; excluded: Array<{ id: string; reason: string }> }> {
  const verdicts = new Array<ProbeResult>(gateway.length);
  let next = 0;
  const workers = Math.max(1, Math.min(opts.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY, gateway.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= gateway.length) return;
        let result = await probeGatewayModel(gateway[index]!, baseUrl, opts, disableThinking);
        if (result.verdict === "unavailable" && result.reason === "probe timed out") {
          result = await probeGatewayModel(gateway[index]!, baseUrl, opts, disableThinking);
        }
        verdicts[index] = result;
      }
    }),
  );
  const systemic = gateway
    .map((model, index) => ({ model, result: verdicts[index]! }))
    .filter((entry) => entry.result.verdict === "systemic");
  if (systemic.length > 0) {
    throw new Error(
      `model verification was inconclusive: ${systemic
        .map(({ model, result }) => `${model.id}: ${"reason" in result ? result.reason : "systemic failure"}`)
        .join("; ")}`,
    );
  }
  const working = gateway.filter((_, index) => verdicts[index]?.verdict === "working");
  const excluded = gateway.flatMap((model, index) => {
    const result = verdicts[index];
    return result?.verdict === "unavailable" ? [{ id: model.id, reason: result.reason }] : [];
  });
  if (working.length === 0) {
    throw new Error(`none of the ${gateway.length} advertised models produced a usable completion`);
  }
  return { working, excluded };
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
  const configuredProvider = config.providers?.[opts.providerId];
  const api = typeof configuredProvider?.api === "string" ? configuredProvider.api : "openai-completions";

  const advertised = await fetchGatewayModels({
    baseUrl,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const canProbe = opts.probeModels && api === "openai-completions";
  const disableThinking = supportsThinkingOff(opts.providerId, api, baseUrl);
  const verified = canProbe
    ? await verifiedGatewayModels(advertised, baseUrl, opts, disableThinking)
    : { working: advertised, excluded: [] };
  const gateway = verified.working;
  const plan = planCatalogUpdate(existing, gateway, opts.pruneMissing || canProbe ? { pruneMissing: true } : {});
  const planLines = describeCatalogPlan(plan).map((line) =>
    canProbe
      ? line
          .replace(/^not on the gateway/, "not working")
          .replace(" — the gateway no longer lists it", " — not advertised or inference probe failed")
      : line,
  );
  const lines = [
    `${opts.providerId} — ${gateway.length} ${canProbe ? "working" : "advertised"} model(s) on ${baseUrl}`,
    ...(canProbe ? [`Inference-tested ${advertised.length}; excluded ${verified.excluded.length}.`] : []),
    ...(opts.probeModels && !canProbe ? [`Inference probe skipped for unsupported provider API ${api}.`] : []),
    ...verified.excluded.map(({ id, reason }) => `  excluded: ${id} — ${reason}`),
    ...planLines,
  ];
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

  opts.signal?.throwIfAborted();
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
      opts.signal?.throwIfAborted();
      const auth = (await opts.authForProvider?.(providerId)) ?? {};
      opts.signal?.throwIfAborted();
      const result = await planProviderRefresh(nextConfig, {
        modelsPath: opts.modelsPath,
        providerId,
        ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.pruneMissing ? { pruneMissing: true } : {}),
        ...(opts.probeModels ? { probeModels: true } : {}),
        ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
        ...(opts.probeConcurrency !== undefined ? { probeConcurrency: opts.probeConcurrency } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      opts.signal?.throwIfAborted();
      if (result.plan.dirty && opts.dryRun) result.lines.push("Dry run — nothing written.");
      if (result.plan.dirty && !opts.dryRun) {
        nextConfig = withProviderModels(nextConfig, providerId, result.plan.next);
      }
      results.push({ providerId, result });
      lines.push(...result.lines);
    } catch (cause) {
      opts.signal?.throwIfAborted();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failures.push({ providerId, error });
      lines.push(`${providerId} — skipped: ${error.message}. Existing configuration kept.`);
    }
  }

  const dirty = results.some(({ result }) => result.plan.dirty);
  if (!dirty || opts.dryRun) return { results, failures, written: false, lines };

  opts.signal?.throwIfAborted();
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
